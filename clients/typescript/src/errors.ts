/**
 * The error contract (ADR 0009, transcribed from clients/go).
 *
 * The one question every caller must be able to answer is "could the store
 * be consulted?". `unavailable` means no: a refused dial, a timeout, a 5xx,
 * a 429, or a body that is not the JSON the API promises. Any other
 * NovamemError is a real answer that was not success — a rejected token, a
 * bad request, an id that is not in your scope (`notFound`). An empty result
 * with no error is the only thing this SDK ever presents as "nothing is
 * stored". Errors never contain the bearer token.
 */
export class NovamemError extends Error {
  /** The client method that failed ("search", "remove-member", …). */
  readonly op: string;
  /** The HTTP status, or 0 when no response was received. */
  readonly statusCode: number;
  /** The server's machine-readable error code, when it sent one. */
  readonly code: string;
  /** True when the store could not be consulted. */
  readonly unavailable: boolean;
  /** True when calling again could plausibly succeed. The SDK never retries for you. */
  readonly retryable: boolean;
  /** True when the store answered that the id is not in your scope. */
  readonly notFound: boolean;
  /** True when the caller's AbortSignal ended the call. */
  readonly canceled: boolean;

  constructor(init: {
    op: string;
    message: string;
    statusCode?: number;
    code?: string;
    unavailable?: boolean;
    retryable?: boolean;
    canceled?: boolean;
  }) {
    const statusCode = init.statusCode ?? 0;
    const code = init.code ?? "";
    let text = `novamem ${init.op}`;
    if (statusCode) text += `: ${statusCode}`;
    if (code) text += ` [${code}]`;
    if (init.message) text += `: ${init.message}`;
    super(text);
    this.name = "NovamemError";
    this.op = init.op;
    this.statusCode = statusCode;
    this.code = code;
    this.unavailable = init.unavailable ?? false;
    this.retryable = init.retryable ?? false;
    this.notFound = statusCode === 404;
    this.canceled = init.canceled ?? false;
  }
}

/** The store could not be consulted. Say so; do not claim ignorance. */
export const isUnavailable = (e: unknown): boolean =>
  e instanceof NovamemError && e.unavailable;
/** Calling again could plausibly succeed. */
export const isRetryable = (e: unknown): boolean =>
  e instanceof NovamemError && e.retryable;
/** The store answered: that id is not in your scope. */
export const isNotFound = (e: unknown): boolean =>
  e instanceof NovamemError && e.notFound;
