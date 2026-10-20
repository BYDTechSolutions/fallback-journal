import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** One record waiting in the journal: one line of the file. */
export interface JournalEntry<T = unknown> {
  /** A random UUID given when the record was first tried. The same on every replay: use it to upsert. */
  id: string;
  /** The `key` passed to `save`, if any: your own idempotency key, such as an order number. */
  key?: string;
  /** When the record was written to the journal (ISO 8601). */
  queuedAt: string;
  /** How many times saving it has failed: 1 when it is first queued. */
  attempts: number;
  /** The message of the last error. */
  lastError: string;
  /** The record exactly as it was passed to `save`, after a round trip through JSON. */
  record: T;
}

/**
 * A line that is not a journal entry. Kept in the file untouched: most likely
 * a write cut short by a crash, and half a record a person can read is worth
 * more than nothing.
 */
export interface CorruptLine {
  /** 1-based line number in the file. */
  line: number;
  /** The line as it is in the file. */
  text: string;
  /** True for a last line with no newline: a write that was interrupted. */
  torn: boolean;
}

/** What a journal file holds. */
export interface JournalContents<T = unknown> {
  /** Records waiting, oldest first. */
  entries: JournalEntry<T>[];
  /** Lines that could not be read as entries. */
  corrupt: CorruptLine[];
}

function isEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string' && entry.id !== '' && 'record' in entry;
}

/** Splits a journal's text into entries and corrupt lines. Blank lines are ignored. */
export function parseJournal<T = unknown>(text: string): JournalContents<T> {
  const entries: JournalEntry<T>[] = [];
  const corrupt: CorruptLine[] = [];
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  lines.forEach((raw, index) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (isEntry(parsed)) {
      entries.push({
        ...parsed,
        attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 1,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : '',
        queuedAt: typeof parsed.queuedAt === 'string' ? parsed.queuedAt : '',
      } as JournalEntry<T>);
    } else {
      corrupt.push({ line: index + 1, text: raw, torn: index === lines.length - 1 && !endsWithNewline });
    }
  });
  return { entries, corrupt };
}

/**
 * Reads a journal file without taking its lock. A missing file is an empty
 * journal. For a file another process may be writing, use `journal.pending()`.
 */
export function readJournal<T = unknown>(file: string): JournalContents<T> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], corrupt: [] };
    throw error;
  }
  return parseJournal<T>(text);
}

/** One entry as its line in the file, without the newline. `recordJson` is the record already serialized. */
export function entryLine(entry: Omit<JournalEntry, 'record'>, recordJson: string): string {
  const head = {
    id: entry.id,
    ...(entry.key !== undefined ? { key: entry.key } : {}),
    queuedAt: entry.queuedAt,
    attempts: entry.attempts,
    lastError: entry.lastError,
  };
  return `${JSON.stringify(head).slice(0, -1)},"record":${recordJson}}`;
}

/** Makes a rename or a new file durable, where the platform allows it. */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Not supported everywhere (Windows); the data itself is already synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Appends lines with a synchronous write and an fsync, so they are on disk
 * when this returns. Creates the file with mode 0600 and its folder with 0700.
 * If the file ends in a torn line, starts on a fresh line so the new entry
 * stays readable. Returns the file's size afterwards.
 */
export function appendLines(file: string, text: string): number {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created = !existsSync(file);
  const fd = openSync(file, 'a+', 0o600);
  try {
    const { size } = fstatSync(fd);
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    const data = Buffer.from(`${prefix}${text}\n`, 'utf8');
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
    return size + data.length;
  } finally {
    closeSync(fd);
    if (created) fsyncDir(dir);
  }
}

/**
 * Replaces the file's content: written to `<file>.tmp`, synced, then renamed
 * over the file. An interruption leaves either the old file or the new one,
 * never half of either. Keeps the file's permissions (0600 for a new file).
 */
export function rewriteFile(file: string, lines: string[]): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // New file.
  }
  const temp = `${file}.tmp`;
  try {
    unlinkSync(temp);
  } catch {
    // Not there: the usual case.
  }
  const fd = openSync(temp, 'wx', mode);
  try {
    fchmodSync(fd, mode);
    const data = Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  fsyncDir(dir);
}
