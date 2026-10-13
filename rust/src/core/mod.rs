//! Cross-cutting primitives shared by every concern.

pub mod audience;
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
