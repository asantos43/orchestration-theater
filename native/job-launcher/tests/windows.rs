// SPDX-License-Identifier: MPL-2.0
//! Integration tests that need Windows (job objects). They run on the Windows CI job (N58) and
//! are not run on Linux. Every wait has a time cap and a failed test never leaves a process
//! behind: the guard kills the launcher, and the job takes the rest with it.
#![cfg(windows)]
#![allow(unsafe_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ot_job_launcher::exit_codes::{EXIT_BATCH_REFUSED, EXIT_SPAWN_FAILED, EXIT_USAGE};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const CAP: Duration = Duration::from_secs(30);

fn launcher() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ot-job-launcher"))
}

/// `target/<profile>/examples/helper.exe`, in the folder of the launcher binary. The final
/// artifacts (binaries and examples) share that folder; the test binary may live elsewhere, under
/// `build/` in the newer build-dir layout of Cargo, so its own path is no guide.
fn helper() -> PathBuf {
    let launcher = PathBuf::from(env!("CARGO_BIN_EXE_ot-job-launcher"));
    let profile_dir = launcher
        .parent()
        .expect("target/<profile>/ot-job-launcher.exe");
    let path = profile_dir.join("examples").join("helper.exe");
    assert!(
        path.exists(),
        "{} is missing: run `cargo test` (it builds the examples) instead of a single test target",
        path.display()
    );
    path
}

fn code_of(status: ExitStatus) -> u32 {
    // Windows exit codes are 32 bits; `code()` gives them as i32.
    u32::from_ne_bytes(status.code().expect("exit code").to_ne_bytes())
}

/// Kills the launcher if the test fails half way; the job then ends the whole tree.
struct Guard(Child);

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_with_cap(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + CAP;
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "the launcher did not finish in {CAP:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Reads stdout lines on a thread so that a test can wait for one with a time cap.
fn lines(stdout: ChildStdout) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

fn field(line: &str, name: &str) -> u32 {
    line.split_whitespace()
        .find_map(|part| part.strip_prefix(name))
        .and_then(|value| value.strip_prefix('='))
        .unwrap_or_else(|| panic!("no {name}= in {line:?}"))
        .parse()
        .expect("a pid")
}

fn is_running(pid: u32) -> bool {
    // SAFETY: plain Win32 calls; the handle is checked and closed.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let running = WaitForSingleObject(handle, 0) != WAIT_OBJECT_0;
        CloseHandle(handle);
        running
    }
}

fn wait_until_gone(pid: u32) {
    let deadline = Instant::now() + CAP;
    while is_running(pid) {
        assert!(
            Instant::now() < deadline,
            "process {pid} is still running after {CAP:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn the_exit_code_of_the_executor_passes_through() {
    for code in [0_u32, 7, 255, 0x00AB_CDEF] {
        let status = launcher()
            .arg("--")
            .arg(helper())
            .args(["exit", &code.to_string()])
            .status()
            .expect("run");
        assert_eq!(code_of(status), code);
    }
}

#[test]
fn stdin_and_stdout_cross_the_launcher() {
    let mut child = launcher()
        .arg("--")
        .arg(helper())
        .arg("echo")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let reader = std::thread::spawn(move || {
        let (mut out, mut err) = (String::new(), String::new());
        stdout.read_to_string(&mut out).expect("read stdout");
        stderr.read_to_string(&mut err).expect("read stderr");
        (out, err)
    });
    stdin
        .write_all("hello from the daemon\nsecond line\n".as_bytes())
        .expect("write");
    drop(stdin);
    let mut guard = Guard(child);
    let status = wait_with_cap(&mut guard.0);
    let (out, err) = reader.join().expect("reader");
    assert_eq!(code_of(status), 0);
    assert_eq!(out, "hello from the daemon\nsecond line\n");
    assert_eq!(err.trim_end(), "bye");
}

#[test]
fn arguments_and_environment_arrive_unchanged() {
    let tricky = [
        "$HOME",
        "${HOME}",
        "$$",
        "%h",
        "%PATH%",
        "with space",
        "with\ttab",
        "say \"hi\"",
        "ends with backslash\\",
        "C:\\my dir\\",
        "back\\\"quote",
        "",
        "ação é 日本語",
    ];
    let output = launcher()
        .arg("--")
        .arg(helper())
        .arg("args")
        .args(tricky)
        .output()
        .expect("run");
    assert_eq!(code_of(output.status), 0);
    let expected: String = tricky.iter().map(|a| format!("{a:?}\n")).collect();
    assert_eq!(String::from_utf8_lossy(&output.stdout), expected);

    let output = launcher()
        .env("OT_JOB_LAUNCHER_TEST", "value with space")
        .arg("--")
        .arg(helper())
        .args(["env", "OT_JOB_LAUNCHER_TEST"])
        .output()
        .expect("run");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim_end(),
        "value with space"
    );
}

#[test]
fn killing_the_launcher_kills_the_whole_tree() {
    let mut child = launcher()
        .arg("--")
        .arg(helper())
        .arg("tree")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn");
    let rx = lines(child.stdout.take().expect("stdout"));
    let mut guard = Guard(child);
    let line = rx.recv_timeout(CAP).expect("the helper announces its pids");
    let (executor, grandchild) = (field(&line, "pid"), field(&line, "grandchild"));
    assert!(is_running(executor) && is_running(grandchild));

    guard.0.kill().expect("terminate the launcher");
    let _ = guard.0.wait();

    wait_until_gone(executor);
    wait_until_gone(grandchild);
}

#[test]
fn leftover_descendants_die_when_the_executor_exits() {
    let mut child = launcher()
        .arg("--")
        .arg(helper())
        .arg("leave")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn");
    let rx = lines(child.stdout.take().expect("stdout"));
    let mut guard = Guard(child);
    let line = rx
        .recv_timeout(CAP)
        .expect("the helper announces the grandchild");
    let grandchild = field(&line, "grandchild");
    let status = wait_with_cap(&mut guard.0);
    assert_eq!(code_of(status), 0);
    // The job closed with the launcher: the grandchild that outlived the Executor is gone too.
    wait_until_gone(grandchild);
}

#[test]
fn the_memory_limit_stops_the_one_who_exceeds_it() {
    const LIMIT: &str = "134217728"; // 128 MiB for the whole job
    let run = |limit: Option<&str>, bytes: &str| {
        let mut command = launcher();
        if let Some(limit) = limit {
            command.args(["--memory-limit-bytes", limit]);
        }
        command
            .arg("--")
            .arg(helper())
            .args(["alloc", bytes])
            .output()
            .expect("run")
    };

    // Under the ceiling, and with no ceiling: fine.
    let small = run(Some(LIMIT), "8388608");
    assert_eq!(code_of(small.status), 0);
    assert!(String::from_utf8_lossy(&small.stdout).contains("allocated"));
    let free = run(None, "536870912");
    assert_eq!(code_of(free.status), 0);

    // 512 MiB under a 128 MiB ceiling: the allocation fails (or the process is stopped).
    let big = run(Some(LIMIT), "536870912");
    assert_ne!(code_of(big.status), 0);
    assert!(!String::from_utf8_lossy(&big.stdout).contains("allocated"));
}

#[test]
fn launcher_failures_use_the_documented_codes() {
    let status = launcher().arg("--").status().expect("run");
    assert_eq!(code_of(status), EXIT_USAGE);
    let status = launcher().arg(helper()).status().expect("run");
    assert_eq!(code_of(status), EXIT_USAGE);
    let status = launcher()
        .args(["--memory-limit-bytes", "abc", "--"])
        .arg(helper())
        .status()
        .expect("run");
    assert_eq!(code_of(status), EXIT_USAGE);

    let status = launcher()
        .args(["--", "this-program-does-not-exist-ot.exe"])
        .status()
        .expect("run");
    assert_eq!(code_of(status), EXIT_SPAWN_FAILED);

    let status = launcher()
        .args(["--", "tool.cmd", "x"])
        .status()
        .expect("run");
    assert_eq!(code_of(status), EXIT_BATCH_REFUSED);
    let status = launcher()
        .args(["--", "C:\\x\\tool.BAT"])
        .status()
        .expect("run");
    assert_eq!(code_of(status), EXIT_BATCH_REFUSED);
}
