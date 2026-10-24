import jwt from 'jsonwebtoken';
import { config } from './config.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, name: user.name }, config.jwtSecret, { expiresIn: '12h' });

export function verifyToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return { id: Number(p.sub), role: p.role, name: p.name };
  } catch { return null; }
}

export function requireAuth(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const user = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (role && user.role !== role) return res.status(403).json({ error: `This area is for ${role}s.` });
    req.user = user;
    next();
  };
}

// Minimal fixed-window rate limiter (per key) - enough to protect auth + AI endpoints.
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req); const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests - please slow down.' });
    }
    next();
  };
}
