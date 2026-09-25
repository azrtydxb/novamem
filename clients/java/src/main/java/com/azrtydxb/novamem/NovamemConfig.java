package com.azrtydxb.novamem;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.time.Duration;

/**
 * Where novamem is and who is calling. Nothing is read from the environment. Build one with {@link
 * #builder()}; {@code build()} rejects a bad base URL or a blank token, so a mistake fails here
 * rather than on every call.
 */
public final class NovamemConfig {
  /** The timeout used when none (or a non-positive one) is given. */
  public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(15);

  private final String baseUrl;
  private final String token;
  private final Duration timeout;
  private final HttpClient httpClient;

  private NovamemConfig(Builder b) {
    String url = b.baseUrl == null ? "" : b.baseUrl.trim();
    while (url.endsWith("/")) {
      url = url.substring(0, url.length() - 1);
    }
    // Names the field, never the value: a token pasted into the wrong option
    // must not end up in a log line.
    if (!isHttpUrl(url)) {
      throw new IllegalArgumentException("novamem: baseUrl is not an absolute http(s) URL");
    }
    // Paths are appended to baseUrl, so a query or fragment on it would
    // swallow every route ("https://h?x=1" + "/v1/stats").
    if (url.contains("?") || url.contains("#")) {
      throw new IllegalArgumentException("novamem: baseUrl must not have a query or fragment");
    }
    if (b.token == null || b.token.isBlank()) {
      throw new IllegalArgumentException("novamem: token is required");
    }
    this.baseUrl = url;
    this.token = b.token;
    this.timeout =
        b.timeout == null || b.timeout.isZero() || b.timeout.isNegative()
            ? DEFAULT_TIMEOUT
            : b.timeout;
    this.httpClient = b.httpClient;
  }

  private static boolean isHttpUrl(String url) {
    try {
      URI u = new URI(url);
      return u.isAbsolute()
          && ("http".equals(u.getScheme()) || "https".equals(u.getScheme()))
          && u.getHost() != null
          && !u.getHost().isEmpty();
    } catch (URISyntaxException e) {
      return false;
    }
  }

  /** A builder with nothing set. */
  public static Builder builder() {
    return new Builder();
  }

  /** The service root, without a trailing slash. */
  public String baseUrl() {
    return baseUrl;
  }

  /** The bound on every call, redirects and body included. */
  public Duration timeout() {
    return timeout;
  }

  /** The caller's HttpClient, or null for the SDK's own. */
  public HttpClient httpClient() {
    return httpClient;
  }

  String token() {
    return token;
  }

  /** The base URL for printing: a token pasted into it by mistake is redacted there too. */
  String redactedBaseUrl() {
    return baseUrl.replace(token, "[redacted]");
  }

  @Override
  public String toString() {
    return "NovamemConfig[baseUrl=" + redactedBaseUrl() + ", token=[redacted]]";
  }

  /** Builds a {@link NovamemConfig}. */
  public static final class Builder {
    private String baseUrl;
    private String token;
    private Duration timeout;
    private HttpClient httpClient;

    private Builder() {}

    /** The service root, e.g. {@code https://novamem.example.com}. */
    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    /** The user's {@code nm_} bearer token. */
    public Builder token(String token) {
      this.token = token;
      return this;
    }

    /** The bound on every call; 15 seconds when unset. */
    public Builder timeout(Duration timeout) {
      this.timeout = timeout;
      return this;
    }

    /**
     * An HttpClient to send through. It must not follow redirects itself ({@code
     * HttpClient.Redirect.NEVER}, the default): the SDK follows them, so the bearer never reaches
     * another origin.
     */
    public Builder httpClient(HttpClient httpClient) {
      this.httpClient = httpClient;
      return this;
    }

    /**
     * The config.
     *
     * @throws IllegalArgumentException naming the field that is wrong
     */
    public NovamemConfig build() {
      return new NovamemConfig(this);
    }
  }
}
