// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectCargoPackages } from './cargo.js';
import { checkCatalogs, readCatalogs } from './catalogs.js';
import {
  defaultExec,
  hasErrors,
  renderResult,
  UsageError,
  type CheckResult,
  type ExecFn,
} from './common.js';
import { loadCopiedCode } from './copied-code.js';
import { checkCredentials, selectCredentialFiles } from './credentials.js';
import { DEFAULT_CONFIG, DEFAULT_TARGETS, parseViolations, runCruiser } from './deps.js';
import { listRepositoryFiles, readTextFiles } from './files.js';
import { checkHeaders, selectHeaderFiles } from './headers.js';
import { buildLicenseReport, licenseResult } from './licenses.js';
import { checkNotices, gatherNoticePackages, renderNotices } from './notices.js';
import { loadPolicy } from './policy.js';
import { collectPackages, resolvePnpmCommand } from './pnpm.js';

export const COMMANDS = [
  'licenses',
  'notices',
  'headers',
  'credentials',
  'catalogs',
  'deps',
] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface CommandContext {
  root: string;
  exec: ExecFn;
  env: Readonly<Record<string, string | undefined>>;
  write: (text: string) => void;
}

export interface CommandOptions {
  /** `licenses`: file that receives the full JSON report. */
  json: string | undefined;
  /** `notices`: only compare, do not write. */
  check: boolean;
}

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';

export function defaultContext(root: string): CommandContext {
  return {
    root,
    exec: defaultExec,
    env: process.env,
    write: (text) => {
      process.stdout.write(`${text}\n`);
    },
  };
}

function verifyDir(root: string): string {
  return path.join(root, 'tools', 'verify');
}

function finish(ctx: CommandContext, title: string, result: CheckResult): number {
  ctx.write(renderResult(title, result));
  return hasErrors(result) ? 1 : 0;
}

async function runLicenses(ctx: CommandContext, options: CommandOptions): Promise<number> {
  const policy = loadPolicy(path.join(verifyDir(ctx.root), 'policy.json'));
  const command = resolvePnpmCommand(ctx.env, process.execPath);
  const packages = [
    ...(await collectPackages(ctx.exec, ctx.root, command)),
    // Rust crates of native/*, read from each Cargo.lock (none when there is no Cargo.lock).
    ...(await collectCargoPackages(ctx.exec, ctx.root)),
  ];
  const report = buildLicenseReport(packages, policy, ctx.root);
  const result = licenseResult(report);
  if (options.json !== undefined) {
    writeFileSync(
      path.resolve(options.json),
      `${JSON.stringify({ ...report, findings: result.findings }, null, 2)}\n`,
    );
  }
  return finish(ctx, 'licenses: third-party license check', result);
}

async function runNotices(ctx: CommandContext, options: CommandOptions): Promise<number> {
  const command = resolvePnpmCommand(ctx.env, process.execPath);
  const packages = await collectPackages(ctx.exec, ctx.root, command, ['prod']);
  const copied = loadCopiedCode(path.join(verifyDir(ctx.root), 'copied-code.json'));
  const expected = renderNotices(gatherNoticePackages(packages), copied);
  const file = path.join(ctx.root, NOTICES_FILE);
  if (options.check) {
    const onDisk = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    return finish(
      ctx,
      'notices: THIRD_PARTY_NOTICES check',
      checkNotices(expected, onDisk, NOTICES_FILE, process.platform),
    );
  }
  writeFileSync(file, expected);
  ctx.write(
    `notices: wrote ${NOTICES_FILE} (${String(packages.length)} bundled package(s), ${String(copied.length)} copied-code entr${copied.length === 1 ? 'y' : 'ies'})`,
  );
  return 0;
}

async function runHeaders(ctx: CommandContext): Promise<number> {
  const policy = loadPolicy(path.join(verifyDir(ctx.root), 'policy.json'));
  const copied = loadCopiedCode(path.join(verifyDir(ctx.root), 'copied-code.json'));
  const paths = selectHeaderFiles(await listRepositoryFiles(ctx.exec, ctx.root), policy);
  return finish(
    ctx,
    'headers: SPDX header check',
    checkHeaders(readTextFiles(ctx.root, paths), policy, copied),
  );
}

async function runCredentials(ctx: CommandContext): Promise<number> {
  const policy = loadPolicy(path.join(verifyDir(ctx.root), 'policy.json'));
  const paths = selectCredentialFiles(await listRepositoryFiles(ctx.exec, ctx.root), policy);
  return finish(
    ctx,
    'credentials: credential lock (architecture 6.3)',
    checkCredentials(readTextFiles(ctx.root, paths), policy),
  );
}

function runCatalogs(ctx: CommandContext): number {
  const policy = loadPolicy(path.join(verifyDir(ctx.root), 'policy.json'));
  return finish(
    ctx,
    'catalogs: i18n catalog check',
    checkCatalogs(readCatalogs(ctx.root, policy.catalogs), policy.catalogs),
  );
}

async function runDeps(ctx: CommandContext): Promise<number> {
  const result = await runCruiser({
    root: ctx.root,
    cwd: ctx.root,
    config: DEFAULT_CONFIG,
    targets: DEFAULT_TARGETS,
    outputType: 'json',
  });
  if (result.exitCode > 0 && result.stdout.trim() === '') {
    throw new UsageError(`dependency-cruiser failed: ${result.stderr.trim()}`);
  }
  const violations = parseViolations(result.stdout);
  const errors = violations.map((v) => ({
    severity: 'error' as const,
    subject: v.from,
    message: `${v.rule}: imports ${v.to}`,
  }));
  return finish(ctx, 'deps: dependency rule (architecture 5.18)', {
    summary: [`rules: ${DEFAULT_CONFIG}; targets: ${DEFAULT_TARGETS.join(', ')}`],
    findings: errors,
  });
}

export function runCommand(
  name: CommandName,
  ctx: CommandContext,
  options: CommandOptions,
): Promise<number> {
  switch (name) {
    case 'licenses':
      return runLicenses(ctx, options);
    case 'notices':
      return runNotices(ctx, options);
    case 'headers':
      return runHeaders(ctx);
    case 'credentials':
      return runCredentials(ctx);
    case 'catalogs':
      return Promise.resolve(runCatalogs(ctx));
    case 'deps':
      return runDeps(ctx);
  }
}
