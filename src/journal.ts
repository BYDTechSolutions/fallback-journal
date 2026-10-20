import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { JournalError, describeError } from './errors.js';
import {
  appendLines,
  entryLine,
  parseJournal,
  rewriteFile,
  type JournalContents,
  type JournalEntry,
} from './file.js';
import { touchLock, tryLock, unlock, withLockSync } from './lock.js';

/** Where the journal is kept when no `file` is given: `fallback-journal.ndjson` in the working directory. */
export const DEFAULT_FILE = 'fallback-journal.ndjson';
/** Default `maxEntries`. */
export const DEFAULT_MAX_ENTRIES = 100_000;
/** Default `maxBytes`: 50 MiB. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** After a background drain leaves failures behind, the next one waits this long, so a record that never saves is not retried on every request. */
const BACKGROUND_RETRY_MS = 30_000;
/** The short lock around appends and rewrites. Held for milliseconds. */
const WRITE_LOCK = { staleMs: 5_000, timeoutMs: 10_000 };
/** The lock held for a whole drain, refreshed while it runs. */
const DRAIN_LOCK_STALE_MS = 60_000;
const DRAIN_LOCK_REFRESH_MS = 10_000;

/** What your save function is told about the attempt. */
export interface SaveMeta {
  /** The entry's id: a UUID that stays the same from the first try through every replay. Upsert on it and a replay can never insert twice. */
  id: string;
  /** The `key` you passed to `save`, if any. */
  key?: string;
  /** 1 for the first try, 2 for the first replay, and so on. */
  attempt: number;
  /** True when the record comes from the journal rather than from `save`. */
  replay: boolean;
}

/**
 * Writes one record to your database, or throws. Called with the record and
 * a {@link SaveMeta}. Whatever it returns comes back as `value` from `save`.
 *
 * @example (record, { id }) => db.insert('signups', { ...record, id })
 */
export type SaveFn<T, R = unknown> = (record: T, meta: SaveMeta) => R | Promise<R>;

/** Options for {@link createJournal}. Every one has a default. */
export interface JournalOptions<T = any> {
  /** Path of the journal file, resolved against the working directory. Default `fallback-journal.ndjson`. Use one file per kind of record. */
  file?: string;
  /** After queuing a record, throw the save error anyway (the record stays in the journal). Default `false`: `save` resolves with `queued: true`. */
  rethrow?: boolean;
  /** After a successful save, replay whatever is waiting in the background, with the same save function. Default `true`. */
  drainOnSuccess?: boolean;
  /**
   * Decides which errors are worth queuing. Return `false` and `save` throws
   * the error instead, without journaling: for errors a retry cannot fix, such
   * as a unique-constraint violation. Default: queue every error.
   */
  queueIf?: (error: unknown, record: T) => boolean;
  /** Refuse to grow past this many lines. Default 100,000. */
  maxEntries?: number;
  /** Refuse to grow past this many bytes. Default 52,428,800 (50 MiB). */
  maxBytes?: number;
  /** Called after a record is written to the journal: log it, alert someone. */
  onQueued?: (entry: JournalEntry<T>, error: unknown) => void;
  /** Called after a drain that saved or failed at least one record. */
  onDrained?: (result: DrainResult) => void;
}

/** Options for one {@link Journal.save} call. */
export interface SaveOptions {
  /** Your own idempotency key (an order number, a request id). Stored with the entry and passed to your save function. */
  key?: string;
}

/** What {@link Journal.save} resolves with. */
export type SaveResult<R = unknown> =
  | {
      /** The record is in your database. */
      saved: true;
      queued: false;
      /** The id your save function was given. */
      id: string;
      /** What your save function returned. */
      value: R;
    }
  | {
      saved: false;
      /** The record is on disk in the journal and will be saved by a later drain. */
      queued: true;
      /** The entry's id, the same one every replay will pass to your save function. */
      id: string;
      /** What your save function threw. */
      error: unknown;
    };

/** A record that failed again during a drain. It stays in the journal. */
export interface DrainFailure {
  id: string;
  key?: string;
  error: unknown;
}

/** What {@link Journal.drain} resolves with. */
export interface DrainResult {
  /** Records saved and removed from the journal. */
  saved: number;
  /** Records that failed again and stay in the journal. */
  failed: number;
  /** Records still waiting after the drain, including any queued while it ran. */
  remaining: number;
  /** Lines that are not readable entries. Kept in the file for a person to recover; see the README. */
  corrupt: number;
  /** True when another process was draining this journal, so nothing was tried. */
  busy: boolean;
  /** Why each failed record failed. */
  errors: DrainFailure[];
}

/** A journal bound to one file. Create it once, at startup, and share it. */
export interface Journal<T = any> {
  /** The journal file's absolute path. */
  readonly file: string;
  /**
   * Saves a record with your function; if that throws, keeps the record in the
   * journal and resolves with `queued: true` instead of throwing.
   *
   * Throws only when the record is in neither place (`JournalError` with code
   * `JOURNAL_FULL` or `WRITE_FAILED`), when `queueIf` said not to queue, when
   * `rethrow` is on, or when the record cannot be written as JSON.
   *
   * @example
   * const result = await journal.save(signup, (s) => db.insert('signups', s));
   * if (result.queued) console.warn('Saved to the journal; it will be replayed.');
   */
  save<R>(record: T, saveFn: SaveFn<T, R>, options?: SaveOptions): Promise<SaveResult<Awaited<R>>>;
  /**
   * Replays every waiting record through your function, oldest first. Saved
   * records are removed; failed ones stay with their attempt count raised.
   * Never throws because of a failing record. A drain already running in this
   * process is joined rather than started twice.
   */
  drain(saveFn: SaveFn<T>): Promise<DrainResult>;
  /** Every record waiting, oldest first. Reads the file. */
  pending(): JournalEntry<T>[];
  /** How many records are waiting. Reads the file: fine for a health check. */
  size(): number;
  /** Entries and corrupt lines, as {@link pending} sees them. */
  read(): JournalContents<T>;
}

function warn(message: string, error: unknown): void {
  process.emitWarning(`${message}: ${describeError(error)}`, { code: 'FALLBACK_JOURNAL' });
}

function callHook<A extends unknown[]>(name: string, hook: ((...args: A) => void) | undefined, ...args: A): void {
  if (!hook) return;
  try {
    hook(...args);
  } catch (error) {
    warn(`fallback-journal: the ${name} hook threw`, error);
  }
}

function checkOptions(options: JournalOptions): void {
  const fail = (message: string): never => {
    throw new JournalError('INVALID_OPTION', `fallback-journal: ${message}`);
  };
  if (options === null || typeof options !== 'object') fail('createJournal(options) takes an object, such as { file: "./data/pending.ndjson" }.');
  if (options.file !== undefined && (typeof options.file !== 'string' || options.file.trim() === '')) {
    fail('"file" must be a path such as "./data/pending.ndjson".');
  }
  for (const name of ['maxEntries', 'maxBytes'] as const) {
    const value = options[name];
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) fail(`"${name}" must be a whole number above 0; got ${String(value)}.`);
  }
  for (const name of ['queueIf', 'onQueued', 'onDrained'] as const) {
    if (options[name] !== undefined && typeof options[name] !== 'function') fail(`"${name}" must be a function.`);
  }
  for (const name of ['rethrow', 'drainOnSuccess'] as const) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') fail(`"${name}" must be true or false.`);
  }
}

function checkSaveFn(saveFn: unknown, call: string): void {
  if (typeof saveFn !== 'function') {
    throw new JournalError(
      'INVALID_ARGUMENT',
      `fallback-journal: ${call} needs your save function, the one that writes a record to the database, e.g. (record) => db.insert('signups', record).`,
    );
  }
}

/**
 * Creates a journal: a file where records that could not be saved wait until
 * they can be.
 *
 * @example
 * import { createJournal } from '@bydtech/fallback-journal';
 *
 * const journal = createJournal({ file: './data/signups.ndjson' });
 * const result = await journal.save(signup, (s) => db.insert('signups', s));
 */
export function createJournal<T = any>(options: JournalOptions<T> = {}): Journal<T> {
  checkOptions(options as JournalOptions);
  const file = resolve(options.file ?? DEFAULT_FILE);
  const writeLock = `${file}.lock`;
  const drainLock = `${file}.drain.lock`;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const rethrow = options.rethrow ?? false;
  const drainOnSuccess = options.drainOnSuccess ?? true;

  let inFlight: Promise<DrainResult> | undefined;
  let lastFailedDrainAt = 0;
  /** Line count by file size and mtime, so a guard check during an outage does not reread the file on every request. */
  let lineCache: { size: number; mtimeMs: number; lines: number } | undefined;

  function readText(): string {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  function countLines(size: number, mtimeMs: number): number {
    if (lineCache && lineCache.size === size && lineCache.mtimeMs === mtimeMs) return lineCache.lines;
    const text = readText();
    let lines = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
    if (text.length && !text.endsWith('\n')) lines++;
    lineCache = { size, mtimeMs, lines };
    return lines;
  }

  function stat(): { size: number; mtimeMs: number } {
    try {
      const { size, mtimeMs } = statSync(file);
      return { size, mtimeMs };
    } catch {
      return { size: 0, mtimeMs: 0 };
    }
  }

  function read(): JournalContents<T> {
    return withLockSync(writeLock, WRITE_LOCK, () => parseJournal<T>(readText()));
  }

  function queue(record: T, recordJson: string, id: string, key: string | undefined, error: unknown): JournalEntry<T> {
    const head = { id, ...(key !== undefined ? { key } : {}), queuedAt: new Date().toISOString(), attempts: 1, lastError: describeError(error) };
    const line = entryLine(head, recordJson);
    const bytes = Buffer.byteLength(line) + 2;
    try {
      withLockSync(writeLock, WRITE_LOCK, () => {
        const before = stat();
        const full = (what: string, option: string) =>
          new JournalError(
            'JOURNAL_FULL',
            `fallback-journal: could not keep the record. Saving it failed (${describeError(error)}), and the journal ${file} is full: ` +
              `${what} (option ${option}). Replay it with "npx fallback-journal replay ${file} --handler ./save.mjs", or raise ${option}.`,
            { cause: error, record },
          );
        if (before.size + bytes > maxBytes) throw full(`${before.size} bytes, limit ${maxBytes}`, 'maxBytes');
        const lines = before.size ? countLines(before.size, before.mtimeMs) : 0;
        if (lines >= maxEntries) throw full(`${lines} entries, limit ${maxEntries}`, 'maxEntries');
        appendLines(file, line);
        const after = stat();
        lineCache = { size: after.size, mtimeMs: after.mtimeMs, lines: lines + 1 };
      });
    } catch (writeError) {
      if (writeError instanceof JournalError && writeError.code === 'JOURNAL_FULL') throw writeError;
      throw new JournalError(
        'WRITE_FAILED',
        `fallback-journal: could not keep the record. Saving it failed (${describeError(error)}), and writing it to ${file} failed too: ${describeError(writeError)}`,
        { cause: error, record },
      );
    }
    return { ...head, record: JSON.parse(recordJson) as T };
  }

  async function runDrain(saveFn: SaveFn<T>): Promise<DrainResult> {
    if (!tryLock(drainLock, DRAIN_LOCK_STALE_MS)) {
      const { entries, corrupt } = read();
      return { saved: 0, failed: 0, remaining: entries.length, corrupt: corrupt.length, busy: true, errors: [] };
    }
    try {
      const { entries, corrupt } = read();
      const done = new Set<string>();
      const failed = new Map<string, string>();
      const errors: DrainFailure[] = [];
      let touchedAt = Date.now();
      for (const entry of entries) {
        if (done.has(entry.id)) continue;
        try {
          await saveFn(entry.record, { id: entry.id, ...(entry.key !== undefined ? { key: entry.key } : {}), attempt: entry.attempts + 1, replay: true });
          done.add(entry.id);
        } catch (error) {
          failed.set(entry.id, describeError(error));
          errors.push({ id: entry.id, ...(entry.key !== undefined ? { key: entry.key } : {}), error });
        }
        if (Date.now() - touchedAt > DRAIN_LOCK_REFRESH_MS) {
          touchLock(drainLock);
          touchedAt = Date.now();
        }
      }

      let remaining = entries.length;
      let corruptCount = corrupt.length;
      if (done.size || failed.size) {
        // Reread under the write lock: records queued while the drain ran are
        // in the file now and must survive the rewrite.
        withLockSync(writeLock, WRITE_LOCK, () => {
          const kept: string[] = [];
          remaining = 0;
          corruptCount = 0;
          for (const raw of readText().split('\n')) {
            const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            if (!line.trim()) continue;
            const parsed = parseJournal<T>(line);
            const entry = parsed.entries[0];
            if (!entry) {
              corruptCount++;
              kept.push(line);
            } else if (done.has(entry.id)) {
              continue;
            } else if (failed.has(entry.id)) {
              remaining++;
              const { record, ...head } = entry;
              kept.push(entryLine({ ...head, attempts: entry.attempts + 1, lastError: failed.get(entry.id) ?? '' }, JSON.stringify(record)));
            } else {
              remaining++;
              kept.push(line);
            }
          }
          rewriteFile(file, kept);
          lineCache = undefined;
        });
      }

      const result: DrainResult = { saved: done.size, failed: failed.size, remaining, corrupt: corruptCount, busy: false, errors };
      lastFailedDrainAt = failed.size ? Date.now() : 0;
      if (done.size || failed.size) callHook('onDrained', options.onDrained, result);
      return result;
    } finally {
      unlock(drainLock);
    }
  }

  function drain(saveFn: SaveFn<T>): Promise<DrainResult> {
    checkSaveFn(saveFn, 'drain(saveFn)');
    if (!inFlight) {
      inFlight = runDrain(saveFn).finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  async function save<R>(record: T, saveFn: SaveFn<T, R>, saveOptions: SaveOptions = {}): Promise<SaveResult<Awaited<R>>> {
    checkSaveFn(saveFn, 'save(record, saveFn)');
    const key = saveOptions?.key;
    if (key !== undefined && (typeof key !== 'string' || key === '')) {
      throw new JournalError('INVALID_ARGUMENT', `fallback-journal: "key" must be a non-empty string; got ${String(key)}.`);
    }
    // Serialized before the first try, so a record that could never be
    // journaled fails now, in development, and not during an outage.
    let recordJson: string | undefined;
    try {
      recordJson = JSON.stringify(record);
    } catch (error) {
      throw new JournalError('NOT_SERIALIZABLE', `fallback-journal: the record cannot be written as JSON (${describeError(error)}). Pass plain data: objects, arrays, strings, numbers, booleans, null.`, { cause: error });
    }
    if (recordJson === undefined) {
      throw new JournalError('NOT_SERIALIZABLE', `fallback-journal: the record cannot be written as JSON; got ${typeof record}. Pass plain data, such as an object.`);
    }

    const id = randomUUID();
    let value: Awaited<R>;
    try {
      value = await saveFn(record, { id, ...(key !== undefined ? { key } : {}), attempt: 1, replay: false });
    } catch (error) {
      let worthQueuing = true;
      if (options.queueIf) {
        try {
          worthQueuing = options.queueIf(error, record) !== false;
        } catch (hookError) {
          warn('fallback-journal: queueIf threw, so the record was queued', hookError);
        }
      }
      if (!worthQueuing) throw error;
      const entry = queue(record, recordJson, id, key, error);
      callHook('onQueued', options.onQueued, entry, error);
      if (rethrow) throw error;
      return { saved: false, queued: true, id, error };
    }

    if (drainOnSuccess && !inFlight && stat().size > 0 && Date.now() - lastFailedDrainAt >= BACKGROUND_RETRY_MS) {
      drain(saveFn as SaveFn<T>).catch((error: unknown) => warn('fallback-journal: a background drain failed', error));
    }
    return { saved: true, queued: false, id, value };
  }

  return {
    file,
    save,
    drain,
    read,
    pending: () => read().entries,
    size: () => read().entries.length,
  };
}
