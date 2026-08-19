use std::ffi::OsStr;

#[expect(unsafe_code, reason = "env::set_var is unsafe as of edition 2024")]
pub(crate) fn set_env<K: AsRef<OsStr>, V: AsRef<OsStr>>(key: K, value: V) {
    // SAFETY: tests touching env run single-threaded
    unsafe { std::env::set_var(key, value) }
}
