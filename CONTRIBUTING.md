# Contributing

Thanks for helping. Issues and pull requests are welcome at
[github.com/BYDTechSolutions/fallback-journal](https://github.com/BYDTechSolutions/fallback-journal).

## Setup

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Node.js 20 or later.

## Rules

- This package exists so records are not lost. A change to how the file is
  written, read, locked or rewritten needs a test that simulates the crash or
  the race it is about: a partial line, a rename that fails, several processes
  (see `test/processes.test.ts`).
- Never drop a line the code cannot read. Report it and keep it.
- Tests write only inside their own temporary directory.
- No runtime dependencies without a strong reason, stated in the README.
- Add a line to `CHANGELOG.md` under "Unreleased".
- American English in code, messages and docs.
