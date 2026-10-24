import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { signToken, requireAuth, rateLimit } from './auth.js';
import { generateQuestions, generateInsights, aiEnabled } from './ai.js';
import { normalizeQuestions, TYPES, DIFFICULTIES } from './questions.js';
import { snapshot } from './metrics.js';
import { config } from './config.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function buildRoutes(db, engine) {
  const r = express.Router();
  const authLimit = rateLimit({ windowMs: 60_000, max: 20 });
  const aiLimit = rateLimit({ windowMs: 60_000, max: 8, key: (req) => `u${req.user.id}` });

  // ---------- auth ----------
  r.post('/auth/register', authLimit, (req, res) => {
    const name = str(req.body.name, 40), email = str(req.body.email, 120).toLowerCase(), password = String(req.body.password ?? ''), role = req.body.role;
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!['teacher', 'student'].includes(role)) return res.status(400).json({ error: 'Choose teacher or student.' });
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'That email is already registered.' });
    const info = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run(name, email, bcrypt.hashSync(password, 10), role);
    const user = { id: info.lastInsertRowid, name, role };
    res.status(201).json({ token: signToken(user), user });
  });

  r.post('/auth/login', authLimit, (req, res) => {
    const email = str(req.body.email, 120).toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!row || !bcrypt.compareSync(String(req.body.password ?? ''), row.password_hash)) return res.status(401).json({ error: 'Wrong email or password.' });
    const user = { id: row.id, name: row.name, role: row.role };
    res.json({ token: signToken(user), user });
  });

  r.get('/me', requireAuth(), (req, res) => res.json({ user: req.user }));

  // ---------- teacher: quizzes ----------
  r.post('/quizzes/generate', requireAuth('teacher'), aiLimit, async (req, res) => {
    const topic = str(req.body.topic, 200);
    const type = TYPES.includes(req.body.type) ? req.body.type : 'mcq';
    const difficulty = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : 'medium';
    const count = Math.min(20, Math.max(1, parseInt(req.body.count, 10) || 5));
    if (topic.length < 2) return res.status(400).json({ error: 'Enter a topic (at least 2 characters).' });
    const out = await generateQuestions({ topic, type, count, difficulty });
    res.json({ ...out, topic, difficulty, aiEnabled: aiEnabled() });
  });

  r.post('/quizzes', requireAuth('teacher'), (req, res) => {
    const title = str(req.body.title, 120);
    const questions = normalizeQuestions(req.body.questions, undefined, 30);
    if (title.length < 2) return res.status(400).json({ error: 'Give the quiz a title.' });
    if (!questions.length) return res.status(400).json({ error: 'Add at least one valid question.' });
    const difficulty = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : 'medium';
    const info = db.prepare('INSERT INTO quizzes (teacher_id,title,topic,difficulty,source,questions_json) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, title, str(req.body.topic, 200), difficulty, str(req.body.source, 60) || 'manual', JSON.stringify(questions));
    res.status(201).json({ id: info.lastInsertRowid });
  });

  r.get('/quizzes', requireAuth('teacher'), (req, res) => {
    const rows = db.prepare('SELECT id,title,topic,difficulty,source,created_at,questions_json FROM quizzes WHERE teacher_id=? ORDER BY id DESC').all(req.user.id);
    res.json({ quizzes: rows.map(({ questions_json, ...q }) => ({ ...q, count: JSON.parse(questions_json).length })) });
  });

  r.get('/quizzes/:id', requireAuth('teacher'), (req, res) => {
    const q = db.prepare('SELECT * FROM quizzes WHERE id=? AND teacher_id=?').get(req.params.id, req.user.id);
    if (!q) return res.status(404).json({ error: 'Quiz not found.' });
    res.json({ ...q, questions: JSON.parse(q.questions_json), questions_json: undefined });
  });

  r.delete('/quizzes/:id', requireAuth('teacher'), (req, res) => {
    db.prepare('DELETE FROM quizzes WHERE id=? AND teacher_id=?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ---------- sessions ----------
  r.post('/sessions', requireAuth('teacher'), (req, res) => {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id=? AND teacher_id=?').get(req.body.quizId, req.user.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    const timeLimit = Math.min(120, Math.max(5, parseInt(req.body.timeLimit, 10) || 20));
    let code;
    do { code = Array.from(crypto.randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('').slice(0, 5); }
    while (engine.getRoom(code) || db.prepare('SELECT 1 FROM sessions WHERE code=?').get(code));
    const info = db.prepare('INSERT INTO sessions (quiz_id,teacher_id,code,time_limit) VALUES (?,?,?,?)').run(quiz.id, req.user.id, code, timeLimit);
    engine.createRoom({ sessionId: info.lastInsertRowid, code, teacherId: req.user.id, timeLimit, quiz: { id: quiz.id, title: quiz.title, questions: JSON.parse(quiz.questions_json) } });
    res.status(201).json({ id: info.lastInsertRowid, code });
  });

  r.get('/sessions', requireAuth('teacher'), (req, res) => {
    const rows = db.prepare(`SELECT s.id,s.code,s.status,s.created_at,q.title,
      (SELECT COUNT(*) FROM participants p WHERE p.session_id=s.id) AS players
      FROM sessions s JOIN quizzes q ON q.id=s.quiz_id WHERE s.teacher_id=? ORDER BY s.id DESC LIMIT 30`).all(req.user.id);
    res.json({ sessions: rows.map((s) => ({ ...s, live: Boolean(engine.getRoom(s.code)) && s.status !== 'finished' })) });
  });

  // students validate a code before opening the socket
  r.get('/sessions/code/:code', requireAuth(), (req, res) => {
    const room = engine.getRoom(req.params.code);
    if (!room || room.status === 'finished') return res.status(404).json({ error: 'No live session with that code.' });
    res.json({ code: room.code, title: room.quiz.title, status: room.status });
  });

  function ownSession(req, res) {
    const s = db.prepare('SELECT s.*, q.title, q.topic, q.questions_json FROM sessions s JOIN quizzes q ON q.id=s.quiz_id WHERE s.id=? AND s.teacher_id=?').get(req.params.id, req.user.id);
    if (!s) { res.status(404).json({ error: 'Session not found.' }); return null; }
    return s;
  }
  function resultsFor(s) {
    const questions = JSON.parse(s.questions_json);
    const players = db.prepare('SELECT user_id AS id, display_name AS name, score, best_streak FROM participants WHERE session_id=? ORDER BY score DESC, display_name').all(s.id)
      .map((p, i) => ({ ...p, rank: i + 1 }));
    const perQuestion = questions.map((q, i) => {
      const a = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(correct),0) c, COALESCE(AVG(response_ms),0) ms FROM answers WHERE session_id=? AND question_index=?').get(s.id, i);
      return { text: q.text, answered: a.n, accuracy: a.n ? Math.round((a.c / a.n) * 100) : 0, avgSeconds: +(a.ms / 1000).toFixed(1) };
    });
    return { session: { id: s.id, code: s.code, title: s.title, status: s.status, created_at: s.created_at }, players, perQuestion };
  }

  r.get('/sessions/:id/results', requireAuth('teacher'), (req, res) => {
    const s = ownSession(req, res); if (!s) return;
    res.json(resultsFor(s));
  });

  r.post('/sessions/:id/insights', requireAuth('teacher'), aiLimit, async (req, res) => {
    const s = ownSession(req, res); if (!s) return;
    const { perQuestion } = resultsFor(s);
    res.json(await generateInsights({ title: s.title, topic: s.topic, perQuestion }));
  });

  // ---------- student ----------
  r.get('/student/history', requireAuth('student'), (req, res) => {
    const rows = db.prepare(`SELECT s.code, q.title, s.created_at, p.score,
      (SELECT COUNT(*)+1 FROM participants o WHERE o.session_id=p.session_id AND o.score>p.score) AS rank,
      (SELECT COUNT(*) FROM participants o WHERE o.session_id=p.session_id) AS players
      FROM participants p JOIN sessions s ON s.id=p.session_id JOIN quizzes q ON q.id=s.quiz_id
      WHERE p.user_id=? ORDER BY s.id DESC LIMIT 30`).all(req.user.id);
    res.json({ history: rows });
  });

  // ---------- ops ----------
  r.get('/health', (_req, res) => res.json({ ok: true, ai: aiEnabled() ? config.nebius.model : 'offline-bank' }));
  r.get('/metrics', requireAuth('teacher'), (_req, res) => res.json({ ...snapshot(), liveRooms: engine.rooms.size }));

  return r;
}
