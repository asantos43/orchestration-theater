// SPDX-License-Identifier: MPL-2.0
//! Windows only: runs the Executor inside a Job Object (architecture 5.9).
//!
//! Sequence (Microsoft documentation, read 2026-11-16):
//! 1. `CreateJobObjectW` and `SetInformationJobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//!    (and, when asked, `JOB_OBJECT_LIMIT_JOB_MEMORY`);
//! 2. `CreateProcessW` with `CREATE_SUSPENDED`, so the program runs no instruction before the job
//!    owns it;
//! 3. `AssignProcessToJobObject`, then `ResumeThread`;
//! 4. `WaitForSingleObject` and `GetExitCodeProcess`; the launcher exits with that code.
//!
//! No `JOB_OBJECT_LIMIT_BREAKAWAY_OK`: a descendant cannot leave the job. When the launcher ends
//! for any reason, even `TerminateProcess` from the daemon, the last handle to the job closes and
//! Windows terminates every process still in it.
//!
//! This is the only module of the crate with `unsafe`: each block is one Win32 call.
//!
//! The job memory limit is `JOB_OBJECT_LIMIT_JOB_MEMORY`: a ceiling on the committed (virtual)
//! memory of ALL processes of the job together, not on each process and not on the working set.

use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess, INFINITE, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};

use crate::cli::{self, Config, Parsed};
use crate::cmdline;
use crate::exit_codes::{
    EXIT_ASSIGN_FAILED, EXIT_BATCH_REFUSED, EXIT_JOB_FAILED, EXIT_RESUME_FAILED, EXIT_SPAWN_FAILED,
    EXIT_USAGE, EXIT_WAIT_FAILED,
};

/// A Win32 handle closed on drop.
struct Handle(HANDLE);

impl Handle {
    /// `None` for a null handle (how `CreateJobObjectW` reports failure).
    fn new(raw: HANDLE) -> Option<Self> {
        if raw.is_null() { None } else { Some(Self(raw)) }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this value and closed exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn fail(code: u32, what: &str) -> u32 {
    // SAFETY: reads the calling thread's last-error value, no pointers involved.
    let os_error = unsafe { GetLastError() };
    eprintln!("ot-job-launcher: {what} (Windows error {os_error}, exit code {code:#010x})");
    code
}

fn refuse(code: u32, what: &str) -> u32 {
    eprintln!("ot-job-launcher: {what} (exit code {code:#010x})");
    code
}

/// Creates the job with `KILL_ON_JOB_CLOSE` and the optional memory ceiling.
fn create_job(memory_limit_bytes: Option<usize>) -> Result<Handle, u32> {
    // SAFETY: null attributes and null name are allowed; the result is checked.
    let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    let Some(job) = Handle::new(raw) else {
        return Err(fail(EXIT_JOB_FAILED, "CreateJobObjectW failed"));
    };
    // SAFETY: the struct is plain data; all-zero is the documented "no limits" value.
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    // DIE_ON_UNHANDLED_EXCEPTION suppresses the crash dialog (SEM_NOGPFAULTERRORBOX) of the
    // processes in the job: nobody is there to click it.
    info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    if let Some(limit) = memory_limit_bytes {
        info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.JobMemoryLimit = limit;
    }
    let size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
        .expect("the struct is a few hundred bytes");
    // SAFETY: `info` is a valid struct of the class and size given.
    let ok = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            ptr::from_ref(&info).cast(),
            size,
        )
    };
    if ok == 0 {
        return Err(fail(EXIT_JOB_FAILED, "SetInformationJobObject failed"));
    }
    Ok(job)
}

/// Standard handles for `STARTF_USESTDHANDLES`, made inheritable on the way.
fn std_handle(which: u32) -> HANDLE {
    // SAFETY: plain query of a standard handle.
    let handle = unsafe { GetStdHandle(which) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return ptr::null_mut();
    }
    // SAFETY: the handle is valid; failure only means it stays as it was.
    unsafe {
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
    handle
}

/// Result of a spawn: both handles are closed on drop.
struct Spawned {
    process: Handle,
    thread: Handle,
}

fn spawn_suspended(command_line: &[u16]) -> Result<Spawned, u32> {
    let mut buffer: Vec<u16> = command_line.to_vec();
    buffer.push(0);

    // SAFETY: all-zero is a valid initial STARTUPINFOW.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = u32::try_from(size_of::<STARTUPINFOW>()).expect("a small struct");
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = std_handle(STD_INPUT_HANDLE);
    startup.hStdOutput = std_handle(STD_OUTPUT_HANDLE);
    startup.hStdError = std_handle(STD_ERROR_HANDLE);
    // SAFETY: all-zero is a valid out-parameter for PROCESS_INFORMATION.
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    // SAFETY: `buffer` is a writable NUL-terminated UTF-16 string, `startup` and `info` are valid,
    // environment and directory are null (inherited), handles are inherited (TRUE).
    let ok = unsafe {
        CreateProcessW(
            ptr::null(),
            buffer.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED,
            ptr::null(),
            ptr::null(),
            &raw const startup,
            &raw mut info,
        )
    };
    if ok == 0 {
        return Err(fail(EXIT_SPAWN_FAILED, "CreateProcessW failed"));
    }
    match (Handle::new(info.hProcess), Handle::new(info.hThread)) {
        (Some(process), Some(thread)) => Ok(Spawned { process, thread }),
        _ => Err(refuse(
            EXIT_SPAWN_FAILED,
            "CreateProcessW returned no handles",
        )),
    }
}

fn kill(process: &Handle) {
    // SAFETY: valid process handle with terminate access (it came from CreateProcessW).
    unsafe {
        TerminateProcess(process.0, 1);
    }
}

/// Runs the Executor and returns the exit code of the launcher.
#[must_use]
pub fn run(config: &Config) -> u32 {
    let limit = match config.memory_limit_bytes.map(usize::try_from).transpose() {
        Ok(limit) => limit,
        Err(_) => {
            return refuse(
                EXIT_USAGE,
                "--memory-limit-bytes does not fit this platform",
            );
        }
    };
    let argv: Vec<Vec<u16>> = config
        .argv
        .iter()
        .map(|arg| arg.encode_wide().collect())
        .collect();
    if argv.iter().any(|arg| arg.contains(&0)) {
        return refuse(EXIT_USAGE, "an argument contains a NUL character");
    }
    if argv
        .first()
        .is_some_and(|program| cmdline::is_batch_script(program))
    {
        return refuse(
            EXIT_BATCH_REFUSED,
            ".cmd and .bat programs are refused: they run through cmd.exe, which re-parses arguments",
        );
    }
    let command_line = match cmdline::build_command_line(&argv) {
        Ok(line) => line,
        Err(error) => return refuse(EXIT_USAGE, &error.to_string()),
    };

    let job = match create_job(limit) {
        Ok(job) => job,
        Err(code) => return code,
    };
    let spawned = match spawn_suspended(&command_line) {
        Ok(spawned) => spawned,
        Err(code) => return code,
    };

    // SAFETY: both handles are valid; the job outlives the call.
    if unsafe { AssignProcessToJobObject(job.0, spawned.process.0) } == 0 {
        let code = fail(EXIT_ASSIGN_FAILED, "AssignProcessToJobObject failed");
        kill(&spawned.process);
        return code;
    }
    // SAFETY: valid thread handle of the suspended main thread.
    if unsafe { ResumeThread(spawned.thread.0) } == u32::MAX {
        let code = fail(EXIT_RESUME_FAILED, "ResumeThread failed");
        kill(&spawned.process);
        return code;
    }
    drop(spawned.thread);

    // SAFETY: valid process handle with SYNCHRONIZE access.
    if unsafe { WaitForSingleObject(spawned.process.0, INFINITE) } != WAIT_OBJECT_0 {
        return fail(EXIT_WAIT_FAILED, "WaitForSingleObject failed");
    }
    let mut exit_code: u32 = 0;
    // SAFETY: valid process handle and a valid out-pointer.
    if unsafe { GetExitCodeProcess(spawned.process.0, &raw mut exit_code) } == 0 {
        return fail(EXIT_WAIT_FAILED, "GetExitCodeProcess failed");
    }
    // `job` closes here (after `spawned`): whatever is still in it is terminated.
    drop(job);
    exit_code
}

/// Entry point: parses the arguments of this process and runs. Returns the exit code.
#[must_use]
pub fn main_from_env() -> u32 {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match cli::parse(args) {
        Ok(Parsed::Run(config)) => run(&config),
        Ok(Parsed::Help) => {
            println!("{}", cli::USAGE);
            0
        }
        Err(error) => {
            eprintln!("ot-job-launcher: {error}\n\n{}", cli::USAGE);
            EXIT_USAGE
        }
    }
}
