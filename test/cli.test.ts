import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, main } from '../src/commands.js';
import { createJournal, VERSION } from '../src/index.js';
import { captureIo, tempDir } from './helpers.js';

let cwd: string;
let cleanup: () => Promise<void>;
let file: string;

beforeEach(async () => {
  ({ dir: cwd, cleanup } = await tempDir());
  file = join(cwd, 'fallback-journal.ndjson');
});
afterEach(() => cleanup());

async function queue(records: unknown[], target = file, key?: string) {
  const journal = createJournal({ file: target, drainOnSuccess: false });
  for (const record of records) await journal.save(record, () => Promise.reject(new Error('db down')), key ? { key } : {});
  return journal;
}

/** A handler module that appends each record it saves to saved.ndjson, and fails for records with fail: true. */
function writeHandler(name = 'save.mjs', body?: string) {
  const path = join(cwd, name);
  writeFileSync(
    path,
    body ??
      `import { appendFileSync, writeFileSync } from 'node:fs';
export default async function save(record, meta) {
  if (record.fail) throw new Error('rejected by the table');
  appendFileSync(${JSON.stringify(join(cwd, 'saved.ndjson'))}, JSON.stringify({ record, meta }) + '\\n');
}
export async function close() {
  writeFileSync(${JSON.stringify(join(cwd, 'closed'))}, 'yes');
}
`,
  );
  return path;
}
const savedRows = () =>
  existsSync(join(cwd, 'saved.ndjson'))
    ? readFileSync(join(cwd, 'saved.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { record: unknown; meta: { id: string; replay: boolean } })
    : [];

describe('general', () => {
  it('prints help with no command', async () => {
    const io = captureIo(cwd);
    expect(await main([], io)).toBe(EXIT.OK);
    expect(io.out()).toMatch(/Usage:/);
  });

  it('prints the version from package.json', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const io = captureIo(cwd);
    expect(await main(['--version'], io)).toBe(EXIT.OK);
    expect(io.out().trim()).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  it('exits 2 for an unknown command, option or extra argument', async () => {
    const a = captureIo(cwd);
    expect(await main(['drain'], a)).toBe(EXIT.USAGE);
    expect(a.err()).toMatch(/Unknown command "drain"/);
    const b = captureIo(cwd);
    expect(await main(['list', '--handlr', 'x'], b)).toBe(EXIT.USAGE);
    expect(await main(['list', 'a', 'b'], captureIo(cwd))).toBe(EXIT.USAGE);
    expect(await main(['count', '--dry-run'], captureIo(cwd))).toBe(EXIT.USAGE);
  });
});

describe('count and list', () => {
  it('counts 0 for a missing journal and the entries otherwise', async () => {
    const io = captureIo(cwd);
    expect(await main(['count'], io)).toBe(EXIT.OK);
    expect(io.out()).toBe('0\n');
    await queue([{ n: 1 }, { n: 2 }]);
    const io2 = captureIo(cwd);
    expect(await main(['count', 'fallback-journal.ndjson'], io2)).toBe(EXIT.OK);
    expect(io2.out()).toBe('2\n');
  });

  it('lists each record with its id, key, attempts and last error', async () => {
    const journal = await queue([{ email: 'someone@example.com' }], file, 'signup-7');
    const io = captureIo(cwd);
    expect(await main(['list'], io)).toBe(EXIT.OK);
    expect(io.out()).toContain('1 record waiting in');
    expect(io.out()).toContain(journal.pending()[0]?.id);
    expect(io.out()).toContain('key=signup-7  attempts=1');
    expect(io.out()).toContain('last error: db down');
    expect(io.out()).toContain('record: {"email":"someone@example.com"}');
  });

  it('prints JSON with --json, and points out corrupt lines', async () => {
    await queue([{ n: 1 }]);
    writeFileSync(file, '{"id":"half', { flag: 'a' });
    const io = captureIo(cwd);
    expect(await main(['list', '--json'], io)).toBe(EXIT.OK);
    const parsed = JSON.parse(io.out()) as { entries: unknown[]; corrupt: Array<{ torn: boolean }> };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.corrupt[0]?.torn).toBe(true);
    const human = captureIo(cwd);
    await main(['list'], human);
    expect(human.err()).toMatch(/line 2 is not a readable entry \(a write cut short\); it is kept in the file/);
    const count = captureIo(cwd);
    await main(['count'], count);
    expect(count.out()).toBe('1\n');
    expect(count.err()).toMatch(/Plus 1 corrupt line/);
  });

  it('says so when nothing is waiting', async () => {
    const io = captureIo(cwd);
    expect(await main(['list', 'nope.ndjson'], io)).toBe(EXIT.OK);
    expect(io.out()).toMatch(/Nothing waiting: .*nope\.ndjson does not exist/);
  });
});

describe('replay', () => {
  it('saves every record with the handler, empties the journal and calls close', async () => {
    const journal = await queue([{ n: 1 }, { n: 2 }]);
    const ids = journal.pending().map((e) => e.id);
    writeHandler();
    const io = captureIo(cwd);
    expect(await main(['replay', '--handler', './save.mjs'], io)).toBe(EXIT.OK);
    expect(io.out()).toBe('Saved 2. The journal is empty.\n');
    expect(savedRows().map((r) => [r.record, r.meta.id, r.meta.replay])).toEqual([
      [{ n: 1 }, ids[0], true],
      [{ n: 2 }, ids[1], true],
    ]);
    expect(journal.size()).toBe(0);
    expect(existsSync(join(cwd, 'closed'))).toBe(true);
  });

  it('exits 1 and keeps the records the handler rejects', async () => {
    const journal = await queue([{ n: 1 }, { n: 2, fail: true }], join(cwd, 'data', 'orders.ndjson'), 'order-9');
    writeHandler();
    const io = captureIo(cwd);
    expect(await main(['replay', 'data/orders.ndjson', '--handler', 'save.mjs'], io)).toBe(EXIT.FAILED);
    expect(io.err()).toMatch(/\(key order-9\): rejected by the table/);
    expect(io.out()).toMatch(/Saved 1\. 1 record failed and stay in the journal/);
    expect(journal.pending()).toMatchObject([{ record: { n: 2, fail: true }, attempts: 2 }]);
  });

  it('changes nothing and saves nothing with --dry-run', async () => {
    await queue([{ n: 1 }]);
    const before = readFileSync(file, 'utf8');
    writeHandler();
    const io = captureIo(cwd);
    expect(await main(['replay', '--handler', 'save.mjs', '--dry-run'], io)).toBe(EXIT.OK);
    expect(io.out()).toMatch(/Dry run: 1 record would be replayed/);
    expect(io.out()).toContain('record: {"n":1}');
    expect(savedRows()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('exits 2 without --handler, with a missing handler, or one with no default export', async () => {
    await queue([{ n: 1 }]);
    const a = captureIo(cwd);
    expect(await main(['replay'], a)).toBe(EXIT.USAGE);
    expect(a.err()).toMatch(/replay needs --handler <module>/);
    const b = captureIo(cwd);
    expect(await main(['replay', '--handler', 'missing.mjs'], b)).toBe(EXIT.USAGE);
    expect(b.err()).toMatch(/missing\.mjs does not exist/);
    writeHandler('named.mjs', 'export function save() {}\n');
    const c = captureIo(cwd);
    expect(await main(['replay', '--handler', 'named.mjs'], c)).toBe(EXIT.USAGE);
    expect(c.err()).toMatch(/must have a default export/);
  });

  it('exits 1 and touches nothing when the handler fails to load', async () => {
    await queue([{ n: 1 }]);
    const before = readFileSync(file, 'utf8');
    writeHandler('broken.mjs', "throw new Error('cannot reach the database');\n");
    const io = captureIo(cwd);
    expect(await main(['replay', '--handler', 'broken.mjs'], io)).toBe(EXIT.FAILED);
    expect(io.err()).toMatch(/Could not load the handler .*cannot reach the database\nThe journal has not been touched/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('exits 0 when there is no journal to replay', async () => {
    writeHandler();
    const io = captureIo(cwd);
    expect(await main(['replay', '--handler', 'save.mjs'], io)).toBe(EXIT.OK);
    expect(io.out()).toMatch(/Nothing to replay/);
  });
});
