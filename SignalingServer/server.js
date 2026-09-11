const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

const PORT = process.env.PORT || 8765;

const WEB_ROOT = path.resolve(__dirname, 'WebViewer');

// sessionId -> { producer: ws|null, viewers: Set<ws> }
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      producer: null,
      viewers: new Set()
    });
  }

  return sessions.get(sessionId);
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({
          iface: name,
          address: net.address
        });
      }
    }
  }

  return results;
}

// ============================================================
// HTTP SERVER — serves WebViewer
// ============================================================

const httpServer = http.createServer((req, res) => {
  let requestPath = req.url.split('?')[0];

  // Browser opens "/" or "/view"
  if (requestPath === '/' || requestPath === '/view') {
    requestPath = '/index.html';
  }

  // Prevent path traversal
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');

  const filePath = path.join(WEB_ROOT, safePath);

  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain'
      });

      res.end('Web Viewer file not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });

    res.end(data);
  });
});

// ============================================================
// WEBSOCKET SERVER — signaling
// ============================================================

const wss = new WebSocket.Server({
  server: httpServer
});

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.role = null;
  ws.sessionId = null;

  console.log(`[+] client connected: ${ws.id}`);

  ws.on('message', (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.warn(`[!] invalid JSON from ${ws.id}`);
      return;
    }

    const {
      type,
      sessionId
    } = msg;

    if (!sessionId && type !== 'ping') {
      safeSend(ws, {
        type: 'error',
        message: 'sessionId is required'
      });

      return;
    }

    switch (type) {

      // ======================================================
      // REGISTER
      // ======================================================

      case 'register': {
        const session = getSession(sessionId);

        ws.sessionId = sessionId;
        ws.role = msg.role;

        if (msg.role === 'producer') {

          if (session.producer && session.producer !== ws) {
            console.log(
              `[i] replacing existing producer for session ${sessionId}`
            );
          }

          session.producer = ws;

          console.log(
            `[i] ${ws.id} registered as PRODUCER for session "${sessionId}"`
          );

          // Existing viewers
          session.viewers.forEach((viewer) => {

            safeSend(viewer, {
              type: 'producer-available',
              sessionId
            });

            safeSend(ws, {
              type: 'viewer-joined',
              sessionId,
              viewerId: viewer.id
            });

          });

        } else if (msg.role === 'viewer') {

          session.viewers.add(ws);

          console.log(
            `[i] ${ws.id} registered as VIEWER for session "${sessionId}"`
          );

          if (session.producer) {

            safeSend(ws, {
              type: 'producer-available',
              sessionId
            });

            // Tell producer about this specific viewer
            safeSend(session.producer, {
              type: 'viewer-joined',
              sessionId,
              viewerId: ws.id
            });

          }

        }

        safeSend(ws, {
          type: 'registered',
          sessionId,
          role: msg.role,
          clientId: ws.id
        });

        break;
      }

      // ======================================================
      // OFFER / ANSWER / ICE
      // ======================================================

      case 'offer':
      case 'answer':
      case 'ice-candidate': {

        const session = getSession(sessionId);

        if (ws.role === 'producer') {

          // Producer -> specific viewer
          if (msg.targetId) {

            const target = [...session.viewers]
              .find((viewer) => viewer.id === msg.targetId);

            safeSend(target, {
              ...msg,
              fromId: ws.id
            });

          } else {

            // Optional broadcast
            session.viewers.forEach((viewer) => {
              safeSend(viewer, {
                ...msg,
                fromId: ws.id
              });
            });

          }

        } else if (ws.role === 'viewer') {

          // Viewer -> Producer
          safeSend(session.producer, {
            ...msg,
            fromId: ws.id
          });

        }

        break;
      }

      // ======================================================
      // PING
      // ======================================================

      case 'ping': {

        safeSend(ws, {
          type: 'pong'
        });

        break;
      }

      // ======================================================
      // UNKNOWN
      // ======================================================

      default:

        console.warn(
          `[!] unknown message type "${type}" from ${ws.id}`
        );

    }
  });

  // ==========================================================
  // DISCONNECT
  // ==========================================================

  ws.on('close', () => {

    console.log(
      `[-] client disconnected: ${ws.id} (role=${ws.role})`
    );

    if (!ws.sessionId) {
      return;
    }

    const session = getSession(ws.sessionId);

    if (session.producer === ws) {

      session.producer = null;

      session.viewers.forEach((viewer) => {

        safeSend(viewer, {
          type: 'producer-left',
          sessionId: ws.sessionId
        });

      });

    }

    session.viewers.delete(ws);

    if (!session.producer && session.viewers.size === 0) {
      sessions.delete(ws.sessionId);
    }

  });

  ws.on('error', (err) => {

    console.error(
      `[!] socket error on ${ws.id}:`,
      err.message
    );

  });

});

// ============================================================
// START SERVER
// ============================================================

httpServer.listen(PORT, '0.0.0.0', () => {

  console.log('='.repeat(60));
  console.log('FPSMonitor Server');
  console.log('='.repeat(60));

  console.log(`HTTP/Web Viewer: http://localhost:${PORT}`);
  console.log(`WebSocket:       ws://localhost:${PORT}`);

  console.log('');
  console.log('Reachable on LAN:');

  getLocalIPs().forEach((ip) => {

    console.log(`  Web Viewer : http://${ip.address}:${PORT}/`);
    console.log(`  WebSocket  : ws://${ip.address}:${PORT}`);

  });

  console.log('='.repeat(60));

});
