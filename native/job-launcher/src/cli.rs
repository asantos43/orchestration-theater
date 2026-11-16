// SPDX-License-Identifier: MPL-2.0
//! Command line of the launcher: `ot-job-launcher [--memory-limit-bytes <n>] -- <exe> [args...]`.
//!
//! Pure: nothing here touches the operating system, so it is tested on every platform.

use std::ffi::OsString;
use std::fmt;

/// Usage text, printed for `--help` and after a usage error.
pub const USAGE: &str = "\
Usage: ot-job-launcher [--memory-limit-bytes <n>] -- <exe> [args...]

Starts <exe> inside a Windows Job Object (KILL_ON_JOB_CLOSE), waits for it and exits with its
exit code. If the launcher dies, Windows ends the whole process tree.

Options:
  --memory-limit-bytes <n>  commit-memory ceiling for the whole job (all processes together)
  -h, --help                print this text and exit 0

Launcher failures use exit codes 0x4F540001..0x4F540007 (see README.md).";

/// What to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Commit-memory ceiling for the whole job, in bytes. `None` means no limit.
    pub memory_limit_bytes: Option<u64>,
    /// The program followed by its arguments, exactly as received (never split again).
    pub argv: Vec<OsString>,
}

/// Result of parsing the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Run(Config),
    Help,
}

/// A command-line mistake, with a message for a human.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError(pub String);

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UsageError {}

fn usage<T>(message: impl Into<String>) -> Result<T, UsageError> {
    Err(UsageError(message.into()))
}

fn parse_limit(text: &str) -> Result<u64, UsageError> {
    // Digits only: no sign, no spaces, no separators, no hex.
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return usage(format!(
            "--memory-limit-bytes expects a positive integer, got {text:?}"
        ));
    }
    match text.parse::<u64>() {
        Ok(0) => usage("--memory-limit-bytes must be greater than zero"),
        Ok(n) => Ok(n),
        Err(_) => usage(format!("--memory-limit-bytes is too large: {text:?}")),
    }
}

/// Parses the arguments that come after the program name.
///
/// Everything after the first `--` belongs to the Executor and is never interpreted.
pub fn parse<I>(args: I) -> Result<Parsed, UsageError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut iter = args.into_iter();
    let mut memory_limit_bytes: Option<u64> = None;
    loop {
        let Some(arg) = iter.next() else {
            return usage("missing `--` before the program to run");
        };
        let Some(text) = arg.to_str() else {
            return usage("options before `--` must be valid Unicode");
        };
        match text {
            "--" => break,
            "-h" | "--help" => return Ok(Parsed::Help),
            "--memory-limit-bytes" => {
                if memory_limit_bytes.is_some() {
                    return usage("--memory-limit-bytes given twice");
                }
                let Some(value) = iter.next() else {
                    return usage("--memory-limit-bytes needs a value");
                };
                let Some(value) = value.to_str() else {
                    return usage("--memory-limit-bytes expects a positive integer");
                };
                memory_limit_bytes = Some(parse_limit(value)?);
            }
            other => {
                if let Some(value) = other.strip_prefix("--memory-limit-bytes=") {
                    if memory_limit_bytes.is_some() {
                        return usage("--memory-limit-bytes given twice");
                    }
                    memory_limit_bytes = Some(parse_limit(value)?);
                } else {
                    return usage(format!("unknown option {other:?} before `--`"));
                }
            }
        }
    }
    let argv: Vec<OsString> = iter.collect();
    match argv.first() {
        None => usage("missing program after `--`"),
        Some(program) if program.is_empty() => usage("the program name is empty"),
        Some(_) => Ok(Parsed::Run(Config {
            memory_limit_bytes,
            argv,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    fn run(items: &[&str]) -> Config {
        match parse(os(items)) {
            Ok(Parsed::Run(config)) => config,
            other => panic!("expected Run, got {other:?}"),
        }
    }

    fn error(items: &[&str]) -> String {
        match parse(os(items)) {
            Err(e) => e.0,
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[test]
    fn program_and_arguments_after_the_separator() {
        let config = run(&["--", "node.exe", "a.js", "--flag", "x y"]);
        assert_eq!(config.memory_limit_bytes, None);
        assert_eq!(config.argv, os(&["node.exe", "a.js", "--flag", "x y"]));
    }

    #[test]
    fn memory_limit_in_both_spellings() {
        assert_eq!(
            run(&["--memory-limit-bytes", "1048576", "--", "a"]).memory_limit_bytes,
            Some(1_048_576)
        );
        assert_eq!(
            run(&["--memory-limit-bytes=2048", "--", "a"]).memory_limit_bytes,
            Some(2048)
        );
    }

    #[test]
    fn the_executor_arguments_are_never_interpreted() {
        let config = run(&["--", "a", "--memory-limit-bytes", "--", "--help", "-h"]);
        assert_eq!(config.memory_limit_bytes, None);
        assert_eq!(
            config.argv,
            os(&["a", "--memory-limit-bytes", "--", "--help", "-h"])
        );
    }

    #[test]
    fn an_empty_executor_argument_is_kept() {
        let config = run(&["--", "a", "", "b"]);
        assert_eq!(config.argv, os(&["a", "", "b"]));
    }

    #[test]
    fn help_before_the_separator() {
        assert_eq!(parse(os(&["--help"])), Ok(Parsed::Help));
        assert_eq!(parse(os(&["-h"])), Ok(Parsed::Help));
    }

    #[test]
    fn missing_separator_or_program() {
        assert!(error(&[]).contains("`--`"));
        assert!(error(&["a.exe"]).contains("unknown option"));
        assert!(error(&["--memory-limit-bytes", "10"]).contains("`--`"));
        assert!(error(&["--"]).contains("missing program"));
        assert!(error(&["--memory-limit-bytes", "10", "--"]).contains("missing program"));
        assert!(error(&["--", ""]).contains("empty"));
    }

    #[test]
    fn bad_memory_limits() {
        for bad in ["0", "-1", "+5", "1.5", "1e3", "0x10", " 5", "5 ", "abc", ""] {
            let message = error(&["--memory-limit-bytes", bad, "--", "a"]);
            assert!(
                message.contains("--memory-limit-bytes"),
                "{bad:?}: {message}"
            );
        }
        assert!(
            error(&["--memory-limit-bytes", "99999999999999999999999", "--", "a"])
                .contains("too large")
        );
        assert!(error(&["--memory-limit-bytes"]).contains("needs a value"));
        assert!(error(&["--memory-limit-bytes=0", "--", "a"]).contains("greater than zero"));
    }

    #[test]
    fn duplicate_and_unknown_options() {
        assert!(
            error(&[
                "--memory-limit-bytes",
                "1",
                "--memory-limit-bytes",
                "2",
                "--",
                "a"
            ])
            .contains("twice")
        );
        assert!(
            error(&[
                "--memory-limit-bytes=1",
                "--memory-limit-bytes=2",
                "--",
                "a"
            ])
            .contains("twice")
        );
        assert!(error(&["--nope", "--", "a"]).contains("unknown option"));
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_before_the_separator_is_a_usage_error() {
        use std::os::unix::ffi::OsStringExt;
        let bad = OsString::from_vec(vec![0xFF, 0xFE]);
        assert!(parse([bad, OsString::from("--"), OsString::from("a")]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_executor_arguments_pass_through() {
        use std::os::unix::ffi::OsStringExt;
        let bad = OsString::from_vec(vec![0xFF, 0xFE]);
        let parsed = parse([OsString::from("--"), OsString::from("a"), bad.clone()]);
        match parsed {
            Ok(Parsed::Run(config)) => assert_eq!(config.argv[1], bad),
            other => panic!("unexpected {other:?}"),
        }
    }
}
