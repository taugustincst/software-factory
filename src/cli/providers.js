import { parseArgs } from 'node:util';
import path from 'node:path';
import { color } from '../util.js';
import { loadProject } from '../pipeline/project.js';
import { STAGES } from '../pipeline/stages.js';
import { STAGE_ROLES } from '../harness/index.js';
import { providerReport } from '../providers/router.js';
import { chainFor } from '../providers/config.js';

const out = (s) => process.stdout.write(s);

export async function cmdProviders(argv) {
  const { values } = parseArgs({ args: argv, options: { dir: { type: 'string', default: '.' }, json: { type: 'boolean' } } });
  const project = await loadProject(path.resolve(values.dir));
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
  Configure in factory.json — keys come only from the environment variable a provider names:
    "providers": { "openai": { "apiKeyEnv": "OPENAI_API_KEY", "price": { "input": 2, "output": 8 } } },
    "routing": { "default": ["claude"], "stages": { "spec": ["openai:gpt-4.1-mini", "claude"] },
                 "roles": { "decision": ["ollama:llama3.1"] }, "escalateOnRetry": false }
  Built-in providers: claude (Claude Code), anthropic, openai, gemini, openrouter, groq, ollama, mock.
`;
