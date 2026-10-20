// The README's quick start. Run: node examples/quickstart.mjs
import { createJournal } from '@bydtech/fallback-journal';

const journal = createJournal(); // keeps failed writes in ./fallback-journal.ndjson
const insertSignup = async (signup) => { throw new Error('database is down'); }; // your real insert goes here

const result = await journal.save({ email: 'someone@example.com' }, insertSignup);
console.log(result.queued ? `Kept on disk (${journal.size()} waiting)` : 'Saved');
