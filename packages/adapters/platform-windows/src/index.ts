// SPDX-License-Identifier: MPL-2.0
export {
  JOB_LAUNCHER_FILE,
  WINDOWS_PROCESS_LAUNCHER_ADAPTER,
  WINDOWS_SHIM_MODES,
  WindowsLauncherConfigSchema,
  type WindowsLauncherConfig,
  type WindowsLauncherConfigInput,
  type WindowsShimMode,
} from './config.js';
export {
  launcherArguments,
  launcherFailureOf,
  WindowsProcessLauncher,
  type WindowsLauncherDeps,
} from './launcher.js';
export {
  checkoutRoots,
  locateJobLauncher,
  type LocateOptions,
  type LocateResult,
} from './locate.js';
export {
  refusedScript,
  resolveExecutable,
  resolveProgram,
  type ResolvedProgram,
  type ResolveOptions,
} from './resolve.js';
export { resolveNpmShim, type ResolvedShim, type ShimOptions } from './shim.js';
