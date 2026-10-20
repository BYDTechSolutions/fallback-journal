import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockSync, tryLock, unlock } from '../src/lock.js';
import { tempDir } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
let lock: string;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  lock = join(dir, 'pending.ndjson.lock');
});
afterEach(() => cleanup());

const holder = (pid: number, host = hostname(), token = 'someone-else') => writeFileSync(lock, JSON.stringify({ pid, host, token }));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;

describe('lock files', () => {
  it('is taken once, released, and taken again', () => {
    expect(tryLock(lock, 1000)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: process.pid, host: hostname() });
    expect(tryLock(lock, 1000)).toBe(false);
    unlock(lock);
    expect(existsSync(lock)).toBe(false);
    expect(tryLock(lock, 1000)).toBe(true);
  });

  it('takes over a lock whose process on this host has exited', () => {
    holder(deadPid());
    expect(tryLock(lock, 60_000)).toBe(true);
  });

  it('takes over a lock left by an earlier run with this same pid, as in a restarted container', () => {
    holder(process.pid, hostname(), 'an-earlier-run');
    expect(tryLock(lock, 60_000)).toBe(true);
  });

  it('respects a live holder until the lock is older than staleMs', () => {
    holder(process.ppid);
    expect(tryLock(lock, 60_000)).toBe(false);
    holder(1234, 'another-host');
    expect(tryLock(lock, 60_000)).toBe(false);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(tryLock(lock, 60_000)).toBe(true);
  });

  it('gives up with LOCKED and says what to do', () => {
    holder(process.ppid);
    expect(() => lockSync(lock, { staleMs: 60_000, timeoutMs: 30 })).toThrow(/held by another process.*delete the lock file/);
  });

  it('never releases a lock another process holds', () => {
    holder(process.ppid);
    unlock(lock);
    expect(existsSync(lock)).toBe(true);
  });
});
