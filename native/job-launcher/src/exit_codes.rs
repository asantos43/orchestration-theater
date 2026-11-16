// SPDX-License-Identifier: MPL-2.0
//! Exit codes of the launcher itself (architecture 5.9).
//!
//! When the Executor runs, the launcher exits with the Executor's own exit code, whatever it is.
//! The codes below are the launcher's own failures. On Windows they sit in the `0x4F54_xxxx`
//! block ("OT"): not a plain small code a program returns on its own, and not an NTSTATUS
//! (`0xC...`/`0x8...`), so the daemon can tell "the launcher failed" from "the Executor failed".
//! A Windows exit code is 32 bits wide; a posix one is 8 bits, which is why the non-Windows
//! code is a small number.

/// Base of the block reserved for launcher failures on Windows.
pub const LAUNCHER_BLOCK: u32 = 0x4F54_0000;

/// Wrong command line (unknown option, missing `--`, no program, bad number).
pub const EXIT_USAGE: u32 = LAUNCHER_BLOCK | 0x01;
/// The Job Object could not be created or configured (limits).
pub const EXIT_JOB_FAILED: u32 = LAUNCHER_BLOCK | 0x02;
/// `CreateProcessW` failed: missing executable, bad working directory, no permission.
pub const EXIT_SPAWN_FAILED: u32 = LAUNCHER_BLOCK | 0x03;
/// The suspended process could not be associated with the job; it was terminated, never resumed.
pub const EXIT_ASSIGN_FAILED: u32 = LAUNCHER_BLOCK | 0x04;
/// The main thread could not be resumed; the process was terminated.
pub const EXIT_RESUME_FAILED: u32 = LAUNCHER_BLOCK | 0x05;
/// Waiting for the process or reading its exit code failed.
pub const EXIT_WAIT_FAILED: u32 = LAUNCHER_BLOCK | 0x06;
/// The program is a `.cmd` or `.bat` script, which goes through `cmd.exe` and is refused.
pub const EXIT_BATCH_REFUSED: u32 = LAUNCHER_BLOCK | 0x07;

/// Every launcher failure code on Windows, for tests and documentation.
pub const ALL_WINDOWS: [u32; 7] = [
    EXIT_USAGE,
    EXIT_JOB_FAILED,
    EXIT_SPAWN_FAILED,
    EXIT_ASSIGN_FAILED,
    EXIT_RESUME_FAILED,
    EXIT_WAIT_FAILED,
    EXIT_BATCH_REFUSED,
];

/// Non-Windows builds: the binary only reports that it is Windows-only (`EX_CONFIG`).
pub const EXIT_UNSUPPORTED_PLATFORM: u32 = 78;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_codes_are_distinct_and_inside_the_reserved_block() {
        let mut seen = std::collections::BTreeSet::new();
        for code in ALL_WINDOWS {
            assert_eq!(code & 0xFFFF_0000, LAUNCHER_BLOCK, "{code:#x}");
            assert!(seen.insert(code), "duplicate {code:#x}");
        }
    }

    #[test]
    fn windows_codes_are_not_small_codes_nor_ntstatus_values() {
        for code in ALL_WINDOWS {
            assert!(code > 255, "{code:#x} collides with an ordinary exit code");
            assert!(code < 0x8000_0000, "{code:#x} looks like an NTSTATUS");
            assert!(
                i32::try_from(code).is_ok(),
                "{code:#x} must fit std::process::exit"
            );
        }
    }

    #[test]
    fn the_non_windows_code_fits_in_one_byte() {
        const { assert!(EXIT_UNSUPPORTED_PLATFORM > 0 && EXIT_UNSUPPORTED_PLATFORM < 256) };
    }
}
