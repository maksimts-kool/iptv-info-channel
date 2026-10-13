//! Cross-cutting primitives shared by every concern.

pub mod audience;
pub mod fetch;
pub mod util;

/// A lazily compiled, process-wide regex for a literal pattern. A typo in the
/// pattern is a programming error caught by the first test that touches it.
#[macro_export]
macro_rules! regex {
    ($re:literal $(,)?) => {{
        static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            #[allow(clippy::expect_used)]
            regex::Regex::new($re).expect("static regex")
        });
        &*RE
    }};
}

/// [`regex!`] for patterns that need look-around (`fancy_regex`).
#[macro_export]
macro_rules! fancy_regex {
    ($re:literal $(,)?) => {{
        static RE: std::sync::LazyLock<fancy_regex::Regex> = std::sync::LazyLock::new(|| {
            #[allow(clippy::expect_used)]
            fancy_regex::Regex::new($re).expect("static regex")
        });
        &*RE
    }};
}
