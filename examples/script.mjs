// A batch import that must not lose a row when the database drops a few
// connections. Run: node examples/script.mjs
import { createJournal } from '@bydtech/fallback-journal';

const journal = createJournal({ file: './data/import.ndjson' });

const rows = [
  { sku: 'A-100', stock: 12 },
  { sku: 'A-101', stock: 0 },
  { sku: 'B-200', stock: 7 },
  { sku: 'B-201', stock: 3 },
  { sku: 'C-300', stock: 40 },
];

// A pretend database that refuses the first three calls. Replace it with your
// insert, and upsert on `id` so a replayed row can never be inserted twice.
let calls = 0;
async function insertRow(row, { id, replay }) {
  calls += 1;
  if (calls <= 3) throw new Error('connection reset by peer');
  console.log(`  saved ${row.sku}${replay ? ' (replayed from the journal)' : ''}, id ${id.slice(0, 8)}`);
}

for (const row of rows) {
  const result = await journal.save(row, insertRow);
  if (result.queued) console.log(`  ${row.sku} kept on disk: ${result.error.message}`);
}

// The script is about to exit, so replay now rather than wait for the next run.
// (A successful save already started a replay in the background; this joins it.)
const { saved, remaining } = await journal.drain(insertRow);
console.log(`Replayed ${saved}. ${remaining} still waiting in ${journal.file}.`);
