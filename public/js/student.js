import { api, guard, el, $, toast, connectSocket, renderBoard, runTimer, clockOffset, brandBar, logout, LETTERS } from './common.js';

const me = guard('student');
const app = $('#app');
let socket = null, stopTimer = null;
const S = { code: null, title: '', status: 'idle', question: null, picked: null, locked: false, reveal: null, score: 0, offset: 0, final: null, lastCorrectLabel: '' };

app.append(brandBar(`${me.user.name} - student`, logout));
const main = el('main', { class: 'wrap narrow' });
const lat = el('div', { class: 'latency hidden' });
app.append(main); document.body.append(lat);

const params = new URLSearchParams(location.search);
const saved = sessionStorage.getItem('quizforge.code');
if (params.get('code')) joinFlow(params.get('code'));
else if (saved) joinFlow(saved, true);
else homeView();

// ---------- home ----------
async function homeView() {
  const input = el('input', { id: 'code', maxlength: 5, placeholder: 'ABCDE', autocomplete: 'off', autocapitalize: 'characters', style: 'text-align:center;font-size:2rem;letter-spacing:.3em;font-weight:800;text-transform:uppercase' });
  const err = el('div', { class: 'msg hidden', role: 'alert' });
  const form = el('form', { class: 'card stack', onsubmit: (e) => { e.preventDefault(); joinFlow(input.value, false, err); } },
    el('h2', { text: 'Join a live quiz' }), el('p', { class: 'muted', text: 'Enter the 5-letter code on your teacher\'s screen.' }),
    el('label', { for: 'code', text: 'Join code' }), input, err, el('button', { class: 'btn big block', type: 'submit', text: 'Join' }));
  const hist = el('section', { class: 'card', style: 'margin-top:16px' }, el('h3', { text: 'Your past quizzes' }), el('p', { class: 'muted small', text: 'Loading...' }));
  main.replaceChildren(form, hist);
  input.focus();
  try {
    const { history } = await api('/student/history');
    hist.replaceChildren(el('h3', { text: 'Your past quizzes' }), history.length ? el('ul', { class: 'list' }, ...history.map((h) =>
      el('li', {}, el('div', {}, el('b', { text: h.title }), el('div', { class: 'muted small', text: new Date(h.created_at + 'Z').toLocaleDateString() })),
        el('div', { style: 'text-align:right' }, el('b', { class: 'num', text: h.score.toLocaleString() }), el('div', { class: 'muted small', text: `#${h.rank} of ${h.players}` }))))) : el('p', { class: 'muted small', text: 'Nothing yet - join your first quiz!' }));
  } catch { hist.remove(); }
}

// ---------- join ----------
async function joinFlow(rawCode, silent = false, errBox) {
  const code = String(rawCode || '').trim().toUpperCase();
  try {
    const info = await api(`/sessions/code/${encodeURIComponent(code)}`);
    S.code = info.code; S.title = info.title;
    sessionStorage.setItem('quizforge.code', info.code);
    history.replaceState(null, '', '/student');
    openSocket();
  } catch (e) {
    sessionStorage.removeItem('quizforge.code');
    if (errBox) { errBox.textContent = e.message; errBox.classList.remove('hidden'); } else { homeView(); if (!silent) toast(e.message); }
  }
}

function openSocket() {
  waiting('Joining...');
  socket = connectSocket({
    onOpen: () => socket.send({ type: 'join', code: S.code }),
    onStatus: (s, v) => { lat.classList.remove('hidden'); lat.textContent = s === 'rtt' ? `connected - ${v} ms` : s === 'online' ? 'connected' : 'reconnecting...'; },
    onMessage,
  });
}

function onMessage(m) {
  switch (m.type) {
    case 'joined':
      S.title = m.title; S.score = m.score; S.offset = clockOffset(m.serverNow); S.status = m.status;
      if (m.status === 'question') { S.question = m.question; S.locked = m.answered; S.picked = null; S.reveal = null; }
      break;
    case 'question': S.status = 'question'; S.question = m; S.picked = null; S.locked = false; S.reveal = null; S.offset = clockOffset(m.serverNow); break;
    case 'answer_ack': S.locked = true; break;
    case 'answer_rejected': S.locked = S.locked; toast(m.reason); if (m.reason === 'This question is closed.' || m.reason === 'Too late!') S.locked = true; break;
    case 'reveal': S.status = 'reveal'; S.reveal = m; S.score = m.you.score; break;
    case 'finished': S.status = 'finished'; S.final = m; S.score = m.you.score; sessionStorage.removeItem('quizforge.code'); break;
    case 'error': sessionStorage.removeItem('quizforge.code'); socket?.close(); homeView(); toast(m.error, 4000); return;
    default: return;
  }
  draw();
}

// ---------- views ----------
function waiting(text, sub) {
  stopTimer?.();
  main.replaceChildren(el('div', { class: 'card waiting' }, el('div', { class: 'spinner' }), el('h2', { text }), sub ? el('p', { class: 'muted', text: sub }) : null));
}

function draw() {
  stopTimer?.();
  if (S.status === 'lobby') return waiting(`You're in, ${me.user.name.split(' ')[0]}!`, `${S.title} - waiting for your teacher to start. Code ${S.code}`);
  if (S.status === 'question') return questionView();
  if (S.status === 'reveal') return revealView();
  if (S.status === 'finished') return finalView();
  waiting('Connecting...');
}

function questionView() {
  const q = S.question;
  const bar = el('i'), secs = el('b', { class: 'num' });
  const submit = (answer, k) => {
    if (S.locked) return;
    S.picked = k ?? answer; S.locked = true;
    socket.send({ type: 'answer', answer });
    draw();
  };
  let body;
  if (q.kind === 'short_answer') {
    const input = el('input', { placeholder: 'Type your answer', maxlength: 120, autocomplete: 'off', disabled: S.locked, 'aria-label': 'Your answer' });
    body = el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) submit(input.value.trim(), input.value.trim()); } },
      input, el('button', { class: 'btn big block', type: 'submit', disabled: S.locked, text: S.locked ? 'Answer locked in' : 'Submit' }));
    if (!S.locked) setTimeout(() => input.focus(), 50);
  } else {
    body = el('div', { class: `options ${q.kind === 'true_false' ? 'tf' : ''}`, role: 'group', 'aria-label': 'Answer choices' }, ...q.options.map((o, k) =>
      el('button', { class: `opt ${S.picked === k ? 'picked' : ''} ${S.locked && S.picked !== k ? 'dim' : ''}`, disabled: S.locked, onclick: () => submit(k, k) },
        el('span', { class: 'ltr', text: LETTERS[k] }), o)));
  }
  main.replaceChildren(el('div', { class: 'card' },
    el('div', { class: 'row between' }, el('span', { class: 'pill', text: `Question ${q.index + 1} / ${q.total}` }), el('span', { class: 'num' }, secs, 's')),
    el('div', { class: 'timerbar', style: 'margin-top:10px' }, bar),
    el('div', { class: 'qtext', text: q.text }), body,
    S.locked ? el('p', { class: 'muted', style: 'text-align:center;margin-top:14px', text: 'Locked in - waiting for the reveal...' }) : null));
  stopTimer = runTimer(bar, secs, q.endsAt, q.timeLimit, S.offset);
}

function revealView() {
  const r = S.reveal, y = r.you;
  const cls = !y.answered ? 'none' : y.correct ? 'good' : 'bad';
  const head = !y.answered ? 'Time\'s up' : y.correct ? 'Correct!' : 'Not quite';
  const ul = el('ul', { class: 'board' }); renderBoard(ul, r.leaderboard, me.user.id);
  const youOutside = y.rank > r.leaderboard.length;
  main.replaceChildren(
    el('div', { class: `result ${cls}` }, el('div', { class: 'big', text: head }),
      el('div', { class: 'num', style: 'font-size:1.3rem;font-weight:800', text: y.correct ? `+${y.points}` : '+0' }),
      !y.correct ? el('p', { class: 'muted', style: 'margin:8px 0 0' }, 'Answer: ', el('b', { text: r.correctLabel })) : null,
      y.streak >= 2 ? el('p', { style: 'margin:8px 0 0;color:var(--gold);font-weight:700', text: `${y.streak} in a row - streak bonus active` }) : null,
      r.explanation ? el('p', { class: 'muted small', style: 'margin:10px 0 0', text: r.explanation }) : null),
    el('div', { class: 'card', style: 'margin-top:14px' },
      el('div', { class: 'row between' }, el('h3', { text: 'Leaderboard' }), el('span', { class: 'pill', text: `You: #${y.rank} - ${y.score.toLocaleString()}` })),
      ul, youOutside ? el('p', { class: 'muted small', text: `You're #${y.rank} of ${y.of}. Keep going!` }) : null),
    el('p', { class: 'muted small', style: 'text-align:center', text: 'Waiting for the next question...' }));
}

function finalView() {
  const f = S.final, ul = el('ul', { class: 'board' }); renderBoard(ul, f.leaderboard, me.user.id);
  main.replaceChildren(
    el('div', { class: 'result good' }, el('div', { class: 'big', text: f.you.rank === 1 ? 'You won! 🏆' : 'Quiz complete' }),
      el('p', { style: 'font-size:1.2rem;margin:6px 0 0' }, `You finished #${f.you.rank} of ${f.you.of} with `, el('b', { class: 'num', text: f.you.score.toLocaleString() }), ' points')),
    el('div', { class: 'card', style: 'margin-top:14px' }, el('h3', { text: 'Final leaderboard' }), ul),
    el('div', { class: 'row', style: 'margin-top:14px;justify-content:center' }, el('button', { class: 'btn', text: 'Join another quiz', onclick: () => { socket?.close(); S.status = 'idle'; lat.classList.add('hidden'); homeView(); } })));
}
