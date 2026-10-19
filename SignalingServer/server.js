
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

const PORT = process.env.PORT || 8765;
const WEB_ROOT = path.resolve(__dirname, 'WebViewer');

const sessions = new Map();

function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            producer: null,
            viewers: new Set(),
            ending: false
        });
    }

    return sessions.get(sessionId);
}

function safeSend(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name] || []) {
            if (net.family === 'IPv4' && !net.internal) {
                addresses.push(net.address);
            }
        }
    }

    return addresses;
}

// ============================================================
// END ENTIRE SESSION
// ============================================================

function endSession(sessionId, requestedBy) {
    const session = sessions.get(sessionId);

    if (!session || session.ending) {
        return;
    }

    session.ending = true;

    console.log(
        `[SESSION] Ending "${sessionId}", requested by ${requestedBy}`
    );

    // Tell the host to stop camera capture and WebRTC.
    if (session.producer) {
        safeSend(session.producer, {
            type: 'end-session',
            sessionId,
            reason: 'disconnect-button'
        });
    }

    // Tell every viewer that the session has ended.
    for (const viewer of session.viewers) {
        safeSend(viewer, {
            type: 'session-ended',
            sessionId,
            reason: 'disconnect-button'
        });
    }

    // Close viewer sockets.
    for (const viewer of session.viewers) {
        if (viewer.readyState === WebSocket.OPEN) {
            viewer.close(4002, 'Session ended');
        }
    }

    // Close the host signaling socket after sending end-session.
    // The host app MUST handle end-session and stop capture.
    if (
        session.producer &&
        session.producer.readyState === WebSocket.OPEN
    ) {
        session.producer.close(4002, 'Session ended');
    }

    // Remove this session from the active session registry.
    sessions.delete(sessionId);
}

// ============================================================
// HTTP SERVER
// ============================================================

const httpServer = http.createServer((req, res) => {
    let requestPath = (req.url || '/').split('?')[0];

    if (requestPath === '/' || requestPath === '/view') {
        requestPath = '/index.html';
    }

    const filePath = path.resolve(WEB_ROOT, '.' + requestPath);

    if (
        filePath !== WEB_ROOT &&
        !filePath.startsWith(WEB_ROOT + path.sep)
    ) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
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
            'Content-Type':
                contentTypes[ext] || 'application/octet-stream',
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
        } catch {
            safeSend(ws, {
                type: 'error',
                message: 'Invalid JSON'
            });
            return;
        }

        const { type, sessionId } = msg;

        if (type === 'ping') {
            safeSend(ws, { type: 'pong' });
            return;
        }

        if (!sessionId) {
            safeSend(ws, {
                type: 'error',
                message: 'sessionId is required'
            });
            return;
        }

        switch (type) {
            // ------------------------------------------------
            // REGISTER
            // ------------------------------------------------

            case 'register': {
                if (!['producer', 'viewer'].includes(msg.role)) {
                    safeSend(ws, {
                        type: 'error',
                        message: 'Invalid role'
                    });
                    return;
                }

                if (ws.sessionId && ws.sessionId !== sessionId) {
                    safeSend(ws, {
                        type: 'error',
                        message: 'Socket already registered'
                    });
                    return;
                }

                const session = getSession(sessionId);

                if (session.ending) {
                    safeSend(ws, {
                        type: 'session-ended',
                        sessionId
                    });
                    ws.close(4002, 'Session ended');
                    return;
                }

                ws.sessionId = sessionId;
                ws.role = msg.role;

                if (msg.role === 'producer') {
                    if (session.producer && session.producer !== ws) {
                        const oldProducer = session.producer;
                        session.producer = ws;
                        oldProducer.close(4001, 'Producer replaced');
                    } else {
                        session.producer = ws;
                    }

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

                    console.log(`[i] Producer registered: ${sessionId}`);
                } else {
                    session.viewers.add(ws);

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

                    console.log(`[i] Viewer registered: ${ws.id}`);
                }

                safeSend(ws, {
                    type: 'registered',
                    sessionId,
                    role: msg.role,
                    clientId: ws.id
                });

                break;
            }

            // ------------------------------------------------
            // END SESSION — VIEWER DISCONNECT BUTTON
            // ------------------------------------------------

            case 'end-session': {
                if (
                    ws.role !== 'viewer' ||
                    ws.sessionId !== sessionId
                ) {
                    safeSend(ws, {
                        type: 'error',
                        message: 'Only a registered viewer can end this session'
                    });
                    return;
                }

                endSession(sessionId, `viewer ${ws.id}`);

                break;
            }

            // ------------------------------------------------
            // WEBRTC SIGNALING
            // ------------------------------------------------

            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                const session = sessions.get(sessionId);

                if (!session || session.ending) {
                    return;
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

            default:
                console.log(`[!] Unknown message: ${type}`);
        }
    });

    // ========================================================
    // DISCONNECT
    // ========================================================

    ws.on('close', () => {
        console.log(
            `[-] Client disconnected: ${ws.id} (${ws.role})`
        );

        if (!ws.sessionId) return;

        const session = sessions.get(ws.sessionId);
        if (!session) return;

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

    ws.on('error', (error) => {
        console.error(`[!] Socket error ${ws.id}:`, error.message);
    });
});

// ============================================================
// START SERVER
// ============================================================

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(55));
    console.log('CALLITNOW / FPSMonitor Server');
    console.log(`HTTP: http://localhost:${PORT}`);
    console.log(`WS:   ws://localhost:${PORT}`);
    console.log('LAN addresses:');

    getLocalIPs().forEach((ip) => {
        console.log(`  http://${ip}:${PORT}/`);
    });

    console.log('='.repeat(55));
});
