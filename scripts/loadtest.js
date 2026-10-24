// Simulates a classroom: N students on real WebSockets answering a live quiz.
// Usage: node scripts/loadtest.js [students=200] [questions=3]
import WebSocket from 'ws';
import bcrypt from 'bcryptjs';
import { createApp } from '../server/app.js';
import { signToken } from '../server/auth.js';
import { snapshot } from '../server/metrics.js';

setTimeout(() => { console.error('load test watchdog: timed out'); process.exit(2); }, 90000).unref();
const N = Number(process.argv[2]) || 200;
const Q = Number(process.argv[3]) || 3;
const { server, db, engine, close } = createApp({ dbPath: ':memory:' });
await new Promise((r) => server.listen(0, r));
const url = `ws://127.0.0.1:${server.address().port}/ws`;

// seed users/quiz/session straight into the DB (skips slow bcrypt-per-signup)
const hash = bcrypt.hashSync('password1', 4);
const ins = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)');
const teacher = { id: Number(ins.run('Teacher', 't@load.test', hash, 'teacher').lastInsertRowid), name: 'Teacher', role: 'teacher' };
const students = Array.from({ length: N }, (_, i) => {
  const name = `Student ${i + 1}`;
  return { id: Number(ins.run(name, `s${i}@load.test`, hash, 'student').lastInsertRowid), name, role: 'student' };
});
const questions = Array.from({ length: Q }, (_, i) => ({ type: 'mcq', text: `Question number ${i + 1}?`, options: ['A', 'B', 'C', 'D'], answer: i % 4, explanation: '' }));
const quizId = Number(db.prepare('INSERT INTO quizzes (teacher_id,title,questions_json) VALUES (?,?,?)').run(teacher.id, 'Load test', JSON.stringify(questions)).lastInsertRowid);
const code = 'LOAD1';
const sessionId = Number(db.prepare('INSERT INTO sessions (quiz_id,teacher_id,code,time_limit) VALUES (?,?,?,?)').run(quizId, teacher.id, code, 20).lastInsertRowid);
engine.createRoom({ sessionId, code, teacherId: teacher.id, timeLimit: 20, quiz: { id: quizId, title: 'Load test', questions } });

const open = (user) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${url}?token=${signToken(user)}`);
  ws.once('open', () => resolve(ws)); ws.once('error', reject);
});
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

const host = await open(teacher);
host.send(JSON.stringify({ type: 'host', code }));
const clients = await Promise.all(students.map(open));
const ackMs = [], fanoutMs = [];
let questionSentAt = 0, questionsReceived = 0, acks = 0, expected = 0;
let onAllQuestions = () => {}, onAllAcks = () => {}, onFinished = () => {}, finished = 0;

clients.forEach((ws, i) => {
  let sentAt = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'question') {
      fanoutMs.push(performance.now() - questionSentAt);
      if (++questionsReceived === N) onAllQuestions();
      // stagger answers over ~400ms like real humans
      setTimeout(() => { sentAt = performance.now(); ws.send(JSON.stringify({ type: 'answer', answer: m.index % 4 })); }, Math.random() * 400);
    } else if (m.type === 'answer_ack') {
      ackMs.push(performance.now() - sentAt);
      if (++acks === expected) onAllAcks();
    } else if (m.type === 'finished' && ++finished === N) onFinished();
  });
  ws.send(JSON.stringify({ type: 'join', code }));
});
await new Promise((r) => setTimeout(r, 500));

const t0 = performance.now();
for (let q = 0; q < Q; q++) {
  questionsReceived = 0; acks = 0; expected = N;
  const gotQ = new Promise((r) => { onAllQuestions = r; });
  const gotAcks = new Promise((r) => { onAllAcks = r; });
  questionSentAt = performance.now();
  host.send(JSON.stringify({ type: 'next' }));
  await gotQ; await gotAcks;
  await new Promise((r) => setTimeout(r, 150)); // let the early-reveal (everyone answered) flush
}
const done = new Promise((r) => { onFinished = r; });
host.send(JSON.stringify({ type: 'next' })); // after the last reveal -> finish
await done;
const total = (performance.now() - t0) / 1000;
const m = snapshot().latencyMs;
const totalAnswers = N * Q;
const stored = db.prepare('SELECT COUNT(*) c FROM answers').get().c;

console.log(`\nQuizForge load test - ${N} students x ${Q} questions on one Node process`);
console.log('--------------------------------------------------------------');
console.log(`Answers stored in DB     : ${stored} / ${totalAnswers}`);
console.log(`Question fan-out (client): p50 ${pct(fanoutMs, 50).toFixed(1)} ms | p95 ${pct(fanoutMs, 95).toFixed(1)} ms`);
console.log(`Answer ack round-trip    : p50 ${pct(ackMs, 50).toFixed(1)} ms | p95 ${pct(ackMs, 95).toFixed(1)} ms`);
console.log(`Server answer handling   : p50 ${m['ws.answer_ack_ms']?.p50} ms | p95 ${m['ws.answer_ack_ms']?.p95} ms  (grade + score + SQLite write)`);
console.log(`Reveal fan-out (server)  : p95 ${m['ws.reveal_fanout_ms']?.p95} ms for ${N} personalised messages`);
console.log(`Throughput               : ${(totalAnswers / total).toFixed(0)} answers/s sustained, ${total.toFixed(1)}s wall time`);
console.log(`RSS memory               : ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n`);

clients.forEach((c) => c.close()); host.close();
await close();
process.exit(stored === totalAnswers ? 0 : 1);
