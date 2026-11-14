/* ============================================================
   Controlo Remoto — cliente web (browser)
   - Liga-se ao servidor por WebSocket (com token)
   - Mostra o ecrã remoto (JPEG stream) num canvas
   - Reencaminha rato/teclado quando o modo Controlo está ativo
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);

const canvas = $('#screen');
const ctx = canvas.getContext('2d');

let ws = null;
let authenticated = false;
let control = false;
let imgW = 0;
let imgH = 0;
let lastMoveAt = 0;
let frameCount = 0;

/* PCs (agentes) disponíveis e o que está a ser visto */
let agentsList = [];
let targetId = null;

/* PC pedido pelo painel: remoto.html?pc=<id> */
const wantedPc = new URLSearchParams(location.search).get('pc');

/* ---------- endereço, credenciais e config do agente ---------- */

const LS_URL = 'remoto.url';
const LS_TOKEN = 'remoto.token';

/* aceita "192.168.1.88", "192.168.1.88:8080" ou "ws://.../ws" */
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  if (!/^wss?:\/\//i.test(s)) s = 'ws://' + s;
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (!u.port && u.protocol === 'ws:') u.port = '8080';
  if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
  return u.toString();
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* ignora */ }
}

const defaultUrl = location.protocol.startsWith('http')
  ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
  : 'ws://localhost:8080/ws';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLocalHost = LOCAL_HOSTS.has(location.hostname);

$('#in-url').value = storageGet(LS_URL) || defaultUrl;
$('#in-token').value = storageGet(LS_TOKEN) || '';
$('#ag-host').value = (location.protocol.startsWith('http') && !isLocalHost) ? location.host : '';

function agentConfig() {
  const server = normalizeUrl($('#ag-host').value) ||
    normalizeUrl($('#in-url').value) || defaultUrl;
  return {
    server,
    token: $('#in-token').value.trim(),
    name: $('#ag-name').value.trim() || 'Meu-PC',
    fps: 5,
    quality: 60,
  };
}

function refreshAgentConfig() {
  const cfg = agentConfig();
  $('#ag-config').value = JSON.stringify(cfg, null, 2);

  let host = '';
  try { host = new URL(cfg.server).hostname; } catch { /* ignora */ }
  $('#ag-warn').hidden = !LOCAL_HOSTS.has(host);
}

['#in-url', '#in-token', '#ag-host', '#ag-name'].forEach((sel) => {
  $(sel).addEventListener('input', refreshAgentConfig);
});
refreshAgentConfig();

/* aberto em localhost: usa o primeiro IP de rede detetado pelo servidor */
if (isLocalHost && !$('#ag-host').value) {
  fetch('/api/net')
    .then((r) => r.json())
    .then((info) => {
      if (!info || !info.addresses || !info.addresses.length) return;
      $('#ag-host').value = info.addresses[0] + ':' + (info.port || 8080);
      refreshAgentConfig();
    })
    .catch(() => { /* servidor antigo sem /api/net — fica o campo vazio */ });
}

$('#ag-copy').addEventListener('click', async () => {
  const btn = $('#ag-copy');
  const old = btn.textContent;
  const text = $('#ag-config').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('#ag-config').select();
    document.execCommand('copy');
  }
  btn.textContent = '✓ Copiado';
  setTimeout(() => { btn.textContent = old; }, 1500);
});

$('#ag-download').addEventListener('click', () => {
  const blob = new Blob([$('#ag-config').value], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'config.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------- helpers ---------- */

function log(msg) {
  const d = new Date().toLocaleTimeString('pt-PT');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = '[' + d + '] ' + msg;
  $('#log').prepend(line);
  while ($('#log').children.length > 40) $('#log').lastChild.remove();
}

function fmtUptime(s) {
  if (s == null || !isFinite(s)) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (d ? d + ' d ' : '') + (d || h ? h + ' h ' : '') + m + ' min';
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function showLoginError(msg) {
  const box = $('#login-error');
  if (msg) { box.textContent = msg; box.hidden = false; }
  else box.hidden = true;
}

function setOverlay(show, text) {
  $('#overlay').hidden = !show;
  if (text) $('#overlay-text').textContent = text;
}

function enterApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function resetToLogin(reason) {
  authenticated = false;
  control = false;
  targetId = null;
  agentsList = [];
  $('#ctl-mode').checked = false;
  canvas.classList.remove('controlling');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  showLoginError(reason || null);
  $('#btn-connect').disabled = false;
  $('#btn-connect').textContent = '🔌 Ligar';
}

/* ---------- informação do agente ---------- */

function applyHost(host) {
  if (!host) return;
  $('#r-name').textContent = host.hostname || '—';
  $('#r-os').textContent = (host.platform || '—') + ' ' + (host.release || '');
  $('#r-cpus').textContent = host.cpus != null ? host.cpus : '—';
  $('#r-mem').textContent = host.mem != null ? host.mem + ' GB' : '—';
  $('#r-arch').textContent = host.arch || '—';
  $('#r-uptime').textContent = fmtUptime(host.uptime);
}

function applySys(sys) {
  if (!sys) return;
  imgW = sys.w;
  imgH = sys.h;
  $('#st-res').textContent = sys.w + '×' + sys.h;
  $('#r-vscreen').textContent = sys.w + ' × ' + sys.h +
    (sys.x || sys.y ? ' (offset ' + sys.x + ',' + sys.y + ')' : '');
  if (canvas.width !== sys.w || canvas.height !== sys.h) {
    canvas.width = sys.w;
    canvas.height = sys.h;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, sys.w, sys.h);
  }
}

function setAgentOnline(on, name, sys, host) {
  $('#st-agent').textContent = on ? (name || 'agente') : 'sem agente';
  $('#st-dot').className = 'dot ' + (on ? 'on' : 'off');
  setOverlay(!on, 'à espera que o agente se ligue…');
  if (sys) applySys(sys);
  if (host) applyHost(host);
}

/* ---------- escolha do PC remoto ---------- */

function renderAgents(list) {
  const sel = $('#sel-agent');
  const prev = sel.value;
  sel.innerHTML = '';

  if (!list.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'sem PCs ligados';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  for (const a of list) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = (a.name || a.id) + (a.ip ? ' · ' + a.ip : '') + (a.online ? '' : ' (offline)');
    sel.appendChild(o);
  }

  if (prev && list.some((a) => a.id === prev)) sel.value = prev;
  else {
    const first = list.find((a) => a.online);
    if (first) sel.value = first.id;
  }
}

function switchTarget(id) {
  if (!id || id === targetId) return;
  targetId = id;
  imgW = 0;
  imgH = 0;
  canvas.width = 1;
  canvas.height = 1;
  $('#st-res').textContent = '—';
  setOverlay(true, 'a ligar ao PC…');
  send({ t: 'select', id });
}

/* ---------- ligação ---------- */

function connect(url, token) {
  showLoginError(null);
  $('#btn-connect').disabled = true;
  $('#btn-connect').textContent = 'a ligar…';

  let sock;
  try {
    sock = new WebSocket(url);
  } catch (err) {
    resetToLogin('URL inválida: ' + err.message);
    return;
  }
  ws = sock;
  ws.binaryType = 'blob';

  ws.onopen = () => send({ t: 'hello', role: 'client', token });

  ws.onmessage = (ev) => {
    if (ev.data instanceof Blob) { onFrame(ev.data); return; }

    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.t) {
      case 'hello':
        if (!msg.ok) {
          ws.onclose = null;
          ws.close();
          resetToLogin(msg.error || 'token inválido');
          return;
        }
        authenticated = true;
        enterApp();
        log('ligado a ' + url);
        break;

      case 'agents':
        agentsList = Array.isArray(msg.list) ? msg.list : [];
        renderAgents(agentsList);
        if (!targetId) {
          const wanted = wantedPc && agentsList.find((a) => a.id === wantedPc && a.online);
          const first = wanted || agentsList.find((a) => a.online);
          if (first) switchTarget(first.id);
        }
        break;

      case 'selected':
        targetId = msg.id || null;
        if (targetId) {
          const a = agentsList.find((x) => x.id === targetId);
          log('a ver ' + (a && a.name ? a.name : targetId));
          pushCfg();
          /* mantém o PC escolhido no URL (F5 não perde a seleção) */
          try {
            const u = new URL(location.href);
            u.searchParams.set('pc', targetId);
            history.replaceState(null, '', u);
          } catch { /* ignora */ }
        }
        break;

      case 'agent':
        setAgentOnline(msg.online, msg.name, msg.sys, msg.host);
        log(msg.online
          ? 'agente ligado' + (msg.name ? ': ' + msg.name : '')
          : 'agente desligado');
        break;

      case 'sys':
        applySys(msg.sys);
        break;

      case 'stats':
        $('#r-cap').textContent = msg.captureMs != null ? Math.round(msg.captureMs) + ' ms' : '—';
        $('#r-inp').textContent = msg.inputMs != null ? Math.round(msg.inputMs) + ' ms' : '—';
        break;

      case 'pong': {
        const ms = Math.round(performance.now() - msg.ts);
        $('#st-ping').textContent = ms + ' ms';
        $('#r-ping2').textContent = ms + ' ms';
        break;
      }
    }
  };

  ws.onclose = () => {
    if (authenticated) resetToLogin('ligação perdida ao servidor');
    else resetToLogin('não foi possível ligar — verifica a URL e se o servidor está a correr');
  };

  ws.onerror = () => { /* o onclose segue-se */ };
}

/* ---------- frames de vídeo ---------- */

async function onFrame(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      imgW = bmp.width;
      imgH = bmp.height;
      $('#st-res').textContent = imgW + '×' + imgH;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    frameCount++;
    setOverlay(false);
  } catch { /* frame corrompido — ignora */ }
}

/* ---------- entrada (rato + teclado) ---------- */

const BTN = ['left', 'middle', 'right'];

function mapPos(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) / Math.max(1, r.width) * (imgW || r.width));
  const y = Math.round((e.clientY - r.top) / Math.max(1, r.height) * (imgH || r.height));
  return { x, y };
}

canvas.addEventListener('mousemove', (e) => {
  if (!control) return;
  const now = performance.now();
  if (now - lastMoveAt < 30) return; /* ~30 eventos/s */
  lastMoveAt = now;
  send(Object.assign({ t: 'input', ev: 'mousemove' }, mapPos(e)));
});

canvas.addEventListener('mousedown', (e) => {
  if (!control) { canvas.focus(); return; }
  e.preventDefault();
  canvas.focus();
  send(Object.assign({ t: 'input', ev: 'mousedown', b: BTN[e.button] || 'left' }, mapPos(e)));
});

canvas.addEventListener('mouseup', (e) => {
  if (!control) return;
  send({ t: 'input', ev: 'mouseup', b: BTN[e.button] || 'left' });
});

canvas.addEventListener('wheel', (e) => {
  if (!control) return;
  e.preventDefault();
  send({ t: 'input', ev: 'wheel', d: e.deltaY });
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => {
  if (control) e.preventDefault();
});

canvas.addEventListener('keydown', (e) => {
  if (!control) return;
  e.preventDefault();
  send({
    t: 'input', ev: 'keydown',
    key: e.key, code: e.code,
    ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
  });
});

canvas.addEventListener('keyup', (e) => {
  if (!control) return;
  e.preventDefault();
  send({ t: 'input', ev: 'keyup', code: e.code });
});

/* ---------- controlos da interface ---------- */

$('#btn-connect').addEventListener('click', () => {
  const url = normalizeUrl($('#in-url').value);
  const token = $('#in-token').value.trim();
  if (!url || !token) { showLoginError('preenche o IP/endereço e o token'); return; }

  $('#in-url').value = url;
  if ($('#in-save').checked) {
    storageSet(LS_URL, url);
    storageSet(LS_TOKEN, token);
  } else {
    storageSet(LS_URL, '');
    storageSet(LS_TOKEN, '');
  }
  refreshAgentConfig();
  connect(url, token);
});

$('#in-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-connect').click();
});

$('#in-token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-connect').click();
});

$('#btn-disconnect').addEventListener('click', () => {
  if (ws) { ws.onclose = null; ws.close(); }
  resetToLogin(null);
});

/* trocar de PC remoto */
$('#sel-agent').addEventListener('change', () => {
  switchTarget($('#sel-agent').value);
});

$('#ctl-mode').addEventListener('change', () => {
  control = $('#ctl-mode').checked;
  canvas.classList.toggle('controlling', control);
  if (control) {
    canvas.focus();
    log('modo controlo ativado — clica no ecrã para ganhar foco do teclado');
  } else {
    log('modo controlo desativado');
  }
});

let cfgTimer = 0;
function pushCfg() {
  send({ t: 'cfg', fps: +$('#ctl-fps').value, quality: +$('#ctl-q').value });
}
function debounceCfg() {
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(pushCfg, 300);
}
$('#ctl-fps').addEventListener('input', debounceCfg);
$('#ctl-q').addEventListener('input', debounceCfg);

$('#btn-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else {
    const w = $('#screen-wrap');
    if (w.requestFullscreen) w.requestFullscreen();
  }
});

$('#btn-send-text').addEventListener('click', () => {
  const v = $('#send-text').value;
  if (!v) return;
  send({ t: 'text', s: v });
  log('texto enviado (' + v.length + ' caracteres)');
});

$('#send-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#btn-send-text').click();
  }
});

/* ---------- ciclos (ping + fps) ---------- */

setInterval(() => {
  if (ws && ws.readyState === 1) send({ t: 'ping', ts: performance.now() });
}, 2000);

setInterval(() => {
  $('#st-fps').textContent = frameCount + ' fps';
  frameCount = 0;
}, 1000);
