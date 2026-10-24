import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import { observe, inc } from './metrics.js';

export function attachWebSocket(server, engine, db) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const user = verifyToken(url.searchParams.get('token') || '');
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.user = user; wss.emit('connection', ws); });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    inc('ws.connections');

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m.type !== 'string') return;

      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t }));

      if (m.type === 'join' || m.type === 'host') {
        if (ws.ctx) engine.leave(ws);
        const room = engine.getRoom(m.code);
        if (!room) return ws.send(JSON.stringify({ type: 'error', error: 'Session not found or already ended.' }));
        if (m.type === 'host') {
          if (ws.user.role !== 'teacher' || ws.user.id !== room.teacherId) return ws.send(JSON.stringify({ type: 'error', error: 'Not your session.' }));
          return engine.joinHost(room, ws);
        }
        if (ws.user.role !== 'student') return ws.send(JSON.stringify({ type: 'error', error: 'Join with a student account.' }));
        return engine.joinStudent(room, ws.user, ws);
      }

      const c = ws.ctx; if (!c) return;
      if (c.role === 'teacher') {
        if (m.type === 'next') engine.next(c.room);
        else if (m.type === 'reveal') engine.reveal(c.room);
        else if (m.type === 'end') engine.finish(c.room);
      } else if (m.type === 'answer') {
        engine.submit(c.room, c.userId, m.answer);
      }
    });

    ws.on('close', () => engine.leave(ws));
    ws.on('error', () => {});
  });

  // drop dead connections every 25s
  const hb = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, 25000);
  hb.unref();
  wss.on('close', () => clearInterval(hb));
  return wss;
}
