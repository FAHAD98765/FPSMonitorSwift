
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
// HTTP SERVER
// ============================================================

const httpServer = http.createServer((req, res) => {
  let requestPath = (req.url || '/').split('?')[0];

  if (requestPath === '/' || requestPath === '/view') {
    requestPath = '/index.html';
  }

  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, safePath);

  if (!filePath.startsWith(WEB_ROOT + path.sep) && filePath !== WEB_ROOT) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
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
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocket.Server({
  server: httpServer
});

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.role = null;
  ws.sessionId = null;

  console.log(`[+] Client connected: ${ws.id}`);

  ws.on('message', (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (error) {
      console.warn(`[!] Invalid JSON from ${ws.id}`);
      return;
    }

    const { type, sessionId } = msg;

    if (!sessionId && type !== 'ping') {
      safeSend(ws, {
        type: 'error',
        message: 'sessionId is required'
      });

      return;
    }

    switch (type) {
      // ------------------------------------------------------
      // REGISTER
      // ------------------------------------------------------

      case 'register': {
        if (!['producer', 'viewer'].includes(msg.role)) {
          safeSend(ws, {
            type: 'error',
            message: 'Invalid role'
          });
          return;
        }

        // Prevent a socket from registering in another session.
        if (ws.sessionId && ws.sessionId !== sessionId) {
          safeSend(ws, {
            type: 'error',
            message: 'Socket is already registered to another session'
          });
          return;
        }

        // Prevent changing roles or duplicate registration.
        if (ws.sessionId === sessionId && ws.role) {
          if (ws.role !== msg.role) {
            safeSend(ws, {
              type: 'error',
              message: 'Socket is already registered with another role'
            });
          }

          return;
        }

        const session = getSession(sessionId);

        // ----------------------------------------------------
        // SINGLE VIEWER LIMIT
        // Only one active viewer per session is allowed.
        // ----------------------------------------------------

        if (msg.role === 'viewer') {
          // Clean up sockets that are no longer open.
          for (const viewer of session.viewers) {
            if (viewer.readyState !== WebSocket.OPEN) {
              session.viewers.delete(viewer);
            }
          }

          if (session.viewers.size >= 1) {
            console.log(
              `[i] Viewer ${ws.id} rejected: session "${sessionId}" is busy`
            );

            safeSend(ws, {
              type: 'error',
              message: 'Stream is busy. Another viewer is already connected.'
            });

            // Do not register the rejected viewer.
            return;
          }
        }

        ws.sessionId = sessionId;
        ws.role = msg.role;

        // ----------------------------------------------------
        // PRODUCER REGISTRATION
        // ----------------------------------------------------

        if (msg.role === 'producer') {
          if (session.producer && session.producer !== ws) {
            console.log(
              `[i] Replacing producer for session ${sessionId}`
            );

            const oldProducer = session.producer;
            session.producer = ws;

            oldProducer.close(4001, 'Producer replaced');
          } else {
            session.producer = ws;
          }

          console.log(
            `[i] ${ws.id} registered as PRODUCER for "${sessionId}"`
          );

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
        } else {
          // --------------------------------------------------
          // VIEWER REGISTRATION
          // Reached only when the viewer limit permits access.
          // --------------------------------------------------

          session.viewers.add(ws);

          console.log(
            `[i] ${ws.id} registered as VIEWER for "${sessionId}"`
          );

          if (session.producer) {
            safeSend(ws, {
              type: 'producer-available',
              sessionId
            });

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

      // ------------------------------------------------------
      // OFFER / ANSWER / ICE CANDIDATE
      // ------------------------------------------------------

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const session = sessions.get(sessionId);

        if (!session) {
          break;
        }

        if (ws.role === 'producer') {
          if (msg.targetId) {
            const target = [...session.viewers].find(
              (viewer) => viewer.id === msg.targetId
            );

            safeSend(target, {
              ...msg,
              fromId: ws.id
            });
          } else {
            session.viewers.forEach((viewer) => {
              safeSend(viewer, {
                ...msg,
                fromId: ws.id
              });
            });
          }
        } else if (ws.role === 'viewer') {
          safeSend(session.producer, {
            ...msg,
            fromId: ws.id
          });
        }

        break;
      }

      // ------------------------------------------------------
      // PING
      // ------------------------------------------------------

      case 'ping': {
        safeSend(ws, { type: 'pong' });
        break;
      }

      default:
        console.warn(
          `[!] Unknown message type "${type}" from ${ws.id}`
        );
    }
  });

  // ==========================================================
  // DISCONNECT — BOTH DIRECTIONS
  // ==========================================================

  ws.on('close', () => {
    console.log(
      `[-] Client disconnected: ${ws.id} (role=${ws.role})`
    );

    if (!ws.sessionId) {
      return;
    }

    const session = sessions.get(ws.sessionId);

    if (!session) {
      return;
    }

    // --------------------------------------------------------
    // PRODUCER / HOST DISCONNECTED
    // --------------------------------------------------------

    if (session.producer === ws) {
      session.producer = null;

      console.log(
        `[i] Producer disconnected from ${ws.sessionId}`
      );

      session.viewers.forEach((viewer) => {
        safeSend(viewer, {
          type: 'producer-left',
          sessionId: ws.sessionId
        });
      });
    }

    // --------------------------------------------------------
    // VIEWER DISCONNECTED
    // --------------------------------------------------------

    if (ws.role === 'viewer') {
      session.viewers.delete(ws);

      console.log(
        `[i] Viewer ${ws.id} disconnected from ${ws.sessionId}`
      );

      // Notify host so the Swift app can stop streaming
      // when no viewers remain.
      if (session.producer) {
        safeSend(session.producer, {
          type: 'viewer-left',
          sessionId: ws.sessionId,
          viewerId: ws.id,
          remainingViewers: session.viewers.size
        });

        console.log(
          `[i] viewer-left sent to producer. Remaining viewers: ${session.viewers.size}`
        );
      }
    }

    // --------------------------------------------------------
    // REMOVE EMPTY SESSION
    // --------------------------------------------------------

    if (!session.producer && session.viewers.size === 0) {
      sessions.delete(ws.sessionId);

      console.log(
        `[i] Empty session removed: ${ws.sessionId}`
      );
    }
  });

  ws.on('error', (err) => {
    console.error(
      `[!] Socket error on ${ws.id}:`,
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
