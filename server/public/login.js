const errEl = document.getElementById('err');
const codeEl = document.getElementById('c');
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const u = document.getElementById('u').value;
  const p = document.getElementById('p').value;
  const c = codeEl.value;
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p, code: c || undefined }),
  });
  if (r.ok) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  errEl.textContent = j.error || 'Login failed';
  if (String(j.error).includes('2fa')) codeEl.style.display = '';
};
