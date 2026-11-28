// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Conflict,
  InvalidInput,
  NotFound,
  type Clock,
  type EventLog,
  type WorkflowDefinitionRecord,
} from '@otheater/core';
import type { WorkflowPackageOrigin } from '@otheater/protocol';
import {
  parseWorkflowYaml,
  validateWorkflow,
  workflowHash,
  type ValidateOptions,
  type ValidWorkflow,
} from '@otheater/workflows';
import semver from 'semver';
import type { Env } from '../../paths.js';
import { execRunner, parseOrigin, type CommandRunner } from '../../plugins/sources.js';
import { writeSituation, type SituationErrorLog } from '../../situations.js';
import type { WorkflowLibrary } from '../library.js';
import { describeIssues } from '../library.js';
import type { WorkflowPackagesSettings } from './config.js';
import { fetchPackageFromGit } from './git-source.js';
import {
  addedPermissions,
  describePermissions,
  permissionKeys,
  type PackagePermissions,
} from './permissions.js';
import type { InstalledWorkflowPackage, WorkflowPackageRegistry } from './registry.js';
import { readPackage, type LoadedPackage } from './source.js';
import { verifySshsig, type KeygenRunner, type SignatureCheck } from './sshsig.js';

/**
 * Installing workflow packages (N298, D5; docs/24 section 9; plan of Phase 11b, P9). The rules that
 * are not in the plan are [proposta]:
 *
 * - a package is read whole and checked before anything is saved: the signature, every workflow
 *   (the validator of the library, so a package that needs a plugin that is not installed is
 *   refused), the versions it would add against the library, and its permissions. Then the
 *   Producer is shown a {@link PackagePreview} and approves it, or not (`approve`);
 * - the signature policy is {@link decidePolicy}: `invalid` is always refused; what is not
 *   verified follows `workflows.packages.unsigned` (`confirm` makes the approval mandatory and
 *   records it, `reject` refuses it), and `signature: require` refuses it whatever `unsigned` says;
 * - an update (the same package id, another version) that brings a permission the Producer had not
 *   approved needs the approval again (docs/24 section 9);
 * - what is saved is all or nothing: every workflow is saved inactive first and only then the
 *   active versions are chosen (`workflows.packages.activate`); a failure puts the active versions
 *   back and removes the versions it created;
 * - a git package is pinned to the commit its ref resolved to at the install, and that commit is
 *   recorded; the installed definitions live in the library and do not change when the ref moves.
 *
 * A signature that is refused writes `workflow.package.signature_failed`; an install writes
 * `workflow.package.installed` and a removal `workflow.package.removed`.
 */

export type PackageConfirmation = 'unsigned' | 'new_permissions';

export type PackageOutcome =
  | {
      readonly kind: 'refused';
      readonly reason: 'invalid' | 'not_signed' | 'not_verified';
      readonly detail: string;
    }
  | {
      readonly kind: 'ready';
      /** Why the approval is mandatory (it is always asked; these are the reasons it cannot be skipped). */
      readonly confirm: readonly PackageConfirmation[];
    };

export interface PreviewWorkflow {
  readonly id: string;
  readonly version: string;
  readonly path: string;
  readonly description: string | null;
}

/** What the Producer sees before a package is installed. */
export interface PackagePreview {
  readonly packageId: string;
  readonly version: string;
  readonly description: string | null;
  readonly origin: WorkflowPackageOrigin;
  readonly hash: string;
  readonly workflows: readonly PreviewWorkflow[];
  readonly permissions: PackagePermissions;
  /** The permission keys not approved before (all of them in a first install). */
  readonly newPermissions: readonly string[];
  /** The version installed now, when the package is an update. */
  readonly previousVersion: string | null;
  readonly signature: SignatureCheck;
  readonly outcome: PackageOutcome;
}

export interface InstallOptions {
  /**
   * Called with the preview of every package that may be installed (never for a refused one).
   * It resolves `true` to install. [proposta] It is always called, so the permissions are always
   * shown; `preview.outcome.confirm` lists the cases where the approval cannot be a formality.
   */
  readonly approve: (preview: PackagePreview) => boolean | Promise<boolean>;
}

export interface PackageInstallResult {
  /** `unchanged`: the same version with the same content was already installed; nothing was written. */
  readonly status: 'installed' | 'updated' | 'unchanged';
  readonly preview: PackagePreview;
  readonly workflows: readonly {
    readonly id: string;
    readonly version: string;
    readonly active: boolean;
  }[];
}

export interface WorkflowPackageInstallerDeps {
  readonly library: Pick<
    WorkflowLibrary,
    'install' | 'get' | 'active' | 'list' | 'activate' | 'remove'
  >;
  readonly registry: WorkflowPackageRegistry;
  /** Read live: the configuration can be reloaded. */
  readonly settings: () => WorkflowPackagesSettings;
  /** The registries the validator checks against (the same as the library's). */
  readonly validateOptions?: (() => ValidateOptions) | undefined;
  /** The folder installs are staged in (`workflowPackagePaths(dataDir).staging`). */
  readonly stagingDir: string;
  readonly events: Pick<EventLog, 'append'>;
  readonly logger: SituationErrorLog;
  readonly clock: Pick<Clock, 'now'>;
  readonly env: Env;
  /** Where a relative folder of an origin is resolved from. */
  readonly cwd: string;
  /** Runs `git`; default `execRunner`. A test gives its own. */
  readonly commandRunner?: CommandRunner | undefined;
  /** Runs `ssh-keygen`; default the real program. A test gives its own. */
  readonly keygenRunner?: KeygenRunner | undefined;
}

/**
 * The policy of the signature: what a check means for the install (`mode` is
 * `workflows.packages.signature`, `unsigned` is `workflows.packages.unsigned`).
 */
export function decidePolicy(
  settings: Pick<WorkflowPackagesSettings, 'signature' | 'unsigned'>,
  signature: SignatureCheck,
): PackageOutcome {
  switch (signature.state) {
    case 'skipped':
    case 'verified':
      return { kind: 'ready', confirm: [] };
    case 'invalid':
      return { kind: 'refused', reason: 'invalid', detail: signature.detail };
    case 'absent':
    case 'unverified': {
      const reason = signature.state === 'absent' ? 'not_signed' : 'not_verified';
      if (settings.signature === 'require') {
        return {
          kind: 'refused',
          reason,
          detail: `workflows.packages.signature is require: ${signature.detail}`,
        };
      }
      if (settings.unsigned === 'reject') {
        return {
          kind: 'refused',
          reason,
          detail: `workflows.packages.unsigned is reject: ${signature.detail}`,
        };
      }
      return { kind: 'ready', confirm: ['unsigned'] };
    }
  }
}

interface PreparedWorkflow {
  readonly path: string;
  readonly valid: ValidWorkflow;
  /** The parsed document, which is what the library validates again and saves. */
  readonly document: unknown;
  readonly hash: string;
}

interface Prepared {
  readonly loaded: LoadedPackage;
  readonly preview: PackagePreview;
  readonly workflows: readonly PreparedWorkflow[];
  readonly previous: InstalledWorkflowPackage | undefined;
  readonly unchanged: boolean;
}

function ref(workflow: { id: string; version: string }): string {
  return `${workflow.id}@${workflow.version}`;
}

export class WorkflowPackageInstaller {
  readonly #deps: WorkflowPackageInstallerDeps;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(deps: WorkflowPackageInstallerDeps) {
    this.#deps = deps;
  }

  /** Reads and checks a package and says what installing it would do. Saves nothing and writes no event. */
  preview(origin: string): Promise<PackagePreview> {
    return this.#exclusive(async () => (await this.#prepare(origin)).preview);
  }

  /**
   * Installs the package at `origin` (a folder, a file, or `git:<url>#<ref>`). Throws
   * `InvalidInput` when the package is not valid, when the signature is refused and when the
   * Producer does not approve, and `Conflict` when a version it brings already exists with another
   * content (a version never changes) or belongs to another package.
   */
  install(origin: string, options: InstallOptions): Promise<PackageInstallResult> {
    return this.#exclusive(async () => {
      const prepared = await this.#prepare(origin);
      const { preview } = prepared;
      if (preview.outcome.kind === 'refused') {
        await this.#signatureFailed(preview, preview.outcome);
        throw new InvalidInput(
          `the package ${preview.packageId} was refused: ${preview.outcome.detail}`,
        );
      }
      if (prepared.unchanged) {
        return { status: 'unchanged', preview, workflows: await this.#states(prepared) };
      }
      if (!(await options.approve(preview))) {
        throw new InvalidInput(
          `the installation of ${preview.packageId}@${preview.version} was not approved`,
        );
      }
      return this.#commit(prepared, preview.outcome.confirm);
    });
  }

  /**
   * Removes a package: the workflow versions it brought, and its registry entry. Nothing is removed
   * when one of its versions is still the active one (`Conflict`: activate another first); a
   * version that a live run still uses (`Conflict` from the library) stops the removal there, and
   * what was removed before it stays removed.
   */
  remove(packageId: string): Promise<void> {
    return this.#exclusive(async () => {
      const { library, registry } = this.#deps;
      const entry = await registry.get(packageId);
      if (entry === undefined) throw new NotFound(`the package ${packageId} is not installed`);
      const records = (await library.list({ source: 'package' }))
        .filter((record) => record.packageId === packageId)
        .sort((a, b) => b.seq - a.seq);
      const active = records.filter((record) => record.state === 'active');
      if (active.length > 0) {
        throw new Conflict(
          `${active.map((record) => ref({ id: record.workflowId, version: record.version })).join(', ')} is the active version of its workflow; activate another version first`,
        );
      }
      const removed: string[] = [];
      try {
        for (const record of records) {
          await library.remove(record.workflowId, record.version);
          removed.push(ref({ id: record.workflowId, version: record.version }));
        }
      } catch (error) {
        const left = records
          .map((record) => ref({ id: record.workflowId, version: record.version }))
          .filter((name) => !removed.includes(name));
        await registry.put({ ...entry, workflows: left });
        throw error;
      }
      await registry.remove(packageId);
      await writeSituation(this.#deps.events, this.#deps.logger, 'workflow.package.removed', {
        packageId,
        version: entry.version,
        workflows: removed,
      });
    });
  }

  list(): Promise<readonly InstalledWorkflowPackage[]> {
    return this.#deps.registry.list();
  }

  get(packageId: string): Promise<InstalledWorkflowPackage | undefined> {
    return this.#deps.registry.get(packageId);
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(run, run);
    this.#lock = result.catch(() => undefined);
    return result;
  }

  async #prepare(originText: string): Promise<Prepared> {
    const { settings: read, library, registry } = this.#deps;
    const settings = read();
    const spec = parseOrigin(originText, this.#deps.cwd);
    if (spec.source === 'npm') {
      throw new InvalidInput('a workflow package is a folder, a file or git:<url>#<ref>, not npm');
    }
    const kind = spec.source === 'path' ? 'file' : 'git';
    if (!settings.sources.includes(kind)) {
      throw new InvalidInput(
        `workflows.packages.sources does not allow ${kind} (it allows ${settings.sources.join(', ')})`,
      );
    }

    await mkdir(this.#deps.stagingDir, { recursive: true });
    const stage = await mkdtemp(join(this.#deps.stagingDir, 'install-'));
    let origin: WorkflowPackageOrigin;
    let loaded: LoadedPackage;
    let signature: SignatureCheck;
    try {
      if (spec.source === 'path') {
        origin = { kind: 'file', path: spec.path };
        loaded = await readPackage(spec.path, settings.max_workflows);
      } else {
        const fetched = await fetchPackageFromGit(
          { url: spec.url, ref: spec.ref },
          {
            runner: this.#deps.commandRunner ?? execRunner,
            env: this.#deps.env,
            timeoutMs: settings.fetch_timeout,
            stage,
          },
        );
        origin = fetched.origin;
        loaded = await readPackage(fetched.root, settings.max_workflows);
      }
      signature = await this.#checkSignature(loaded, settings, stage);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }

    const workflows = await this.#validate(loaded);
    const permissions = describePermissions(
      workflows.map((workflow) => workflow.valid),
      this.#deps.validateOptions?.().stepTypes,
    );
    for (const workflow of workflows) {
      const existing = await library.get(workflow.valid.id, workflow.valid.version);
      if (existing === undefined) continue;
      this.#checkExisting(existing, workflow, loaded.id);
    }
    const previous = await registry.get(loaded.id);
    if (previous?.version === loaded.version && previous.hash !== loaded.hash) {
      throw new Conflict(
        `the package ${loaded.id}@${loaded.version} is installed with other content: a version never changes, so raise its version`,
      );
    }
    const newPermissions = addedPermissions(previous?.permissions ?? [], permissions);
    const outcome = decidePolicy(settings, signature);
    const finalOutcome: PackageOutcome =
      outcome.kind === 'ready' && previous !== undefined && newPermissions.length > 0
        ? { kind: 'ready', confirm: [...outcome.confirm, 'new_permissions'] }
        : outcome;

    const preview: PackagePreview = {
      packageId: loaded.id,
      version: loaded.version,
      description: loaded.description,
      origin,
      hash: loaded.hash,
      workflows: workflows.map((workflow) => ({
        id: workflow.valid.id,
        version: workflow.valid.version,
        path: workflow.path,
        description: workflow.valid.definition.description ?? null,
      })),
      permissions,
      newPermissions,
      previousVersion: previous?.version ?? null,
      signature,
      outcome: finalOutcome,
    };
    const unchanged = previous?.version === loaded.version && previous.hash === loaded.hash;
    return { loaded, preview, workflows, previous, unchanged };
  }

  async #checkSignature(
    loaded: LoadedPackage,
    settings: WorkflowPackagesSettings,
    tempRoot: string,
  ): Promise<SignatureCheck> {
    if (settings.signature === 'off') {
      return { state: 'skipped', signer: null, detail: 'workflows.packages.signature is off' };
    }
    if (loaded.signatureText === null) {
      return { state: 'absent', signer: null, detail: 'the package has no signature' };
    }
    return verifySshsig(loaded.signedBytes, loaded.signatureText, {
      trustedKeys: settings.trusted_keys,
      sshKeygen: settings.ssh_keygen,
      timeoutMs: settings.verify_timeout,
      env: this.#deps.env,
      tempRoot,
      runner: this.#deps.keygenRunner,
    });
  }

  /** Validates every workflow of the package; all the errors are collected before it throws. */
  async #validate(loaded: LoadedPackage): Promise<PreparedWorkflow[]> {
    const options = this.#deps.validateOptions?.() ?? {};
    const problems: string[] = [];
    const prepared: PreparedWorkflow[] = [];
    const seen = new Set<string>();
    for (const file of loaded.workflows) {
      const parsed = parseWorkflowYaml(file.text);
      if (!parsed.ok) {
        problems.push(`${file.path}: ${parsed.errors.map((error) => error.message).join('; ')}`);
        continue;
      }
      const result = validateWorkflow(parsed.value, options);
      if (!result.ok) {
        problems.push(`${file.path}: ${describeIssues(result.errors)}`);
        continue;
      }
      const name = ref(result.workflow);
      if (seen.has(name)) {
        problems.push(`${file.path}: ${name} is already in the package`);
        continue;
      }
      seen.add(name);
      prepared.push({
        path: file.path,
        valid: result.workflow,
        document: parsed.value,
        hash: await workflowHash(result.workflow.definition),
      });
    }
    if (problems.length > 0) {
      throw new InvalidInput(`the package ${loaded.id} is not valid: ${problems.join(' | ')}`);
    }
    return prepared;
  }

  #checkExisting(
    existing: WorkflowDefinitionRecord,
    workflow: PreparedWorkflow,
    packageId: string,
  ): void {
    const name = ref(workflow.valid);
    if (existing.hash !== workflow.hash) {
      throw new Conflict(
        `${name} already exists with other content: a version never changes, so raise its version`,
      );
    }
    if (existing.source !== 'package' || existing.packageId !== packageId) {
      throw new Conflict(`${name} already exists and does not belong to the package ${packageId}`);
    }
  }

  async #states(
    prepared: Prepared,
  ): Promise<readonly { id: string; version: string; active: boolean }[]> {
    const states = [];
    for (const workflow of prepared.workflows) {
      const record = await this.#deps.library.get(workflow.valid.id, workflow.valid.version);
      states.push({
        id: workflow.valid.id,
        version: workflow.valid.version,
        active: record?.state === 'active',
      });
    }
    return states;
  }

  async #commit(
    prepared: Prepared,
    confirm: readonly PackageConfirmation[],
  ): Promise<PackageInstallResult> {
    const { library, registry, clock } = this.#deps;
    const { loaded, preview, previous } = prepared;
    const mode = this.#deps.settings().activate;
    const created: { id: string; version: string }[] = [];
    const wasActive = new Map<string, string | undefined>();
    const activated: string[] = [];
    try {
      for (const workflow of prepared.workflows) {
        const { id, version } = workflow.valid;
        if (!wasActive.has(id)) wasActive.set(id, (await library.active(id))?.version);
        const existed = (await library.get(id, version)) !== undefined;
        await library.install(workflow.document, {
          source: 'package',
          packageId: loaded.id,
          activate: false,
        });
        if (!existed) created.push({ id, version });
      }
      for (const [id, before] of wasActive) {
        const best = prepared.workflows
          .filter((workflow) => workflow.valid.id === id)
          .map((workflow) => workflow.valid.version)
          .sort(semver.rcompare)[0];
        if (best === undefined) continue;
        if (mode === 'always' || (mode === 'when_none' && before === undefined)) {
          await library.activate(id, best);
          activated.push(id);
        }
      }
      const now = clock.now();
      await registry.put({
        id: loaded.id,
        version: loaded.version,
        hash: loaded.hash,
        origin: preview.origin,
        workflows: prepared.workflows.map((workflow) => ref(workflow.valid)),
        signature: preview.signature.state,
        signer: preview.signature.signer,
        confirmedUnsigned: confirm.includes('unsigned'),
        permissions: permissionKeys(preview.permissions),
        installedAt: previous?.installedAt ?? now,
        updatedAt: now,
      });
    } catch (error) {
      await this.#rollback(created, activated, wasActive);
      throw error;
    }
    await writeSituation(this.#deps.events, this.#deps.logger, 'workflow.package.installed', {
      packageId: loaded.id,
      version: loaded.version,
      previousVersion: previous?.version ?? null,
      hash: loaded.hash,
      origin: preview.origin,
      workflows: prepared.workflows.map((workflow) => ref(workflow.valid)),
      signature: preview.signature.state,
      signer: preview.signature.signer,
      confirmedUnsigned: confirm.includes('unsigned'),
      newPermissions: [...preview.newPermissions],
    });
    return {
      status: previous === undefined ? 'installed' : 'updated',
      preview,
      workflows: await this.#states(prepared),
    };
  }

  /** Puts back the active versions and removes the versions an install that failed had created. */
  async #rollback(
    created: readonly { id: string; version: string }[],
    activated: readonly string[],
    wasActive: ReadonlyMap<string, string | undefined>,
  ): Promise<void> {
    const { library, logger } = this.#deps;
    const attempt = async (what: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          `a workflow package install was not fully undone: ${what}`,
        );
      }
    };
    for (const id of activated) {
      const before = wasActive.get(id);
      if (before !== undefined)
        await attempt(`activate ${id}@${before}`, () => library.activate(id, before));
    }
    for (const { id, version } of [...created].reverse()) {
      await attempt(`remove ${id}@${version}`, () => library.remove(id, version));
    }
  }

  async #signatureFailed(
    preview: PackagePreview,
    outcome: Extract<PackageOutcome, { kind: 'refused' }>,
  ): Promise<void> {
    const settings = this.#deps.settings();
    await writeSituation(
      this.#deps.events,
      this.#deps.logger,
      'workflow.package.signature_failed',
      {
        packageId: preview.packageId,
        version: preview.version,
        origin: preview.origin,
        mode: settings.signature === 'require' ? 'require' : 'verify_if_present',
        unsigned: settings.unsigned,
        reason: outcome.reason,
        detail: outcome.detail,
      },
    );
  }
}
