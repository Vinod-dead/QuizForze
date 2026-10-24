// Live session engine. Server-authoritative: the server owns the clock, grading and scoring.
// State machine:  lobby -> question -> reveal -> (question -> reveal)* -> finished
import { scoreAnswer, rankPlayers } from './scoring.js';
import { gradeAnswer, publicQuestion, correctAnswerLabel } from './questions.js';
import { inc, timer } from './metrics.js';

const GRACE_MS = 400; // network jitter allowance after the timer ends
const OPEN = 1;

export class Engine {
  constructor(db) {
    this.db = db;
    this.rooms = new Map(); // code -> room
    this.stmts = {
      upsertPart: db.prepare(`INSERT INTO participants (session_id,user_id,display_name) VALUES (?,?,?) ON CONFLICT(session_id,user_id) DO UPDATE SET display_name=excluded.display_name`),
      getPart: db.prepare(`SELECT score,best_streak FROM participants WHERE session_id=? AND user_id=?`),
      saveAnswer: db.prepare(`INSERT INTO answers (session_id,user_id,question_index,answer_json,correct,points,response_ms) VALUES (?,?,?,?,?,?,?)`),
      updScore: db.prepare(`UPDATE participants SET score=?, best_streak=MAX(best_streak,?) WHERE session_id=? AND user_id=?`),
      setStatus: db.prepare(`UPDATE sessions SET status=?, ended_at=CASE WHEN ?='finished' THEN datetime('now') ELSE ended_at END WHERE id=?`),
        };
  }

  // ----- room lifecycle -----
  createRoom({ sessionId, code, teacherId, quiz, timeLimit }) {
    const room = {
      sessionId, code, teacherId, quiz, timeLimit,
      status: 'lobby', qIndex: -1, openedAt: 0, endsAt: 0, timer: null,
      players: new Map(), // userId -> {id,name,score,streak,totalMs,sockets:Set}
      hosts: new Set(),
      answers: new Map(), // qIndex -> Map(userId -> {answer,correct,points,ms})
    };
    this.rooms.set(code, room);
    return room;
  }
  getRoom(code) { return this.rooms.get(String(code || '').toUpperCase()); }

  player(room, id, name) {
    let p = room.players.get(id);
    if (!p) {
      const row = this.stmts.getPart.get(room.sessionId, id);
      p = { id, name, score: row?.score || 0, streak: 0, totalMs: 0, sockets: new Set() };
      room.players.set(id, p);
    }
    return p;
  }

  // ----- connections -----
  joinStudent(room, user, ws) {
    if (room.status === 'finished') return this.send(ws, { type: 'error', error: 'This session has ended.' });
    const p = this.player(room, user.id, user.name);
    p.name = user.name;
    this.stmts.upsertPart.run(room.sessionId, user.id, user.name);
    p.sockets.add(ws);
    ws.ctx = { room, role: 'student', userId: user.id };
    this.send(ws, { type: 'joined', ...this.studentSnapshot(room, p) });
    this.broadcastHosts(room, { type: 'players', players: this.playerList(room) });
    inc('ws.student_joins');
  }

  joinHost(room, ws) {
    room.hosts.add(ws);
    ws.ctx = { room, role: 'teacher' };
    this.send(ws, { type: 'host_state', ...this.hostSnapshot(room) });
  }

  leave(ws) {
    const c = ws.ctx; if (!c) return;
    const { room } = c;
    if (c.role === 'teacher') room.hosts.delete(ws);
    else {
      const p = room.players.get(c.userId);
      if (p) { p.sockets.delete(ws); this.broadcastHosts(room, { type: 'players', players: this.playerList(room) }); }
    }
  }

  // ----- teacher actions -----
  next(room) {
    if (room.status === 'finished') return;
    if (room.status === 'question') return this.reveal(room); // double-press = close the open question
    const nextIdx = room.qIndex + 1;
    if (nextIdx >= room.quiz.questions.length) return this.finish(room);
    room.qIndex = nextIdx;
    room.status = 'question';
    room.openedAt = Date.now();
    room.endsAt = room.openedAt + room.timeLimit * 1000;
    room.answers.set(nextIdx, new Map());
    this.stmts.setStatus.run('live', 'live', room.sessionId);
    clearTimeout(room.timer);
    room.timer = setTimeout(() => this.reveal(room), room.timeLimit * 1000 + GRACE_MS);

    const q = room.quiz.questions[nextIdx];
    const payload = { type: 'question', ...publicQuestion(q, nextIdx, room.quiz.questions.length), endsAt: room.endsAt, timeLimit: room.timeLimit, serverNow: Date.now() };
    const stop = timer('ws.question_fanout_ms');
    this.broadcastAll(room, payload);
    stop();
  }

  reveal(room) {
    if (room.status !== 'question') return;
    clearTimeout(room.timer);
    room.status = 'reveal';
    const q = room.quiz.questions[room.qIndex];
    const answers = room.answers.get(room.qIndex);
    // players who didn't answer lose their streak
    for (const p of room.players.values()) if (!answers.has(p.id)) p.streak = 0;

    const ranked = rankPlayers([...room.players.values()].map(({ id, name, score, totalMs }) => ({ id, name, score, totalMs })));
    const board = ranked.slice(0, 10).map(({ id, name, score, rank }) => ({ id, name, score, rank }));
    const counts = this.distribution(room, q, answers);
    const correctLabel = correctAnswerLabel(q);
    const base = { type: 'reveal', index: room.qIndex, total: room.quiz.questions.length, correctIndex: q.answer ?? null, correctLabel, explanation: q.explanation, distribution: counts, leaderboard: board };

    this.broadcastHosts(room, { ...base, answered: answers.size, accuracy: this.accuracy(answers) });
    const t = timer('ws.reveal_fanout_ms');
    for (const p of room.players.values()) {
      const mine = answers.get(p.id);
      const me = ranked.find((r) => r.id === p.id);
      const msg = { ...base, you: { answered: !!mine, correct: !!mine?.correct, points: mine?.points || 0, score: p.score, rank: me?.rank, streak: p.streak, of: ranked.length } };
      for (const ws of p.sockets) this.send(ws, msg);
    }
    t();
  }

  finish(room) {
    if (room.status === 'finished') return;
    clearTimeout(room.timer);
    room.status = 'finished';
    this.stmts.setStatus.run('finished', 'finished', room.sessionId);
    const ranked = rankPlayers([...room.players.values()].map(({ id, name, score, totalMs }) => ({ id, name, score, totalMs })));
    const board = ranked.slice(0, 10).map(({ id, name, score, rank }) => ({ id, name, score, rank }));
    this.broadcastHosts(room, { type: 'finished', leaderboard: board });
    for (const p of room.players.values()) {
      const me = ranked.find((r) => r.id === p.id);
      for (const ws of p.sockets) this.send(ws, { type: 'finished', leaderboard: board, you: { score: p.score, rank: me?.rank, of: ranked.length } });
    }
    // free memory after clients have had time to read final state
    setTimeout(() => this.rooms.delete(room.code), 10 * 60 * 1000).unref();
  }

  // ----- student answer -----
  submit(room, userId, answer) {
    const stop = timer('ws.answer_ack_ms');
    const p = room.players.get(userId);
    const reply = (m) => { for (const ws of p?.sockets || []) this.send(ws, m); };
    if (!p) return;
    if (room.status !== 'question') { reply({ type: 'answer_rejected', reason: 'This question is closed.' }); return stop(); }
    const now = Date.now();
    if (now > room.endsAt + GRACE_MS) { reply({ type: 'answer_rejected', reason: 'Too late!' }); return stop(); }
    const answers = room.answers.get(room.qIndex);
    if (answers.has(userId)) { reply({ type: 'answer_rejected', reason: 'You already answered.' }); return stop(); }

    const q = room.quiz.questions[room.qIndex];
    if (q.type === 'short_answer') answer = String(answer ?? '').slice(0, 120);
    else if (!Number.isInteger(answer) || answer < 0 || answer >= q.options.length) { reply({ type: 'answer_rejected', reason: 'Invalid answer.' }); return stop(); }

    const elapsed = Math.min(room.timeLimit * 1000, Math.max(0, now - room.openedAt));
    const correct = gradeAnswer(q, answer);
    const s = scoreAnswer({ correct, elapsedMs: elapsed, timeLimitMs: room.timeLimit * 1000, prevStreak: p.streak });
    p.streak = s.streak; p.score += s.points; p.totalMs += elapsed;
    answers.set(userId, { answer, correct, points: s.points, ms: elapsed });

    this.db.transaction(() => {
      this.stmts.saveAnswer.run(room.sessionId, userId, room.qIndex, JSON.stringify(answer), correct ? 1 : 0, s.points, elapsed);
      this.stmts.updScore.run(p.score, p.streak, room.sessionId, userId);
    })();

    reply({ type: 'answer_ack', locked: true }); // no correctness leak until reveal
    this.broadcastHosts(room, { type: 'answer_count', answered: answers.size, total: room.players.size, userId });
    inc('answers.total');
    stop();
    // everyone present has answered -> reveal early (keeps classes snappy)
    const online = [...room.players.values()].filter((x) => x.sockets.size > 0);
    if (online.length && online.every((x) => answers.has(x.id))) this.reveal(room);
  }

  // ----- helpers -----
  accuracy(answers) {
    if (!answers.size) return 0;
    return Math.round(([...answers.values()].filter((a) => a.correct).length / answers.size) * 100);
  }
  distribution(room, q, answers) {
    if (q.type === 'short_answer') {
      const c = [...answers.values()].filter((a) => a.correct).length;
      return [c, answers.size - c];
    }
    const counts = new Array(q.options.length).fill(0);
    for (const a of answers.values()) counts[a.answer]++;
    return counts;
  }
  playerList(room) {
    return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, online: p.sockets.size > 0, score: p.score }));
  }
  studentSnapshot(room, p) {
    const snap = { code: room.code, title: room.quiz.title, status: room.status, score: p.score, streak: p.streak, serverNow: Date.now() };
    if (room.status === 'question') {
      const q = room.quiz.questions[room.qIndex];
      Object.assign(snap, { question: { ...publicQuestion(q, room.qIndex, room.quiz.questions.length), endsAt: room.endsAt, timeLimit: room.timeLimit }, answered: room.answers.get(room.qIndex)?.has(p.id) || false });
    }
    return snap;
  }
  hostSnapshot(room) {
    const snap = { code: room.code, title: room.quiz.title, status: room.status, qIndex: room.qIndex, total: room.quiz.questions.length, timeLimit: room.timeLimit, players: this.playerList(room), serverNow: Date.now() };
    if (room.status === 'question') {
      const q = room.quiz.questions[room.qIndex];
      snap.question = { ...publicQuestion(q, room.qIndex, snap.total), endsAt: room.endsAt, answer: q.answer ?? null, accepted: q.accepted };
      snap.answered = room.answers.get(room.qIndex)?.size || 0;
    }
    snap.leaderboard = rankPlayers([...room.players.values()].map(({ id, name, score, totalMs }) => ({ id, name, score, totalMs }))).slice(0, 10).map(({ id, name, score, rank }) => ({ id, name, score, rank }));
    return snap;
  }
  send(ws, msg) { if (ws.readyState === OPEN) ws.send(JSON.stringify(msg)); }
  broadcastHosts(room, msg) { for (const ws of room.hosts) this.send(ws, msg); }
  broadcastAll(room, msg) {
    this.broadcastHosts(room, { ...msg, answer: room.quiz.questions[room.qIndex].answer ?? null });
    for (const p of room.players.values()) for (const ws of p.sockets) this.send(ws, msg);
  }
}
