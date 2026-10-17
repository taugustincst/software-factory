import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Run state lives in <repo>/.factory/runs/<id>/ (gitignored): run.json plus one log per stage attempt. */
export const RUN_ID_RE = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
export const LOG_NAME_RE = /^[a-z]+-\d+\.log$/;

export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function runsDir(dir) {
  return path.join(dir, '.factory', 'runs');
}

export function runDir(dir, id) {
  if (!RUN_ID_RE.test(id)) throw new Error(`invalid run id: ${id}`);
  return path.join(runsDir(dir), id);
}

export async function saveRun(dir, run) {
  const d = runDir(dir, run.id);
  await fs.mkdir(d, { recursive: true });
  const tmp = path.join(d, `run.json.${process.pid}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`);
  await fs.rename(tmp, path.join(d, 'run.json')); // atomic, so the dashboard never reads half a file
}

export async function appendLog(dir, id, name, text) {
  if (!LOG_NAME_RE.test(name)) throw new Error(`invalid log name: ${name}`);
  await fs.mkdir(runDir(dir, id), { recursive: true });
  await fs.appendFile(path.join(runDir(dir, id), name), text);
}

export async function readRun(dir, id) {
  const file = path.join(runDir(dir, id), 'run.json');
  if (!existsSync(file)) return null;
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function readLog(dir, id, name) {
  // launcher.txt is written by the dashboard's spawner, not appendLog, so it is
  // readable under its exact name only — the pattern stays strict for the rest.
  if (name !== 'launcher.txt' && !LOG_NAME_RE.test(name)) throw new Error(`invalid log name: ${name}`);
  const file = path.join(runDir(dir, id), name);
  return existsSync(file) ? fs.readFile(file, 'utf8') : null;
}

export async function listRuns(dir) {
  const base = runsDir(dir);
  if (!existsSync(base)) return [];
  const ids = (await fs.readdir(base))
    .filter((n) => RUN_ID_RE.test(n))
    .sort()
    .reverse();
  const runs = await Promise.all(ids.map((id) => readRun(dir, id).catch(() => null)));
  return runs.filter(Boolean);
}
