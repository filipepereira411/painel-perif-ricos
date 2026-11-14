/* ============================================================
   Painel de Periféricos — leitura real de periféricos no browser
   Estrutura: index.html · css/style.css · js/app.js
   ============================================================ */
'use strict';

/* ---------- utilitários ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function toast(msg, kind = 'info') {
  const t = el('div', 'toast ' + kind, msg);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

function fmtDur(s) {
  if (!isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? h + ' h ' + m + ' min' : m + ' min';
}

function hex4(n) {
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}

function mediaErrText(err) {
  if (err.name === 'NotAllowedError') return 'permissão negada pelo utilizador';
  if (err.name === 'NotFoundError') return 'nenhum dispositivo encontrado';
  if (err.name === 'NotReadableError') return 'dispositivo ocupado (em uso por outra aplicação)';
  return err.message || err.name;
}

/* ---------- separadores ---------- */

function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    $$('.section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + btn.dataset.tab));
  });
}

/* ============================================================
   PAINEL — resumo do sistema
   ============================================================ */

async function refreshOverview() {
  const pads = navigator.getGamepads
    ? Array.from(navigator.getGamepads()).filter(Boolean)
    : [];
  $('#ov-gamepads').textContent = pads.length;

  let mediaCount = '—';
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try { mediaCount = (await navigator.mediaDevices.enumerateDevices()).length; } catch { /* ignora */ }
  }
  $('#ov-media').textContent = mediaCount;

  let hidCount = '—';
  if (navigator.hid && navigator.hid.getDevices) {
    try { hidCount = (await navigator.hid.getDevices()).length; } catch { /* ignora */ }
  }
  $('#ov-hid').textContent = hidCount;
}

async function initBattery() {
  const meter = $('#bat-meter');
  if (!navigator.getBattery) {
    $('#bat-level').textContent = 'API não suportada';
    $('#bat-charging').textContent = '—';
    return;
  }
  try {
    const bat = await navigator.getBattery();
    const update = () => {
      meter.style.width = Math.round(bat.level * 100) + '%';
      $('#bat-level').textContent = Math.round(bat.level * 100) + '%';
      $('#bat-charging').textContent = bat.charging ? '⚡ sim' : 'não';
      $('#bat-full').textContent = bat.charging ? fmtDur(bat.chargingTime) : '—';
      $('#bat-left').textContent = bat.charging ? '—' : fmtDur(bat.dischargingTime);
    };
    ['levelchange', 'chargingchange', 'chargingtimechange', 'dischargingtimechange']
      .forEach((ev) => bat.addEventListener(ev, update));
    update();
  } catch { /* ignora */ }
}

function fillStatic() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  $('#net-type').textContent = c.type || '—';
  $('#net-eff').textContent = c.effectiveType || '—';
  $('#net-down').textContent = c.downlink != null ? c.downlink + ' Mb/s' : '—';
  $('#net-rtt').textContent = c.rtt != null ? c.rtt + ' ms' : '—';
  $('#net-save').textContent = c.saveData != null ? (c.saveData ? 'ligada' : 'desligada') : '—';

  $('#scr-res').textContent = screen.width + ' × ' + screen.height;
  $('#scr-avail').textContent = screen.availWidth + ' × ' + screen.availHeight;
  $('#scr-depth').textContent = screen.colorDepth + ' bits';
  $('#scr-dpr').textContent = window.devicePixelRatio + '×';
  $('#scr-orient').textContent = (screen.orientation && screen.orientation.type) || '—';

  $('#sys-cores').textContent = navigator.hardwareConcurrency || '—';
  $('#sys-mem').textContent = navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '—';
  $('#sys-platform').textContent = navigator.platform || '—';
  $('#sys-ua').textContent = navigator.userAgent;
}

/* ============================================================
   RATO — área de teste com trilha, leituras e contadores
   ============================================================ */

const mouse = {
  trail: [],
  counters: { left: 0, middle: 0, right: 0, dbl: 0, wheelUp: 0, wheelDown: 0 },
};

function initMouse() {
  const pad = $('#mouse-pad');
  const cv = $('#mouse-canvas');
  const ctx = cv.getContext('2d');

  /* chips de botões (bitmask de e.buttons) */
  const chipsWrap = $('#m-buttons');
  const chips = {};
  [
    ['left', '◀ esq.'], ['right', 'dir. ▶'], ['middle', 'meio'],
    ['back', 'voltar'], ['forward', 'avançar'],
  ].forEach(([name, label]) => {
    const c = el('span', 'chip', label);
    chipsWrap.appendChild(c);
    chips[name] = c;
  });

  function setButtons(bits) {
    chips.left.classList.toggle('on', !!(bits & 1));
    chips.right.classList.toggle('on', !!(bits & 2));
    chips.middle.classList.toggle('on', !!(bits & 4));
    chips.back.classList.toggle('on', !!(bits & 8));
    chips.forward.classList.toggle('on', !!(bits & 16));
  }

  function renderCounters() {
    $('#m-c-left').textContent = mouse.counters.left;
    $('#m-c-middle').textContent = mouse.counters.middle;
    $('#m-c-right').textContent = mouse.counters.right;
    $('#m-c-dbl').textContent = mouse.counters.dbl;
    $('#m-c-wu').textContent = mouse.counters.wheelUp;
    $('#m-c-wd').textContent = mouse.counters.wheelDown;
  }

  pad.addEventListener('mousemove', (e) => {
    $('#m-pos').textContent = e.offsetX + ', ' + e.offsetY;
    $('#mouse-pad-label').textContent = e.offsetX + ', ' + e.offsetY;
    $('#m-client').textContent = e.clientX + ', ' + e.clientY;
    $('#m-screen').textContent = e.screenX + ', ' + e.screenY;
    $('#m-move').textContent = e.movementX + ', ' + e.movementY;
    mouse.trail.push({ x: e.offsetX, y: e.offsetY });
    if (mouse.trail.length > 90) mouse.trail.shift();
    setButtons(e.buttons);
  });

  pad.addEventListener('mouseleave', () => {
    mouse.trail.length = 0;
    setButtons(0);
  });

  pad.addEventListener('mousedown', (e) => {
    if (e.button === 0) mouse.counters.left++;
    if (e.button === 1) mouse.counters.middle++;
    if (e.button === 2) mouse.counters.right++;
    setButtons(e.buttons);
    renderCounters();
  });

  pad.addEventListener('mouseup', (e) => setButtons(e.buttons));
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  pad.addEventListener('dblclick', () => { mouse.counters.dbl++; renderCounters(); });

  pad.addEventListener('wheel', (e) => {
    e.preventDefault();
    $('#m-wheel').textContent = e.deltaY + (e.deltaMode === 1 ? ' (linhas)' : ' (px)');
    if (e.deltaY < 0) mouse.counters.wheelUp++;
    else mouse.counters.wheelDown++;
    renderCounters();
  }, { passive: false });

  $('#m-reset').addEventListener('click', () => {
    mouse.counters = { left: 0, middle: 0, right: 0, dbl: 0, wheelUp: 0, wheelDown: 0 };
    renderCounters();
  });

  renderCounters();

  /* loop de desenho da trilha */
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = pad.clientWidth;
    const h = pad.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pts = mouse.trail;
    if (pts.length > 1) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      for (let i = 1; i < pts.length; i++) {
        const a = i / pts.length;
        ctx.strokeStyle = 'rgba(34, 211, 238, ' + (0.12 + 0.75 * a) + ')';
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      const p = pts[pts.length - 1];
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

/* ============================================================
   TECLADO — mapa por posição física (event.code)
   ============================================================ */

const KB_ROWS = [
  ['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'],
  ['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace'],
  ['Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Backslash'],
  ['CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Enter'],
  ['ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash', 'ShiftRight'],
  ['ControlLeft', 'MetaLeft', 'AltLeft', 'Space', 'AltRight', 'MetaRight', 'ContextMenu', 'ControlRight'],
  ['Insert', 'Home', 'PageUp', 'Delete', 'End', 'PageDown'],
  ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'],
];

const KB_LABELS = {
  Escape: 'Esc', Backquote: '` ~', Minus: '- _', Equal: '= +', Backspace: '⌫',
  Tab: 'Tab ⇥', CapsLock: 'Caps', Enter: 'Enter ⏎', Backslash: '\\ |',
  BracketLeft: '[ {', BracketRight: '] }', Semicolon: '; :', Quote: "' \"",
  Comma: ', <', Period: '. >', Slash: '/ ?',
  ShiftLeft: 'Shift', ShiftRight: 'Shift',
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  MetaLeft: 'Win', MetaRight: 'Win',
  AltLeft: 'Alt', AltRight: 'Alt',
  ContextMenu: '≡', Space: '',
  Insert: 'Ins', Delete: 'Del', PageUp: 'Pg↑', PageDown: 'Pg↓',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

const KB_WIDE = new Set(['Backspace', 'Tab', 'CapsLock', 'Enter', 'ShiftLeft', 'ShiftRight']);
const KB_FN = new Set(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);

function keyLabel(code) {
  if (code === 'Space') return '';
  if (KB_LABELS[code]) return KB_LABELS[code];
  return code.replace(/^Digit/, '').replace(/^Key/, '');
}

function initKeyboard() {
  const kb = $('#keyboard');

  for (const row of KB_ROWS) {
    const rowEl = el('div', 'kb-row');
    for (const code of row) {
      const k = el('div', 'key' + (code === 'Space' ? ' space' : ''), keyLabel(code));
      if (KB_WIDE.has(code)) k.classList.add('wide');
      if (KB_FN.has(code)) k.classList.add('fn');
      k.dataset.code = code;
      k.title = code;
      rowEl.appendChild(k);
    }
    kb.appendChild(rowEl);
  }

  function setMods(e) {
    $('#k-ctrl').classList.toggle('on', e.ctrlKey);
    $('#k-shift').classList.toggle('on', e.shiftKey);
    $('#k-alt').classList.toggle('on', e.altKey);
    $('#k-meta').classList.toggle('on', e.metaKey);
  }

  function findKey(code) {
    return kb.querySelector('[data-code="' + CSS.escape(code) + '"]');
  }

  window.addEventListener('keydown', (e) => {
    if ($('#k-capture').checked) e.preventDefault();
    const k = findKey(e.code);
    if (k) k.classList.add('down');
    if (!e.repeat) {
      $('#k-key').textContent = e.key;
      $('#k-code').textContent = e.code;
      $('#k-which').textContent = e.keyCode || '—';
    }
    setMods(e);
  });

  window.addEventListener('keyup', (e) => {
    const k = findKey(e.code);
    if (k) k.classList.remove('down');
    setMods(e);
  });

  /* limpar teclas presas ao mudar de janela (ex.: Alt+Tab) */
  window.addEventListener('blur', () => {
    $$('.key.down', kb).forEach((k) => k.classList.remove('down'));
    ['k-ctrl', 'k-shift', 'k-alt', 'k-meta'].forEach((id) => $('#' + id).classList.remove('on'));
  });
}

/* ============================================================
   COMANDOS (Gamepad API)
   ============================================================ */

const GP_BTN_NAMES = [
  'A/Cruz', 'B/Círc.', 'X/Quad.', 'Y/Triâng.',
  'LB', 'RB', 'LT', 'RT',
  'Back', 'Start', 'LS', 'RS',
  'D↑', 'D↓', 'D←', 'D→',
];

const gpRefs = new Map(); /* index -> { btnEls, bars, knobA, knobB } */

function buildGamepadCard(gp) {
  const card = el('div', 'card gp-card');

  const head = el('div', 'card-head');
  head.appendChild(el('span', 'gp-idx', '#' + gp.index));
  head.appendChild(el('span', 'gp-name', gp.id || 'Comando'));
  head.appendChild(el('span', 'chip', gp.mapping === 'standard' ? 'standard' : 'não standard'));
  card.appendChild(head);

  const body = el('div', 'gp-body');
  const left = el('div', 'gp-left');

  /* analógicos */
  let knobA = null;
  let knobB = null;
  const sticks = el('div', 'sticks');
  if (gp.axes.length >= 2) {
    const s1 = el('div', 'stick');
    knobA = el('div', 'knob');
    s1.appendChild(knobA);
    sticks.appendChild(s1);
  }
  if (gp.axes.length >= 4) {
    const s2 = el('div', 'stick');
    knobB = el('div', 'knob');
    s2.appendChild(knobB);
    sticks.appendChild(s2);
  }
  if (knobA) left.appendChild(sticks);

  /* barras dos eixos */
  const axesWrap = el('div', 'axes');
  const bars = [];
  gp.axes.forEach((_, i) => {
    const row = el('div', 'axis-row');
    row.appendChild(el('span', 'axis-label', 'Eixo ' + i));
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = '0%';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'axis-val', '0.00'));
    axesWrap.appendChild(row);
    bars.push({ fill, val: row.lastChild });
  });
  left.appendChild(axesWrap);
  body.appendChild(left);

  /* botões */
  const btns = el('div', 'gp-btns');
  const btnEls = [];
  gp.buttons.forEach((_, i) => {
    const chip = el('div', 'gbtn');
    chip.appendChild(el('span', 'gbtn-idx', i));
    if (GP_BTN_NAMES[i]) chip.appendChild(el('span', 'gbtn-name', GP_BTN_NAMES[i]));
    chip.title = 'Botão ' + i;
    btns.appendChild(chip);
    btnEls.push(chip);
  });
  body.appendChild(btns);
  card.appendChild(body);

  const foot = el('div', 'card-foot');
  const vib = el('button', 'btn', '📳 Testar vibração');
  vib.addEventListener('click', () => vibrate(gp.index));
  foot.appendChild(vib);
  foot.appendChild(el('span', 'hint', gp.buttons.length + ' botões · ' + gp.axes.length + ' eixos'));
  card.appendChild(foot);

  gpRefs.set(gp.index, { btnEls, bars, knobA, knobB });
  return card;
}

async function vibrate(index) {
  const gp = navigator.getGamepads ? navigator.getGamepads()[index] : null;
  const act = gp && gp.vibrationActuator;
  if (!act || typeof act.playEffect !== 'function') {
    toast('Este comando não suporta vibração.', 'warn');
    return;
  }
  try {
    await act.playEffect('dual-rumble', {
      duration: 700,
      strongMagnitude: 1.0,
      weakMagnitude: 1.0,
    });
  } catch (err) {
    toast('Erro na vibração: ' + err.message, 'bad');
  }
}

function rebuildGamepads() {
  const list = $('#gamepad-list');
  list.innerHTML = '';
  gpRefs.clear();

  const pads = navigator.getGamepads
    ? Array.from(navigator.getGamepads()).filter(Boolean)
    : [];
  $('#gamepad-empty').hidden = pads.length > 0;
  pads.forEach((gp) => list.appendChild(buildGamepadCard(gp)));
  refreshOverview();
}

function initGamepads() {
  window.addEventListener('gamepadconnected', rebuildGamepads);
  window.addEventListener('gamepaddisconnected', rebuildGamepads);
  rebuildGamepads();

  function gpLoop() {
    if (navigator.getGamepads) {
      for (const gp of Array.from(navigator.getGamepads())) {
        if (!gp) continue;
        const r = gpRefs.get(gp.index);
        if (!r) { rebuildGamepads(); continue; }

        gp.buttons.forEach((b, i) => {
          const chip = r.btnEls[i];
          if (!chip) return;
          chip.classList.toggle('down', b.pressed);
        });

        gp.axes.forEach((v, i) => {
          const b = r.bars[i];
          if (!b) return;
          b.fill.style.width = Math.min(1, Math.abs(v)) * 100 + '%';
          b.val.textContent = v.toFixed(2);
        });

        if (r.knobA && gp.axes.length >= 2) {
          r.knobA.style.left = ((gp.axes[0] + 1) / 2 * 100) + '%';
          r.knobA.style.top = ((gp.axes[1] + 1) / 2 * 100) + '%';
        }
        if (r.knobB && gp.axes.length >= 4) {
          r.knobB.style.left = ((gp.axes[2] + 1) / 2 * 100) + '%';
          r.knobB.style.top = ((gp.axes[3] + 1) / 2 * 100) + '%';
        }
      }
    }
    requestAnimationFrame(gpLoop);
  }
  requestAnimationFrame(gpLoop);
}

/* ============================================================
   WEBHID
   ============================================================ */

const hidReportCount = new Map();

function initHid() {
  if (!window.isSecureContext) {
    const box = $('#hid-unsupported');
    box.textContent = 'O WebHID só funciona em contexto seguro. Abre o painel em https:// ou em ' +
      'http://localhost — por um IP LAN (192.168.0.1–192.168.1.254) o browser esconde esta API. ' +
      'Para usar nesse endereço, marca-o como seguro em ' +
      'chrome://flags/#unsafely-treat-insecure-origin-as-secure.';
    box.hidden = false;
    $('#hid-request').disabled = true;
    return;
  }

  if (!navigator.hid || !navigator.hid.requestDevice) {
    $('#hid-unsupported').textContent =
      'Este browser não tem WebHID. Usa Chrome ou Edge no desktop (Safari e browsers móveis não suportam).';
    $('#hid-unsupported').hidden = false;
    $('#hid-request').disabled = true;
    return;
  }

  navigator.hid.addEventListener('connect', () => renderHid());
  navigator.hid.addEventListener('disconnect', () => renderHid());

  $('#hid-request').addEventListener('click', async () => {
    try {
      const devs = await navigator.hid.requestDevice({ filters: [] });
      if (!devs.length) toast('Nenhum dispositivo selecionado.');
      await renderHid();
    } catch (err) {
      toast('Seletor indisponível: ' + err.message, 'bad');
    }
  });

  $('#hid-clear').addEventListener('click', () => { $('#hid-log').innerHTML = ''; });
  renderHid();
}

async function renderHid() {
  const wrap = $('#hid-list');
  wrap.innerHTML = '';

  let devs = [];
  try { devs = await navigator.hid.getDevices(); } catch { /* ignora */ }
  $('#hid-empty').hidden = devs.length > 0;

  for (const dev of devs) {
    const card = el('div', 'hid-device');
    const dot = el('span', 'dot' + (dev.opened ? ' on' : ''));
    card.appendChild(dot);
    card.appendChild(el('span', 'hid-name', dev.productName || 'Dispositivo HID'));
    card.appendChild(el('span', 'hid-ids', 'VID ' + hex4(dev.vendorId) + ' · PID ' + hex4(dev.productId)));
    const stats = el('span', 'hid-count', (hidReportCount.get(dev) || 0) + ' relatórios');
    card.appendChild(stats);
    wrap.appendChild(card);

    if (!dev.opened) {
      try {
        await dev.open();
        dot.classList.add('on');
      } catch (err) {
        toast('Não foi possível abrir "' + (dev.productName || 'dispositivo') + '": ' + err.message, 'warn');
      }
    }

    dev.oninputreport = (e) => {
      const bytes = Array.from(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
      const n = (hidReportCount.get(dev) || 0) + 1;
      hidReportCount.set(dev, n);
      stats.textContent = n + ' relatórios';
      addHidLog(dev, e.reportId, bytes);
    };
  }
  refreshOverview();
}

function addHidLog(dev, reportId, bytes) {
  const log = $('#hid-log');
  const line = el('div', 'log-line');
  const time = new Date().toLocaleTimeString('pt-PT');
  const shown = bytes.slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
  const more = bytes.length > 16 ? ' … (+' + (bytes.length - 16) + ')' : '';
  line.textContent = '[' + time + '] ' + (dev.productName || 'HID') +
    ' · report ' + reportId + ' · ' + bytes.length + ' B: ' + shown + more;
  log.prepend(line);
  while (log.children.length > 80) log.lastChild.remove();
}

/* ============================================================
   CÂMARA E MICROFONE
   ============================================================ */

let camStream = null;
let micStream = null;
let micCtx = null;
let analyser = null;
let micBuf = null;
let micRaf = 0;

function initMedia() {
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!supported) {
    $('#media-list').textContent = window.isSecureContext
      ? 'Este browser não expõe a API de câmara/microfone — usa Chrome ou Edge no desktop.'
      : 'Câmara e microfone só funcionam em contexto seguro: usa https:// ou http://localhost. Por um ' +
        'IP LAN (192.168.0.1–192.168.1.254) o browser bloqueia o acesso; marca esse endereço como ' +
        'seguro em chrome://flags/#unsafely-treat-insecure-origin-as-secure ou usa HTTPS.';
    $('#cam-start').disabled = true;
    $('#mic-start').disabled = true;
    $('#media-refresh').disabled = true;
    return;
  }

  $('#media-refresh').addEventListener('click', refreshMediaDevices);
  $('#cam-start').addEventListener('click', startCam);
  $('#cam-stop').addEventListener('click', stopCam);
  $('#mic-start').addEventListener('click', startMic);
  $('#mic-stop').addEventListener('click', stopMic);

  refreshMediaDevices();
}

async function refreshMediaDevices() {
  const list = $('#media-list');
  list.innerHTML = '';

  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* ignora */ }

  const groups = [
    ['videoinput', '📷 Câmaras'],
    ['audioinput', '🎤 Microfones'],
    ['audiooutput', '🔊 Saídas de áudio'],
  ];

  const camSel = $('#cam-select');
  const micSel = $('#mic-select');
  camSel.innerHTML = '';
  micSel.innerHTML = '';

  for (const [kind, title] of groups) {
    const ofKind = devs.filter((d) => d.kind === kind);
    list.appendChild(el('div', 'media-group-title', title + ' (' + ofKind.length + ')'));
    if (!ofKind.length) list.appendChild(el('div', 'hint', 'nenhum detetado'));

    ofKind.forEach((d) => {
      const row = el('div', 'media-item');
      row.appendChild(el('span', 'media-name', d.label || 'Sem nome (concede permissão para o revelar)'));
      list.appendChild(row);
      if (kind === 'videoinput') {
        camSel.appendChild(new Option(d.label || 'Câmara ' + (camSel.length + 1), d.deviceId));
      }
      if (kind === 'audioinput') {
        micSel.appendChild(new Option(d.label || 'Microfone ' + (micSel.length + 1), d.deviceId));
      }
    });
  }
  refreshOverview();
}

async function startCam() {
  stopCam();
  const id = $('#cam-select').value;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: id ? { deviceId: { exact: id } } : true,
      audio: false,
    });
    const video = $('#cam-video');
    video.srcObject = camStream;
    await video.play().catch(() => { /* autoplay bloqueado não é problema com muted */ });
    toast('Câmara ligada.', 'good');
    refreshMediaDevices();
  } catch (err) {
    toast('Erro na câmara: ' + mediaErrText(err), 'bad');
  }
}

function stopCam() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  $('#cam-video').srcObject = null;
}

async function startMic() {
  stopMic();
  const id = $('#mic-select').value;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: id ? { deviceId: { exact: id } } : true,
    });
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = micCtx.createMediaStreamSource(micStream);
    analyser = micCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    micBuf = new Float32Array(analyser.fftSize);
    micLoop();
    toast('Microfone ligado.', 'good');
    refreshMediaDevices();
  } catch (err) {
    toast('Erro no microfone: ' + mediaErrText(err), 'bad');
  }
}

function stopMic() {
  cancelAnimationFrame(micRaf);
  if (analyser) { analyser = null; micBuf = null; }
  if (micCtx) { micCtx.close().catch(() => {}); micCtx = null; }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  $('#mic-meter').style.width = '0%';
  $('#mic-level').textContent = '0%';
}

function micLoop() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(micBuf);
  let sum = 0;
  for (let i = 0; i < micBuf.length; i++) sum += micBuf[i] * micBuf[i];
  const rms = Math.sqrt(sum / micBuf.length);
  const pct = Math.min(100, Math.round(rms * 300));
  $('#mic-meter').style.width = pct + '%';
  $('#mic-level').textContent = pct + '%';
  micRaf = requestAnimationFrame(micLoop);
}

/* ============================================================
   TODOS OS DISPOSITIVOS — inventário PnP via servidor (/api/devices)
   ============================================================ */

let devAll = [];
let devClasses = [];
let devLoaded = false;

async function loadDevices(force) {
  const list = $('#dev-list');
  $('#dev-count').textContent = 'a ler dispositivos…';

  try {
    const r = await fetch('/api/devices' + (force ? '?refresh=1' : ''), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    devAll = Array.isArray(data.devices) ? data.devices : [];
    devClasses = Array.isArray(data.classes) ? data.classes : [];

    fillClassSelect();
    renderDevices();
    $('#ov-dev').textContent = data.total != null ? data.total : devAll.length;
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el('p', 'hint',
      'Não foi possível ler a lista (' + err.message + '). Esta lista é servida por server.js — ' +
      'abre o painel através do servidor, não como ficheiro local.'));
    $('#dev-count').textContent = '—';
    $('#ov-dev').textContent = '—';
  }
}

function fillClassSelect() {
  const sel = $('#dev-class');
  const current = sel.value;
  sel.innerHTML = '';

  const all = el('option', null, 'Todas as classes (' + devAll.length + ')');
  all.value = '';
  sel.appendChild(all);

  for (const c of devClasses) {
    const o = el('option', null, c.name + ' (' + c.count + ')');
    o.value = c.name;
    sel.appendChild(o);
  }
  sel.value = devClasses.some((c) => c.name === current) ? current : '';
}

function renderDevices() {
  const list = $('#dev-list');
  const q = ($('#dev-search').value || '').trim().toLowerCase();
  const cls = $('#dev-class').value;

  const items = devAll.filter((d) => {
    if (cls && d.class !== cls) return false;
    if (!q) return true;
    return (d.name + ' ' + d.manufacturer + ' ' + d.class + ' ' + d.bus + ' ' + d.id)
      .toLowerCase().includes(q);
  });

  $('#dev-count').textContent = items.length + ' de ' + devAll.length + ' dispositivos';
  list.innerHTML = '';

  if (!items.length) {
    list.appendChild(el('p', 'hint', devAll.length
      ? 'Nenhum dispositivo corresponde ao filtro.'
      : 'Nenhum dispositivo encontrado.'));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const d of items) {
    const row = el('div', 'dev-item');

    const main = el('div', 'dev-main');
    main.appendChild(el('strong', null, d.name));
    main.appendChild(el('div', 'dev-meta mono', [d.class, d.bus, d.status].filter(Boolean).join(' · ')));
    if (d.manufacturer) main.appendChild(el('div', 'dev-man', d.manufacturer));

    row.appendChild(main);
    if (d.id) row.appendChild(el('code', 'dev-id mono', d.id));
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

function initDevices() {
  $('#dev-search').addEventListener('input', renderDevices);
  $('#dev-class').addEventListener('change', renderDevices);
  $('#dev-refresh').addEventListener('click', () => loadDevices(true));

  /* só lê quando o separador é aberto pela primeira vez */
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn && btn.dataset.tab === 'dispositivos' && !devLoaded) {
      devLoaded = true;
      loadDevices();
    }
  });
}

/* ============================================================
   PCs ligados — quem está disponível para controlo remoto (/api/agents)
   ============================================================ */

async function loadPcs() {
  const list = $('#pc-list');
  list.innerHTML = '';
  list.appendChild(el('p', 'hint', 'a procurar PCs…'));

  try {
    const r = await fetch('/api/agents', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const pcs = Array.isArray(data.agents) ? data.agents.filter((a) => a.online) : [];

    list.innerHTML = '';
    if (!pcs.length) {
      list.appendChild(el('p', 'hint',
        'Nenhum PC ligado. Corre o agente (agent\\start-agent.bat) na máquina que queres controlar.'));
      return;
    }

    for (const pc of pcs) {
      const row = el('div', 'pc-item');
      const main = el('div', 'pc-main');
      main.appendChild(el('strong', null, pc.name || pc.id));
      main.appendChild(el('div', 'pc-meta mono',
        [pc.ip, pc.sys ? pc.sys.w + '×' + pc.sys.h : null].filter(Boolean).join(' · ')));
      row.appendChild(main);

      const a = el('a', 'btn btn-sm', 'Controlar');
      a.href = 'remoto.html?pc=' + encodeURIComponent(pc.id);
      row.appendChild(a);
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el('p', 'hint', 'Não foi possível ler a lista (' + err.message + ').'));
  }
}

/* ---------- arranque ---------- */

initTabs();
fillStatic();
initBattery();
$('#ov-refresh').addEventListener('click', refreshOverview);
$('#pc-refresh').addEventListener('click', loadPcs);
initMouse();
initKeyboard();
initGamepads();
initHid();
initMedia();
initDevices();
refreshOverview();
loadPcs();
setInterval(loadPcs, 15000);
