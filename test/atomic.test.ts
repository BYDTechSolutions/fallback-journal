import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createJournal } from '../src/index.js';
import { tempDir } from './helpers.js';

// A crash between writing the temp file and renaming it over the journal is
// simulated by making the rename fail.
const crash = vi.hoisted(() => ({ onRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (crash.onRename && from.endsWith('.tmp')) throw new Error('simulated crash before rename');
      return fs.renameSync(from, to);
    },
  };
});

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  crash.onRename = false;
  await cleanup();
});

it('leaves the journal whole when a drain dies before its rename', async () => {
  const file = join(dir, 'pending.ndjson');
  const original = ['a', 'b', 'c']
    .map((n) => JSON.stringify({ id: n, queuedAt: '2026-01-01T00:00:00.000Z', attempts: 1, lastError: 'down', record: { n } }))
    .join('\n') + '\n';
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, original);

  crash.onRename = true;
  const journal = createJournal({ file, drainOnSuccess: false });
  await expect(journal.drain(() => undefined)).rejects.toThrow('simulated crash before rename');
  expect(readFileSync(file, 'utf8')).toBe(original);

  // The next drain, after "restart", replays all three: ids let the save function upsert.
  crash.onRename = false;
  const ids: string[] = [];
  expect(await journal.drain((_record, { id }) => void ids.push(id))).toMatchObject({ saved: 3, remaining: 0 });
  expect(ids).toEqual(['a', 'b', 'c']);
});
