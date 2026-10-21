import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATES_DIR, run } from './util.js';
import { installClaudeKit } from './claude-kit.js';
import { writeBaseSnapshot } from './upgrade-base.js';

const TOKEN = /\{\{factory\.([a-zA-Z][\w]*)\}\}/g;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.pdf', '.zip']);
/** Files stored under a safe name in the template and renamed on output. */
const RENAMES = { _gitignore: '.gitignore', _dockerignore: '.dockerignore', _npmrc: '.npmrc' };

/** Pinned to an immutable commit so generated repos run a known factory version in CI. Bump on release. */
export const FACTORY_PACKAGE = 'github:taugustincst/software-factory#b214252603d86ad139d0fdb59a34483ae507bc1c';

export const DESCRIPTION_RE = /^[^"\\<>`$\n\r{}]{1,200}$/;
export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export async function listTemplates() {
  const names = (await fs.readdir(TEMPLATES_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
  return Promise.all(names.map(loadTemplate));
}

export async function loadTemplate(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid template name "${name}"`);
  const file = path.join(TEMPLATES_DIR, name, 'template.json');
  if (!existsSync(file)) {
    const available = (await fs.readdir(TEMPLATES_DIR)).filter((n) => !n.startsWith('_')).join(', ');
    throw new Error(`unknown template "${name}". Available: ${available}`);
  }
  const meta = JSON.parse(await fs.readFile(file, 'utf8'));
  return { ...meta, id: name, dir: path.join(TEMPLATES_DIR, name, 'files') };
}

export function render(text, vars, fileForErrors) {
  return text.replace(TOKEN, (_, key) => {
    if (!(key in vars)) throw new Error(`template variable {{factory.${key}}} has no value (in ${fileForErrors})`);
    return String(vars[key]);
  });
}

async function copyTree(srcDir, dstDir, vars) {
  if (!existsSync(srcDir)) return [];
  const written = [];
  for (const entry of await fs.readdir(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const outName = RENAMES[entry.name] ?? entry.name;
    const dst = path.join(dstDir, outName);
    if (entry.isDirectory()) {
      await fs.mkdir(dst, { recursive: true });
      written.push(...(await copyTree(src, dst, vars)));
      continue;
    }
    if (!BINARY_EXT.has(path.extname(outName).toLowerCase())) {
      const text = await fs.readFile(src, 'utf8');
      await fs.writeFile(dst, render(text, vars, path.relative(TEMPLATES_DIR, src)));
    } else {
      await fs.copyFile(src, dst);
    }
    const mode = (await fs.stat(src)).mode;
    if (mode & 0o111) await fs.chmod(dst, 0o755);
    written.push(dst);
  }
  return written;
}

function titleCase(name) {
  return name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Create a new project from a template.
 * Steps: copy _shared + template files with variables rendered, write factory.json,
 * install the Claude kit, run the install command, and make the first commit.
 */
export async function scaffold({
  template: templateName,
  name,
  dir,
  description,
  owner = 'your-github-user',
  install = true,
  git = true,
  claude = true,
  log = () => {},
}) {
  if (!NAME_RE.test(name ?? '')) {
    throw new Error(`project name "${name}" must be 2-64 chars of lowercase letters, digits and dashes`);
  }
  // Values are substituted into JSON, TOML, YAML, HTML and CODEOWNERS, so keep them inert.
  if (description !== undefined && !DESCRIPTION_RE.test(description)) {
    throw new Error('description must be 1-200 characters without quotes, backslashes, angle brackets, backticks, $ or newlines');
  }
  if (!OWNER_RE.test(owner)) throw new Error(`owner "${owner}" must be a GitHub user, org, or org/team`);
  const template = await loadTemplate(templateName);
  const target = path.resolve(dir ?? name);
  if (existsSync(target) && (await fs.readdir(target)).length > 0) {
    throw new Error(`target directory ${target} already exists and is not empty`);
  }
  await fs.mkdir(target, { recursive: true });

  const vars = {
    name,
    title: titleCase(name),
    description: description ?? template.defaultDescription ?? `${titleCase(name)} service`,
    owner,
    year: new Date().getFullYear(),
    template: template.id,
    factoryPackage: FACTORY_PACKAGE,
    ...template.vars,
  };

  log(`Copying ${template.id} template`);
  await copyTree(path.join(TEMPLATES_DIR, '_shared', 'files'), target, vars);
  await copyTree(template.dir, target, vars);

  const factoryJson = {
    $schema: 'https://raw.githubusercontent.com/taugustincst/software-factory/main/schema/factory.schema.json',
    name,
    template: template.id,
    commands: template.commands,
  };
  await fs.writeFile(path.join(target, 'factory.json'), `${JSON.stringify(factoryJson, null, 2)}\n`);

  if (claude) {
    log('Installing Claude Code kit');
    await installClaudeKit(target, { projectName: vars.title });
  }

  const steps = { install: null, git: null };
  if (install && template.commands.install) {
    log(`Installing dependencies: ${template.commands.install}`);
    const r = await run(template.commands.install, { cwd: target, timeoutMs: 15 * 60_000 });
    steps.install = r.code === 0 ? 'ok' : 'failed';
    if (r.code !== 0)
      log(`Install failed (exit ${r.code}). Run it yourself: ${template.commands.install}\n${r.stderr.slice(-2000)}`);
    // Format rendered files with the project's own formatter so the first commit is lint-clean.
    for (const cmd of r.code === 0 ? (template.postCreate ?? []) : []) {
      const p = await run(cmd, { cwd: target, timeoutMs: 5 * 60_000 });
      if (p.code !== 0) log(`Post-create step failed: ${cmd}\n${(p.stdout + p.stderr).slice(-1500)}`);
    }
  }

  if (git) {
    const init = await run(['git', 'init', '-q', '-b', 'main'], { cwd: target });
    if (init.code === 0) {
      await run(['git', 'add', '-A'], { cwd: target });
      // Fresh machines (and CI runners) may have no git identity at all, in which
      // case `git commit` fails outright. Fall back to a factory identity for this
      // one commit — passed with -c, so nothing is written to the user's config.
      // GIT_AUTHOR_*/GIT_COMMITTER_* in the environment still take precedence over -c.
      const identity = [];
      if (
        !process.env.GIT_AUTHOR_NAME ||
        !process.env.GIT_AUTHOR_EMAIL ||
        !process.env.GIT_COMMITTER_NAME ||
        !process.env.GIT_COMMITTER_EMAIL
      ) {
        const [name, email] = await Promise.all([
          run(['git', 'config', '--get', 'user.name'], { cwd: target }),
          run(['git', 'config', '--get', 'user.email'], { cwd: target }),
        ]);
        if (name.code !== 0 || email.code !== 0)
          identity.push('-c', 'user.name=software-factory', '-c', 'user.email=software-factory@localhost');
      }
      const commit = await run(
        ['git', ...identity, 'commit', '-q', '-m', `chore: scaffold ${name} from software-factory ${template.id} template`],
        { cwd: target },
      );
      steps.git = commit.code === 0 ? 'ok' : 'no-commit';
      if (commit.code !== 0)
        log('git initialised, but the first commit failed (set git user.name/user.email and commit yourself)');
    } else {
      steps.git = 'failed';
    }
  }

  // Record the pristine rendered tree so a later `factory upgrade` can
  // three-way merge template changes against it. Lives in .factory/
  // (git-ignored in every template); best-effort — an upgrade can also
  // recover the base from the scaffold commit.
  try {
    await writeBaseSnapshot(target, target, {
      template: template.id,
      scaffoldedWith: FACTORY_PACKAGE,
      at: new Date().toISOString(),
    });
  } catch {
    log('Could not record the upgrade base snapshot (.factory/upgrade); upgrades can still use the git scaffold commit.');
  }

  return { target, template, vars, steps };
}
