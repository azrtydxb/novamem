//! Conversions across the C boundary, used by the generated code.
//!
//! Ownership: everything `*_to_c` allocates is owned by the C value it goes
//! into and released by the matching `free_*`. C strings are UTF-8; an
//! interior NUL (impossible in valid JSON text, possible in user content)
//! is replaced so the string is never silently cut short.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

pub(crate) fn boxed<T>(v: T) -> *mut T {
    Box::into_raw(Box::new(v))
}

pub(crate) unsafe fn write_out<T>(out: *mut T, v: T) {
    if let Some(o) = out.as_mut() {
        *o = v;
    }
}

pub(crate) unsafe fn opt_num<T: Copy>(p: *const T) -> Option<T> {
    p.as_ref().copied()
}

pub(crate) unsafe fn c_str(p: *const c_char) -> Option<String> {
    (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().into_owned())
}

pub(crate) unsafe fn c_enum<T: DeserializeOwned>(p: *const c_char) -> Option<T> {
    c_str(p).and_then(|s| serde_json::from_value(Value::String(s)).ok())
}

pub(crate) unsafe fn c_json<T: DeserializeOwned>(p: *const c_char) -> Option<T> {
    c_str(p).and_then(|s| serde_json::from_str(&s).ok())
}

pub(crate) fn str_to_c(s: Option<&str>) -> *mut c_char {
    match s {
        None => ptr::null_mut(),
        Some(s) => {
            CString::new(s.replace('\0', "\u{FFFD}")).map_or(ptr::null_mut(), CString::into_raw)
        }
    }
}

pub(crate) fn enum_to_c<T: Serialize>(v: Option<&T>) -> *mut c_char {
    match v.and_then(|v| serde_json::to_value(v).ok()) {
        Some(Value::String(s)) => str_to_c(Some(&s)),
        _ => ptr::null_mut(),
    }
}

pub(crate) fn json_to_c<T: Serialize>(v: Option<&T>) -> *mut c_char {
    match v.and_then(|v| serde_json::to_string(v).ok()) {
        Some(s) => str_to_c(Some(&s)),
        None => ptr::null_mut(),
    }
}

pub(crate) unsafe fn free_str(p: *mut c_char) {
    if !p.is_null() {
        drop(CString::from_raw(p));
    }
}

/// NULL means absent (None); a non-NULL pointer with length 0 is empty.
pub(crate) unsafe fn c_str_array(p: *const *mut c_char, len: usize) -> Option<Vec<String>> {
    if p.is_null() {
        return None;
    }
    Some(
        std::slice::from_raw_parts(p, len)
            .iter()
            .map(|s| c_str(*s).unwrap_or_default())
            .collect(),
    )
}

pub(crate) fn str_array_to_c(v: Option<&[String]>) -> (*mut *mut c_char, usize) {
    match v {
        None => (ptr::null_mut(), 0),
        Some(v) => {
            let items: Box<[*mut c_char]> = v.iter().map(|s| str_to_c(Some(s))).collect();
            let len = items.len();
            (Box::into_raw(items).cast(), len)
        }
    }
}

pub(crate) unsafe fn free_str_array(p: *mut *mut c_char, len: usize) {
    if !p.is_null() {
        let items = Box::from_raw(ptr::slice_from_raw_parts_mut(p, len));
        for s in items.iter() {
            free_str(*s);
        }
    }
}

pub(crate) unsafe fn c_obj_array<C, R>(
    p: *const C,
    len: usize,
    f: impl Fn(&C) -> R,
) -> Option<Vec<R>> {
    if p.is_null() {
        return None;
    }
    Some(std::slice::from_raw_parts(p, len).iter().map(f).collect())
}

pub(crate) fn obj_array_to_c<R, C>(v: Option<&[R]>, f: impl Fn(&R) -> C) -> (*mut C, usize) {
    match v {
        None => (ptr::null_mut(), 0),
        Some(v) => {
            let items: Box<[C]> = v.iter().map(f).collect();
            let len = items.len();
            (Box::into_raw(items).cast(), len)
        }
    }
}

pub(crate) unsafe fn free_obj_array<C>(p: *mut C, len: usize, f: impl Fn(&mut C)) {
    if !p.is_null() {
        let mut items = Box::from_raw(ptr::slice_from_raw_parts_mut(p, len));
        for x in items.iter_mut() {
            f(x);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_and_arrays_round_trip_and_free() {
        unsafe {
            let p = str_to_c(Some("héllo\0world"));
            assert_eq!(c_str(p).as_deref(), Some("héllo\u{FFFD}world"));
            free_str(p);

            let (a, n) = str_array_to_c(Some(&["a".into(), "b".into()]));
            assert_eq!(
                c_str_array(a, n),
                Some(vec!["a".to_string(), "b".to_string()])
            );
            free_str_array(a, n);

            let (e, m) = str_array_to_c(Some(&[]));
            assert!(!e.is_null(), "an empty array is not absent");
            assert_eq!(c_str_array(e, m), Some(vec![]));
            free_str_array(e, m);
            assert_eq!(c_str_array(ptr::null(), 0), None);
        }
    }
}
