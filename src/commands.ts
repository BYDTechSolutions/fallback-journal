import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { describeError } from './errors.js';
import { readJournal, type JournalEntry } from './file.js';
import { createJournal, DEFAULT_FILE, type SaveFn } from './journal.js';
import { VERSION } from './version.js';

/** Exit codes: 0 success, 1 records failed or the journal was busy, 2 bad usage (nothing touched). */
export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

/** Everything the CLI touches outside itself, so tests can replace it. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

export const HELP = `fallback-journal ${VERSION}: see and replay records waiting in a journal file

Usage:
  fallback-journal list [file] [--json]
  fallback-journal count [file]
  fallback-journal replay [file] --handler <module> [--dry-run]

Commands:
  list     Show every record waiting, and any corrupt line.
  count    Print how many records are waiting.
  replay   Save every waiting record with the default export of <module>,
           e.g. export default async function save(record, { id }) { ... }
           Saved records leave the journal; failed ones stay.

[file] defaults to ./${DEFAULT_FILE}.

Options:
  --handler <module>   For replay: a .mjs or .js file whose default export saves one record
  --dry-run            For replay: load the handler and list what would be replayed; save nothing
  --json               For list: print the entries as JSON
  -h, --help           Show this help
  -v, --version        Show the version

Exit codes: 0 ok, 1 some records failed again or another process was draining, 2 usage error.
`;

class UsageError extends Error {}

const OPTIONS = {
  handler: { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const satisfies ParseArgsConfig['options'];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeEntry(entry: JournalEntry): string {
  const key = entry.key !== undefined ? `  key=${entry.key}` : '';
  return (
    `  ${entry.queuedAt || '(no time)'}  ${entry.id}${key}  attempts=${entry.attempts}\n` +
    `    last error: ${entry.lastError || '(none recorded)'}\n` +
    `    record: ${clip(JSON.stringify(entry.record) ?? 'undefined', 300)}\n`
  );
}

function corruptNotes(file: string, io: CliIo): number {
  const { corrupt } = readJournal(file);
  for (const line of corrupt) {
    io.stderr(`! line ${line.line} is not a readable entry${line.torn ? ' (a write cut short)' : ''}; it is kept in the file: ${clip(line.text, 120)}\n`);
  }
  return corrupt.length;
}

async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(describeError(error));
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT.OK;
  }
  const [command, fileArg, ...extra] = positionals;
  if (values.help || !command) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  if (!['list', 'count', 'replay'].includes(command)) throw new UsageError(`Unknown command "${command}". Use list, count or replay.`);
  if (extra.length) throw new UsageError(`Unexpected argument "${extra[0]}". Pass one journal file.`);
  if (command !== 'replay' && (values.handler !== undefined || values['dry-run'])) {
    throw new UsageError('--handler and --dry-run only apply to replay.');
  }
  if (command !== 'list' && values.json) throw new UsageError('--json only applies to list.');
  const file = resolve(io.cwd, fileArg ?? DEFAULT_FILE);

  if (command === 'count') {
    io.stdout(`${readJournal(file).entries.length}\n`);
    const corrupt = readJournal(file).corrupt.length;
    if (corrupt) io.stderr(`Plus ${plural(corrupt, 'corrupt line')}: run "fallback-journal list" to see them.\n`);
    return EXIT.OK;
  }

  if (command === 'list') {
    const { entries, corrupt } = readJournal(file);
    if (values.json) {
      io.stdout(`${JSON.stringify({ file, entries, corrupt }, null, 2)}\n`);
      return EXIT.OK;
    }
    if (!existsSync(file)) {
      io.stdout(`Nothing waiting: ${file} does not exist.\n`);
      return EXIT.OK;
    }
    io.stdout(entries.length ? `${plural(entries.length, 'record')} waiting in ${file}:\n\n` : `Nothing waiting in ${file}.\n`);
    for (const entry of entries) io.stdout(describeEntry(entry));
    corruptNotes(file, io);
    return EXIT.OK;
  }

  // replay
  if (!values.handler) {
    throw new UsageError('replay needs --handler <module>: a file whose default export saves one record, e.g. --handler ./save.mjs');
  }
  const handlerPath = resolve(io.cwd, values.handler);
  if (!existsSync(handlerPath)) throw new UsageError(`The handler ${handlerPath} does not exist.`);
  if (!existsSync(file)) {
    io.stdout(`Nothing to replay: ${file} does not exist.\n`);
    return EXIT.OK;
  }

  let handler: { default?: unknown; close?: unknown };
  try {
    handler = (await import(pathToFileURL(handlerPath).href)) as typeof handler;
  } catch (error) {
    io.stderr(`Could not load the handler ${handlerPath}: ${describeError(error)}\nThe journal has not been touched.\n`);
    return EXIT.FAILED;
  }
  if (typeof handler.default !== 'function') {
    throw new UsageError(
      `The handler ${handlerPath} must have a default export that saves one record:\n` +
        `  export default async function save(record, { id }) { await db.insert('signups', { ...record, id }); }`,
    );
  }
  const saveFn = handler.default as SaveFn<unknown>;
  const close = async () => {
    if (typeof handler.close === 'function') await (handler.close as () => unknown)();
  };

  try {
    if (values['dry-run']) {
      const { entries } = readJournal(file);
      io.stdout(`Dry run: ${plural(entries.length, 'record')} would be replayed from ${file}. Nothing was saved or changed.\n\n`);
      for (const entry of entries) io.stdout(describeEntry(entry));
      corruptNotes(file, io);
      return EXIT.OK;
    }

    const journal = createJournal({ file, drainOnSuccess: false });
    const result = await journal.drain(saveFn);
    if (result.busy) {
      io.stderr(`Another process is draining ${file} right now; nothing was replayed. Try again when it is done.\n`);
      return EXIT.FAILED;
    }
    for (const failure of result.errors) {
      const key = failure.key !== undefined ? ` (key ${failure.key})` : '';
      io.stderr(`! ${failure.id}${key}: ${describeError(failure.error)}\n`);
    }
    const notes: string[] = [];
    if (result.failed) notes.push(`${plural(result.failed, 'record')} failed and stay in the journal; the errors are above`);
    if (result.remaining > result.failed) notes.push(`${plural(result.remaining - result.failed, 'record')} arrived while replaying and wait for the next run`);
    if (result.corrupt) notes.push(`${plural(result.corrupt, 'corrupt line')} kept as-is; see "fallback-journal list"`);
    io.stdout(`Saved ${result.saved}. ${notes.length ? `${notes.join('; ')}.` : 'The journal is empty.'}\n`);
    return result.failed ? EXIT.FAILED : EXIT.OK;
  } finally {
    await close();
  }
}

/** Runs the CLI with the given arguments and returns the exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\nRun "fallback-journal --help" for usage.\n`);
      return EXIT.USAGE;
    }
    io.stderr(`fallback-journal: ${describeError(error)}\n`);
    return EXIT.FAILED;
  }
}
