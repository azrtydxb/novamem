//! The C ABI over the novamem Rust SDK (clients/c, ADR 0009).
//!
//! Every `extern "C"` function is a blocking call into the async SDK on one
//! process-wide runtime, wrapped so that no Rust panic crosses the boundary.
//! The per-type structs and the 41 operations are generated
//! (`ffi_types.rs`, `ffi_methods.rs`) from the same model as
//! `clients/c/include/novamem.h`.

#![allow(non_camel_case_types, clippy::missing_safety_doc)]

use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;
use std::time::Duration;

mod conv;
mod ffi_methods;
mod ffi_types;
#[cfg(feature = "test-dispatch")]
mod test_args;

pub use ffi_methods::*;
pub use ffi_types::*;

use conv::c_str;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum novamem_status {
    NOVAMEM_OK = 0,
    NOVAMEM_ERR = 1,
}

/// Mirrors `novamem_error` in novamem.h: fixed-size, so it never needs
/// freeing. Strings are truncated to fit and always NUL-terminated.
#[repr(C)]
pub struct novamem_error {
    pub op: [c_char; 64],
    pub status_code: i32,
    pub code: [c_char; 64],
    pub message: [c_char; 512],
    pub unavailable: bool,
    pub retryable: bool,
    pub not_found: bool,
    pub canceled: bool,
}

/// Opaque to C: the Rust clients behind the handles.
pub struct novamem_client(pub(crate) novamem::Client);
pub struct novamem_management(pub(crate) novamem::Management);
pub struct novamem_admin(pub(crate) novamem::Admin);

/// A failure on either side of the boundary.
pub(crate) enum FfiError {
    Sdk(novamem::Error),
    Local { op: &'static str, message: String },
}

impl From<novamem::Error> for FfiError {
    fn from(e: novamem::Error) -> Self {
        FfiError::Sdk(e)
    }
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("novamem-ffi: cannot start its runtime")
    })
}

pub(crate) fn block_on<F: std::future::Future>(f: F) -> F::Output {
    runtime().block_on(f)
}

pub(crate) unsafe fn handle<'a, T>(h: *const T, op: &'static str) -> Result<&'a T, FfiError> {
    h.as_ref().ok_or_else(|| FfiError::Local {
        op,
        message: "null handle".into(),
    })
}

fn copy(dst: &mut [c_char], s: &str) {
    let n = s.len().min(dst.len() - 1);
    // Truncate on a char boundary so the C string stays valid UTF-8.
    let n = (0..=n).rev().find(|&i| s.is_char_boundary(i)).unwrap_or(0);
    for (d, b) in dst.iter_mut().zip(&s.as_bytes()[..n]) {
        *d = *b as c_char;
    }
    dst[n] = 0;
}

unsafe fn write_error(
    err: *mut novamem_error,
    op: &str,
    status: u16,
    code: &str,
    message: &str,
    flags: (bool, bool, bool),
) {
    if let Some(e) = err.as_mut() {
        copy(&mut e.op, op);
        copy(&mut e.code, code);
        copy(&mut e.message, message);
        e.status_code = i32::from(status);
        (e.unavailable, e.retryable, e.not_found) = flags;
        e.canceled = false;
    }
}

pub(crate) unsafe fn fill(err: *mut novamem_error, e: &novamem::Error) {
    let flags = (e.is_unavailable(), e.is_retryable(), e.is_not_found());
    write_error(err, e.op(), e.status(), e.code(), e.message(), flags);
}

pub(crate) unsafe fn fill_local(err: *mut novamem_error, op: &str, message: &str) {
    write_error(err, op, 0, "", message, (false, false, false));
}

/// Runs one operation: maps its error into `err`, and turns a panic into an
/// error rather than letting it unwind into C.
pub(crate) unsafe fn guard(
    err: *mut novamem_error,
    f: impl FnOnce() -> Result<(), FfiError>,
) -> novamem_status {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => novamem_status::NOVAMEM_OK,
        Ok(Err(FfiError::Sdk(e))) => {
            fill(err, &e);
            novamem_status::NOVAMEM_ERR
        }
        Ok(Err(FfiError::Local { op, message })) => {
            fill_local(err, op, &message);
            novamem_status::NOVAMEM_ERR
        }
        Err(_) => {
            fill_local(err, "internal", "internal panic");
            novamem_status::NOVAMEM_ERR
        }
    }
}

unsafe fn config(
    base_url: *const c_char,
    token: *const c_char,
    timeout_ms: u32,
) -> novamem::Config {
    novamem::Config {
        base_url: c_str(base_url).unwrap_or_default(),
        token: c_str(token).unwrap_or_default(),
        timeout: (timeout_ms > 0).then(|| Duration::from_millis(u64::from(timeout_ms))),
        http: None,
    }
}

macro_rules! handle_fns {
    ($handle:ident, $sdk:ident, $new:ident, $free:ident) => {
        #[no_mangle]
        pub unsafe extern "C" fn $new(
            base_url: *const c_char,
            token: *const c_char,
            timeout_ms: u32,
            err: *mut novamem_error,
        ) -> *mut $handle {
            let mut out = std::ptr::null_mut();
            guard(err, || {
                out = Box::into_raw(Box::new($handle(novamem::$sdk::new(config(
                    base_url, token, timeout_ms,
                ))?)));
                Ok(())
            });
            out
        }

        #[no_mangle]
        pub unsafe extern "C" fn $free(h: *mut $handle) {
            if !h.is_null() {
                drop(Box::from_raw(h));
            }
        }
    };
}

handle_fns!(
    novamem_client,
    Client,
    novamem_client_new,
    novamem_client_free
);
handle_fns!(
    novamem_management,
    Management,
    novamem_management_new,
    novamem_management_free
);
handle_fns!(novamem_admin, Admin, novamem_admin_new, novamem_admin_free);

/// Frees a string this library returned. NULL-safe.
#[no_mangle]
pub unsafe extern "C" fn novamem_string_free(s: *mut c_char) {
    conv::free_str(s);
}
