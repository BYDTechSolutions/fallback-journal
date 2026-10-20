/**
 * Why the journal could not do what was asked.
 *
 * - `INVALID_OPTION`: an option passed to `createJournal` has an impossible value.
 * - `INVALID_ARGUMENT`: `save` or `drain` was called with the wrong arguments.
 * - `NOT_SERIALIZABLE`: the record cannot be written as JSON (a `BigInt`, a circular reference).
 * - `JOURNAL_FULL`: the save failed and the journal has reached `maxEntries` or `maxBytes`.
 * - `WRITE_FAILED`: the save failed and the record could not be written to the journal either.
 * - `LOCKED`: another process held the journal's lock for too long.
 */
export type JournalErrorCode =
  | 'INVALID_OPTION'
  | 'INVALID_ARGUMENT'
  | 'NOT_SERIALIZABLE'
  | 'JOURNAL_FULL'
  | 'WRITE_FAILED'
  | 'LOCKED';

/**
 * An error with a stable `code` and a message written for a person to read.
 *
 * For `JOURNAL_FULL` and `WRITE_FAILED` the record is in neither place: `record`
 * holds it, and `cause` is the error your save function threw, so you can log
 * it as a last resort.
 */
export class JournalError extends Error {
  readonly code: JournalErrorCode;
  /** The record that could not be kept, for `JOURNAL_FULL` and `WRITE_FAILED`. */
  readonly record?: unknown;

  constructor(code: JournalErrorCode, message: string, options: { cause?: unknown; record?: unknown } = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'JournalError';
    this.code = code;
    if ('record' in options) this.record = options.record;
  }
}

/** The message of anything thrown, for logs and the journal's `lastError` field. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
