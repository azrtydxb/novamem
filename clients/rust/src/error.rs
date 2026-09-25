use std::fmt;

/// Every failure of a call. Never contains the bearer token.
///
/// The question every caller must be able to answer is "could the store be
/// consulted?" — [`Error::is_unavailable`]. It is true for a refused dial, a
/// timeout, a 5xx, a 429, or a body that is not the JSON the API promises.
/// Any other error is a real answer that was not success: a rejected token,
/// a bad request, an id that is not in your scope ([`Error::is_not_found`]).
/// An `Ok` with no results is the only thing this crate ever presents as
/// "nothing is stored".
#[derive(Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", self.render())]
pub struct Error {
    op: String,
    status: u16,
    code: String,
    message: String,
    unavailable: bool,
    retryable: bool,
}

impl Error {
    pub(crate) fn new(op: &str, message: impl Into<String>) -> Self {
        Error {
            op: op.into(),
            status: 0,
            code: String::new(),
            message: message.into(),
            unavailable: false,
            retryable: false,
        }
    }

    pub(crate) fn unavailable(op: &str, message: impl Into<String>, retryable: bool) -> Self {
        Error {
            unavailable: true,
            retryable,
            ..Error::new(op, message)
        }
    }

    pub(crate) fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    pub(crate) fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = code.into();
        self
    }

    /// The client method that failed ("search", "remove-member", …).
    pub fn op(&self) -> &str {
        &self.op
    }

    /// The HTTP status, or 0 when no response was received.
    pub fn status(&self) -> u16 {
        self.status
    }

    /// The server's machine-readable error code, when it sent one.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// The server's message, or a description of the transport failure.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The store could not be consulted. Say so; do not claim ignorance.
    pub fn is_unavailable(&self) -> bool {
        self.unavailable
    }

    /// Calling again could plausibly succeed. This crate never retries for
    /// you: the budget belongs to the caller.
    pub fn is_retryable(&self) -> bool {
        self.retryable
    }

    /// The store answered: that id is not in your scope.
    pub fn is_not_found(&self) -> bool {
        self.status == 404
    }

    fn render(&self) -> String {
        let mut s = format!("novamem {}", self.op);
        if self.status != 0 {
            s += &format!(": {}", self.status);
        }
        if !self.code.is_empty() {
            s += &format!(" [{}]", self.code);
        }
        if !self.message.is_empty() {
            s += &format!(": {}", self.message);
        }
        s
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Error")
            .field("op", &self.op)
            .field("status", &self.status)
            .field("code", &self.code)
            .field("message", &self.message)
            .field("unavailable", &self.unavailable)
            .field("retryable", &self.retryable)
            .finish()
    }
}
