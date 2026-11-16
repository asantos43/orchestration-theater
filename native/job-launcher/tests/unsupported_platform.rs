// SPDX-License-Identifier: MPL-2.0
//! Outside Windows the binary only explains itself and exits with the fixed code 78.
#![cfg(not(windows))]

use std::process::Command;

#[test]
fn prints_windows_only_and_exits_78() {
    let output = Command::new(env!("CARGO_BIN_EXE_ot-job-launcher"))
        .args(["--", "anything"])
        .output()
        .expect("run the launcher");
    assert_eq!(output.status.code(), Some(78));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("only works on Windows"), "{stderr}");
    assert!(output.stdout.is_empty());
}
