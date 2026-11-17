// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The script (roteiro) the Scriptwriter submits (architecture 5.4, "Roteiro = DAG de demandas"):
 * a list of demands plus the contracts they cite. These schemas check the shape only. The rules
 * that need the whole script (ids, graph, contracts, files, readiness) live in `validate.ts`, so the
 * Scriptwriter gets them as a structured list it can act on, not as a thrown error.
 *
 * Everything the architecture does not fix is a [proposta]:
 * - `ContractRef` is the id of a contract declared in `Script.contracts`; the architecture names the
 *   type but never defines it;
 * - `Contract` is `{ id, kind?, title, description }`;
 * - `VerifyStep` is `{ name, command, args }`: a command the daemon runs in the demand worktree,
 *   without a shell (the architecture names the type but never defines it);
 * - ids (demand and contract) are limited to `[A-Za-z0-9_-]`, up to 64 characters, because the
 *   demand id ends up inside git ref names (`play/<id>/attempts/<demanda>/<tentativa>`, 5.5);
 * - `timeoutMin` is optional, because `limits.demand_timeout` applies "quando o Roteirista nao
 *   define o timeoutMin da demanda" (5.4), although the interface lists it without `?`.
 */

/** Ids are used in git ref names: a conservative, ASCII-only alphabet. */
export const SCRIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const scriptId = z
  .string()
  .regex(
    SCRIPT_ID_PATTERN,
    'must start with a letter or digit, then only letters, digits, "_" or "-", up to 64 characters',
  );

const text = (max: number) => z.string().trim().min(1).max(max);

export const DEMAND_COMPLEXITIES = ['low', 'medium', 'high'] as const;
export const DemandComplexitySchema = z.enum(DEMAND_COMPLEXITIES);
export type DemandComplexity = z.infer<typeof DemandComplexitySchema>;

/** What a contract describes (architecture 5.4: "arquivos, APIs, tipos, schema"). */
export const CONTRACT_KINDS = ['file', 'api', 'type', 'schema', 'other'] as const;
export const ContractKindSchema = z.enum(CONTRACT_KINDS);
export type ContractKind = z.infer<typeof ContractKindSchema>;

/** A rigid interface between Actors. Demands cite it by `id` in `contract.inputs`/`outputs`. */
export const ContractSchema = z.strictObject({
  id: scriptId,
  kind: ContractKindSchema.optional(),
  title: text(200),
  description: text(20_000),
});
export type Contract = z.infer<typeof ContractSchema>;

/** A reference to a contract: its id. */
export const ContractRefSchema = scriptId;
export type ContractRef = z.infer<typeof ContractRefSchema>;

/** A code step run at the end of an attempt, in the demand worktree (tests, lint). */
export const VerifyStepSchema = z.strictObject({
  name: text(120),
  command: text(1000),
  args: z.array(z.string().max(4000)).max(100),
});
export type VerifyStep = z.infer<typeof VerifyStepSchema>;

export const DemandSchema = z.strictObject({
  id: scriptId,
  title: text(200),
  description: text(20_000),
  /** Edges of the DAG: the demands that must finish before this one starts. */
  dependsOn: z.array(scriptId).max(200),
  contract: z.strictObject({
    inputs: z.array(ContractRefSchema).max(200),
    outputs: z.array(ContractRefSchema).max(200),
  }),
  /** Repository-relative paths (a trailing "/" means a directory): scope and conflict detection. */
  expectedFiles: z.array(z.string().min(1).max(1000)).max(500),
  complexity: DemandComplexitySchema,
  specialty: text(100).optional(),
  /** Minutes. Missing means `limits.demand_timeout`. */
  timeoutMin: z.number().int().positive().max(100_000).optional(),
  acceptanceCriteria: z.array(text(2000)).max(100),
  verify: z.array(VerifyStepSchema).max(50),
  /** Why there is no `verify` step. The Author judges it (REVIEWING_SCRIPT). */
  verifyWaiver: text(2000).optional(),
  /**
   * A rewritten script (N84): the Scriptwriter says this demand is exactly as it was in the script
   * it replaces. The daemon checks it (same description, contract, expected files, dependencies
   * and verify) before it keeps the approved work. [proposta] The architecture says the
   * Scriptwriter marks the unchanged demands but not how.
   */
  unchanged: z.boolean().optional(),
});
export type Demand = z.infer<typeof DemandSchema>;

export const ScriptSchema = z.strictObject({
  contracts: z.array(ContractSchema).max(1000),
  demands: z.array(DemandSchema).max(1000),
});
export type Script = z.infer<typeof ScriptSchema>;
