'use strict';

/* ============================================================
   Servidor de Controlo Remoto
   - Serve o painel web (../web)
   - WebSocket em /ws: agentes enviam frames, clientes vêem e controlam
   - Autenticação por token (gerado automaticamente em config.json)
   ============================================================ */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = {};
try {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
  config = JSON.parse(raw);
} catch {
  config = {};
}

if (!config.token) {
  config.token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('Token gerado e guardado em server/config.json');
}

const PORT = Number(process.env.PORT || config.port || 8080);
const BIND = process.env.BIND || config.bind || '0.0.0.0';
const TOKEN = config.token;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'web')));

/* IPs da rede local, para o painel gerar o config.json do agente */
app.get('/api/net', (req, res) => {
  res.json({ port: PORT, addresses: lanAddresses() });
});

/* ============================================================
   Inventário de dispositivos da máquina (Windows / WMI)
   - wmic devolve CSV em inglês; forçamos a consola a UTF-8 para os acentos
   - cache de 30 s (?refresh=1 ignora a cache)
   ============================================================ */

let devCache = { at: 0, data: null };

function wmic(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'cmd.exe',
      ['/c', 'chcp 65001>nul && wmic ' + args],
      { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(stdout.toString('utf8'));
      }
    );
  });
}

/* CSV do wmic: campos com vírgulas vêm entre aspas */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const BUS_NAMES = {
  USB: 'USB', USBSTOR: 'USB (armazenamento)', HID: 'HID', PCI: 'PCI', ACPI: 'ACPI',
  BTHENUM: 'Bluetooth', BTHLEDEVICE: 'Bluetooth LE', SWD: 'Software', ROOT: 'Raiz',
  DISPLAY: 'Ecrã', MONITOR: 'Monitor', PRINTQUEUE: 'Impressora', SCSI: 'SCSI',
  STORAGE: 'Armazenamento', INTELAUDIO: 'Áudio', MMDEVAPI: 'Áudio', SW: 'Software',
};

function busOf(id) {
  const prefix = String(id || '').split('\\')[0].toUpperCase();
  return BUS_NAMES[prefix] || prefix || '—';
}

/* o wmic escapa entidades XML nos campos (& → &amp;) */
function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

async function listDevices() {
  const text = await wmic('path Win32_PnPEntity get DeviceID,Manufacturer,Name,PNPClass,Status /format:csv');
  const rows = parseCsv(text).filter((r) => r.some((v) => v.trim() !== ''));
  if (rows.length < 2) return [];

  const head = rows[0].map((h) => h.trim());
  const col = (k) => head.indexOf(k);
  const iId = col('DeviceID');
  const iName = col('Name');
  const iCls = col('PNPClass');
  const iMan = col('Manufacturer');
  const iSt = col('Status');

  const out = [];
  for (const r of rows.slice(1)) {
    const id = unescapeXml(r[iId]).trim();
    const name = unescapeXml(r[iName]).trim();
    if (!id && !name) continue;
    if (/^Node$/i.test(name)) continue;
    out.push({
      id,
      name: name || '(sem nome)',
      class: unescapeXml(r[iCls]).trim() || 'Sem classe',
      manufacturer: unescapeXml(r[iMan]).trim(),
      status: unescapeXml(r[iSt]).trim() || '—',
      bus: busOf(id),
    });
  }

  out.sort((a, b) => a.class.localeCompare(b.class, 'pt') || a.name.localeCompare(b.name, 'pt'));
  return out;
}

app.get('/api/devices', async (req, res) => {
  const force = req.query.refresh === '1';
  if (!force && devCache.data && Date.now() - devCache.at < 30000) {
    return res.json(devCache.data);
  }

  try {
    const devices = await listDevices();
    const counts = new Map();
    for (const d of devices) counts.set(d.class, (counts.get(d.class) || 0) + 1);

    const data = {
      generated: new Date().toISOString(),
      host: os.hostname(),
      total: devices.length,
      classes: Array.from(counts, ([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt')),
      devices,
    };

    devCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Não foi possível listar os dispositivos: ' + err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/* erros de rede: porta ocupada, sem permissões, etc. */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está ocupada — o servidor já deve estar a correr.`);
    console.error(`Abre http://localhost:${PORT} (ou /remoto.html) em vez de arrancar outro.`);
    console.error('Para parar o que está a ocupar a porta: Get-Process node | Stop-Process -Force');
  } else if (err.code === 'EACCES') {
    console.error(`Sem permissão para usar a porta ${PORT}. Tenta outra: set PORT=8081 && node server.js`);
  } else {
    console.error('Erro no servidor: ' + err.message);
  }
  process.exit(1);
});
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') return; /* já tratado acima */
  console.error('Erro no WebSocket: ' + err.message);
});

const clients = new Set();
const agents = new Map();          // id -> { id, ws, name, ip, sys, host }
const lastCfgByAgent = new Map();  // id -> { t:'cfg', fps, quality }

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  for (const client of clients) send(client, obj);
}

/* id estável por PC (nome + IP): reconexões do mesmo agente reutilizam o id */
function agentIdFor(name, ip) {
  return crypto.createHash('sha1').update(name + '|' + ip).digest('hex').slice(0, 8);
}

function agentIsOnline(a) {
  return !!(a && a.ws.readyState === WebSocket.OPEN);
}

function agentsList() {
  return Array.from(agents.values()).map((a) => ({
    id: a.id,
    name: a.name,
    ip: a.ip,
    online: agentIsOnline(a),
    sys: a.sys,
    host: a.host,
  }));
}

/* lista de PCs ligados, para o painel mostrar quem está disponível */
app.get('/api/agents', (req, res) => {
  res.json({ agents: agentsList() });
});

function broadcastAgents() {
  broadcast({ t: 'agents', list: agentsList() });
}

/* mensagens só para os clientes que estão a ver este agente */
function sendToTarget(id, obj) {
  for (const client of clients) if (client.target === id) send(client, obj);
}

function agentState(a) {
  return {
    t: 'agent',
    id: a ? a.id : null,
    online: agentIsOnline(a),
    name: a ? a.name : null,
    sys: a ? a.sys : null,
    host: a ? a.host : null,
  };
}

/* o agente só captura quando há alguém a vê-lo */
function notifyStream(a) {
  if (!agentIsOnline(a)) return;
  let needed = false;
  for (const client of clients) {
    if (client.target === a.id) { needed = true; break; }
  }
  send(a.ws, { t: 'stream', on: needed });
}

/* escolher o PC que este cliente está a ver */
function selectTarget(ws, id) {
  const prev = agents.get(ws.target);
  ws.target = id && agents.has(id) ? id : null;
  if (prev) notifyStream(prev);

  const a = agents.get(ws.target);
  if (!a) {
    send(ws, { t: 'selected', id: null });
    send(ws, agentState(null));
    return;
  }

  notifyStream(a);
  send(ws, { t: 'selected', id: a.id });
  send(ws, agentState(a));
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = null;
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    /* frames do agente chegam como binário (JPEG) e são retransmitidos
       apenas para os clientes que escolheram esse agente */
    if (isBinary) {
      if (ws.role !== 'agent') return;
      for (const client of clients) {
        if (client.target === ws.agentId && client.readyState === WebSocket.OPEN) client.send(data);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    /* ---------- autenticação ---------- */
    if (msg.t === 'hello') {
      if (msg.token !== TOKEN) {
        send(ws, { t: 'hello', ok: false, error: 'token inválido' });
        ws.close();
        return;
      }

      if (msg.role === 'agent') {
        const name = String(msg.name || ip);
        const id = agentIdFor(name, ip);

        const prev = agents.get(id);
        if (prev && prev.ws !== ws) {
          try { prev.ws.close(); } catch { /* ignora */ }
        }

        ws.role = 'agent';
        ws.agentId = id;

        const rec = { id, ws, name, ip, sys: null, host: msg.host || null };
        agents.set(id, rec);

        send(ws, { t: 'hello', ok: true, id, name });
        const cfg = lastCfgByAgent.get(id);
        if (cfg) send(ws, cfg);

        broadcastAgents();
        notifyStream(rec);
        console.log(`[+] Agente ligado: ${name} (${ip}) id=${id}`);
        return;
      }

      ws.role = 'client';
      clients.add(ws);
      send(ws, { t: 'hello', ok: true });
      send(ws, { t: 'agents', list: agentsList() });

      /* se só há um PC ligado, escolhe-o automaticamente */
      const online = Array.from(agents.values()).filter(agentIsOnline);
      if (online.length === 1) selectTarget(ws, online[0].id);
      else send(ws, agentState(null));

      console.log(`[+] Cliente ligado: ${ip}`);
      return;
    }

    if (!ws.role) return; /* ainda não autenticado */

    /* ---------- mensagens do agente ---------- */
    if (ws.role === 'agent') {
      const rec = agents.get(ws.agentId);
      if (!rec) return;

      if (msg.t === 'sys') {
        rec.sys = msg.sys || null;
        if (msg.host) rec.host = msg.host;
        sendToTarget(rec.id, { t: 'sys', sys: rec.sys });
        broadcastAgents(); /* nome/ecrã atualizados na lista de todos */
      } else if (msg.t === 'stats') {
        sendToTarget(rec.id, msg);
      }
      return;
    }

    /* ---------- mensagens do cliente ---------- */
    if (msg.t === 'ping') {
      send(ws, { t: 'pong', ts: msg.ts });
      return;
    }

    if (msg.t === 'select') {
      selectTarget(ws, String(msg.id || ''));
      return;
    }

    if (msg.t === 'agents') {
      send(ws, { t: 'agents', list: agentsList() });
      return;
    }

    const target = agents.get(ws.target);
    if (!target || !agentIsOnline(target)) return;

    if (msg.t === 'cfg') {
      lastCfgByAgent.set(target.id, { t: 'cfg', fps: msg.fps, quality: msg.quality });
    }
    send(target.ws, msg);
  });

  ws.on('close', () => {
    if (clients.delete(ws)) {
      console.log(`[-] Cliente desligado: ${ip}`);
      if (ws.target) notifyStream(agents.get(ws.target));
      return;
    }

    if (ws.role === 'agent' && ws.agentId) {
      const rec = agents.get(ws.agentId);
      if (rec && rec.ws === ws) {
        console.log(`[-] Agente desligado: ${rec.name}`);
        agents.delete(ws.agentId);
        broadcastAgents();
        sendToTarget(ws.agentId, { t: 'agent', online: false, name: rec.name, sys: null, host: null });
      }
    }
  });

  ws.on('error', () => { /* o close segue-se */ });
});

/* heartbeat: deteta ligações mortas */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignora */ }
  }
}, 30000);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, BIND, () => {
  console.log('Servidor de controlo remoto ativo');
  console.log(`  Local : http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  Rede  : http://${ip}:${PORT}`);
  }
  console.log(`  Token : ${TOKEN}`);
});
