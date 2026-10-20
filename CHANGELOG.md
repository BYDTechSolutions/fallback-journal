# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-21

### Changed

- Published from GitHub Actions through npm trusted publishing, with a
  provenance attestation linking the package to this repository. No code changes.

## [0.1.0] - 2026-10-21

### Added

- `createJournal({ file? })` with `save(record, saveFn, { key? })`: tries the save, and on failure appends the record to the journal (synchronous write and `fsync`, file mode 0600) and resolves with `queued: true` instead of throwing. A successful save replays waiting records in the background.
- `drain(saveFn)`: replays waiting records oldest first, keeps the ones that fail with their attempt count and last error, keeps records queued during the drain, and rewrites the file atomically (temp file and rename).
- An `id` per record, the same on every attempt, plus an optional `key`, passed to the save function so replays can upsert.
- Torn last lines from a crash are reported as corrupt and kept; the next append starts on a fresh line.
- Lock files with stale detection, so several processes on one machine can append to and drain one journal.
- Options `rethrow`, `drainOnSuccess`, `queueIf`, `maxEntries`, `maxBytes`, `onQueued`, `onDrained`; `JournalError` with codes `INVALID_OPTION`, `INVALID_ARGUMENT`, `NOT_SERIALIZABLE`, `JOURNAL_FULL`, `WRITE_FAILED`, `LOCKED`.
- `size()`, `pending()`, `read()` and `readJournal(file)`.
- CLI: `fallback-journal list`, `count` and `replay --handler <module>` with `--dry-run`; exit codes 0, 1 and 2.

[Unreleased]: https://github.com/BYDTechSolutions/fallback-journal/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/BYDTechSolutions/fallback-journal/releases/tag/v0.1.1
[0.1.0]: https://github.com/BYDTechSolutions/fallback-journal/tree/86ce0fb3a8f534447a57bebf3ab2a95a2d1d85e6
