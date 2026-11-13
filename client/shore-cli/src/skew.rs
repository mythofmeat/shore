use std::cmp::Ordering;

pub(crate) const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

fn numbers(version: &str) -> Option<Vec<u64>> {
    version
        .split(['-', '+'])
        .next()?
        .split('.')
        .map(|part| part.parse().ok())
        .collect()
}

pub(crate) fn hint(client: &str, daemon: Option<&str>) -> Option<String> {
    let theirs = daemon?;
    match numbers(client)?.cmp(&numbers(theirs)?) {
        Ordering::Less => Some(format!(
            "This client is {client} and the daemon is {theirs}. Upgrade the client."
        )),
        Ordering::Greater => Some(format!(
            "This client is {client} and the daemon is {theirs}. Upgrade the daemon, or restart it if it has been upgraded."
        )),
        Ordering::Equal => None,
    }
}

#[derive(Debug)]
pub(crate) struct UnreadableResult {
    name: String,
    source: serde_json::Error,
    hint: Option<String>,
}

impl UnreadableResult {
    pub(crate) fn new(name: &str, source: serde_json::Error) -> Self {
        Self {
            name: name.to_owned(),
            source,
            hint: hint(
                CLIENT_VERSION,
                shore_common::swp_client::daemon_version().as_deref(),
            ),
        }
    }
}

impl std::fmt::Display for UnreadableResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "couldn't read the daemon's answer to `{}`: {}",
            self.name, self.source
        )?;
        match &self.hint {
            Some(hint) => write!(f, "\n{hint}"),
            None => Ok(()),
        }
    }
}

impl std::error::Error for UnreadableResult {}

#[cfg(test)]
mod tests {
    use super::hint;

    #[test]
    fn a_newer_daemon_means_upgrade_the_client_and_an_older_one_means_upgrade_the_daemon() {
        assert_eq!(
            hint("4.59.0", Some("4.60.0")).as_deref(),
            Some("This client is 4.59.0 and the daemon is 4.60.0. Upgrade the client.")
        );
        assert_eq!(
            hint("4.9.0", Some("4.10.0")).as_deref(),
            Some("This client is 4.9.0 and the daemon is 4.10.0. Upgrade the client.")
        );
        assert_eq!(
            hint("4.60.1", Some("4.60.0")).as_deref(),
            Some(
                "This client is 4.60.1 and the daemon is 4.60.0. Upgrade the daemon, or restart it if it has been upgraded."
            )
        );
    }

    #[test]
    fn the_same_release_or_a_version_that_cant_be_compared_gets_no_hint() {
        assert_eq!(hint("4.60.0", Some("4.60.0")), None);
        assert_eq!(hint("4.60.0-1", Some("4.60.0+local")), None);
        assert_eq!(hint("4.60.0", None), None);
        assert_eq!(hint("4.60.0", Some("dev")), None);
        assert_eq!(hint("dev", Some("4.60.0")), None);
    }
}
