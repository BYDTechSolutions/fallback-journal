// app/api/signup/route.ts: a Next.js route handler (App Router).
// npm install @bydtech/fallback-journal
import { createJournal } from '@bydtech/fallback-journal';
import { prisma } from '@/lib/prisma'; // your Prisma client

// The journal needs a file system that survives restarts: the Node.js runtime
// on a server or container with a volume, not the Edge runtime or a
// serverless function (see "When not to use it" in the README).
export const runtime = 'nodejs';

interface Signup {
  email: string;
}

const journal = createJournal<Signup>({ file: process.env.SIGNUP_JOURNAL ?? './data/signups.ndjson' });

// Upsert on the journal's id, so a replay never creates a second row.
const insertSignup = (signup: Signup, { id }: { id: string }) =>
  prisma.signup.upsert({ where: { id }, create: { id, ...signup }, update: {} });

export async function POST(request: Request) {
  const { email } = (await request.json()) as Signup;
  const result = await journal.save({ email }, insertSignup);
  return Response.json({ ok: true }, { status: result.saved ? 201 : 202 });
}
