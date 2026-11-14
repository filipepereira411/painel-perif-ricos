'use strict';

/* ============================================================
   Agente de Controlo Remoto (Windows)
   - Lê a configuração de config.json
   - Arranca o worker.ps1 (captura de ecrã + injeção de input)
   - Liga-se ao servidor por WebSocket e retransmite frames/input
   Sem dependências: usa o WebSocket nativo do Node 22+.
   ============================================================ */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const WORKER_FILE = path.join(__dirname, 'worker.ps1');

const DEFAULT_CFG = {
  server: 'ws://localhost:8080/ws',
  token: '',
  name: os.hostname(),
  fps: 5,
  quality: 60,
};

let cfg = Object.assign({}, DEFAULT_CFG);
try {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
  cfg = Object.assign(cfg, JSON.parse(raw));
} catch {
  console.warn('config.json inválido ou ausente — a usar valores por omissão.');
}

if (!cfg.token) {
  console.error('Falta o "token" em config.json (copia o token mostrado pelo servidor).');
  process.exit(1);
}

const HOST_INFO = {
  hostname: os.hostname(),
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  cpus: os.cpus().length,
  mem: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
  uptime: Math.round(os.uptime()),
};

let fps = clamp(Number(cfg.fps) || 5, 1, 30);
let quality = clamp(Number(cfg.quality) || 60, 20, 95);

let ws = null;
let worker = null;
let workerReady = false;
let streaming = false;
let timer = null;
let shotStart = 0;
let sys = { x: 0, y: 0, w: 0, h: 0 };

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/* ============================================================
   Worker (PowerShell)
   ============================================================ */

function startWorker() {
  if (worker) return;

  worker = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER_FILE],
    { windowsHide: true }
  );

  let buffer = '';
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      onWorkerLine(line);
    }
  });

  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (d) => {
    const text = d.trim();
    if (text) console.error('[worker] ' + text);
  });

  worker.on('error', (err) => {
    console.error('Não foi possível arrancar o worker: ' + err.message);
  });

  const bootTimer = setTimeout(() => {
    if (!workerReady) {
      console.warn('O worker (PowerShell) ainda não respondeu — se persistir, um antivírus pode estar a bloquear o PowerShell.');
    }
  }, 10000);

  worker.on('exit', (code) => {
    clearTimeout(bootTimer);
    worker = null;
    workerReady = false;
    streaming = false;
    clearTimeout(timer);
    console.warn(`Worker terminou (código ${code}). A reiniciar em 2 s…`);
    setTimeout(startWorker, 2000);
  });

  worker.stdin.on('error', () => { /* ignora EPIPE durante o fecho */ });
}

function workerSend(obj) {
  if (worker && worker.stdin.writable) {
    worker.stdin.write(JSON.stringify(obj) + '\n');
  }
}

function onWorkerLine(line) {
  if (!line) return;

  if (line.startsWith('SIZE ')) {
    const p = line.split(' ');
    const next = { x: +p[1] || 0, y: +p[2] || 0, w: +p[3] || 0, h: +p[4] || 0 };
    if (next.w && next.h) {
      if (!workerReady) console.log(`Worker pronto — ecrã virtual ${next.w}×${next.h}`);
      workerReady = true;
      setSys(next);
    }
    return;
  }

  if (line.startsWith('FRAME ')) {
    const p = line.split(' ');
    const x = +p[1] || 0;
    const y = +p[2] || 0;
    const w = +p[3] || 0;
    const h = +p[4] || 0;
    const b64 = p[5] || '';

    if (w && h && (w !== sys.w || h !== sys.h || x !== sys.x || y !== sys.y)) {
      setSys({ x, y, w, h });
    }

    const jpeg = Buffer.from(b64, 'base64');
    if (ws && ws.readyState === 1 && jpeg.length && ws.bufferedAmount < 2000000) ws.send(jpeg);

    send({ t: 'stats', captureMs: Date.now() - shotStart });

    if (streaming) {
      const elapsed = Date.now() - shotStart;
      scheduleFrame(Math.max(0, Math.round(1000 / fps) - elapsed));
    }
    return;
  }

  if (line.startsWith('PONG ')) {
    send({ t: 'pong', ts: line.slice(5) });
    return;
  }

  if (line.startsWith('ERR ')) {
    console.error('[worker] ' + line.slice(4));
  }
}

function setSys(next) {
  sys = next;
  send({ t: 'sys', sys });
}

/* ============================================================
   Streaming
   ============================================================ */

function startStream() {
  if (streaming) return;
  streaming = true;
  requestFrame();
}

function stopStream() {
  streaming = false;
  clearTimeout(timer);
}

function scheduleFrame(delay) {
  clearTimeout(timer);
  timer = setTimeout(requestFrame, delay);
}

function requestFrame() {
  if (!streaming) return;
  if (!worker || !workerReady) {
    scheduleFrame(300);
    return;
  }
  shotStart = Date.now();
  workerSend({ op: 'shot', q: quality });
}

/* ============================================================
   WebSocket
   ============================================================ */

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function connect() {
  let sock;
  try {
    sock = new WebSocket(cfg.server);
  } catch (err) {
    console.error('URL do servidor inválida: ' + err.message);
    process.exit(1);
  }

  ws = sock;
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    console.log(`Ligado a ${cfg.server} como ${cfg.name}`);
    send({
      t: 'hello',
      role: 'agent',
      token: cfg.token,
      name: cfg.name,
      host: HOST_INFO,
    });
    if (sys.w && sys.h) send({ t: 'sys', sys });
  });

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;

    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.t) {
      case 'hello':
        if (!msg.ok) {
          console.error('Servidor recusou a ligação: ' + (msg.error || 'token inválido'));
          process.exit(1);
        }
        break;

      case 'stream':
        if (msg.on) startStream();
        else stopStream();
        break;

      case 'cfg':
        if (Number(msg.fps) > 0) fps = clamp(Number(msg.fps), 1, 30);
        if (Number(msg.quality) > 0) quality = clamp(Number(msg.quality), 20, 95);
        break;

      case 'input':
        handleInput(msg);
        break;

      case 'text':
        typeText(String(msg.s || '').slice(0, 2000));
        break;

      case 'ping':
        workerSend({ op: 'ping', ts: Number(msg.ts) || 0 });
        break;
    }
  });

  ws.addEventListener('close', () => {
    releaseAll();
    streaming = false;
    clearTimeout(timer);
    ws = null;
    console.warn('Ligação perdida. A tentar novamente em 3 segundos…');
    setTimeout(connect, 3000);
  });

  ws.addEventListener('error', () => { /* o close segue-se */ });
}

/* ============================================================
   Input
   ============================================================ */

const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, Escape: 0x1B, Space: 0x20,
  CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, Pause: 0x13, PrintScreen: 0x2C,
  ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3,
  AltLeft: 0xA4, AltRight: 0xA5, MetaLeft: 0x5B, MetaRight: 0x5C, ContextMenu: 0x5D,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE, Slash: 0xBF,
  Backquote: 0xC0, BracketLeft: 0xDB, Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE,
  NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadMultiply: 0x6A,
  NumpadDivide: 0x6F, NumpadDecimal: 0x6E,
};

for (let i = 1; i <= 12; i++) VK['F' + i] = 0x6F + i;
for (let i = 0; i <= 9; i++) VK['Digit' + i] = 0x30 + i;
for (let i = 0; i < 26; i++) VK['Key' + String.fromCharCode(65 + i)] = 0x41 + i;

const EXTENDED = new Set([
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ControlRight', 'AltRight', 'ContextMenu', 'PrintScreen',
  'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract', 'NumpadAdd', 'NumpadDecimal',
]);

const vkDown = new Set();
const btnDown = new Set();

/* solta teclas e botões que ficaram premidos (ex.: ligação perdida a meio) */
function releaseAll() {
  for (const code of vkDown) {
    const vk = VK[code];
    if (vk) workerSend({ op: 'kup', vk, ext: EXTENDED.has(code) });
  }
  vkDown.clear();
  for (const b of btnDown) workerSend({ op: 'up', b });
  btnDown.clear();
}

function handleInput(msg) {
  switch (msg.ev) {
    case 'mousemove':
      workerSend({
        op: 'move',
        x: Math.round((Number(msg.x) || 0) + sys.x),
        y: Math.round((Number(msg.y) || 0) + sys.y),
      });
      break;

    case 'mousedown': {
      const b = msg.b || 'left';
      btnDown.add(b);
      workerSend({ op: 'down', b });
      break;
    }

    case 'mouseup': {
      const b = msg.b || 'left';
      btnDown.delete(b);
      workerSend({ op: 'up', b });
      break;
    }

    case 'wheel':
      workerSend({ op: 'wheel', d: (Number(msg.d) || 0) > 0 ? 1 : -1 });
      break;

    case 'keydown':
      onKeyDown(msg);
      break;

    case 'keyup':
      onKeyUp(msg);
      break;
  }
}

function onKeyDown(msg) {
  const code = msg.code || '';
  const key = typeof msg.key === 'string' ? msg.key : '';
  const vk = VK[code];
  const shortcut = !!(msg.ctrl || msg.alt || msg.meta);

  /* atalhos e teclas especiais: códigos virtuais */
  if (vk && (shortcut || key.length !== 1)) {
    workerSend({ op: 'kdown', vk, ext: EXTENDED.has(code) });
    vkDown.add(code);
    return;
  }

  /* texto normal: caractere unicode (acentos e maiúsculas corretos) */
  if (key.length === 1) {
    workerSend({ op: 'type', ch: key.charCodeAt(0) });
    return;
  }

  if (vk) {
    workerSend({ op: 'kdown', vk, ext: EXTENDED.has(code) });
    vkDown.add(code);
  }
}

function onKeyUp(msg) {
  const code = msg.code || '';
  if (!vkDown.has(code)) return;
  const vk = VK[code];
  if (!vk) return;
  workerSend({ op: 'kup', vk, ext: EXTENDED.has(code) });
  vkDown.delete(code);
}

function typeText(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      workerSend({ op: 'kdown', vk: 0x0D, ext: false });
      workerSend({ op: 'kup', vk: 0x0D, ext: false });
    } else if (code !== 13) {
      workerSend({ op: 'type', ch: code });
    }
  }
}

/* ============================================================
   Arranque
   ============================================================ */

startWorker();
connect();

process.on('SIGINT', () => {
  stopStream();
  if (worker) worker.kill();
  process.exit(0);
});
