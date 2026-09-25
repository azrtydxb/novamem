package com.azrtydxb.novamem;

/**
 * Every failure of a call. Never contains the bearer token.
 *
 * <p>The one question every caller must be able to answer is "could the store be consulted?" —
 * {@link #isUnavailable()}. It is true for a refused dial, a timeout, a 5xx, a 429, or a body that
 * is not the JSON the API promises. Any other NovamemException is a real answer that was not
 * success: a rejected token, a bad request, an id that is not in your scope ({@link
 * #isNotFound()}). An empty result with no exception is the only thing this SDK presents as
 * "nothing is stored". Cancelling an async call's future surfaces as {@link
 * java.util.concurrent.CancellationException}, as usual.
 */
public final class NovamemException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  private final String op;
  private final String detail;
  private final int statusCode;
  private final String code;
  private final boolean unavailable;
  private final boolean retryable;

  NovamemException(String op, String detail) {
    this(op, detail, 0, "", false, false);
  }

  NovamemException(
      String op,
      String detail,
      int statusCode,
      String code,
      boolean unavailable,
      boolean retryable) {
    super(render(op, detail, statusCode, code));
    this.op = op;
    this.detail = detail;
    this.statusCode = statusCode;
    this.code = code;
    this.unavailable = unavailable;
    this.retryable = retryable;
  }

  static NovamemException unavailable(String op, String detail, int statusCode, boolean retryable) {
    return new NovamemException(op, detail, statusCode, "", true, retryable);
  }

  private static String render(String op, String detail, int status, String code) {
    StringBuilder s = new StringBuilder("novamem ").append(op);
    if (status != 0) {
      s.append(": ").append(status);
    }
    if (!code.isEmpty()) {
      s.append(" [").append(code).append(']');
    }
    if (!detail.isEmpty()) {
      s.append(": ").append(detail);
    }
    return s.toString();
  }

  /** The client method that failed ("search", "remove-member", …). */
  public String op() {
    return op;
  }

  /** The server's message, or a description of the transport failure. */
  public String detail() {
    return detail;
  }

  /** The HTTP status, or 0 when no response was received. */
  public int statusCode() {
    return statusCode;
  }

  /** The server's machine-readable error code, when it sent one; otherwise "". */
  public String code() {
    return code;
  }

  /** The store could not be consulted. Say so; do not claim ignorance. */
  public boolean isUnavailable() {
    return unavailable;
  }

  /** Calling again could plausibly succeed. The SDK never retries for you. */
  public boolean isRetryable() {
    return retryable;
  }

  /** The store answered: that id is not in your scope. */
  public boolean isNotFound() {
    return statusCode == 404;
  }
}
