// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * The plan of faults of the chaos tests (Phase 11, P1; docs/23). A fault is one of two things:
 * - a **crash**: at a named point of the daemon (`crashPoint('effects.after_execute', 'open_pr')`)
 *   the process kills itself with SIGKILL, so the next start finds what a power cut would leave
 *   (as far as the system keeps the files);
 * - a **fail**: at a named point (`failPoint('fs.write', 'log')`) the call throws an error with the
 *   `code` of the system (`ENOSPC`, `EIO`...), the way a full disk does (used by the disk steps).
 *
 * `faults.inject` says where the plan comes from:
 * - `off` (default): there is no plan, and every point does nothing;
 * - `env`: the variables {@link CRASH_AT_VARIABLE} and {@link FAULT_VARIABLE};
 * - `plan`: a JSON file (`faults.plan_file`, relative to the data directory), for the manual
 *   roteiro of the owner.
 *
 * In the release build (the one that defines `__OT_BUILD_VERSION__`) the plan is always empty,
 * whatever the key, the variables and the file say: the same rule as `OT_TEST_MIGRATION`. [proposta]
 */

declare const __OT_BUILD_VERSION__: string | undefined;

export const FAULT_INJECT_MODES = ['off', 'env', 'plan'] as const;
export type FaultInjectMode = (typeof FAULT_INJECT_MODES)[number];

/** `faults.plan_file` default: relative to the data directory. */
export const DEFAULT_FAULT_PLAN_FILE = 'fault-plan.json';

/** `OT_TEST_CRASH_AT=<point>[:<detail>][#<n>]`: kills at the `n`th hit (default 1) of the point. */
export const CRASH_AT_VARIABLE = 'OT_TEST_CRASH_AT';
/** `OT_TEST_FAULT=<point>[:<detail>]=<CODE>[#<n>[x<times>]]`, comma separated. */
export const FAULT_VARIABLE = 'OT_TEST_FAULT';

/** The system error codes a fail point can raise. */
export const FAULT_ERROR_CODES = ['ENOSPC', 'EIO', 'EACCES', 'EMFILE', 'SQLITE_FULL'] as const;
export type FaultErrorCode = (typeof FAULT_ERROR_CODES)[number];

export interface CrashRule {
  readonly point: string;
  /** Without it the rule matches the point whatever its detail; with it, only that detail. */
  readonly detail?: string | undefined;
  /** The hit (1-based, counting the hits that match the rule) that kills. */
  readonly nth: number;
}

export interface FailRule {
  readonly point: string;
  readonly detail?: string | undefined;
  readonly code: FaultErrorCode;
  /** The first matching hit (1-based) that fails. */
  readonly nth: number;
  /** How many hits fail in a row from `nth`; `0` means every one from there on. */
  readonly times: number;
}

export interface FaultPlan {
  readonly crash: readonly CrashRule[];
  readonly fail: readonly FailRule[];
}

export const EMPTY_FAULT_PLAN: FaultPlan = { crash: [], fail: [] };

const PositiveInt = z.int().min(1);
const PointName = z
  .string()
  .regex(/^[a-z][a-z0-9_.]*$/, 'expected a point name such as effects.after_execute');
const Detail = z.string().min(1).optional();

const CrashRuleSchema = z.strictObject({
  point: PointName,
  detail: Detail,
  nth: PositiveInt.default(1),
});

const FailRuleSchema = z.strictObject({
  point: PointName,
  detail: Detail,
  code: z.enum(FAULT_ERROR_CODES),
  nth: PositiveInt.default(1),
  times: z.int().min(0).default(1),
});

const FaultPlanSchema = z.strictObject({
  crash: z.array(CrashRuleSchema).default([]),
  fail: z.array(FailRuleSchema).default([]),
});

/** Parses the JSON of a plan file. Throws `Error` naming what is wrong. */
export function parseFaultPlan(text: string): FaultPlan {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The fault plan is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  const parsed = FaultPlanSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid fault plan: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function splitPointAndDetail(text: string): { point: string; detail?: string } {
  const cut = text.indexOf(':');
  const point = cut < 0 ? text : text.slice(0, cut);
  const detail = cut < 0 ? '' : text.slice(cut + 1);
  return detail === '' ? { point } : { point, detail };
}

/** `<point>[:<detail>][#<n>]` (the value of {@link CRASH_AT_VARIABLE}). */
export function parseCrashSpec(text: string): CrashRule {
  const [name = '', nth] = text.trim().split('#');
  const { point, detail } = splitPointAndDetail(name);
  const rule = CrashRuleSchema.safeParse({
    point,
    ...(detail === undefined ? {} : { detail }),
    ...(nth === undefined ? {} : { nth: Number(nth) }),
  });
  if (!rule.success) {
    throw new Error(`Invalid ${CRASH_AT_VARIABLE} "${text}": ${z.prettifyError(rule.error)}`);
  }
  return rule.data;
}

/** `<point>[:<detail>]=<CODE>[#<n>[x<times>]]` (one entry of {@link FAULT_VARIABLE}). */
export function parseFailSpec(text: string): FailRule {
  const trimmed = text.trim();
  const equals = trimmed.lastIndexOf('=');
  if (equals < 0)
    throw new Error(`Invalid ${FAULT_VARIABLE} entry "${text}": expected <point>=<CODE>`);
  const { point, detail } = splitPointAndDetail(trimmed.slice(0, equals));
  const [code = '', count] = trimmed.slice(equals + 1).split('#');
  const [nth, times] = count === undefined ? [] : count.split('x');
  const rule = FailRuleSchema.safeParse({
    point,
    ...(detail === undefined ? {} : { detail }),
    code,
    ...(nth === undefined ? {} : { nth: Number(nth) }),
    ...(times === undefined ? {} : { times: Number(times) }),
  });
  if (!rule.success) {
    throw new Error(`Invalid ${FAULT_VARIABLE} entry "${text}": ${z.prettifyError(rule.error)}`);
  }
  return rule.data;
}

export type FaultEnv = Readonly<Record<string, string | undefined>>;

/** Whether this process is the release build (it defines `__OT_BUILD_VERSION__`). */
export function isReleaseBuild(): boolean {
  return typeof __OT_BUILD_VERSION__ === 'string';
}

export interface FaultPlanInput {
  readonly mode: FaultInjectMode;
  readonly env: FaultEnv;
  /** Absolute path of the plan file, for `mode: plan`. */
  readonly planFile?: string | undefined;
  /** Default: whether this process is the release build. A test passes `true` to prove it ignores the key. */
  readonly releaseBuild?: boolean | undefined;
  /** Test seam: reads the plan file. Default: the file system. */
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
}

/**
 * The plan a start-up arms. Empty with `off`, in the release build and when nothing is set; a
 * malformed variable or file rejects, so a test that meant a fault never runs without it.
 */
export async function resolveFaultPlan(input: FaultPlanInput): Promise<FaultPlan> {
  const release = input.releaseBuild ?? isReleaseBuild();
  if (release || input.mode === 'off') return EMPTY_FAULT_PLAN;
  if (input.mode === 'env') {
    const crashAt = input.env[CRASH_AT_VARIABLE]?.trim() ?? '';
    const faults = input.env[FAULT_VARIABLE]?.trim() ?? '';
    return {
      crash: crashAt === '' ? [] : [parseCrashSpec(crashAt)],
      fail:
        faults === ''
          ? []
          : faults
              .split(',')
              .filter((part) => part.trim() !== '')
              .map(parseFailSpec),
    };
  }
  if (input.planFile === undefined) return EMPTY_FAULT_PLAN;
  const read = input.readFile ?? ((path: string) => readFile(path, 'utf8'));
  let text: string;
  try {
    text = await read(input.planFile);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return EMPTY_FAULT_PLAN;
    throw error;
  }
  return parseFaultPlan(text);
}

/** `faults.plan_file` as an absolute path (a relative one is inside the data directory). */
export function faultPlanPath(dataDir: string, planFile: string): string {
  return isAbsolute(planFile) ? planFile : resolve(dataDir, planFile);
}

/** The error a fail point throws: the shape Node gives a failed system call. */
export function faultError(code: FaultErrorCode, where: string): Error {
  const text: Record<FaultErrorCode, string> = {
    ENOSPC: 'no space left on device',
    EIO: 'input/output error',
    EACCES: 'permission denied',
    EMFILE: 'too many open files',
    SQLITE_FULL: 'database or disk is full',
  };
  const error = new Error(`${code}: ${text[code]}, injected at ${where}`);
  return Object.assign(error, { code, injected: true });
}
