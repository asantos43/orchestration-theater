// SPDX-License-Identifier: MPL-2.0
//! Test helper for the integration tests (run on Windows CI): a tiny program with a few modes.
//!
//! - `exit <code>`: exits with that code;
//! - `echo`: copies stdin to stdout until EOF, then writes "bye" to stderr;
//! - `args`: prints each argument as a Debug-quoted line;
//! - `env <NAME>`: prints the value of an environment variable (or `<unset>`);
//! - `sleep`: sleeps (at most 120 s, so a leftover never lives long);
//! - `tree`: starts a sleeping grandchild, prints `pid=<own> grandchild=<pid>` and sleeps;
//! - `leave`: starts a sleeping grandchild, prints its pid and exits 0 right away;
//! - `alloc <bytes>`: commits and touches that much memory; prints `allocated` or `alloc-failed`.

use std::io::{Read, Write};
use std::process::{Command, Stdio, exit};
use std::time::Duration;

fn sleep_capped() -> ! {
    std::thread::sleep(Duration::from_secs(120));
    exit(9);
}

// The grandchild is left running on purpose: the tests check that the job ends it.
#[allow(clippy::zombie_processes)]
fn spawn_sleeper() -> u32 {
    let me = std::env::current_exe().expect("current exe");
    let child = Command::new(me)
        .arg("sleep")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn grandchild");
    child.id()
}

fn main() {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let mode = args.first().map_or("", String::as_str);
    match mode {
        "exit" => {
            let code: i32 = args[1].parse().expect("exit code");
            exit(code);
        }
        "echo" => {
            let mut input = Vec::new();
            std::io::stdin()
                .read_to_end(&mut input)
                .expect("read stdin");
            std::io::stdout().write_all(&input).expect("write stdout");
            std::io::stdout().flush().expect("flush");
            eprintln!("bye");
        }
        "args" => {
            for arg in &args[1..] {
                println!("{arg:?}");
            }
        }
        "env" => {
            println!(
                "{}",
                std::env::var(&args[1]).unwrap_or_else(|_| "<unset>".into())
            );
        }
        "sleep" => sleep_capped(),
        "tree" => {
            let grandchild = spawn_sleeper();
            println!("pid={} grandchild={grandchild}", std::process::id());
            std::io::stdout().flush().expect("flush");
            sleep_capped();
        }
        "leave" => {
            let grandchild = spawn_sleeper();
            println!("grandchild={grandchild}");
        }
        "alloc" => {
            let bytes: usize = args[1].parse().expect("byte count");
            let mut block: Vec<u8> = Vec::new();
            if block.try_reserve_exact(bytes).is_err() {
                println!("alloc-failed");
                exit(3);
            }
            block.resize(bytes, 1);
            std::hint::black_box(&block);
            println!("allocated");
        }
        other => {
            eprintln!("helper: unknown mode {other:?}");
            exit(64);
        }
    }
}
