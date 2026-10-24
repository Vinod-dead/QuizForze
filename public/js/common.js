// Shared client helpers: auth storage, API wrapper, resilient WebSocket, tiny DOM utils.
const KEY = 'quizforge.auth';

export const auth = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } },
  set(v) { localStorage.setItem(KEY, JSON.stringify(v)); },
  clear() { localStorage.removeItem(KEY); },
};

export async function api(path, { method = 'GET', body } = {}) {
  const a = auth.get();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(a ? { Authorization: `Bearer ${a.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && a) { auth.clear(); location.href = '/'; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Redirects to the sign-in page unless a user with the right role is signed in. */
export function guard(role) {
  const a = auth.get();
  if (!a || a.user.role !== role) { location.href = '/'; return null; }
  return a;
}

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const show = (n, on = true) => n.classList.toggle('hidden', !on);

export function toast(text, ms = 2600) {
  const t = el('div', { class: 'toast', role: 'status', text });
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/** WebSocket with auto-reconnect, RTT ping and a message handler. */
export function connectSocket({ onMessage, onStatus, onOpen }) {
  const a = auth.get();
  let ws, alive = true, retry = 0, pingTimer;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  function open() {
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(a.token)}`);
    ws.onopen = () => {
      retry = 0; onStatus?.('online'); onOpen?.();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', t: performance.now() })), 4000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') return onStatus?.('rtt', Math.round(performance.now() - m.t));
      onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (!alive) return;
      onStatus?.('offline');
      setTimeout(open, Math.min(5000, 400 * 2 ** retry++));
    };
  }
  open();
  return {
    send: (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m)),
    close: () => { alive = false; ws?.close(); },
  };
}

/** Keeps the browser clock honest relative to the server (for countdown display only). */
export function clockOffset(serverNow) { return serverNow - Date.now(); }

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function renderBoard(ul, rows, meId) {
  ul.replaceChildren(...rows.map((r) =>
    el('li', { class: r.id === meId ? 'me' : '' },
      el('span', { class: 'rk', text: r.rank }),
      el('span', { class: 'nm', text: r.name }),
      el('span', { class: 'sc', text: r.score.toLocaleString() }))));
}

/** Smooth countdown bar; returns a stop function. */
export function runTimer(bar, label, endsAt, timeLimit, offset) {
  let raf;
  const total = timeLimit * 1000;
  const tick = () => {
    const left = Math.max(0, endsAt - (Date.now() + offset));
    bar.style.transform = `scaleX(${left / total})`;
    bar.style.backgroundPosition = `${100 - (left / total) * 100}% 0`;
    if (label) label.textContent = Math.ceil(left / 1000);
    if (left > 0) raf = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(raf);
}

export function brandBar(who, onLogout) {
  return el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: '/' }, el('span', { class: 'logo', text: 'Q' }), 'QuizForge'),
    el('div', { class: 'row' },
      el('span', { class: 'muted small who', text: who }),
      el('button', { class: 'btn ghost', onclick: onLogout, text: 'Sign out' })));
}

export function logout() { auth.clear(); location.href = '/'; }
