import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load factory.json, or infer commands for repos that were not scaffolded by the factory.
 * Returns { name, template, commands: { install?, lint?, typecheck?, test?, build? }, inferred }.
 */
export async function loadProject(dir) {
  const file = path.join(dir, 'factory.json');
  if (existsSync(file)) {
    const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      name: cfg.name ?? path.basename(dir),
      template: cfg.template ?? 'custom',
      commands: cfg.commands ?? {},
      inferred: false,
    };
  }
  return { name: path.basename(dir), template: 'inferred', commands: await inferCommands(dir), inferred: true };
}

export async function inferCommands(dir) {
  const commands = {};
  const pkgFile = path.join(dir, 'package.json');
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    const scripts = pkg.scripts ?? {};
    const pm = existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(dir, 'yarn.lock')) ? 'yarn' : 'npm';
    commands.install =
      pm === 'npm' ? (existsSync(path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install') : `${pm} install`;
    for (const key of ['lint', 'typecheck', 'test', 'build']) {
      if (scripts[key] && !/no test specified/.test(scripts[key])) commands[key] = `${pm} run ${key}`;
    }
    return commands;
  }
  if (existsSync(path.join(dir, 'pyproject.toml'))) {
    const py = await fs.readFile(path.join(dir, 'pyproject.toml'), 'utf8');
    commands.install = existsSync(path.join(dir, 'uv.lock')) || /\[tool\.uv\]/.test(py) ? 'uv sync' : 'pip install -e .';
    const r = commands.install === 'uv sync' ? 'uv run ' : '';
    if (/ruff/.test(py)) commands.lint = `${r}ruff check . && ${r}ruff format --check .`;
    if (/mypy/.test(py)) commands.typecheck = `${r}mypy .`;
    if (/pytest/.test(py)) commands.test = `${r}pytest -q`;
    return commands;
  }
  if (existsSync(path.join(dir, 'Makefile'))) {
    const mk = await fs.readFile(path.join(dir, 'Makefile'), 'utf8');
    for (const key of ['install', 'lint', 'typecheck', 'test', 'build']) {
      if (new RegExp(`^${key}:`, 'm').test(mk)) commands[key] = `make ${key}`;
    }
  }
  return commands;
}
