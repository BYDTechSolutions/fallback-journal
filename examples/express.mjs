// An Express 5 route that never loses a signup to a database outage.
// npm install express @bydtech/fallback-journal
import express from 'express';
import { createJournal } from '@bydtech/fallback-journal';

const journal = createJournal({ file: './data/signups.ndjson' });

// Your insert. Upsert on `id`: a replay then never inserts the same signup twice.
async function insertSignup(signup, { id }) {
  // await pool.query(
  //   'INSERT INTO signups (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
  //   [id, signup.email],
  // );
  throw new Error('no database configured in this example');
}

const app = express();

app.post('/signup', express.json(), async (req, res) => {
  const result = await journal.save({ email: req.body.email }, insertSignup);
  // 201: in the database. 202: on disk, and saved as soon as the database is back.
  res.status(result.saved ? 201 : 202).json({ ok: true });
});

// For a monitor: anything above 0 means records are waiting for the database.
app.get('/health', (req, res) => {
  res.json({ signupsWaiting: journal.size() });
});

app.listen(3000, () => console.log('POST http://localhost:3000/signup'));
