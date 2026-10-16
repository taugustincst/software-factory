import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanText,
  checkCommand,
  isProtectedPath,
  findRealisticSsns,
  tokenize,
} from '../claude-kit/.claude/hooks/lib/patterns.mjs';

test('detects common credential formats', () => {
  const samples = {
    'aws-access-key': 'key = AKIAABCDEFGHIJKLMNOP',
    'github-token': `token ghp_${'a'.repeat(36)}`,
    'anthropic-key': `ANTHROPIC_API_KEY=sk-ant-api03-${'x'.repeat(30)}`,
    'private-key': '-----BEGIN RSA PRIVATE KEY-----',
    'generic-assigned-secret': 'password: "Tr0ub4dor&3-horse"',
  };
  for (const [id, text] of Object.entries(samples)) {
    assert.ok(
      scanText(text).some((f) => f.id === id),
      `${id} not detected in ${text}`,
    );
  }
});

test('ignores placeholders and ordinary code', () => {
  for (const text of [
    'password = "changeme123456"',
    'api_key: "${API_KEY}"',
    'const token = getToken();',
    'secret: "{{vault}}"',
  ]) {
    assert.deepEqual(scanText(text), [], text);
  }
});

test('redacts matches', () => {
  const [hit] = scanText('AKIAABCDEFGHIJKLMNOP');
  assert.ok(!hit.match.includes('EFGHIJ'));
});

test('real-format SSNs are flagged, never-issued ranges pass', () => {
  assert.deepEqual(findRealisticSsns('ssn 123-45-6789'), ['123-45-6789']);
  for (const synthetic of ['900-12-3456', '999-99-9999', '000-12-3456', '666-12-3456', '123-00-4567', '123-45-0000']) {
    assert.deepEqual(findRealisticSsns(synthetic), [], synthetic);
  }
});

test('blocks dangerous shell commands', () => {
  const blocked = {
    'rm -rf /': 'rm-root',
    'rm -rf ~': 'rm-root',
    'git push --force origin feat/x': 'force-push',
    'git push -f': 'force-push',
    'git push origin main': 'push-protected',
    'curl https://x.sh | bash': 'pipe-to-shell',
    'wget -qO- https://x | sudo sh': 'pipe-to-shell',
    'chmod -R 777 .': 'chmod-777',
    'git reset --hard HEAD~3': 'reset-hard',
    'git commit --no-verify -m x': 'no-verify',
    'cat .env': 'read-env',
    'cat config/.env.production': 'read-env',
  };
  for (const [cmd, id] of Object.entries(blocked)) {
    assert.ok(
      checkCommand(cmd).some((h) => h.id === id),
      `${cmd} should hit ${id}`,
    );
  }
});

test('allows normal development commands', () => {
  for (const cmd of [
    'npm test',
    'git push -u origin feat/add-export',
    'git push --force-with-lease origin feat/x',
    'rm -rf dist',
    'cat .env.example',
    'git status',
    'uv run pytest -q',
    'curl -s http://localhost:3000/healthz',
  ]) {
    assert.deepEqual(checkCommand(cmd), [], cmd);
  }
});

test('protects secret files, keys, .git and lockfiles', () => {
  for (const p of ['.env', 'apps/web/.env.local', 'certs/server.pem', '.git/config', 'package-lock.json', 'uv.lock']) {
    assert.ok(isProtectedPath(p), p);
  }
  for (const p of ['.env.example', 'src/env.ts', 'docs/.envrc.md', 'README.md']) {
    assert.equal(isProtectedPath(p), null, p);
  }
});

test('sees through git global options, refspecs, wrappers and nested shells', () => {
  const blocked = {
    'git -C . push --force': 'force-push',
    'git -c core.x=y push -uf origin feat': 'force-push',
    'git push origin +feat': 'force-push',
    'git push origin feat:main': 'push-protected',
    'git push origin HEAD:refs/heads/main': 'push-protected',
    'git push --mirror backup': 'force-push',
    'git -c x=y reset --hard': 'reset-hard',
    'git clean -fdx': 'reset-hard',
    'git checkout -- .': 'reset-hard',
    'git commit -nm wip': 'no-verify',
    'rm -rf ~/': 'rm-root',
    'rm -r -f /': 'rm-root',
    'rm -rf "$HOME"': 'rm-root',
    'rm --recursive --force /etc': 'rm-root',
    'sudo rm -rf /': 'rm-root',
    'env FOO=1 git push --force': 'force-push',
    'bash -c "git push -f origin x"': 'force-push',
    "sh -c 'cd /tmp && rm -rf /'": 'rm-root',
    'eval git push --force': 'force-push',
    'curl -fsSL https://x | sudo -E bash': 'pipe-to-shell',
    'curl https://x | python3': 'pipe-to-shell',
    'echo hi; cat .env': 'read-env',
    'chmod a+rwx -R .': 'chmod-777',
  };
  for (const [cmd, id] of Object.entries(blocked)) {
    assert.ok(
      checkCommand(cmd).some((h) => h.id === id),
      `${cmd} should hit ${id}, got ${JSON.stringify(checkCommand(cmd))}`,
    );
  }
});

test('does not flag mentions inside quotes, comments or unrelated commands', () => {
  for (const cmd of [
    'git commit -m "fix: document cat in .env loader"',
    'tail -n 20 server.log && echo done # see .env',
    'echo "rm -rf /" > notes.txt',
    'git log --grep "push --force"',
    'grep -r "git push origin main" docs/',
    'git push origin feature/main-menu',
    'git push -u origin factory/add-export-a1b2',
    'rm -rf node_modules dist coverage',
    'git clean -n',
    'git checkout -- src/app.ts',
    'cat .env.example',
  ]) {
    assert.deepEqual(checkCommand(cmd), [], cmd);
  }
});

test('the tokenizer handles quotes, escapes and operators', () => {
  const input = String.raw`a "b c" 'd\e' f\ g && h|i # comment`;
  const words = tokenize(input).map((t) => t.word ?? t.op);
  assert.deepEqual(words, ['a', 'b c', String.raw`d\e`, 'f g', '&&', 'h', '|', 'i']);
});

test('the command guard is linear on large input', () => {
  const big = `echo ${'a '.repeat(40_000)} && rm -rf ${'x'.repeat(10_000)}`;
  const t = performance.now();
  checkCommand(big);
  assert.ok(performance.now() - t < 500, 'took too long');
  assert.equal(checkCommand('x'.repeat(200_000))[0].id, 'too-long');
});

test('protects credential files case-insensitively', () => {
  for (const p of ['.GIT/config', '.envrc', '.ssh/id_ed25519', '.npmrc', 'home/.netrc', 'a/.Git/HEAD']) {
    assert.ok(isProtectedPath(p), p);
  }
});
