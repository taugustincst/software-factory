import { parseArgs } from 'node:util';
import path from 'node:path';
import { color } from '../util.js';
import { loadProject } from '../pipeline/project.js';
import { STAGES } from '../pipeline/stages.js';
import { STAGE_ROLES } from '../harness/index.js';
import { providerReport } from '../providers/router.js';
import { chainFor } from '../providers/config.js';
import { verifyProviders } from '../providers/verify.js';

const out = (s) => process.stdout.write(s);

export async function cmdProviders(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.' },
      json: { type: 'boolean' },
      verify: { type: 'boolean' },
      deep: { type: 'boolean' },
      only: { type: 'string' },
      all: { type: 'boolean' },
    },
  });
  const project = await loadProject(path.resolve(values.dir));
  if (values.verify || values.deep) return verifyCmd(project, values);
  const report = await providerReport({ config: project.config });
  const stages = [
    ...STAGES.filter((s) => !s.deterministic || s.id === 'inspect'),
    { id: 'improve', role: 'generative' },
    { id: 'decide', role: 'decision' },
  ];
  const routes = Object.fromEntries(
    stages.map((s) => [s.id, chainFor(report.routing, s, s.role ?? STAGE_ROLES[s.id]).map((r) => r.route)]),
  );
  if (values.json) return out(`${JSON.stringify({ ...report, routes }, null, 2)}\n`);
  out(
    `${color.bold('Providers')}${report.configured ? '' : color.dim('  (built-in presets; add "providers"/"routing" to factory.json to use more)')}\n`,
  );
  for (const r of report.rows)
    out(
      `${r.available ? color.green('✓') : color.dim('–')} ${r.name.padEnd(11)} ${r.type.padEnd(12)} ${(r.key ?? '').padEnd(28)} ${r.baseUrl ?? ''}${r.priced ? '' : r.type === 'anthropic' || r.type === 'openai' ? color.dim('  (unpriced: cost shows $0)') : ''}\n`,
    );
  out(
    `\n${color.bold('Routing')} (first available wins${report.routing.escalateOnRetry ? '; retries escalate down the chain' : ''})\n`,
  );
  for (const [id, chain] of Object.entries(routes)) out(`  ${id.padEnd(8)} ${chain.join(' → ')}\n`);
  for (const w of report.warnings) out(`${color.yellow('!')} ${w}\n`);
}

export const PROVIDERS_HELP = `
providers (other LLMs)
  factory providers                    The LLMs this repo can use, which are available, and each stage's route
  factory providers --verify [--deep]  Live check: endpoint, key and routed models (--deep adds one tiny
                                       tool-call round trip); says exactly which keys are missing [--only] [--all]
  Configure in factory.json — keys come only from the environment variable a provider names:
    "providers": { "openai": { "apiKeyEnv": "OPENAI_API_KEY", "price": { "input": 2, "output": 8 } } },
    "routing": { "default": ["claude"], "stages": { "spec": ["openai:gpt-4.1-mini", "claude"] },
                 "roles": { "decision": ["ollama:llama3.1"] }, "escalateOnRetry": false }
  Built-in providers: claude (Claude Code), anthropic, openai, gemini, openrouter, groq, ollama, mock.
`;

/** `factory providers --verify [--deep] [--only <name>] [--all]`: live checks, and what is missing. */
async function verifyCmd(project, values) {
  const v = await verifyProviders({
    config: project.config,
    only: values.only ?? null,
    all: Boolean(values.all),
    deep: Boolean(values.deep),
  });
  if (values.json) {
    out(`${JSON.stringify(v, null, 2)}\n`);
  } else {
    out(
      `${color.bold('Provider verification')}${values.deep ? ' (deep: one tiny tool-call round trip each)' : ' (free checks; add --deep for a tool-call round trip)'}\n`,
    );
    for (const r of v.results) {
      const icon = r.status === 'ok' ? color.green('✓') : r.status === 'failed' ? color.red('✗') : color.dim('–');
      out(`${icon} ${r.name.padEnd(11)} ${r.status.padEnd(8)}${v.routed.includes(r.name) ? ' routed' : ''}\n`);
      for (const c of r.checks) out(`    ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}\n`);
      if (r.needs) out(`    needs: ${r.needs}\n`);
    }
    if (!v.results.length) out('Nothing to verify: no provider is routed or has a key here.\n');
    if (v.needs.length) {
      out(`\n${color.bold('To verify the rest')}\n`);
      for (const n of v.needs) out(`  ${n.provider}${n.routed ? ' (routed)' : ''}: ${n.needs}\n`);
    }
  }
  if (!v.ok) process.exitCode = 1;
}
