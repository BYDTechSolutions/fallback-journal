#!/usr/bin/env node
import { main } from './commands.js';

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
});
process.exitCode = code;
// A replay handler may leave a database pool open. Exit anyway once the work
// is done; the timer does not keep a process alive that would exit by itself.
setTimeout(() => process.exit(code), 500).unref();
