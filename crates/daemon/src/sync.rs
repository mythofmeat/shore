use std::sync::{Mutex, MutexGuard};
use tracing::error;

pub(crate) fn lock_or_recover<'lock, T>(
    resource: &'static str,
    mutex: &'lock Mutex<T>,
) -> MutexGuard<'lock, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            error!(resource, "Recovering from poisoned mutex");
            poisoned.into_inner()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    #[test]
    fn recovers_from_poisoned_mutex() {
        let mutex = Mutex::new(vec![1, 2, 3]);

        let result = catch_unwind(AssertUnwindSafe(|| {
            let _guard = mutex.lock().unwrap();
            panic!("poison daemon test mutex");
        }));
        assert!(result.is_err());

        let guard = lock_or_recover("daemon test mutex", &mutex);
        assert_eq!(*guard, vec![1, 2, 3]);
    }
}
