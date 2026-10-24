import { api, guard, el, $, toast, connectSocket, renderBoard, runTimer, clockOffset, brandBar, logout, LETTERS } from './common.js';

const me = guard('teacher');
const app = $('#app');
let socket = null, stopTimer = null;

// ============ routing (hash based so refresh keeps you in place) ============
window.addEventListener('hashchange', route);
route();

function route() {
  socket?.close(); socket = null; stopTimer?.();
  const [view, arg] = location.hash.slice(1).split('/');
  app.replaceChildren(brandBar(`${me.user.name} - teacher`, logout));
  const wrap = el('main', { class: 'wrap' });
  app.append(wrap);
  if (view === 'host' && arg) hostView(wrap, arg.toUpperCase());
  else if (view === 'results' && arg) resultsView(wrap, arg);
  else dashboard(wrap);
}

// ============ dashboard ============
async function dashboard(root) {
  const draft = { questions: [], topic: '', difficulty: 'medium', source: 'manual' };
  const createCard = el('section', { class: 'card' });
  const editorSlot = el('div');
  const quizzesSlot = el('section', { class: 'card' });
  const sessionsSlot = el('section', { class: 'card' });
  root.append(
    el('h1', { text: 'Teacher dashboard' }),
    el('div', { class: 'grid' }, createCard, editorSlot, el('div', { class: 'grid two' }, quizzesSlot, sessionsSlot)));

  // ---- generator form ----
  const f = {
    topic: el('input', { id: 'topic', maxlength: 200, placeholder: 'e.g. Photosynthesis, World War II, Python loops' }),
    type: el('select', { id: 'type' }, el('option', { value: 'mcq', text: 'Multiple choice' }), el('option', { value: 'true_false', text: 'True / False' }), el('option', { value: 'short_answer', text: 'Short answer' })),
    count: el('input', { id: 'count', type: 'number', min: 1, max: 20, value: 5 }),
    difficulty: el('select', { id: 'difficulty' }, ...['easy', 'medium', 'hard'].map((d) => el('option', { value: d, text: d[0].toUpperCase() + d.slice(1), selected: d === 'medium' }))),
  };
  const genBtn = el('button', { class: 'btn', type: 'button', text: 'Generate with AI' });
  const blankBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Start from blank' });
  const genMsg = el('div', { class: 'msg info hidden' });
  createCard.append(
    el('h2', { text: 'Create a quiz' }),
    el('div', { class: 'field' }, el('label', { for: 'topic', text: 'Topic' }), f.topic),
    el('div', { class: 'fields' },
      el('div', { class: 'field' }, el('label', { for: 'type', text: 'Question type' }), f.type),
      el('div', { class: 'field' }, el('label', { for: 'count', text: 'How many (1-20)' }), f.count),
      el('div', { class: 'field' }, el('label', { for: 'difficulty', text: 'Difficulty' }), f.difficulty)),
    el('div', { class: 'row' }, genBtn, blankBtn), genMsg);

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true; genBtn.textContent = 'Generating...';
    try {
      const out = await api('/quizzes/generate', { method: 'POST', body: { topic: f.topic.value, type: f.type.value, count: f.count.value, difficulty: f.difficulty.value } });
      Object.assign(draft, { questions: out.questions, topic: out.topic, difficulty: out.difficulty, source: out.source, title: `${out.topic} quiz` });
      genMsg.textContent = out.warning || (out.aiEnabled ? `Generated ${out.questions.length} questions via ${out.source}. Review and edit before saving.` : `AI key not set - loaded ${out.questions.length} sample questions from the offline bank. Add NEBIUS_API_KEY to generate on any topic.`);
      genMsg.classList.remove('hidden');
      drawEditor();
    } catch (e) { toast(e.message); } finally { genBtn.disabled = false; genBtn.textContent = 'Generate with AI'; }
  });
  blankBtn.addEventListener('click', () => {
    Object.assign(draft, { questions: [blankQuestion(f.type.value)], topic: f.topic.value, difficulty: f.difficulty.value, source: 'manual', title: f.topic.value || 'My quiz' });
    drawEditor();
  });

  // ---- review editor ----
  function drawEditor() {
    const title = el('input', { value: draft.title || '', maxlength: 120, 'aria-label': 'Quiz title' });
    title.addEventListener('input', () => { draft.title = title.value; });
    const list = el('div');
    const paint = () => list.replaceChildren(...draft.questions.map((q, i) => questionEditor(q, i, () => { draft.questions.splice(i, 1); paint(); })));
    paint();
    const limit = el('input', { type: 'number', min: 5, max: 120, value: 20, style: 'width:90px', 'aria-label': 'Seconds per question' });
    const save = async (host) => {
      try {
        const out = await api('/quizzes', { method: 'POST', body: { title: draft.title, topic: draft.topic, difficulty: draft.difficulty, source: draft.source, questions: draft.questions } });
        toast('Quiz saved');
        if (host) return hostQuiz(out.id, limit.value);
        editorSlot.replaceChildren(); refreshLists();
      } catch (e) { toast(e.message, 4000); }
    };
    editorSlot.replaceChildren(el('section', { class: 'card' },
      el('div', { class: 'row between' }, el('h2', { text: 'Review & edit' }), el('span', { class: 'pill', text: `${draft.questions.length} questions` })),
      el('div', { class: 'field' }, el('label', { text: 'Quiz title' }), title),
      list,
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('button', { class: 'btn ghost', text: '+ Add question', onclick: () => { draft.questions.push(blankQuestion(f.type.value)); paint(); } })),
      el('div', { class: 'row', style: 'margin-top:18px' },
        el('button', { class: 'btn ghost', text: 'Save quiz', onclick: () => save(false) }),
        el('label', { style: 'margin:0;display:flex;align-items:center;gap:8px' }, 'Seconds / question', limit),
        el('button', { class: 'btn', text: 'Save & go live', onclick: () => save(true) }))));
    editorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- saved quizzes + sessions ----
  async function refreshLists() {
    const [{ quizzes }, { sessions }] = await Promise.all([api('/quizzes'), api('/sessions')]);
    quizzesSlot.replaceChildren(el('h2', { text: 'My quizzes' }), quizzes.length ? el('ul', { class: 'list' }, ...quizzes.map((q) => {
      const secs = el('select', { 'aria-label': 'Seconds per question' }, ...[10, 15, 20, 30, 45, 60].map((s) => el('option', { value: s, text: `${s}s`, selected: s === 20 })));
      secs.style.width = '76px';
      return el('li', {},
        el('div', {}, el('b', { text: q.title }), el('div', { class: 'muted small', text: `${q.count} questions - ${q.difficulty}${q.source.startsWith('nebius') ? ' - AI' : ''}` })),
        el('div', { class: 'row' }, secs,
          el('button', { class: 'btn', text: 'Go live', onclick: () => hostQuiz(q.id, secs.value) }),
          el('button', { class: 'btn danger', 'aria-label': `Delete ${q.title}`, text: 'Delete', onclick: async () => { if (confirm(`Delete "${q.title}"?`)) { await api(`/quizzes/${q.id}`, { method: 'DELETE' }); refreshLists(); } } })));
    })) : el('p', { class: 'muted', text: 'No quizzes yet. Generate one above.' }));

    sessionsSlot.replaceChildren(el('h2', { text: 'Recent sessions' }), sessions.length ? el('ul', { class: 'list' }, ...sessions.map((s) =>
      el('li', {},
        el('div', {}, el('b', { text: s.title }), el('div', { class: 'muted small', text: `${s.code} - ${s.players} players - ${s.status}` })),
        s.live ? el('a', { class: 'btn', href: `#host/${s.code}`, text: 'Open' }) : el('a', { class: 'btn ghost', href: `#results/${s.id}`, text: 'Results' })))) : el('p', { class: 'muted', text: 'Sessions you host will appear here.' }));
  }
  refreshLists().catch((e) => toast(e.message));
}

async function hostQuiz(quizId, timeLimit) {
  try {
    const { code } = await api('/sessions', { method: 'POST', body: { quizId, timeLimit } });
    location.hash = `#host/${code}`;
  } catch (e) { toast(e.message); }
}

function blankQuestion(type) {
  if (type === 'true_false') return { type, text: '', options: ['True', 'False'], answer: 0, explanation: '' };
  if (type === 'short_answer') return { type, text: '', options: [], accepted: [''], explanation: '' };
  return { type: 'mcq', text: '', options: ['', '', '', ''], answer: 0, explanation: '' };
}

function questionEditor(q, i, onRemove) {
  const text = el('textarea', { 'aria-label': `Question ${i + 1}`, maxlength: 400 }, q.text);
  text.value = q.text; text.addEventListener('input', () => { q.text = text.value; });
  const expl = el('input', { placeholder: 'Explanation shown after the answer (optional)', value: q.explanation || '', maxlength: 600 });
  expl.addEventListener('input', () => { q.explanation = expl.value; });
  let body;
  if (q.type === 'short_answer') {
    const acc = el('input', { value: (q.accepted || []).join(', '), placeholder: 'Accepted answers, comma separated' });
    acc.addEventListener('input', () => { q.accepted = acc.value.split(',').map((s) => s.trim()).filter(Boolean); });
    body = el('div', { class: 'field', style: 'margin-top:10px' }, el('label', { text: 'Accepted answers (any match is correct)' }), acc);
  } else {
    body = el('div', { class: 'opts' }, ...q.options.map((o, k) => {
      const radio = el('input', { type: 'radio', name: `ans${i}-${q.text.length}-${Math.random()}`, checked: q.answer === k, 'aria-label': `Option ${LETTERS[k]} is correct` });
      radio.addEventListener('change', () => { q.answer = k; });
      const inp = el('input', { value: o, maxlength: 200, readonly: q.type === 'true_false', 'aria-label': `Option ${LETTERS[k]}`, placeholder: `Option ${LETTERS[k]}` });
      inp.addEventListener('input', () => { q.options[k] = inp.value; });
      return el('div', { class: 'optrow' }, radio, inp);
    }));
    // radios in one group
    const g = `g${Math.random().toString(36).slice(2)}`;
    body.querySelectorAll('input[type=radio]').forEach((r) => { r.name = g; });
  }
  return el('div', { class: 'qedit' },
    el('div', { class: 'row between' }, el('b', { text: `Q${i + 1} - ${{ mcq: 'Multiple choice', true_false: 'True / False', short_answer: 'Short answer' }[q.type]}` }),
      el('button', { class: 'btn danger', type: 'button', text: 'Remove', onclick: onRemove })),
    text, body, el('div', { style: 'margin-top:10px' }, expl));
}

// ============ host console ============
function hostView(root, code) {
  const S = { status: 'connecting', players: [], leaderboard: [], answered: 0, offset: 0, question: null, reveal: null, qIndex: -1, total: 0, title: '', rtt: null };
  const view = el('div', { class: 'grid' });
  const lat = el('div', { class: 'latency', text: 'connecting...' });
  root.append(view); document.body.append(lat);

  socket = connectSocket({
    onOpen: () => socket.send({ type: 'host', code }),
    onStatus: (s, v) => { lat.textContent = s === 'rtt' ? `live - ${v} ms` : s === 'online' ? 'live' : 'reconnecting...'; },
    onMessage: (m) => {
      switch (m.type) {
        case 'host_state': Object.assign(S, { status: m.status, title: m.title, total: m.total, qIndex: m.qIndex, players: m.players, leaderboard: m.leaderboard, question: m.question || null, answered: m.answered || 0, timeLimit: m.timeLimit, offset: clockOffset(m.serverNow) }); S.reveal = null; break;
        case 'players': S.players = m.players; break;
        case 'question': S.status = 'question'; S.question = m; S.qIndex = m.index; S.total = m.total; S.answered = 0; S.reveal = null; S.offset = clockOffset(m.serverNow); break;
        case 'answer_count': S.answered = m.answered; break;
        case 'reveal': S.status = 'reveal'; S.reveal = m; S.leaderboard = m.leaderboard; break;
        case 'finished': S.status = 'finished'; S.leaderboard = m.leaderboard; break;
        case 'error': view.replaceChildren(el('div', { class: 'card' }, el('h2', { text: m.error }), el('a', { class: 'btn', href: '#', text: 'Back to dashboard' }))); return;
        default: return;
      }
      draw();
    },
  });
  // remove the latency chip when leaving the view
  window.addEventListener('hashchange', () => lat.remove(), { once: true });

  function draw() {
    stopTimer?.();
    const joinUrl = `${location.origin}/student?code=${code}`;
    const header = el('section', { class: 'card' },
      el('div', { class: 'row between' },
        el('div', {}, el('div', { class: 'muted small', text: `${S.title}` }), el('div', { class: 'muted' }, 'Students join at ', el('b', { text: `${location.host}/student` }), ' with code')),
        el('span', { class: S.status === 'finished' ? 'pill' : 'pill live', text: S.status === 'lobby' ? 'Lobby' : S.status === 'finished' ? 'Finished' : `Question ${S.qIndex + 1} / ${S.total}` })),
      el('div', { class: 'code num', text: code, 'aria-label': `Join code ${code.split('').join(' ')}` }),
      el('button', { class: 'btn ghost', text: 'Copy join link', onclick: () => navigator.clipboard?.writeText(joinUrl).then(() => toast('Link copied')) }));
    const parts = [header];

    if (S.status === 'lobby' || S.status === 'connecting') {
      parts.push(el('section', { class: 'card' },
        el('div', { class: 'row between' }, el('h2', { text: `Players (${S.players.length})` }),
          el('button', { class: 'btn big', text: 'Start quiz', disabled: !S.players.length, onclick: () => socket.send({ type: 'next' }) })),
        S.players.length ? el('div', { class: 'chips' }, ...S.players.map((p) => el('span', { class: `chip ${p.online ? '' : 'off'}`, text: p.name }))) : el('p', { class: 'muted', text: 'Waiting for students to join...' })));
    }

    if (S.status === 'question' && S.question) {
      const q = S.question;
      const bar = el('i'); const secs = el('b', { class: 'num' });
      parts.push(el('section', { class: 'card' },
        el('div', { class: 'row between' }, el('span', { class: 'muted', text: `Answered ${S.answered} / ${S.players.length}` }), el('span', {}, secs, 's')),
        el('div', { class: 'timerbar' }, bar),
        el('div', { class: 'qtext', text: q.text }),
        q.options.length ? optionList(q, q.answer) : el('p', { class: 'muted', text: 'Students are typing their answers...' }),
        el('div', { class: 'row', style: 'margin-top:16px' }, el('button', { class: 'btn', text: 'Close question now', onclick: () => socket.send({ type: 'reveal' }) }))));
      queueMicrotask(() => { stopTimer = runTimer(bar, secs, q.endsAt, q.timeLimit, S.offset); });
    }

    if (S.status === 'reveal' && !S.reveal) {
      parts.push(el('section', { class: 'card' }, el('p', { class: 'muted', text: 'Question closed.' }),
        el('button', { class: 'btn big', text: S.qIndex + 1 >= S.total ? 'Finish quiz' : 'Next question', onclick: () => socket.send({ type: 'next' }) })));
    }

    if (S.status === 'reveal' && S.reveal) {
      const r = S.reveal; const last = r.index + 1 >= r.total;
      const q = S.question || {};
      parts.push(el('section', { class: 'card' },
        el('div', { class: 'qtext', text: q.text || `Question ${r.index + 1}` }),
        el('div', { class: 'stats' },
          el('div', { class: 'stat' }, el('b', { text: `${r.accuracy}%` }), 'correct'),
          el('div', { class: 'stat' }, el('b', { text: `${r.answered}` }), 'answered'),
          el('div', { class: 'stat' }, el('b', { text: r.correctLabel }), 'answer')),
        q.options?.length ? optionList(q, r.correctIndex, r.distribution) : null,
        r.explanation ? el('p', { class: 'muted', style: 'margin-top:12px', text: r.explanation }) : null,
        el('div', { class: 'row', style: 'margin-top:14px' }, el('button', { class: 'btn big', text: last ? 'Finish quiz' : 'Next question', onclick: () => socket.send({ type: 'next' }) }))));
    }

    if (S.status === 'finished') {
      parts.push(el('section', { class: 'card' }, el('h2', { text: 'Final results' }), podium(S.leaderboard),
        el('div', { class: 'row' }, el('a', { class: 'btn', href: '#', id: 'toResults', text: 'Results & AI insights' }), el('a', { class: 'btn ghost', href: '#', text: 'Dashboard' }))));
    }

    if (S.status !== 'lobby' && S.status !== 'connecting' && S.status !== 'finished') {
      const ul = el('ul', { class: 'board' }); renderBoard(ul, S.leaderboard);
      parts.push(el('section', { class: 'card' }, el('div', { class: 'row between' }, el('h2', { text: 'Live leaderboard' }), el('span', { class: 'pill live', text: 'updates after each question' })), S.leaderboard.length ? ul : el('p', { class: 'muted', text: 'Scores appear after the first question.' })));
    }
    view.replaceChildren(...parts.filter(Boolean));

    const toRes = $('#toResults');
    if (toRes) api('/sessions').then(({ sessions }) => { const s = sessions.find((x) => x.code === code); if (s) toRes.href = `#results/${s.id}`; });
  }
  draw();
}

function optionList(q, correctIndex, dist) {
  return el('div', { class: `options ${(q.kind || q.type) === 'true_false' ? 'tf' : ''}` }, ...q.options.map((o, k) =>
    el('div', { class: `opt ${dist && correctIndex !== k ? 'dim' : ''} ${dist && correctIndex === k ? 'right' : ''}`, style: 'cursor:default' },
      el('span', { class: 'ltr', text: LETTERS[k] }), o, dist ? el('span', { class: 'count', text: dist[k] }) : null)));
}

function podium(board) {
  const [a, b, c] = board;
  const cell = (p, cls) => p ? el('div', { class: cls }, el('b', { text: `#${p.rank}` }), el('div', { text: p.name }), el('div', { class: 'num', text: p.score.toLocaleString() })) : null;
  return el('div', {}, el('div', { class: 'podium' }, cell(b, 'p2'), cell(a, 'p1'), cell(c, 'p3')));
}

// ============ results ============
async function resultsView(root, id) {
  root.append(el('a', { href: '#', text: '< Dashboard' }));
  try {
    const { session, players, perQuestion } = await api(`/sessions/${id}/results`);
    const insight = el('div', { class: 'insight hidden' });
    const btn = el('button', { class: 'btn', text: 'Generate AI insights', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Thinking...';
      try { const out = await api(`/sessions/${id}/insights`, { method: 'POST' }); insight.textContent = out.text; insight.classList.remove('hidden'); } catch (e) { toast(e.message); }
      btn.disabled = false; btn.textContent = 'Regenerate';
    } });
    const csv = el('button', { class: 'btn ghost', text: 'Download CSV', onclick: () => {
      const rows = [['Rank', 'Name', 'Score', 'Best streak'], ...players.map((p) => [p.rank, p.name, p.score, p.best_streak])];
      const blob = new Blob([rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `quizforge-${session.code}.csv` }); a.click();
    } });
    const ul = el('ul', { class: 'board' }); renderBoard(ul, players);
    root.append(
      el('h1', { text: session.title }),
      el('div', { class: 'grid two' },
        el('section', { class: 'card' }, el('h2', { text: `Leaderboard (${players.length})` }), players.length ? ul : el('p', { class: 'muted', text: 'Nobody played this session.' }), csv),
        el('section', { class: 'card' }, el('h2', { text: 'Question accuracy' }), el('ul', { class: 'list' }, ...perQuestion.map((q, i) =>
          el('li', {}, el('div', {}, el('b', { text: `Q${i + 1}` }), ` ${q.text.slice(0, 70)}${q.text.length > 70 ? '...' : ''}`), el('span', { class: 'pill num', text: `${q.accuracy}% - ${q.avgSeconds}s` }))))),
      ),
      el('section', { class: 'card' }, el('h2', { text: 'AI teaching insights' }), el('p', { class: 'muted', text: 'Summarises what the class understood and what to re-teach.' }), insight, btn));
  } catch (e) { root.append(el('div', { class: 'msg', text: e.message })); }
}
