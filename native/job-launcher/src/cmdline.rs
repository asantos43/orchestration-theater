// SPDX-License-Identifier: MPL-2.0
//! Rebuilds the Windows command line from an already split `argv` (architecture 5.9).
//!
//! `CreateProcessW` takes ONE string, which the new process splits again with the rules of the
//! Microsoft C runtime (`CommandLineToArgvW`). The launcher receives `argv` already split, so it
//! must quote every argument so that the Executor sees exactly the same list. Nothing here goes
//! through a shell: `%VAR%`, `$HOME`, `^`, `&` and `|` stay literal text. Only `cmd.exe`
//! expands them, which is why `.cmd` and `.bat` programs are refused ([`is_batch_script`]).
//!
//! The functions work on UTF-16 code units, the native Windows representation, so they are pure
//! and run on every platform (the unit tests run on Linux). Rules:
//! <https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments>
//! (page dated 2021-12-09, read 2026-11-16).

use std::fmt;

/// Longest command line `CreateProcessW` accepts, in UTF-16 units, terminating NUL included.
pub const MAX_COMMAND_LINE_UNITS: usize = 32_767;

const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const NEWLINE: u16 = b'\n' as u16;
const VTAB: u16 = 0x0B;
const QUOTE: u16 = b'"' as u16;
const BACKSLASH: u16 = b'\\' as u16;

/// Why a command line could not be built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandLineError {
    /// No program at all.
    Empty,
    /// A Windows path cannot contain `"`; the program name is quoted without escapes.
    QuoteInProgram,
    /// The result would not fit in the 32,767 units `CreateProcessW` takes.
    TooLong,
}

impl fmt::Display for CommandLineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("no program to run"),
            Self::QuoteInProgram => f.write_str("the program name contains a double quote"),
            Self::TooLong => write!(
                f,
                "the command line is longer than the {MAX_COMMAND_LINE_UNITS} units CreateProcessW accepts"
            ),
        }
    }
}

impl std::error::Error for CommandLineError {}

/// UTF-16 units of a string (what the tests and the Windows code feed in).
#[must_use]
pub fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn push_backslashes(out: &mut Vec<u16>, count: usize) {
    out.extend(std::iter::repeat_n(BACKSLASH, count));
}

/// Quotes one ordinary argument (not the program name) so that `CommandLineToArgvW` returns it unchanged.
///
/// Quoted only when needed (empty, or it has a space, tab, newline, vertical tab or `"`). Inside the
/// quotes every `"` becomes `\"`, the backslashes right before it are doubled, and the backslashes
/// at the end are doubled so they do not escape the closing quote.
pub fn quote_arg(arg: &[u16], out: &mut Vec<u16>) {
    let needs_quotes = arg.is_empty()
        || arg
            .iter()
            .any(|&c| matches!(c, SPACE | TAB | NEWLINE | VTAB | QUOTE));
    if !needs_quotes {
        out.extend_from_slice(arg);
        return;
    }
    out.push(QUOTE);
    let mut backslashes = 0usize;
    for &c in arg {
        match c {
            BACKSLASH => backslashes += 1,
            QUOTE => {
                push_backslashes(out, backslashes * 2 + 1);
                out.push(QUOTE);
                backslashes = 0;
            }
            _ => {
                push_backslashes(out, backslashes);
                out.push(c);
                backslashes = 0;
            }
        }
    }
    push_backslashes(out, backslashes * 2);
    out.push(QUOTE);
}

/// Builds the command line for `CreateProcessW` (without the terminating NUL).
///
/// `argv[0]` is the program: the runtime reads it with its own rule (a quoted part is taken as it
/// is, no escapes), so it is wrapped in quotes when it has a space or tab and never escaped.
///
/// # Errors
/// [`CommandLineError`] when there is no program, the program has a `"`, or the line is too long.
pub fn build_command_line(argv: &[Vec<u16>]) -> Result<Vec<u16>, CommandLineError> {
    let (program, rest) = argv.split_first().ok_or(CommandLineError::Empty)?;
    if program.is_empty() {
        return Err(CommandLineError::Empty);
    }
    if program.contains(&QUOTE) {
        return Err(CommandLineError::QuoteInProgram);
    }
    let mut line = Vec::with_capacity(argv.iter().map(|a| a.len() + 3).sum());
    if program.iter().any(|&c| matches!(c, SPACE | TAB)) {
        line.push(QUOTE);
        line.extend_from_slice(program);
        line.push(QUOTE);
    } else {
        line.extend_from_slice(program);
    }
    for arg in rest {
        line.push(SPACE);
        quote_arg(arg, &mut line);
    }
    if line.len() + 1 > MAX_COMMAND_LINE_UNITS {
        return Err(CommandLineError::TooLong);
    }
    Ok(line)
}

/// True when the program is a `.cmd` or `.bat` script.
///
/// Such a file is run by `cmd.exe`, which expands `%VAR%`, treats `^ & | < >` as syntax and
/// re-parses the arguments with other rules, so an argument can become a command (the "BatBadBut"
/// class of bugs). The launcher refuses them. Trailing dots and spaces are ignored because the file
/// system drops them (`tool.cmd.` is `tool.cmd`).
#[must_use]
pub fn is_batch_script(program: &[u16]) -> bool {
    let mut end = program.len();
    while end > 0 && matches!(program[end - 1], 0x2E | SPACE) {
        end -= 1;
    }
    let name = &program[..end];
    let Some(dot) = name.iter().rposition(|&c| c == 0x2E) else {
        return false;
    };
    // A dot inside a directory name (`C:\a.b\tool`) is not an extension.
    if name[dot..]
        .iter()
        .any(|&c| c == BACKSLASH || c == b'/' as u16)
    {
        return false;
    }
    let extension: Vec<u8> = name[dot + 1..]
        .iter()
        .map(|&c| u8::try_from(c).map_or(0, |b| b.to_ascii_lowercase()))
        .collect();
    extension == b"cmd" || extension == b"bat"
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arguments of the posix launcher's list, plus the Windows-specific ones.
    const TRICKY: &[&str] = &[
        "$HOME",
        "${HOME}",
        "$$",
        "%h",
        "%PATH%",
        "%PATH% and more",
        "plain",
        "with space",
        "with\ttab",
        "new\nline",
        "say \"hi\"",
        "\"",
        "\"\"",
        "a\"b",
        "ends with backslash\\",
        "ends\\",
        "\\\\server\\share\\",
        "C:\\dir\\",
        "C:\\my dir\\",
        "C:\\my dir\\\\",
        "back\\\"quote",
        "two\\\\\"quotes",
        "trailing quote\\\"",
        "",
        " ",
        "\t",
        "ação é 日本語 😀",
        "açãoé",
        "^&|<>()",
        "'single'",
        "--flag=\"value with space\"",
        "-e",
        "a=b",
    ];

    /// Reference parser: the Microsoft C runtime rules for arguments after `argv[0]`.
    fn parse(line: &[u16]) -> Vec<Vec<u16>> {
        let mut args = Vec::new();
        let mut i = 0;
        let n = line.len();
        loop {
            while i < n && (line[i] == SPACE || line[i] == TAB) {
                i += 1;
            }
            if i >= n {
                return args;
            }
            let mut arg = Vec::new();
            let mut in_quotes = false;
            while i < n {
                let c = line[i];
                if c == BACKSLASH {
                    let mut count = 0;
                    while i < n && line[i] == BACKSLASH {
                        count += 1;
                        i += 1;
                    }
                    if i < n && line[i] == QUOTE {
                        push_backslashes(&mut arg, count / 2);
                        if count % 2 == 1 {
                            arg.push(QUOTE);
                            i += 1;
                        }
                    } else {
                        push_backslashes(&mut arg, count);
                    }
                } else if c == QUOTE {
                    if in_quotes && i + 1 < n && line[i + 1] == QUOTE {
                        arg.push(QUOTE);
                        i += 2;
                    } else {
                        in_quotes = !in_quotes;
                        i += 1;
                    }
                } else if !in_quotes && (c == SPACE || c == TAB) {
                    break;
                } else {
                    arg.push(c);
                    i += 1;
                }
            }
            args.push(arg);
        }
    }

    fn quoted(arg: &str) -> String {
        let mut out = Vec::new();
        quote_arg(&to_wide(arg), &mut out);
        String::from_utf16(&out).expect("valid UTF-16")
    }

    fn line(args: &[&str]) -> String {
        let argv: Vec<Vec<u16>> = args.iter().map(|a| to_wide(a)).collect();
        String::from_utf16(&build_command_line(&argv).expect("builds")).expect("valid UTF-16")
    }

    #[test]
    fn shell_looking_text_stays_literal() {
        for arg in [
            "$HOME", "${HOME}", "$$", "%h", "%PATH%", "^&|<>()", "'single'", "a=b", "-e",
        ] {
            assert_eq!(quoted(arg), arg, "{arg} must not change");
        }
    }

    #[test]
    fn quoting_follows_the_runtime_rules() {
        assert_eq!(quoted(""), "\"\"");
        assert_eq!(quoted("with space"), "\"with space\"");
        assert_eq!(quoted("with\ttab"), "\"with\ttab\"");
        assert_eq!(quoted("%PATH% and more"), "\"%PATH% and more\"");
        assert_eq!(quoted("a\"b"), "\"a\\\"b\"");
        assert_eq!(quoted("\""), "\"\\\"\"");
        assert_eq!(quoted("back\\\"quote"), "\"back\\\\\\\"quote\"");
        assert_eq!(
            quoted("ends with backslash\\"),
            "\"ends with backslash\\\\\""
        );
        assert_eq!(quoted("C:\\my dir\\"), "\"C:\\my dir\\\\\"");
        // Backslashes that do not touch a quote are literal and stay as they are.
        assert_eq!(quoted("C:\\dir\\"), "C:\\dir\\");
        assert_eq!(quoted("a\\b c"), "\"a\\b c\"");
        assert_eq!(quoted("ação é"), "\"ação é\"");
        assert_eq!(quoted("açãoé"), "açãoé");
    }

    #[test]
    fn the_program_is_quoted_without_escapes() {
        assert_eq!(line(&["node.exe"]), "node.exe");
        assert_eq!(
            line(&["C:\\Program Files\\nodejs\\node.exe", "a b"]),
            "\"C:\\Program Files\\nodejs\\node.exe\" \"a b\""
        );
        assert_eq!(line(&["a.exe", "", "x"]), "a.exe \"\" x");
    }

    #[test]
    fn every_tricky_argument_round_trips() {
        let argv: Vec<Vec<u16>> = std::iter::once("prog.exe")
            .chain(TRICKY.iter().copied())
            .map(to_wide)
            .collect();
        let built = build_command_line(&argv).expect("builds");
        let parsed = parse(&built).split_off(1);
        let expected: Vec<Vec<u16>> = argv.into_iter().skip(1).collect();
        assert_eq!(parsed.len(), expected.len());
        for (got, want) in parsed.iter().zip(&expected) {
            assert_eq!(
                String::from_utf16_lossy(got),
                String::from_utf16_lossy(want)
            );
        }
        assert_eq!(parsed, expected);
    }

    #[test]
    fn generated_arguments_round_trip() {
        // Deterministic xorshift: no dependency, same sequence on every run.
        let alphabet: Vec<u16> = to_wide("a b\t\\\\\"\"\"%$é日");
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for _ in 0..3000 {
            let count = (next() % 4) as usize + 1;
            let mut args = Vec::new();
            for _ in 0..count {
                let len = (next() % 9) as usize;
                let arg: Vec<u16> = (0..len)
                    .map(|_| alphabet[(next() % alphabet.len() as u64) as usize])
                    .collect();
                args.push(arg);
            }
            let mut argv = vec![to_wide("p.exe")];
            argv.extend(args.iter().cloned());
            let built = build_command_line(&argv).expect("builds");
            assert_eq!(
                parse(&built)[1..],
                args[..],
                "line: {}",
                String::from_utf16_lossy(&built)
            );
        }
    }

    #[test]
    fn invalid_programs_and_long_lines() {
        assert_eq!(build_command_line(&[]), Err(CommandLineError::Empty));
        assert_eq!(
            build_command_line(&[Vec::new()]),
            Err(CommandLineError::Empty)
        );
        assert_eq!(
            build_command_line(&[to_wide("a\"b.exe")]),
            Err(CommandLineError::QuoteInProgram)
        );
        let almost = vec!['x' as u16; MAX_COMMAND_LINE_UNITS - 1 - 2];
        assert!(build_command_line(&[to_wide("a"), almost.clone()]).is_ok());
        let mut over = almost;
        over.push('x' as u16);
        over.push('x' as u16);
        assert_eq!(
            build_command_line(&[to_wide("a"), over]),
            Err(CommandLineError::TooLong)
        );
    }

    #[test]
    fn batch_scripts_are_recognized() {
        for yes in [
            "tool.cmd",
            "TOOL.CMD",
            "tool.Bat",
            "C:\\x\\tool.cmd",
            "C:\\a.b\\tool.bat",
            "tool.cmd.",
            "tool.cmd ",
            "tool.bat..",
            "./tool.cmd",
        ] {
            assert!(is_batch_script(&to_wide(yes)), "{yes}");
        }
        for no in [
            "tool.exe",
            "tool",
            "tool.cmdx",
            "tool.xcmd",
            "C:\\a.cmd\\tool",
            "C:\\a.cmd\\tool.exe",
            "tool.com",
            "cmd.exe",
            "",
            ".",
            "日本語.exe",
        ] {
            assert!(!is_batch_script(&to_wide(no)), "{no}");
        }
    }
}
