// A handler for the CLI: npx fallback-journal replay ./data/signups.ndjson --handler ./save-handler.mjs
// The default export saves one record; `close` (optional) runs when the replay is done.
// npm install pg
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export default async function save(record, { id }) {
  // ON CONFLICT on the journal's id makes a second replay of the same record a no-op.
  await pool.query('INSERT INTO signups (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, record.email]);
}

export async function close() {
  await pool.end();
}
