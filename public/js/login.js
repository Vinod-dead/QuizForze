import { api, auth, $, show } from './common.js';

let role = 'student', mode = 'login';

const existing = auth.get();
if (existing) location.href = `/${existing.user.role}`;

function paint() {
  $('#authTitle').textContent = mode === 'login' ? 'Sign in' : `Create ${role} account`;
  $('#submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  show($('#nameField'), mode === 'register');
  $('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#switchText').textContent = mode === 'login' ? 'New here?' : 'Already have an account?';
  $('#switchLink').textContent = mode === 'login' ? 'Create an account' : 'Sign in';
  for (const b of document.querySelectorAll('#roleTabs button')) b.setAttribute('aria-selected', String(b.dataset.role === role));
}

for (const b of document.querySelectorAll('#roleTabs button')) b.addEventListener('click', () => { role = b.dataset.role; paint(); });
$('#switchLink').addEventListener('click', (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; show($('#err'), false); paint(); });

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#submit'); btn.disabled = true; show($('#err'), false);
  try {
    const body = { email: $('#email').value, password: $('#password').value };
    if (mode === 'register') Object.assign(body, { name: $('#name').value, role });
    const out = await api(`/auth/${mode}`, { method: 'POST', body });
    if (mode === 'login' && out.user.role !== role) {
      throw new Error(`This account is a ${out.user.role} account - switch the tab above.`);
    }
    auth.set(out);
    location.href = `/${out.user.role}`;
  } catch (err) {
    const box = $('#err'); box.textContent = err.message; show(box);
  } finally { btn.disabled = false; }
});
paint();
