
const WebSocket = require('ws');
const os = require('os');

const PORT = process.env.PORT || 8765;

// sessionId -> { producer: ws|null, viewers: Set<ws> }
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { producer: null, viewers: new Set() });
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
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({ iface: name, address: net.address });
      }
    }
  }
  return results;
}

const wss = new WebSocket.Server({ port: PORT });

console.log('='.repeat(60));
console.log('FPSMonitor Signaling Server');
console.log('='.repeat(60));
console.log(`Listening on port ${PORT}`);
console.log('Reachable at (use one of these on BOTH phones):');
getLocalIPs().forEach((ip) => {
  console.log(`  ws://${ip.address}:${PORT}   (${ip.iface})`);
});
console.log('='.repeat(60));

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

    const { type, sessionId } = msg;

    if (!sessionId && type !== 'ping') {
      safeSend(ws, { type: 'error', message: 'sessionId is required' });
      return;
    }

    switch (type) {
      case 'register': {
        // msg: { type: 'register', sessionId, role: 'producer' | 'viewer' }
        const session = getSession(sessionId);
        ws.sessionId = sessionId;
        ws.role = msg.role;

        if (msg.role === 'producer') {
          if (session.producer && session.producer !== ws) {
            console.log(`[i] replacing existing producer for session ${sessionId}`);
          }
          session.producer = ws;
          console.log(`[i] ${ws.id} registered as PRODUCER for session "${sessionId}"`);
          // let existing viewers know a producer is available, and let the
          // producer know about viewers that were already waiting
          session.viewers.forEach((v) => {
            safeSend(v, { type: 'producer-available', sessionId });
            safeSend(ws, { type: 'viewer-joined', sessionId, viewerId: v.id });
          });
        } else if (msg.role === 'viewer') {
          session.viewers.add(ws);
          console.log(`[i] ${ws.id} registered as VIEWER for session "${sessionId}"`);
          if (session.producer) {
            safeSend(ws, { type: 'producer-available', sessionId });
            // Tell the producer a new viewer is ready so it can create an offer.
            safeSend(session.producer, { type: 'viewer-joined', sessionId, viewerId: ws.id });
          }
        }
        safeSend(ws, { type: 'registered', sessionId, role: msg.role, clientId: ws.id });
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Relay to the *other* side of this session.
        const session = getSession(sessionId);

        if (ws.role === 'producer') {
          // producer -> specific viewer (msg.targetId) or broadcast to all viewers
          if (msg.targetId) {
            const target = [...session.viewers].find((v) => v.id === msg.targetId);
            safeSend(target, { ...msg, fromId: ws.id });
          } else {
            session.viewers.forEach((v) => safeSend(v, { ...msg, fromId: ws.id }));
          }
        } else if (ws.role === 'viewer') {
          // viewer -> producer, tag with fromId so producer knows which
          // RTCPeerConnection this belongs to (multi-viewer support)
          safeSend(session.producer, { ...msg, fromId: ws.id });
        }
        break;
      }

      case 'ping': {
        safeSend(ws, { type: 'pong' });
        break;
      }

      default:
        console.warn(`[!] unknown message type "${type}" from ${ws.id}`);
    }
  });

  ws.on('close', () => {
    console.log(`[-] client disconnected: ${ws.id} (role=${ws.role})`);
    if (ws.sessionId) {
      const session = getSession(ws.sessionId);
      if (session.producer === ws) {
        session.producer = null;
        session.viewers.forEach((v) => safeSend(v, { type: 'producer-left', sessionId: ws.sessionId }));
      }
      session.viewers.delete(ws);
      if (!session.producer && session.viewers.size === 0) {
        sessions.delete(ws.sessionId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[!] socket error on ${ws.id}:`, err.message);
  });
});
