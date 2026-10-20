import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createJournal } from '../src/index.js';
import { tempDir } from './helpers.js';

// Several real processes appending to and draining one journal at once.
// They run the package bundled from src, as a user's processes would.

let dir: string;
let cleanup: () => Promise<void>;
let bundle: string;

beforeAll(async () => {
  ({ dir, cleanup } = await tempDir());
  await build({ entry: { index: 'src/index.ts' }, outDir: join(dir, 'bundle'), format: ['esm'], platform: 'node', target: 'node20', dts: false, silent: true, config: false });
  bundle = pathToFileURL(join(dir, 'bundle', 'index.js')).href;
}, 30_000);
afterAll(() => cleanup());

function run(script: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}: ${err}`))));
  });
}

const appender = () => `
  import { createJournal } from '${bundle}';
  const [file, worker, count] = process.argv.slice(1);
  const journal = createJournal({ file, drainOnSuccess: false });
  for (let i = 0; i < Number(count); i++) {
    const r = await journal.save({ worker, i }, () => { throw new Error('down'); });
    if (!r.queued) process.exit(3);
  }
`;

const drainer = () => `
  import { appendFileSync } from 'node:fs';
  import { createJournal } from '${bundle}';
  const [file, saved] = process.argv.slice(1);
  const journal = createJournal({ file, drainOnSuccess: false });
  const result = await journal.drain(async (record, { id }) => {
    appendFileSync(saved, id + '\\n');
    await new Promise((r) => setTimeout(r, 1));
  });
  process.stdout.write(JSON.stringify(result));
`;

it('loses nothing and saves nothing twice with four writers and two drainers', async () => {
  const file = join(dir, 'shared.ndjson');
  const saved = join(dir, 'saved.txt');
  writeFileSync(saved, '');
  const seed = createJournal({ file, drainOnSuccess: false });
  for (let i = 0; i < 100; i++) await seed.save({ worker: 'seed', i }, () => Promise.reject(new Error('down')));

  const results = await Promise.all([
    run(drainer(), [file, saved]),
    run(appender(), [file, 'w1', '50']),
    run(appender(), [file, 'w2', '50']),
    run(drainer(), [file, saved]),
    run(appender(), [file, 'w3', '50']),
    run(appender(), [file, 'w4', '50']),
  ]);
  const drains = [results[0], results[3]].map((r) => JSON.parse(r ?? '{}') as { busy: boolean; saved: number });
  expect(drains.some((d) => d.saved > 0)).toBe(true);

  // Whatever arrived after the drains is still waiting; drain it here.
  await seed.drain((_record, { id }) => {
    writeFileSync(saved, `${id}\n`, { flag: 'a' });
  });
  const ids = readFileSync(saved, 'utf8').split('\n').filter(Boolean);
  expect(ids).toHaveLength(300);
  expect(new Set(ids).size).toBe(300);
  expect(seed.size()).toBe(0);
  expect(seed.read().corrupt).toEqual([]);
}, 60_000);
