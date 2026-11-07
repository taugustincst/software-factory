import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, dashboardToken, LOGIN_HTML, MIN_TOKEN_LENGTH } from '../src/dashboard/auth.js';
import { startDashboard } from '../src/dashboard/server.js';
import { fixtureRepo, startOnFreePort } from './helpers.js';

const TOKEN = 'a'.repeat(24) + 'Zq9';

test('token source: env only, minimum length, never factory.json', () => {
  assert.equal(dashboardToken({ env: {} }), null, 'off by default');
  assert.equal(dashboardToken({ env: { FACTORY_DASHBOARD_TOKEN: '' } }), null);
  assert.deepEqual(dashboardToken({ env: { FACTORY_DASHBOARD_TOKEN: TOKEN } }), { value: TOKEN, env: 'FACTORY_DASHBOARD_TOKEN' });
  assert.deepEqual(dashboardToken({ env: { MY_TOK: TOKEN }, config: { dashboard: { tokenEnv: 'MY_TOK' } } }).env, 'MY_TOK');
  assert.throws(() => dashboardToken({ env: { FACTORY_DASHBOARD_TOKEN: 'short' } }), new RegExp(`at least ${MIN_TOKEN_LENGTH}`));
  assert.throws(() => dashboardToken({ env: {}, config: { dashboard: { token: TOKEN } } }), /must not be in factory\.json/);
  assert.throws(
    () => dashboardToken({ env: {}, config: { dashboard: { tokenEnv: 'lower case' } } }),
    /not an environment variable name/,
  );
});

test('auth core: constant-time match, sessions, bearer, expiry, rate limit, logout', () => {
  let t = 1_000_000;
  const a = createAuth(TOKEN, { now: () => t, maxFailures: 3, windowMs: 1000, sessionMs: 5000 });
  const req = (headers) => ({ headers });
  assert.equal(a.verify(req({})), false);
  assert.equal(a.verify(req({ authorization: `Bearer ${TOKEN}` })), true);
  assert.equal(a.verify(req({ authorization: 'Bearer nope' })), false);
  assert.equal(a.login('wrong', 'ip1').status, 401);
  assert.equal(a.login(undefined, 'ip1').status, 401);
  assert.equal(a.login('', 'ip1').status, 401);
  assert.equal(a.login(TOKEN, 'ip1').status, 429, 'locked out after 3 failures, even with the right token');
  assert.equal(a.login(TOKEN, 'ip2').ok, true, 'other addresses are unaffected');
  t += 1001;
  const ok = a.login(TOKEN, 'ip1');
  assert.equal(ok.ok, true, 'the window passes');
  assert.match(ok.cookie, /^factory_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=5$/);
  const cookie = ok.cookie.split(';')[0];
  assert.equal(a.verify(req({ cookie: `other=1; ${cookie}` })), true);
  assert.equal(a.verify(req({ cookie: 'factory_session=deadbeef' })), false, 'malformed ids are rejected');
  assert.match(a.logout(req({ cookie })), /Max-Age=0/);
  assert.equal(a.verify(req({ cookie })), false, 'logged out');
  const again = a.login(TOKEN, 'ip3').cookie.split(';')[0];
  t += 5001;
  assert.equal(a.verify(req({ cookie: again })), false, 'sessions expire');
});

test('login page: phone-sized, no innerHTML, posts by fetch', () => {
  assert.match(LOGIN_HTML, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(LOGIN_HTML, /input \{ font: 16px/, '16px so iOS does not zoom');
  assert.match(LOGIN_HTML, /min-height: 48px/);
  assert.doesNotMatch(LOGIN_HTML, /innerHTML|<form/);
  assert.match(LOGIN_HTML, /fetch\('\/login'/);
});

test('dashboard without a token: unchanged, no login', async () => {
  const { dir } = fixtureRepo();
  const { server, url } = await startOnFreePort(startDashboard, { dir });
  try {
    assert.equal((await fetch(`${url}/api/runs`)).status, 200);
    assert.equal((await (await fetch(`${url}/api/project`)).json()).auth, false);
    assert.equal((await fetch(`${url}/login`)).status, 404, 'no login route when login is off');
  } finally {
    server.close();
  }
});

test('dashboard with a token: everything but /login needs a session or bearer', async () => {
  const { dir } = fixtureRepo();
  const { server, url } = await startOnFreePort(startDashboard, { dir, token: TOKEN });
  try {
    const page = await fetch(`${url}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
    assert.equal((await fetch(`${url}/api/runs`)).status, 401);
    const login = await fetch(`${url}/login`);
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-security-policy'), /form-action 'none'/, 'CSP unchanged');
    const post = (body, headers = { 'Content-Type': 'application/json', Origin: url }) =>
      fetch(`${url}/login`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post({ token: TOKEN }, { 'Content-Type': 'application/json' })).status, 403, 'login needs same Origin');
    assert.equal((await post({ token: TOKEN }, { Origin: url })).status, 415);
    assert.equal((await post({ token: 'wrong' })).status, 401);
    const ok = await post({ token: TOKEN });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${url}/api/runs`, { headers: { cookie } })).status, 200);
    assert.equal((await (await fetch(`${url}/api/project`, { headers: { cookie } })).json()).auth, true);
    assert.equal((await fetch(`${url}/`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${url}/api/runs`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
    // A logged-in session still needs same-origin POSTs.
    const cross = await fetch(`${url}/api/runs`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    assert.equal(cross.status, 403);
    assert.equal((await fetch(`${url}/logout`, { method: 'POST', headers: { cookie } })).status, 403, 'logout needs same Origin');
    await fetch(`${url}/logout`, { method: 'POST', headers: { cookie, Origin: url } });
    assert.equal((await fetch(`${url}/api/runs`, { headers: { cookie } })).status, 401);
  } finally {
    server.close();
  }
});

test('UI: sign-out only when login is on, and a 401 returns to sign-in', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="signout" type="button" hidden>Sign out</);
  assert.match(html, /if \(p\.auth\)/);
  assert.match(html, /r\.status === 401[\s\S]{0,80}location\.replace\('\/login'\)/);
});
