// SPDX-License-Identifier: MPL-2.0
//! `ot-job-launcher`: starts one Executor inside a Windows Job Object (architecture 5.9).
//!
//! The command line, the quoting and the exit codes are plain code and build on every platform,
//! so `cargo test` covers them anywhere. Only [`launch`] talks to Windows.

pub mod cli;
pub mod cmdline;
pub mod exit_codes;

// The only module with `unsafe`: one Win32 call per block, each with a SAFETY comment.
#[cfg(windows)]
#[allow(unsafe_code)]
pub mod launch;
