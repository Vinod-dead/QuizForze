import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';

let ctx, base;
const post = async (path, body, token) => {
  const r = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const get = async (path, token) => (await fetch(`${base}/api${path}`, { headers: { Authorization: `Bearer ${token}` } })).json();

function client(token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  const inbox = [], waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d); inbox.push(m); waiters.splice(0).forEach((w) => w()); });
  const opened = new Promise((r) => ws.on('open', r));
  const waitFor = async (type, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`timeout waiting for ${type}; got ${inbox.map((m) => m.type)}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  return { ws, opened, waitFor, send: (m) => ws.send(JSON.stringify(m)) };
}

test.before(async () => {
  ctx = createApp({ dbPath: ':memory:' });
  await new Promise((r) => ctx.server.listen(0, r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
});
test.after(() => ctx.close());

test('full live session: AI fallback -> host -> 2 students -> scoring -> leaderboard -> results', async () => {
  const t = (await post('/auth/register', { name: 'Ms Rao', email: 't@x.com', password: 'password1', role: 'teacher' })).body;
  const a = (await post('/auth/register', { name: 'Asha', email: 'a@x.com', password: 'password1', role: 'student' })).body;
  const b = (await post('/auth/register', { name: 'Ben', email: 'b@x.com', password: 'password1', role: 'student' })).body;

  // role enforcement
  assert.equal((await post('/quizzes/generate', { topic: 'x' }, a.token)).status, 403);
  assert.equal((await post('/auth/register', { name: 'Dup', email: 't@x.com', password: 'password1', role: 'student' })).status, 409);

  const gen = await post('/quizzes/generate', { topic: 'Web basics', type: 'mcq', count: 3, difficulty: 'easy' }, t.token);
  assert.equal(gen.status, 200); assert.equal(gen.body.questions.length, 3);
  const quiz = await post('/quizzes', { title: 'Web basics', topic: 'Web basics', questions: gen.body.questions }, t.token);
  const sess = (await post('/sessions', { quizId: quiz.body.id, timeLimit: 10 }, t.token)).body;
  assert.match(sess.code, /^[A-Z2-9]{5}$/);

  const host = client(t.token), sa = client(a.token), sb = client(b.token);
  await Promise.all([host.opened, sa.opened, sb.opened]);
  host.send({ type: 'host', code: sess.code }); await host.waitFor('host_state');
  sa.send({ type: 'join', code: sess.code }); await sa.waitFor('joined');
  sb.send({ type: 'join', code: sess.code }); await sb.waitFor('joined');

  // a student cannot host
  const imposter = client(a.token); await imposter.opened; imposter.send({ type: 'host', code: sess.code });
  assert.match((await imposter.waitFor('error')).error, /Not your session/);

  const correctOf = (i) => gen.body.questions[i].answer;
  for (let i = 0; i < 3; i++) {
    host.send({ type: 'next' });
    const qa = await sa.waitFor('question'); await sb.waitFor('question');
    assert.equal(qa.index, i); assert.equal(qa.answer, undefined, 'students must never receive the answer');
    sa.send({ type: 'answer', answer: correctOf(i) });                       // Asha always right
    sb.send({ type: 'answer', answer: (correctOf(i) + 1) % 4 });             // Ben always wrong
    await sa.waitFor('answer_ack');
    const ra = await sa.waitFor('reveal'); const rb = await sb.waitFor('reveal');   // all answered -> early reveal
    assert.equal(ra.you.correct, true); assert.equal(rb.you.correct, false);
    assert.equal(ra.correctIndex, correctOf(i));
    assert.equal(ra.leaderboard[0].name, 'Asha');
  }
  host.send({ type: 'next' });
  const fin = await sa.waitFor('finished'); await sb.waitFor('finished');
  assert.equal(fin.you.rank, 1); assert.ok(fin.you.score >= 1500 + 50 + 100, 'streak bonuses applied');
  assert.equal((await sb.waitFor('finished').catch(() => null)), null);

  // duplicate answers are rejected (new session q)
  const res = await get(`/sessions/${sess.id}/results`, t.token);
  assert.equal(res.players[0].name, 'Asha'); assert.equal(res.perQuestion.every((q) => q.accuracy === 50), true);
  const ins = await post(`/sessions/${sess.id}/insights`, {}, t.token);
  assert.ok(ins.body.text.length > 10);
  const hist = await get('/student/history', a.token); assert.equal(hist.history[0].rank, 1);
  [host, sa, sb, imposter].forEach((c) => c.ws.close());
});

test('late / duplicate answers are rejected and timer auto-reveals', async () => {
  const t = (await post('/auth/register', { name: 'T2', email: 't2@x.com', password: 'password1', role: 'teacher' })).body;
  const s = (await post('/auth/register', { name: 'S2', email: 's2@x.com', password: 'password1', role: 'student' })).body;
  const s3 = (await post('/auth/register', { name: 'S3', email: 's3@x.com', password: 'password1', role: 'student' })).body;
  const quiz = await post('/quizzes', { title: 'TF', questions: [{ type: 'true_false', text: 'A stack is LIFO.', answer: true }] }, t.token);
  const sess = (await post('/sessions', { quizId: quiz.body.id, timeLimit: 5 }, t.token)).body;
  const host = client(t.token), c = client(s.token), idle = client(s3.token);
  await Promise.all([host.opened, c.opened, idle.opened]);
  host.send({ type: 'host', code: sess.code }); await host.waitFor('host_state');
  c.send({ type: 'join', code: sess.code }); await c.waitFor('joined');
  idle.send({ type: 'join', code: sess.code }); await idle.waitFor('joined');
  host.send({ type: 'next' }); await c.waitFor('question');
  c.send({ type: 'answer', answer: 0 }); await c.waitFor('answer_ack');
  c.send({ type: 'answer', answer: 0 });
  assert.match((await c.waitFor('answer_rejected')).reason, /already/);
  const r = await c.waitFor('reveal', 8000);                 // idle student never answers -> timer closes the question
  assert.equal(r.you.correct, true);
  c.send({ type: 'answer', answer: 0 });
  assert.match((await c.waitFor('answer_rejected')).reason, /closed|late/i);
  [host, c, idle].forEach((x) => x.ws.close());
});
