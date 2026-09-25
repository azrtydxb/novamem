//! One function makes every request, so the classification of failures is
//! written exactly once.

use std::fmt;
use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use crate::Error;

/// Bounds a single call when no timeout is given. Sized for the slowest
/// operation: capture embeds the content server-side before it answers.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// Responses larger than this are rejected rather than buffered.
pub const MAX_RESPONSE_BYTES: usize = 8 << 20;

/// Everything a client needs, all of it injected: nothing is read from the
/// environment, so two clients — or one pointed at a test server — can
/// live in one process.
#[derive(Clone, Default)]
pub struct Config {
    /// The service root, e.g. `https://novamem.example.com`.
    pub base_url: String,
    /// The user's `nm_…` bearer. Never included in an error or in `Debug`.
    pub token: String,
    /// Bounds each call. `None` means [`DEFAULT_TIMEOUT`].
    pub timeout: Option<Duration>,
    /// An injected client, e.g. with a custom root store. Its own redirect
    /// policy then applies.
    pub http: Option<reqwest::Client>,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("base_url", &self.base_url)
            .field("token", &"[redacted]")
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct Transport {
    base: String,
    token: String,
    timeout: Duration,
    http: reqwest::Client,
}

impl fmt::Debug for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Transport")
            .field("base", &self.base)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// A successful response: its status, kept so a body that decodes as JSON
/// but not as the expected type can still report it.
pub(crate) struct Resp {
    pub status: u16,
    pub body: Value,
}

pub(crate) struct Call<'a> {
    pub op: &'a str,
    pub method: Method,
    pub path: String,
    pub body: Option<Value>,
    pub query: Vec<(&'a str, String)>,
    pub expect_body: bool,
}

impl<'a> Call<'a> {
    pub fn new(op: &'a str, method: Method, path: impl Into<String>) -> Self {
        Call {
            op,
            method,
            path: path.into(),
            body: None,
            query: Vec::new(),
            expect_body: true,
        }
    }

    pub fn body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    pub fn query(mut self, k: &'a str, v: Option<impl ToString>) -> Self {
        if let Some(v) = v {
            let v = v.to_string();
            if !v.is_empty() {
                self.query.push((k, v));
            }
        }
        self
    }

    pub fn no_body(mut self) -> Self {
        self.expect_body = false;
        self
    }
}

impl Transport {
    pub fn new(cfg: Config) -> Result<Self, Error> {
        let base = cfg.base_url.trim().trim_end_matches('/').to_string();
        let ok = reqwest::Url::parse(&base)
            .map(|u| {
                (u.scheme() == "http" || u.scheme() == "https")
                    && u.host_str().is_some_and(|h| !h.is_empty())
            })
            .unwrap_or(false);
        // Names the field, never the value: a token pasted into the wrong
        // field must not end up in a log line.
        if !ok {
            return Err(Error::new(
                "config",
                "base_url is not an absolute http(s) URL",
            ));
        }
        if cfg.token.trim().is_empty() {
            return Err(Error::new("config", "token is required"));
        }
        let http = match cfg.http {
            Some(h) => h,
            // reqwest drops Authorization on a redirect to another host, as
            // Go's http.Client does (tests/redirect.rs).
            None => reqwest::Client::builder()
                .use_rustls_tls()
                .build()
                .map_err(|e| Error::new("config", format!("building the HTTP client: {e}")))?,
        };
        Ok(Transport {
            base,
            token: cfg.token,
            timeout: cfg.timeout.unwrap_or(DEFAULT_TIMEOUT),
            http,
        })
    }

    fn redact(&self, s: &str) -> String {
        s.replace(&self.token, "[redacted]")
    }

    /// Performs one request and returns its status and decoded JSON body
    /// (`Null` when the call expects none). Every call is bounded by the
    /// timeout.
    pub async fn call(&self, c: Call<'_>) -> Result<Resp, Error> {
        let op = c.op;
        match tokio::time::timeout(self.timeout, self.exchange(&c)).await {
            Err(_) => Err(Error::unavailable(op, "timed out", true)),
            Ok(Err(e)) => Err(e),
            Ok(Ok((status, raw))) => Ok(Resp {
                status,
                body: self.decode(op, status, &raw, c.expect_body)?,
            }),
        }
    }

    async fn exchange(&self, c: &Call<'_>) -> Result<(u16, Vec<u8>), Error> {
        let mut req = self
            .http
            .request(c.method.clone(), format!("{}{}", self.base, c.path))
            .header(reqwest::header::ACCEPT, "application/json")
            .bearer_auth(&self.token);
        if !c.query.is_empty() {
            req = req.query(&c.query);
        }
        if let Some(b) = &c.body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(
                    serde_json::to_vec(b)
                        .map_err(|e| Error::new(c.op, format!("encode request: {e}")))?,
                );
        }
        let mut resp = req
            .send()
            .await
            .map_err(|e| self.transport_error(c.op, &e))?;
        let status = resp.status().as_u16();
        let mut raw = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| self.transport_error(c.op, &e))?
        {
            raw.extend_from_slice(&chunk);
            if raw.len() > MAX_RESPONSE_BYTES {
                return Err(
                    Error::unavailable(c.op, "response body exceeds 8 MiB", false)
                        .with_status(status),
                );
            }
        }
        Ok((status, raw))
    }

    fn transport_error(&self, op: &str, e: &reqwest::Error) -> Error {
        if e.is_timeout() {
            return Error::unavailable(op, "timed out", true);
        }
        // Refused dial, DNS, reset, TLS: the host could not be consulted.
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(e);
        while let Some(s) = src {
            msg = format!("{msg}: {s}");
            src = s.source();
        }
        Error::unavailable(op, self.redact(&format!("unreachable: {msg}")), true)
    }

    fn decode(&self, op: &str, status: u16, raw: &[u8], expect_body: bool) -> Result<Value, Error> {
        if !(200..300).contains(&status) {
            return Err(self.http_error(op, status, raw));
        }
        if !expect_body {
            return Ok(Value::Null);
        }
        if raw.iter().all(u8::is_ascii_whitespace) {
            // A 2xx with no body is not the contract: decoding it into a
            // default would tell a forget caller the delete happened.
            return Err(Error::unavailable(op, "empty response body", false).with_status(status));
        }
        // In practice a proxy's HTML error page: we never reached a working
        // novamem. Not retryable — the same request parses the same way.
        serde_json::from_slice(raw).map_err(|_| {
            Error::unavailable(op, "malformed response body", false).with_status(status)
        })
    }

    fn http_error(&self, op: &str, status: u16, raw: &[u8]) -> Error {
        let (mut message, mut code) = (String::new(), String::new());
        if let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(raw) {
            if let Some(e) = m
                .get("error")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                message = e.to_string();
                code = m
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
        }
        if message.is_empty() {
            let text = String::from_utf8_lossy(raw).trim().to_string();
            message = match text.char_indices().nth(256) {
                Some((i, _)) => format!("{}…", &text[..i]),
                None => text,
            };
        }
        // The server's message and code are quoted verbatim; a server that
        // echoes the credential back would otherwise launder it into logs.
        let (message, code) = (self.redact(&message), self.redact(&code));
        let e = if status >= 500 || status == 429 {
            Error::unavailable(op, message, true)
        } else {
            Error::new(op, message)
        };
        e.with_status(status).with_code(code)
    }
}
