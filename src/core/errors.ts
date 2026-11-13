/**
 * Errors that an agent can branch on.
 *
 * Every failure crossing the tool boundary is an ActionError so callers get a
 * stable `code` instead of parsing prose. `hint` is for the agent's next move,
 * `data` carries structured evidence (never HTML blobs).
 */

// Codes are added when a caller can act on them. A declared-but-unused code is an
// invitation to fill it with the nearest wrong meaning.
export type ErrorCode =
  | 'E_NO_BROWSER'
  | 'E_NO_TAB'
  | 'E_BAD_URL'
  | 'E_NAV_TIMEOUT'
  | 'E_NAV_FAILED'
  | 'E_PRECONDITION_FAILED'
  | 'E_REF_INVALID'
  | 'E_REF_STALE'
  | 'E_TARGET_NOT_FOUND'
  | 'E_TARGET_UNSUPPORTED'
  | 'E_WRONG_SITE'
  | 'E_NOT_INTERACTABLE'
  | 'E_ACTION_TIMEOUT'
  | 'E_ACTION_FAILED'
  | 'E_BROWSER_DISCONNECTED'
  // A native-messaging frame exceeded MAX_FRAME_BYTES. Separate from E_INTERNAL
  // because the caller can act on it: shrink the payload, or stop sending. Without
  // its own code this reached the agent as "internal bug" and read as unactionable.
  | 'E_FRAME_TOO_LARGE'
  | 'E_BAD_ARGUMENT'
  | 'E_INTERNAL';

export class ActionError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly data?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; data?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.data !== undefined) this.data = options.data;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint !== undefined ? { hint: this.hint } : {}),
        ...(this.data !== undefined ? { data: this.data } : {}),
      },
    };
  }
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode | 'E_INTERNAL';
    message: string;
    hint?: string;
    data?: Record<string, unknown>;
  };
}

export function toEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof ActionError) return error.toEnvelope();
  return classifyUnknown(error).toEnvelope();
}

/**
 * Maps a foreign error onto a branchable code.
 *
 * The tool layer only formats envelopes, so classification has to happen here —
 * otherwise every transport timeout reaches the agent as E_INTERNAL and there is
 * nothing to branch on. `guarded()` and `toEnvelope()` share this one mapping.
 */
export function classifyUnknown(error: unknown): ActionError {
  if (error instanceof ActionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Target page, context or browser has been closed|No tab with given id|Cannot find context/i.test(message)) {
    return new ActionError('E_BROWSER_DISCONNECTED', message, {
      hint: 'The browser or tab closed. Open a new tab before retrying.',
      cause: error,
    });
  }
  if (/Cannot access a chrome:\/\/ URL|Cannot attach to this target/i.test(message)) {
    return new ActionError('E_TARGET_UNSUPPORTED', message, {
      hint: 'Chrome internal pages cannot be driven. Open an http(s) page first.',
      cause: error,
    });
  }
  if (/element is not visible|no such element|not found in page/i.test(message)) {
    return new ActionError('E_TARGET_NOT_FOUND', message, {
      hint: 'Call browser_observe and use a current ref.',
      cause: error,
    });
  }
  if (/Timeout .* exceeded|timed out/i.test(message)) {
    return new ActionError('E_ACTION_TIMEOUT', message, { cause: error });
  }
  return new ActionError('E_INTERNAL', message, { cause: error });
}

/** Wrap unknown throws so the tool layer always sees a branchable code. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyUnknown(err);
  }
}
