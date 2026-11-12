/**
 * Errors that an agent can branch on.
 *
 * Every failure crossing the tool boundary is an ActionError so callers get a
 * stable `code` instead of parsing prose. `hint` is for the agent's next move,
 * `data` carries structured evidence (never HTML blobs).
 */

export type ErrorCode =
  | 'E_NO_TAB'
  | 'E_BAD_URL'
  | 'E_NAV_TIMEOUT'
  | 'E_PAGE_BUSY'
  | 'E_REF_INVALID'
  | 'E_REF_STALE'
  | 'E_TARGET_NOT_FOUND'
  | 'E_TARGET_AMBIGUOUS'
  | 'E_NOT_INTERACTABLE'
  | 'E_ACTION_TIMEOUT'
  | 'E_ACTION_FAILED'
  | 'E_BROWSER_DISCONNECTED'
  | 'E_SESSION_CLOSED'
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
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'E_INTERNAL', message } };
}

/** Wrap unknown throws so the tool layer always sees a branchable code. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ActionError) throw err;
    if (err instanceof Error && /Target page, context or browser has been closed/i.test(err.message)) {
      throw new ActionError('E_BROWSER_DISCONNECTED', err.message, {
        hint: 'The browser or tab closed. Open a new tab before retrying.',
        cause: err,
      });
    }
    if (err instanceof Error && /Timeout .* exceeded/i.test(err.message)) {
      throw new ActionError('E_ACTION_TIMEOUT', err.message, { cause: err });
    }
    throw new ActionError('E_INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
  }
}
