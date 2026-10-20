import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { JournalError } from './errors.js';

/**
 * A lock file: `<journal>.lock` or `<journal>.drain.lock`, created with `O_EXCL`
 * so only one process can hold it, holding the owner's pid, host and a token
 * unique to this process.
 *
 * A lock is stale, and taken over, when its owner is on this host and no longer
 * running (or is this pid but an earlier run of it, as in a restarted container
 * where every process is pid 1), or when the file has not been touched for
 * `staleMs`. A process on another host can only be judged by age.
 */

/** Unique to this process, so a lock left by an earlier process with the same pid is recognized. */
const PROCESS_TOKEN = randomUUID();
const HOST = hostname();

interface LockInfo {
  pid: number;
  host: string;
  token: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readInfo(path: string): LockInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    if (typeof info.pid === 'number' && typeof info.host === 'string' && typeof info.token === 'string') {
      return info as LockInfo;
    }
  } catch {
    // Being written right now, or damaged: judged by age alone.
  }
  return undefined;
}

/** Whether a lock left at `path` may be taken over. False when it is gone. */
export function isStale(path: string, staleMs: number): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  const info = readInfo(path);
  if (info && info.host === HOST) {
    if (info.pid === process.pid) return info.token !== PROCESS_TOKEN;
    if (!isAlive(info.pid)) return true;
  }
  return Date.now() - mtimeMs > staleMs;
}

/** Whether this process holds the lock at `path`. */
export function ownsLock(path: string): boolean {
  const info = readInfo(path);
  return !!info && info.host === HOST && info.pid === process.pid && info.token === PROCESS_TOKEN;
}

function create(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'ENOENT') throw error;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw retryError;
    }
  }
  try {
    const info: LockInfo = { pid: process.pid, host: HOST, token: PROCESS_TOKEN };
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Moves a stale lock aside and deletes it. Moving first means two processes cannot both delete it. */
function breakLock(path: string): void {
  const aside = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // Someone else got there first.
  }
  try {
    unlinkSync(aside);
  } catch {
    // Harmless leftover.
  }
}

/** Takes the lock if it is free or stale. Never waits. */
export function tryLock(path: string, staleMs: number): boolean {
  if (create(path)) return true;
  if (!isStale(path, staleMs)) return false;
  breakLock(path);
  return create(path);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/**
 * Takes the lock, waiting up to `timeoutMs`. Synchronous on purpose: it guards
 * appends and rewrites that take milliseconds, and an append must finish
 * before `save` returns.
 */
export function lockSync(path: string, options: { staleMs: number; timeoutMs: number }): void {
  const deadline = Date.now() + options.timeoutMs;
  let wait = 1;
  while (!tryLock(path, options.staleMs)) {
    if (Date.now() >= deadline) {
      throw new JournalError(
        'LOCKED',
        `fallback-journal: ${path} has been held by another process for over ${options.timeoutMs} ms. ` +
          `If no other process is using this journal, delete the lock file and try again.`,
      );
    }
    sleepSync(wait);
    wait = Math.min(wait * 2, 25);
  }
}

/** Releases a lock this process holds. Leaves it alone if another process has taken it over. */
export function unlock(path: string): void {
  if (!ownsLock(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Marks a long-held lock as still in use, so other processes do not judge it stale. */
export function touchLock(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // If it is gone, the next unlock is a no-op.
  }
}

/** Runs `fn` while holding the lock at `path`. */
export function withLockSync<R>(path: string, options: { staleMs: number; timeoutMs: number }, fn: () => R): R {
  lockSync(path, options);
  try {
    return fn();
  } finally {
    unlock(path);
  }
}
