import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../src/commands.js';

/** A fresh temporary directory, removed by `cleanup`. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fallback-journal-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A CLI io that records what it prints. */
export function captureIo(cwd: string): CliIo & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    cwd,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    out: () => out,
    err: () => err,
  };
}

/** A pretend database table: `up` decides whether inserts work. */
export function fakeDb<T = Record<string, unknown>>() {
  const rows: Array<{ record: T; id: string; key?: string; attempt: number; replay: boolean }> = [];
  const db = {
    up: true,
    rows,
    calls: 0,
    insert: async (record: T, meta: { id: string; key?: string; attempt: number; replay: boolean }) => {
      db.calls++;
      if (!db.up) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      rows.push({ record, ...meta });
      return rows.length;
    },
  };
  return db;
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
