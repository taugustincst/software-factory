import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { gates, gatePassed } from '../src/pipeline/gates.js';
import { inferCommands } from '../src/pipeline/project.js';
import { tmp } from './helpers.js';

function ctxFor(files) {
  const dir = tmp();
  const artifactDir = path.join(dir, 'docs', 'specs', 'x');
  mkdirSync(artifactDir, { recursive: true });
  const artifacts = {
    spec: path.join(artifactDir, 'SPEC.md'),
    plan: path.join(artifactDir, 'PLAN.md'),
    review: path.join(artifactDir, 'REVIEW.md'),
  };
  for (const [k, v] of Object.entries(files)) writeFileSync(artifacts[k], v);
  return { dir, artifactDir, artifacts, project: { commands: { test: 'node -e 0' } }, rel: (p) => path.relative(dir, p) };
}

const SPEC = `# T\n\n## Problem\np\n\n## Requirements\n- R1: a\n- R2: b\n\n## Acceptance Criteria\n- [ ] AC1 (R1): x\n- [ ] AC2 (R2): y\n\n## Out of Scope\nn\n`;

test('spec gate accepts a complete spec and rejects a partial one', async () => {
  assert.ok(gatePassed(await gates.spec(ctxFor({ spec: SPEC }))));
  const partial = await gates.spec(ctxFor({ spec: '# T\n\n## Problem\np\n' }));
  assert.ok(!gatePassed(partial));
  assert.ok(partial.some((c) => c.name.includes('Acceptance Criteria') && !c.ok));
  assert.ok(!gatePassed(await gates.spec(ctxFor({}))), 'missing file fails');
});

test('plan gate requires every acceptance criterion to be covered', async () => {
  const plan = (covers) => `# Plan\n\n## Tasks\n- [ ] T1: do — covers: ${covers}\n\n## Test Strategy\ns\n\n## Risks\n- r → m\n`;
  assert.ok(gatePassed(await gates.plan(ctxFor({ spec: SPEC, plan: plan('AC1, AC2') }))));
  const missing = await gates.plan(ctxFor({ spec: SPEC, plan: plan('AC1') }));
  assert.ok(!gatePassed(missing));
  assert.match(missing.find((c) => !c.ok).detail, /AC2/);
});

test('review gate parses verdicts and blocker lines', async () => {
  const ok = await gates.review(
    ctxFor({ review: '# R\n\nVerdict: APPROVE\n\n## Findings\n- [MINOR] a.js:1 — nit\n\nNo [BLOCKER] items.\n' }),
  );
  assert.ok(gatePassed(ok), JSON.stringify(ok));
  const bold = await gates.review(ctxFor({ review: '# R\n\n**Verdict:** APPROVE\n' }));
  assert.ok(gatePassed(bold), 'bold markdown verdict is accepted');
  const blocked = await gates.review(
    ctxFor({ review: '# R\n\nVerdict: APPROVE\n\n## Findings\n- [BLOCKER] a.js:1 — sql injection — parameterise\n' }),
  );
  assert.ok(!gatePassed(blocked), 'a BLOCKER fails even with APPROVE');
  assert.ok(!gatePassed(await gates.review(ctxFor({ review: 'Verdict: REQUEST_CHANGES' }))));
});

test('infers commands for repos without factory.json', async () => {
  const node = tmp();
  writeFileSync(
    path.join(node, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint .', test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }),
  );
  assert.deepEqual(await inferCommands(node), { install: 'npm install', lint: 'npm run lint', build: 'npm run build' });

  const py = tmp();
  writeFileSync(path.join(py, 'pyproject.toml'), '[tool.uv]\n[tool.ruff]\n[tool.pytest.ini_options]\n');
  const cmds = await inferCommands(py);
  assert.equal(cmds.install, 'uv sync');
  assert.equal(cmds.test, 'uv run pytest -q');
});
