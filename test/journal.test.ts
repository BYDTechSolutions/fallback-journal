import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJournal, JournalError, readJournal, type JournalEntry } from '../src/index.js';
import { fakeDb, sleep, tempDir } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
let file: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  file = join(dir, 'data', 'pending.ndjson');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const lines = () => readFileSync(file, 'utf8').split('\n').filter(Boolean);

describe('save', () => {
  it('saves with your function and touches no file when it works', async () => {
    const db = fakeDb();
    const journal = createJournal({ file });
    const result = await journal.save({ email: 'someone@example.com' }, db.insert);
    expect(result).toEqual({ saved: true, queued: false, id: expect.any(String), value: 1 });
    expect(db.rows[0]).toMatchObject({ record: { email: 'someone@example.com' }, id: result.id, attempt: 1, replay: false });
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the record on disk and resolves, instead of throwing, when the save fails', async () => {
    const db = fakeDb();
    db.up = false;
    const journal = createJournal({ file });
    const result = await journal.save({ email: 'someone@example.com' }, db.insert);
    expect(result.saved).toBe(false);
    expect(result.queued).toBe(true);
    if (result.queued) expect((result.error as Error).message).toMatch(/ECONNREFUSED/);
    const [line] = lines();
    const entry = JSON.parse(line ?? '') as JournalEntry;
    expect(entry).toEqual({
      id: result.id,
      queuedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      attempts: 1,
      lastError: 'connect ECONNREFUSED 127.0.0.1:5432',
      record: { email: 'someone@example.com' },
    });
    expect(journal.size()).toBe(1);
    expect(journal.pending()[0]?.id).toBe(result.id);
  });

  it('defaults to fallback-journal.ndjson in the working directory', () => {
    expect(createJournal().file).toBe(resolve('fallback-journal.ndjson'));
  });

  it('rethrows the save error after queuing when rethrow is on', async () => {
    const journal = createJournal({ file, rethrow: true });
    await expect(journal.save({ n: 1 }, () => Promise.reject(new Error('db down')))).rejects.toThrow('db down');
    expect(journal.size()).toBe(1);
  });

  it('throws without queuing when queueIf says the error is not worth retrying', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
    const journal = createJournal({ file, queueIf: (error) => (error as { code?: string }).code !== '23505' });
    await expect(journal.save({ n: 1 }, () => Promise.reject(duplicate))).rejects.toBe(duplicate);
    expect(existsSync(file)).toBe(false);
    const queued = await journal.save({ n: 2 }, () => Promise.reject(new Error('timeout')));
    expect(queued.queued).toBe(true);
  });

  it('accepts a synchronous save function', async () => {
    const journal = createJournal({ file });
    expect(await journal.save({ n: 1 }, () => 'ok')).toMatchObject({ saved: true, value: 'ok' });
    const failed = await journal.save({ n: 2 }, () => {
      throw new Error('sync failure');
    });
    expect(failed.queued).toBe(true);
  });

  it('refuses a record that cannot be written as JSON before trying to save it', async () => {
    const db = fakeDb();
    const journal = createJournal({ file });
    await expect(journal.save({ n: 1n }, db.insert)).rejects.toMatchObject({ code: 'NOT_SERIALIZABLE' });
    await expect(journal.save(undefined, db.insert)).rejects.toMatchObject({ code: 'NOT_SERIALIZABLE' });
    expect(db.calls).toBe(0);
  });

  it('explains a missing save function or a bad option', async () => {
    const journal = createJournal({ file });
    // @ts-expect-error: deliberately wrong
    await expect(journal.save({ n: 1 })).rejects.toThrow(/needs your save function/);
    await expect(journal.save({ n: 1 }, () => 1, { key: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(() => createJournal({ maxEntries: 0 })).toThrow(/"maxEntries" must be a whole number above 0/);
    expect(() => createJournal({ file: '' })).toThrow(/"file" must be a path/);
    // @ts-expect-error: deliberately wrong
    expect(() => createJournal({ onQueued: 'log' })).toThrow(/"onQueued" must be a function/);
  });

  it('reports WRITE_FAILED, with the record and the save error, when the disk fails too', async () => {
    mkdirSync(file, { recursive: true }); // a directory where the file should be
    const journal = createJournal({ file });
    const saveError = new Error('db down');
    const error = (await journal.save({ n: 1 }, () => Promise.reject(saveError)).catch((e: unknown) => e)) as JournalError;
    expect(error).toBeInstanceOf(JournalError);
    expect(error.code).toBe('WRITE_FAILED');
    expect(error.record).toEqual({ n: 1 });
    expect(error.cause).toBe(saveError);
    expect(error.message).toMatch(/Saving it failed \(db down\), and writing it to .* failed too/);
  });
});

describe('drain', () => {
  it('replays waiting records with the same id, and empties the journal', async () => {
    const db = fakeDb();
    const journal = createJournal({ file, drainOnSuccess: false });
    db.up = false;
    const first = await journal.save({ n: 1 }, db.insert);
    const second = await journal.save({ n: 2 }, db.insert);
    db.up = true;
    const result = await journal.drain(db.insert);
    expect(result).toEqual({ saved: 2, failed: 0, remaining: 0, corrupt: 0, busy: false, errors: [] });
    expect(db.rows.map((r) => [r.id, r.attempt, r.replay])).toEqual([
      [first.id, 2, true],
      [second.id, 2, true],
    ]);
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('keeps records that fail again, with the attempt count and error updated', async () => {
    const journal = createJournal({ file, drainOnSuccess: false });
    for (const n of [1, 2, 3]) await journal.save({ n }, () => Promise.reject(new Error('down')));
    const saved: number[] = [];
    const result = await journal.drain(async (record: { n: number }) => {
      if (record.n === 2) throw new Error('value too long for column "phone"');
      saved.push(record.n);
    });
    expect(saved).toEqual([1, 3]);
    expect(result).toMatchObject({ saved: 2, failed: 1, remaining: 1, busy: false });
    expect((result.errors[0]?.error as Error).message).toMatch(/too long/);
    const [left] = journal.pending();
    expect(left).toMatchObject({ record: { n: 2 }, attempts: 2, lastError: 'value too long for column "phone"' });
    expect(result.errors[0]?.id).toBe(left?.id);
  });

  it('keeps records queued while a drain is running', async () => {
    const journal = createJournal({ file, drainOnSuccess: false });
    await journal.save({ n: 1 }, () => Promise.reject(new Error('down')));
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const draining = journal.drain(async () => {
      await gate;
    });
    await sleep(10);
    await journal.save({ n: 2 }, () => Promise.reject(new Error('down again')));
    release();
    const result = await draining;
    expect(result).toMatchObject({ saved: 1, remaining: 1 });
    expect(journal.pending().map((e) => e.record)).toEqual([{ n: 2 }]);
  });

  it('drains in the background after a successful save, with the same function', async () => {
    const db = fakeDb();
    const journal = createJournal({ file });
    db.up = false;
    await journal.save({ n: 1 }, db.insert);
    db.up = true;
    await journal.save({ n: 2 }, db.insert);
    await journal.drain(db.insert); // joins the background drain
    expect(db.rows.map((r) => r.record)).toEqual([{ n: 2 }, { n: 1 }]);
    expect(journal.size()).toBe(0);
  });

  it('does not drain after a save when drainOnSuccess is off', async () => {
    const db = fakeDb();
    const journal = createJournal({ file, drainOnSuccess: false });
    db.up = false;
    await journal.save({ n: 1 }, db.insert);
    db.up = true;
    await journal.save({ n: 2 }, db.insert);
    await sleep(20);
    expect(db.rows).toHaveLength(1);
    expect(journal.size()).toBe(1);
  });

  it('does not retry a record that keeps failing on every request', async () => {
    const journal = createJournal({ file });
    await journal.save({ poison: true }, () => Promise.reject(new Error('down')));
    let tries = 0;
    const insert = async (record: { poison?: boolean }) => {
      if (record.poison) {
        tries++;
        throw new Error('bad row');
      }
    };
    await journal.save({ ok: 1 }, insert);
    await journal.drain(insert); // joins the first background drain
    expect(tries).toBe(1);
    await journal.save({ ok: 2 }, insert);
    await journal.save({ ok: 3 }, insert);
    await sleep(20);
    expect(tries).toBe(1);
  });

  it('joins a drain already running in this process instead of inserting twice', async () => {
    const db = fakeDb();
    const journal = createJournal({ file, drainOnSuccess: false });
    db.up = false;
    for (const n of [1, 2, 3]) await journal.save({ n }, db.insert);
    db.up = true;
    const slow = async (record: unknown, meta: { id: string; attempt: number; replay: boolean }) => {
      await sleep(5);
      return db.insert(record as Record<string, unknown>, meta);
    };
    const [a, b] = await Promise.all([journal.drain(slow), journal.drain(slow)]);
    expect(a).toBe(b);
    expect(db.rows).toHaveLength(3);
  });

  it('skips, reporting busy, when another journal on the same file is draining', async () => {
    const one = createJournal({ file, drainOnSuccess: false });
    const two = createJournal({ file, drainOnSuccess: false });
    await one.save({ n: 1 }, () => Promise.reject(new Error('down')));
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const draining = one.drain(() => gate);
    await sleep(10);
    const calls = vi.fn();
    expect(await two.drain(calls)).toMatchObject({ busy: true, saved: 0, remaining: 1 });
    expect(calls).not.toHaveBeenCalled();
    release();
    expect(await draining).toMatchObject({ saved: 1, remaining: 0 });
    expect(existsSync(`${file}.drain.lock`)).toBe(false);
  });

  it('does nothing on a missing journal', async () => {
    const journal = createJournal({ file });
    expect(await journal.drain(() => undefined)).toEqual({ saved: 0, failed: 0, remaining: 0, corrupt: 0, busy: false, errors: [] });
    expect(journal.size()).toBe(0);
  });
});

describe('crashes and corrupt lines', () => {
  const entry = (n: number) => JSON.stringify({ id: `id-${n}`, queuedAt: '2026-01-01T00:00:00.000Z', attempts: 1, lastError: 'down', record: { n } });

  it('reports a torn last line and keeps it, and the next append starts on a new line', async () => {
    mkdirSync(join(dir, 'data'));
    writeFileSync(file, `${entry(1)}\n{"id":"id-2","queuedAt":"2026-01-01T00:00`); // crash mid-write
    expect(readJournal(file).corrupt).toEqual([{ line: 2, text: '{"id":"id-2","queuedAt":"2026-01-01T00:00', torn: true }]);

    const journal = createJournal({ file, drainOnSuccess: false });
    await journal.save({ n: 3 }, () => Promise.reject(new Error('down')));
    const contents = journal.read();
    expect(contents.entries.map((e) => e.record)).toEqual([{ n: 1 }, { n: 3 }]);
    expect(contents.corrupt).toHaveLength(1);
    expect(contents.corrupt[0]?.torn).toBe(false); // now followed by a newline

    const result = await journal.drain(() => undefined);
    expect(result).toMatchObject({ saved: 2, remaining: 0, corrupt: 1 });
    expect(readFileSync(file, 'utf8')).toBe('{"id":"id-2","queuedAt":"2026-01-01T00:00\n');
  });

  it('treats JSON that is not an entry as corrupt, and skips blank lines', () => {
    mkdirSync(join(dir, 'data'));
    writeFileSync(file, `\n${entry(1)}\n[1,2]\n\n{"record":1}\r\n`);
    const { entries, corrupt } = readJournal(file);
    expect(entries).toHaveLength(1);
    expect(corrupt.map((c) => c.line)).toEqual([3, 5]);
  });

  it('ignores a temp file left by a rewrite that never finished', async () => {
    mkdirSync(join(dir, 'data'));
    writeFileSync(file, `${entry(1)}\n`);
    writeFileSync(`${file}.tmp`, 'half a rewrite');
    const journal = createJournal({ file, drainOnSuccess: false });
    expect(journal.size()).toBe(1);
    expect(await journal.drain(() => undefined)).toMatchObject({ saved: 1 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('replaces the file by rename, so a reader sees the old file or the new one', async () => {
    mkdirSync(join(dir, 'data'));
    writeFileSync(file, `${entry(1)}\n${entry(2)}\n`);
    const before = statSync(file).ino;
    const journal = createJournal({ file, drainOnSuccess: false });
    await journal.drain(async (r: { n: number }) => {
      if (r.n === 2) throw new Error('no');
    });
    expect(statSync(file).ino).not.toBe(before);
    expect(readdirSync(join(dir, 'data')).sort()).toEqual(['pending.ndjson']);
  });
});

describe('idempotency', () => {
  it('passes your key and the same id to every attempt, and stores the key', async () => {
    const db = fakeDb();
    const journal = createJournal({ file, drainOnSuccess: false });
    db.up = false;
    const result = await journal.save({ total: 42 }, db.insert, { key: 'order-1001' });
    expect(db.calls).toBe(1);
    expect(journal.pending()[0]).toMatchObject({ id: result.id, key: 'order-1001' });
    db.up = true;
    await journal.drain(db.insert);
    expect(db.rows[0]).toMatchObject({ id: result.id, key: 'order-1001', attempt: 2, replay: true });
  });

  it('gives every saved record its own id', async () => {
    const journal = createJournal({ file });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add((await journal.save({ i }, () => undefined)).id);
    expect(ids.size).toBe(20);
  });
});

describe('limits', () => {
  it('throws JOURNAL_FULL, with the record, at maxEntries', async () => {
    const journal = createJournal({ file, maxEntries: 2 });
    const fail = () => Promise.reject(new Error('down'));
    await journal.save({ n: 1 }, fail);
    await journal.save({ n: 2 }, fail);
    const error = (await journal.save({ n: 3 }, fail).catch((e: unknown) => e)) as JournalError;
    expect(error.code).toBe('JOURNAL_FULL');
    expect(error.record).toEqual({ n: 3 });
    expect(error.message).toMatch(/is full: 2 entries, limit 2 \(option maxEntries\)/);
    expect(error.message).toMatch(/npx fallback-journal replay/);
    expect(journal.size()).toBe(2);
  });

  it('throws JOURNAL_FULL at maxBytes', async () => {
    const journal = createJournal({ file, maxBytes: 300 });
    const fail = () => Promise.reject(new Error('down'));
    await journal.save({ text: 'a'.repeat(50) }, fail);
    await expect(journal.save({ text: 'b'.repeat(200) }, fail)).rejects.toThrow(/option maxBytes/);
    expect(journal.size()).toBe(1);
  });

  it('counts lines written by someone else since the last check', async () => {
    const journal = createJournal({ file, maxEntries: 3 });
    const fail = () => Promise.reject(new Error('down'));
    await journal.save({ n: 1 }, fail);
    const other = createJournal({ file });
    await other.save({ n: 2 }, fail);
    await other.save({ n: 3 }, fail);
    await expect(journal.save({ n: 4 }, fail)).rejects.toMatchObject({ code: 'JOURNAL_FULL' });
  });
});

describe('file permissions', () => {
  it.skipIf(process.platform === 'win32')('creates the file 0600 and its folder 0700, and keeps the mode on rewrite', async () => {
    const journal = createJournal({ file, drainOnSuccess: false });
    await journal.save({ n: 1 }, () => Promise.reject(new Error('down')));
    await journal.save({ n: 2 }, () => Promise.reject(new Error('down')));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'data')).mode & 0o777).toBe(0o700);
    await journal.drain(async (r: { n: number }) => {
      if (r.n === 2) throw new Error('no');
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o640);
    await journal.drain(() => undefined);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });
});

describe('hooks', () => {
  it('calls onQueued with the entry and the error, and onDrained with the result', async () => {
    const onQueued = vi.fn();
    const onDrained = vi.fn();
    const journal = createJournal({ file, drainOnSuccess: false, onQueued, onDrained });
    const error = new Error('down');
    const result = await journal.save({ n: 1 }, () => Promise.reject(error), { key: 'k1' });
    expect(onQueued).toHaveBeenCalledWith(expect.objectContaining({ id: result.id, key: 'k1', record: { n: 1 }, attempts: 1 }), error);
    await journal.drain(() => undefined);
    expect(onDrained).toHaveBeenCalledWith(expect.objectContaining({ saved: 1, failed: 0, remaining: 0 }));
    await journal.drain(() => undefined);
    expect(onDrained).toHaveBeenCalledTimes(1); // nothing to report the second time
  });

  it('turns a throwing hook into a process warning instead of breaking the save', async () => {
    const warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const journal = createJournal({
      file,
      onQueued: () => {
        throw new Error('logger broke');
      },
    });
    const result = await journal.save({ n: 1 }, () => Promise.reject(new Error('down')));
    expect(result.queued).toBe(true);
    expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/onQueued hook threw: logger broke/), expect.anything());
  });
});
