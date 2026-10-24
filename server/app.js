import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Engine } from './engine.js';
import { buildRoutes } from './routes.js';
import { attachWebSocket } from './ws.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');

export function createApp({ dbPath }) {
  const db = openDb(dbPath);
  const engine = new Engine(db);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  app.use('/api', buildRoutes(db, engine));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('/teacher', (_req, res) => res.sendFile(path.join(pub, 'teacher.html')));
  app.get('/student', (_req, res) => res.sendFile(path.join(pub, 'student.html')));
  app.use(express.static(pub));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on our side.' }); });

  const server = http.createServer(app);
  const wss = attachWebSocket(server, engine, db);
  return {
    app, server, db, engine,
    close: () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => { db.close(); resolve(); }); }),
  };
}
