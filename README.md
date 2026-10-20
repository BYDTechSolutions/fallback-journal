# @bydtech/fallback-journal

When a database write fails, keep the record on disk as one JSON line and save it later, so a restart never loses a signup, a lead or an order.

[![npm version](https://img.shields.io/npm/v/@bydtech/fallback-journal.svg)](https://www.npmjs.com/package/@bydtech/fallback-journal)
[![CI](https://github.com/BYDTechSolutions/fallback-journal/actions/workflows/ci.yml/badge.svg)](https://github.com/BYDTechSolutions/fallback-journal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why it exists

A form says "thanks, we got it", but the database was down for a minute, so the insert failed. The usual fix, holding failed writes in an array to retry later, works until the process restarts: then the array is gone, and so is the person who was told their message arrived. Nobody notices, because the only record of them was the thing that disappeared.

This package keeps the failed write in a file instead, synced to disk before `save` returns, and puts it in the database once the database is back.

## Install

```sh
npm install @bydtech/fallback-journal
```

Node.js 20 or later. No runtime dependencies. It is an ES module; a CommonJS app (a default NestJS build, say) can `require` it on Node.js 20.19+ or 22.12+.

## Quick start

Paste this into `quickstart.mjs` and run `node quickstart.mjs`:

```js
import { createJournal } from '@bydtech/fallback-journal';

const journal = createJournal(); // keeps failed writes in ./fallback-journal.ndjson
const insertSignup = async (signup) => { throw new Error('database is down'); }; // your real insert goes here

const result = await journal.save({ email: 'someone@example.com' }, insertSignup);
console.log(result.queued ? `Kept on disk (${journal.size()} waiting)` : 'Saved');
```

It prints `Kept on disk (1 waiting)`, and `fallback-journal.ndjson` now holds the signup. Now pretend the database is back: change the insert to one that works and run it again.

```js
const insertSignup = async (signup) => console.log('inserted', signup.email);
```

It prints `inserted` twice: the new signup, then the one that was waiting, and the file is empty again.

That is the whole idea: **wrap your insert in `journal.save(record, insert)`**. If the insert works, nothing else happens. If it throws, the record goes to the file and `save` resolves with `queued: true` instead of throwing. The next successful `save` replays what is waiting, or you call `journal.drain(insert)` yourself.

**Add the file to `.gitignore`.** It holds real user data:

```gitignore
fallback-journal.ndjson*
```

## When to use it, and when not to

Use it when:

- a write must not be lost, and telling the user "try again later" is worse than saving it a minute late: signups, contact forms, leads, orders, webhook payloads;
- your app runs as a long-lived Node.js process (a server, a container, a worker) with a disk that survives restarts;
- the record is plain JSON data.

Do not use it when:

- **you run on serverless or the Edge** (Vercel functions, AWS Lambda, Cloudflare Workers): the file system there is temporary or missing, so the journal would vanish with the instance, which is the failure this package exists to fix. Use a durable queue instead;
- your container has no volume: the file dies with the container. Mount one and point `file` at it;
- several servers need one shared journal: each server keeps its own file (see [How it works](#how-it-works-and-its-limits));
- the write must happen exactly in order with other writes, or inside a transaction with them: a replayed record arrives later than records saved after it;
- the error is one a retry cannot fix, such as invalid data or a duplicate key: those should reach the user. Use [`queueIf`](#configuration) to throw them instead of queuing.

## Examples

Each one is in [`examples/`](examples).

### Express

```js
import express from 'express';
import { createJournal } from '@bydtech/fallback-journal';

const journal = createJournal({ file: './data/signups.ndjson' });

async function insertSignup(signup, { id }) {
  // Upsert on `id`, so a replay never inserts the same signup twice.
  await pool.query('INSERT INTO signups (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, signup.email]);
}

const app = express();
app.post('/signup', express.json(), async (req, res) => {
  const result = await journal.save({ email: req.body.email }, insertSignup);
  res.status(result.saved ? 201 : 202).json({ ok: true }); // 202: on disk, saved once the database is back
});
app.get('/health', (req, res) => res.json({ signupsWaiting: journal.size() }));
app.listen(3000);
```

### Next.js route handler

```ts
// app/api/signup/route.ts
import { createJournal } from '@bydtech/fallback-journal';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs'; // needs a real file system: a server or container, not serverless

interface Signup { email: string }
const journal = createJournal<Signup>({ file: './data/signups.ndjson' });

const insertSignup = (signup: Signup, { id }: { id: string }) =>
  prisma.signup.upsert({ where: { id }, create: { id, ...signup }, update: {} });

export async function POST(request: Request) {
  const { email } = (await request.json()) as Signup;
  const result = await journal.save({ email }, insertSignup);
  return Response.json({ ok: true }, { status: result.saved ? 201 : 202 });
}
```

### NestJS service

```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { createJournal, type SaveMeta } from '@bydtech/fallback-journal';
import { SignupEntity } from './signup.entity';

interface Signup { email: string }

@Injectable()
export class SignupsService implements OnApplicationBootstrap {
  private readonly log = new Logger(SignupsService.name);
  private readonly journal = createJournal<Signup>({
    file: 'storage/signups.ndjson',
    onQueued: (entry, error) => this.log.warn(`Signup ${entry.id} kept on disk: ${String(error)}`),
  });

  constructor(@InjectRepository(SignupEntity) private readonly signups: Repository<SignupEntity>) {}

  private readonly insert = async (signup: Signup, { id }: SaveMeta) => {
    await this.signups.upsert({ id, ...signup }, ['id']);
  };

  async create(signup: Signup) {
    const result = await this.journal.save(signup, this.insert);
    return { received: true, storedIn: result.saved ? 'database' : 'journal' };
  }

  onApplicationBootstrap() {
    // Records left from before a restart go in once the app is up.
    this.journal.drain(this.insert).catch((error: unknown) => this.log.error(String(error)));
  }
}
```

### A plain script

```js
import { createJournal } from '@bydtech/fallback-journal';

const journal = createJournal({ file: './data/import.ndjson' });

for (const row of rows) {
  const result = await journal.save(row, insertRow);
  if (result.queued) console.log(`${row.sku} kept on disk: ${result.error.message}`);
}

// About to exit: replay now rather than wait for the next run.
const { saved, remaining } = await journal.drain(insertRow);
console.log(`Replayed ${saved}. ${remaining} still waiting.`);
```

[`examples/script.mjs`](examples/script.mjs) runs as is, with a pretend database that drops its first three calls.

## Idempotency: replays never insert twice

Every record gets an `id` (a random UUID) before the first try, and your save function receives it on every attempt, the first one and every replay:

```js
await journal.save(order, (order, { id, key, attempt, replay }) => db.orders.upsert({ id, ...order }));
```

Use it as the primary key, or in an `ON CONFLICT (id) DO NOTHING`, and a record is saved once even when a replay repeats a write that had in fact gone through (a timeout after the database committed, a crash before the journal was cleaned up).

Already have your own unique value, such as an order number or a request id? Pass it as `key`. It is stored with the entry and passed to your function as `meta.key`:

```js
await journal.save(order, saveOrder, { key: order.number });
```

## CLI reference

For looking at a journal, and replaying it by hand: after an outage when no new write came along to trigger a replay, when a record keeps failing, or with a journal copied from a server that is gone.

```
fallback-journal list [file] [--json]
fallback-journal count [file]
fallback-journal replay [file] --handler <module> [--dry-run]
```

`[file]` defaults to `./fallback-journal.ndjson`.

- **`list`** prints every waiting record with its id, key, attempts, last error and data, and every corrupt line. `--json` prints `{ file, entries, corrupt }`.
- **`count`** prints the number of waiting records, and nothing else, on stdout.
- **`replay`** saves each waiting record with the default export of `--handler`, oldest first. Saved records leave the journal; failed ones stay, with their error printed. `--dry-run` loads the handler and lists what would be replayed, without saving or changing anything.

A handler is a `.mjs` (or `.js`) file whose default export saves one record, with the same signature as the function you pass to `save`. An optional `close` export runs at the end, to shut a connection pool:

```js
// save.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export default async function save(record, { id }) {
  await pool.query('INSERT INTO signups (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, record.email]);
}
export async function close() {
  await pool.end();
}
```

```sh
npx fallback-journal replay ./data/signups.ndjson --handler ./save.mjs --dry-run
npx fallback-journal replay ./data/signups.ndjson --handler ./save.mjs
```

| Exit code | Meaning |
|---|---|
| `0` | Done: every record was saved, there was nothing to replay, or `list`, `count` and `--dry-run` finished. |
| `1` | Some records failed again and stay in the journal, the handler could not be loaded, or another process was draining the journal. |
| `2` | Usage error: unknown command or option, missing `--handler`, a handler without a default export. Nothing was touched. |

## API reference

```ts
import { createJournal, readJournal, JournalError } from '@bydtech/fallback-journal';
```

### `createJournal(options?)`

Returns a journal bound to one file. Create it once, at startup, and share it. Use one journal (one file) per kind of record: a drain replays every entry with the one function it is given.

### `journal.save(record, saveFn, { key }?)`

Calls `saveFn(record, meta)`. Resolves with:

- `{ saved: true, queued: false, id, value }` when it worked (`value` is what `saveFn` returned);
- `{ saved: false, queued: true, id, error }` when it threw and the record is now in the journal.

After a successful save it replays waiting records in the background with the same `saveFn` (turn off with `drainOnSuccess: false`).

`save` throws only when it should not pretend the record is safe:

- `JournalError` `JOURNAL_FULL` or `WRITE_FAILED`: the save failed **and** the record could not be written to the journal. `error.record` holds the record and `error.cause` the save error, so you can log them as a last resort;
- `JournalError` `NOT_SERIALIZABLE`: the record cannot be written as JSON (a `BigInt`, a circular reference). Checked before the first try, so you find out in development, not during an outage;
- the save error itself, when `queueIf` returns `false`, or after queuing when `rethrow` is on.

`meta` is `{ id, key?, attempt, replay }`: `attempt` is 1 for the first try and counts up on each replay; `replay` is true when the record comes from the journal.

### `journal.drain(saveFn)`

Replays every waiting record, oldest first, each on its own: one record that fails does not hold back the rest. Resolves with `{ saved, failed, remaining, corrupt, busy, errors }`. Records that fail again stay, with `attempts` and `lastError` updated. Records queued while the drain runs are kept. If a drain is already running in this process, you get that one's result; if another process is draining the same file, it resolves at once with `busy: true`.

### `journal.size()`, `journal.pending()`, `journal.read()`

How many records are waiting; the entries themselves, oldest first; and `{ entries, corrupt }`. Each reads the file: fine for a health check, not for a hot loop.

### `readJournal(file)`

Reads any journal file, without a lock: `{ entries, corrupt }`. A missing file is an empty journal.

### The file

One entry per line:

```json
{"id":"0b6f…","key":"order-1001","queuedAt":"2026-10-21T09:14:03.112Z","attempts":1,"lastError":"connect ECONNREFUSED 127.0.0.1:5432","record":{"email":"someone@example.com"}}
```

All types (`Journal`, `JournalOptions`, `JournalEntry`, `SaveFn`, `SaveMeta`, `SaveResult`, `DrainResult`, `JournalErrorCode`, …) are exported, with TSDoc for your editor. `createJournal<Signup>()` types the record everywhere.

## Configuration

Every option is optional.

| Option | Default | What it does |
|---|---|---|
| `file` | `'fallback-journal.ndjson'` | Path of the journal, resolved against the working directory when the journal is created. Its folder is created if needed. |
| `drainOnSuccess` | `true` | After a successful `save`, replay waiting records in the background with the same function. After a replay that left failures, the next background replay waits 30 seconds, so a record that never saves is not retried on every request. |
| `rethrow` | `false` | Throw the save error after queuing the record, for callers that want the error (to return a 503, say) and still keep the record. |
| `queueIf` | queue every error | `(error, record) => boolean`. Return `false` to throw the error instead of queuing: for errors a retry cannot fix, such as a unique-constraint violation. |
| `maxEntries` | `100000` | Lines the journal may hold. Past it, a failed save throws `JOURNAL_FULL`. |
| `maxBytes` | `52428800` (50 MiB) | Bytes the journal may hold. Past it, a failed save throws `JOURNAL_FULL`. |
| `onQueued` | none | `(entry, error) => void`, after a record is written to the journal: log it, alert someone. |
| `onDrained` | none | `(result) => void`, after a drain that saved or failed at least one record. |

A hook that throws does not break the save: its error becomes a process warning (code `FALLBACK_JOURNAL`).

## How it works, and its limits

- **Appends are synchronous and synced.** The line is written with `writeSync` and `fsync`ed before `save` resolves, and the folder is synced when the file is first created. This path runs when something is already broken, and an asynchronous write that loses the race with a crash is the failure being fixed. It costs a few milliseconds, only when a save fails.
- **A crash mid-append leaves a torn last line.** It is reported as corrupt (`torn: true`), never deleted, and the next append starts on a fresh line so the new entry stays readable. Half a record a person can read is worth more than nothing. Corrupt lines stay in the file through every drain; look at them with `fallback-journal list`, recover what you can, and delete the line by hand.
- **Drains rewrite the file atomically.** The remaining lines go to `<file>.tmp`, which is synced and renamed over the journal. A crash at any point leaves the old file or the new one, never half of either. A crash after records were saved but before the rename means they are replayed again: that is what the `id` is for.
- **Lock files make several processes on one machine safe** (cluster workers, PM2 instances, a CLI replay next to the app). `<file>.lock` is held for the milliseconds an append or a rewrite takes, so no process's append is lost in another's rewrite. `<file>.drain.lock` is held for a whole drain, so two processes never replay the same record at once; the second one gets `busy: true`. A lock whose process has exited is taken over at once, as is one left by an earlier run with the same pid (a restarted container). A lock whose owner cannot be checked, because it runs on another host, is taken over when it has not been touched for 5 seconds (append lock) or 60 seconds (drain lock; a running drain refreshes it).
- **Several servers sharing a network file system are not supported.** Lock files over NFS or SMB are not reliable enough to promise anything. Give each server its own file on its own disk.
- **Replays are at-least-once.** The `id` turns that into exactly-once in your database, if your save function upserts on it. Without that, a record can be inserted twice after a crash in the wrong moment.
- **Records are stored as JSON.** A `Date` comes back from a replay as a string, a `Buffer` as `{ type, data }`, and `undefined` fields disappear. The first try gets your original object.
- **One journal, one kind of record.** A drain replays every entry with the function it is given.
- **Order is kept within the journal**, oldest first, but a replayed record reaches the database after records that were saved directly in the meantime.
- **Tested on Linux and macOS.** On Windows, `fsync` of a folder is skipped and file modes do not apply.
- **No runtime dependencies.** It uses `node:fs`, `node:crypto` (`randomUUID`), `node:os`, `node:path` and `node:util` `parseArgs` for the CLI.

### The file holds real user data

Whatever you save is in the journal in plain text: email addresses, names, phone numbers, order details. Treat it like a database table:

- it is created with mode `0600` (owner only) in a folder created `0700`; keep it that way;
- keep it out of version control (`fallback-journal.ndjson*` in `.gitignore`) and out of container images;
- put it on a volume that is backed up, since until it is replayed it is the only copy;
- it falls under the same privacy rules as your database: delete records people ask you to delete from it too.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

Maintained by [BYD Tech](https://bydtech.in), a software studio that builds MVPs, AI agents, and web & mobile apps.
