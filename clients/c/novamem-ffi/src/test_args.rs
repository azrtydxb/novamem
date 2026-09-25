//! Helpers for novamem_test_call_by_name: turning a scenario's JSON args
//! into the C arguments a typed function takes. Test-dispatch builds only.

use std::ffi::CString;
use std::os::raw::c_char;
use std::ptr;

use serde::de::DeserializeOwned;
use serde_json::Value;

pub(crate) fn arg_cstring(a: &Value, k: &str) -> Option<CString> {
    a.get(k)
        .and_then(Value::as_str)
        .and_then(|s| CString::new(s).ok())
}

pub(crate) fn arg_json(a: &Value, k: &str) -> Option<CString> {
    a.get(k).and_then(|v| CString::new(v.to_string()).ok())
}

pub(crate) fn arg_value<T: DeserializeOwned>(a: &Value, k: &str) -> Option<T> {
    a.get(k)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

pub(crate) fn cstr_ptr(s: &Option<CString>) -> *const c_char {
    s.as_ref().map_or(ptr::null(), |s| s.as_ptr())
}

pub(crate) fn opt_ptr<T>(v: &Option<T>) -> *const T {
    v.as_ref().map_or(ptr::null(), |v| v as *const T)
}
