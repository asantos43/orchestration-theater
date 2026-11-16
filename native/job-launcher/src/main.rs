// SPDX-License-Identifier: MPL-2.0
//! Binary `ot-job-launcher`. Windows only; elsewhere it explains that and exits with code 78.

#[cfg(windows)]
fn main() {
    let code = ot_job_launcher::launch::main_from_env();
    // A Windows exit code is 32 bits; the `as` cast keeps the bits (0x4F54_0001 stays as is).
    std::process::exit(code as i32);
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!(
        "ot-job-launcher: this program only works on Windows (it needs Job Objects); \
         exiting with code {}",
        ot_job_launcher::exit_codes::EXIT_UNSUPPORTED_PLATFORM
    );
    std::process::ExitCode::from(
        u8::try_from(ot_job_launcher::exit_codes::EXIT_UNSUPPORTED_PLATFORM)
            .expect("the unsupported-platform code fits in one byte"),
    )
}
