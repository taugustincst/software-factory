import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Optional dashboard login (issue #38). Off unless a token is configured, so the default
 * stays local-only / tailnet-only with no login. One shared token, no accounts:
 *   - the token comes from an environment variable (FACTORY_DASHBOARD_TOKEN, or the name in
 *     factory.json dashboard.tokenEnv) — never a CLI argument, never the file itself;
 *   - comparison is constant-time over SHA-256 digests;
 *   - a successful login sets an HttpOnly, SameSite=Strict session cookie (in memory; a
 *     restart logs everyone out); scripts can send `Authorization: Bearer <token>`;
 *   - repeated wrong tokens from one address are rate-limited.
 */

export const MIN_TOKEN_LENGTH = 16;
export const DEFAULT_TOKEN_ENV = 'FACTORY_DASHBOARD_TOKEN';
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const COOKIE = 'factory_session';

/** The configured token, or null when login is off. Throws on a token too short to be safe. */
export function dashboardToken({ env = process.env, config = {} } = {}) {
  const name = config.dashboard?.tokenEnv ?? DEFAULT_TOKEN_ENV;
  if (!ENV_RE.test(name)) throw new Error(`dashboard.tokenEnv "${name}" is not an environment variable name`);
  if (config.dashboard?.token !== undefined)
    throw new Error('dashboard.token must not be in factory.json; set dashboard.tokenEnv and export the token');
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (value.length < MIN_TOKEN_LENGTH)
    throw new Error(`${name} must be at least ${MIN_TOKEN_LENGTH} characters (try: openssl rand -hex 24)`);
  return { value, env: name };
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function createAuth(
  token,
  { now = () => Date.now(), maxFailures = 5, windowMs = 10 * 60_000, sessionMs = 30 * 24 * 3600_000 } = {},
) {
  const want = digest(token);
  const sessions = new Map();
  const failures = new Map();

  const matches = (candidate) =>
    typeof candidate === 'string' && candidate.length > 0 && timingSafeEqual(digest(candidate), want);

  function cookieValue(req) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }

  return {
    /** Is this request authenticated (session cookie or bearer token)? */
    verify(req) {
      const auth = String(req.headers.authorization ?? '');
      if (auth.startsWith('Bearer ') && matches(auth.slice(7))) return true;
      const id = cookieValue(req);
      if (!id || !/^[0-9a-f]{64}$/.test(id)) return false;
      const exp = sessions.get(id);
      if (!exp) return false;
      if (exp < now()) {
        sessions.delete(id);
        return false;
      }
      return true;
    },
    /** Try a login. Returns { ok, cookie?, status, error? }. */
    login(candidate, ip = 'unknown') {
      const t = now();
      const f = failures.get(ip);
      if (f && f.count >= maxFailures && t - f.first < windowMs)
        return { ok: false, status: 429, error: 'too many attempts; wait a few minutes' };
      if (!matches(candidate)) {
        if (!f || t - f.first >= windowMs) failures.set(ip, { count: 1, first: t });
        else f.count++;
        return { ok: false, status: 401, error: 'wrong token' };
      }
      failures.delete(ip);
      const id = randomBytes(32).toString('hex');
      sessions.set(id, t + sessionMs);
      return {
        ok: true,
        status: 200,
        cookie: `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionMs / 1000)}`,
      };
    },
    logout(req) {
      const id = cookieValue(req);
      if (id) sessions.delete(id);
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    },
    sessionCount: () => sessions.size,
  };
}

/** The login page: phone-sized, no innerHTML, posts the token with fetch (CSP keeps form-action 'none'). */
export const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Factory Floor · Sign in</title>
<style>
:root { --bg: #f6f5f2; --panel: #ffffff; --ink: #1b1a18; --muted: #6b6760; --line: #e3e0d9; --accent: #c2410c; --bad: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #141311; --panel: #1b1a18; --ink: #f1efea; --muted: #a39e94; --line: #34312c; --accent: #f97316; --bad: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; padding: max(16px, env(safe-area-inset-top)) 16px; }
main { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 24px 20px; }
h1 { font-size: 20px; margin: 0 0 6px; display: flex; align-items: center; gap: 10px; }
h1 i { width: 12px; height: 12px; background: var(--accent); display: inline-block; transform: rotate(45deg); }
p { color: var(--muted); margin: 0 0 18px; font-size: 14px; }
label { display: grid; gap: 6px; font-weight: 600; font-size: 14px; }
input { font: 16px/1.4 ui-monospace, monospace; padding: 12px; min-height: 48px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); width: 100%; }
button { margin-top: 16px; width: 100%; min-height: 48px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { opacity: 0.6; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
#err { color: var(--bad); min-height: 1.5em; margin: 12px 0 0; font-size: 14px; }
</style>
</head>
<body>
<main>
<h1><i></i>Factory Floor</h1>
<p>This dashboard needs its login token.</p>
<label for="t">Token <input id="t" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" enterkeyhint="go" /></label>
<button id="go" type="button">Sign in</button>
<p id="err" role="alert"></p>
</main>
<script>
const t = document.getElementById('t');
const go = document.getElementById('go');
const err = document.getElementById('err');
async function submit() {
  go.disabled = true;
  err.textContent = '';
  try {
    const r = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t.value }) });
    if (r.ok) return location.replace('/');
    const b = await r.json().catch(() => ({}));
    err.textContent = b.error || 'Sign-in failed';
  } catch (e) {
    err.textContent = e.message;
  }
  go.disabled = false;
  t.select();
}
go.onclick = submit;
t.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
t.focus();
</script>
</body>
</html>
`;
