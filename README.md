# Controlo Remoto 💻🖱️⌨️

Sistema completo de controlo remoto de PC — ver e controlar o ecrã, rato e
teclado de um computador Windows a partir de qualquer browser.

Três peças:

| Peça | Onde corre | O que faz |
|---|---|---|
| `server/` | Qualquer máquina (Node.js) | Serve o painel web + retransmite por WebSocket |
| `agent/` | **O PC a controlar** (Windows) | Captura o ecrã e injeta rato/teclado |
| `web/` | No browser | Painel de visualização e controlo |

Zero dependências no agente; o servidor usa `express` e `ws`.

---

## Páginas servidas

| URL | O que é |
|---|---|
| `http://<ip>:8080/` | **Painel de Periféricos** — teste local de rato, teclado, comandos, HID, câmara e microfone |
| `http://<ip>:8080/remoto.html` | **Controlo Remoto** — ver e controlar outro PC (ou ser controlado) |

As duas páginas têm um link uma para a outra. Arranque rápido: duplo clique em
`start-tudo.bat` (abre servidor + agente).

> **WebHID, câmara e microfone** só funcionam em contexto seguro. Por omissão, apenas
> `https://` e `http://localhost` contam — um IP da LAN
> (`192.168.0.1`–`192.168.1.254`, ex.: `http://192.168.1.88:8080`) **não** é contexto
> seguro e o browser esconde essas APIs. Três saídas:
>
> 1. abrir o painel em `http://localhost:8080` na própria máquina;
> 2. pôr um proxy TLS (`https://`) à frente do servidor;
> 3. marcar o IP como seguro em
>    `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (Chrome/Edge; em rede
>    gerida, a política `OverrideSecurityRestrictionsOnInsecureOrigin`).
>
> A regra do IP não se altera no código: quem decide o que é "contexto seguro" é o browser.

---

## 1. Servidor

```bash
cd server
npm install
node server.js
```

No arranque mostra o endereço na rede e **gera um token automaticamente**
(fica guardado em `server/config.json`):

```
Painel web : http://192.168.1.10:8080
Token      : 3f9c1a...  ← copia isto
```

## 2. Agente (no PC a controlar)

1. Copia a pasta `agent/` para o PC (precisa de **Node.js 22+** e Windows).
2. Configura o agente — duas opções:
   - **Automático**: executa `configurar-agente.bat`, escreve o IP/endereço do
     servidor (ex.: `192.168.1.10:8080`) e o token. O `config.json` é gerado.
   - **Manual**: edita `agent/config.json`:

```json
{
  "server": "ws://192.168.1.10:8080/ws",
  "token": "O-TOKEN-QUE-O-SERVIDOR-MOSTROU",
  "name": "Meu-PC",
  "fps": 5,
  "quality": 60
}
```

3. Executa `start-agent.bat` (ou `node agent.js`).

O agente reconecta-se sozinho se a ligação cair.

## 3. Controlar

Abre `http://<ip-do-servidor>:8080` em qualquer browser da rede, escreve o
IP/endereço do servidor (basta `192.168.1.10` ou `192.168.1.10:8080`; o
`ws://…/ws` é completado automaticamente), cola o token, clica **Ligar**,
ativa **🎛️ Controlo** e clica no ecrã para ganhar foco do teclado. A partir
daí, o rato e o teclado atuam no PC remoto.

Ajusta **FPS** e **Qualidade** na barra para afinar fluidez/largura de banda.
O botão **⛶ Ecrã inteiro** dá vista completa.

### Vários PCs ao mesmo tempo

Podes ter **vários PCs ligados ao mesmo servidor** e escolher qual vês:

- A barra do controlo remoto tem um seletor (`#sel-agent`) com todos os PCs ligados
  e o respetivo IP; os que estão offline aparecem marcados.
- O cartão **PCs ligados** do painel lista as máquinas online e o botão
  **Controlar** abre `remoto.html?pc=<id>` já com esse PC escolhido.
- Cada agente recebe `stream on` **só quando alguém o está a ver** — os outros
  ficam em pausa, sem gastar CPU nem largura de banda.
- O id de cada PC é estável (`sha1(nome|ip)` primeiros 8 hex), por isso
  reconexões não criam duplicados.
- `GET /api/agents` devolve a lista (usada pelo painel):

```json
{ "agents": [ { "id": "bff5363f", "name": "DESKTOP-FSK7C12",
                "ip": "192.168.1.88", "online": true,
                "sys": { "w": 1366, "h": 768 } } ] }
```

## 4. Todos os dispositivos

O separador **🔍 Todos os dispositivos** do painel lista *todos* os dispositivos
Plug and Play da máquina que corre o servidor: USB, HID, áudio, vídeo, Bluetooth,
impressoras, ecrãs, controladores, baterias, etc. Tem pesquisa e filtro por classe.

É servido por `GET /api/devices` (cache de 30 s, `?refresh=1` força a leitura):

```json
{
  "generated": "2026-11-13T19:00:00.000Z",
  "host": "DESKTOP-XXXX",
  "total": 143,
  "classes": [{ "name": "USB", "count": 8 }],
  "devices": [
    { "id": "USB\\VID_058F&PID_3881\\...", "name": "PC Camera",
      "class": "Camera", "manufacturer": "...", "status": "OK", "bus": "USB" }
  ]
}
```

A leitura é feita localmente com `wmic` (sem dependências novas).

---

## Como funciona (por dentro)

```
[browser]  ←WebSocket(JSON+JPEG)→  [servidor]  ←WebSocket→  [agent (Node)]
                                                 ↓ stdin (JSON linha a linha)
                                            [worker.ps1 (PowerShell)]
                                                 ↓ P/Invoke user32.dll
                                    SetCursorPos · mouse_event · keybd_event
                                    SendInput(UNICODE) · CopyFromScreen (JPEG)
```

- Captura: `System.Drawing` copia o ecrã virtual (inclui vários monitores)
  e devolve JPEG em base64.
- Teclado: teclas normais são escritas por caractere unicode
  (`KEYEVENTF_UNICODE` → acentos e maiúsculas perfeitos); atalhos com
  Ctrl/Alt/Win usam códigos virtuais (VK) com a flag *extended* quando
  aplicável.
- Rato: posição mapeada das coordenadas do canvas para a resolução remota,
  com offset do ecrã virtual.

## Notas e limitações

- **Ctrl+Alt+Del** não pode ser enviado por software (mecanismo de
  segurança do Windows); alguns atalhos do browser (Ctrl+T, Ctrl+W) são
  reservados e não chegam ao PC remoto.
- O input é injetado na **sessão interativa** do utilizador com sessão
  iniciada — não funciona no ecrã de bloqueio/UAC.
- Agente apenas para **Windows** (o worker é PowerShell + .NET).

## Segurança ⚠️

- Autenticação por **token** — sem ele nada se liga.
- O tráfego `ws://` **não é cifrado** na LAN. Para acesso pela internet,
  usa uma VPN (Tailscale/WireGuard) ou um proxy TLS (`wss://` com
  Caddy/nginx).
- Usa **apenas em máquinas tuas**. Tal como o RustDesk/TeamViewer, esta
  ferramenta dá controlo total do PC onde corre o agente.

## Extras

- **Arranque automático**: cria um atalho para `start-agent.bat` na pasta
  `shell:startup`.
- **Compilar o agente em .exe** (opcional, dispensa o Node na máquina
  remota):
  ```bash
  npm i -g pkg
  pkg agent.js --output agent.exe
  ```
  (mantém `worker.ps1` ao lado do exe)
