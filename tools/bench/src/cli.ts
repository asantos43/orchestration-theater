#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { parseCliArgs, UsageError, USAGE, type StoreArgs } from './args.js';
import { Deadline, scrub, type Log } from './common.js';
import { collectEnvironment } from './env.js';
import { checkDirectory, UnsafeDirectoryError } from './fs-guard.js';
import { renderMarkdown, renderText, type Results } from './report.js';
import { runScenarioA, type ResultA } from './scenario-a.js';
import { runScenarioB, SIZES, type ResultB } from './scenario-b.js';

async function runStore(args: StoreArgs): Promise<number> {
  const started = performance.now();
  const log: Log = (message) => {
    process.stderr.write(
      `[${((performance.now() - started) / 1000).toFixed(0).padStart(4)} s] ${message}\n`,
    );
  };
  const { realPath, mount } = await checkDirectory(resolve(args.dir));
  log(`Folder is on a ${mount.fsType} filesystem: ok`);
  const runDir = await mkdtemp(join(realPath, 'run-'));
  const secrets = [runDir, realPath, homedir()];

  // Interrupted (Ctrl+C, timeout): remove what this run created before leaving.
  const interrupted = (signal: NodeJS.Signals): void => {
    process.stderr.write(`Received ${signal}; removing ${runDir}\n`);
    void rm(runDir, { recursive: true, force: true }).finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);

  try {
    const deadline = new Deadline(args.budgetMinutes);
    const environment = await collectEnvironment(runDir, mount);
    let scenarioA: ResultA | undefined;
    let scenarioB: ResultB | undefined;
    if (args.section !== 'b') {
      scenarioA = await runScenarioA({
        dir: runDir,
        repetitions: args.quick ? 1 : 3,
        maxTransactions: args.quick ? 300 : 2000,
        maxMs: args.quick ? 10_000 : 30_000,
        payloadBytes: 200,
        deadline,
        log,
      });
    }
    if (args.section !== 'a') {
      scenarioB = await runScenarioB({
        dir: runDir,
        sizes: args.quick ? SIZES.slice(0, 1) : SIZES,
        repetitions: args.quick ? 1 : 3,
        deadline,
        log,
        secrets,
      });
    }
    const results: Results = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      quick: args.quick,
      totalSeconds: Math.round((performance.now() - started) / 1000),
      environment,
      scenarioA,
      scenarioB,
    };
    process.stdout.write(`${renderText(results)}\n`);
    if (args.out !== undefined) {
      const out = resolve(args.out);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${scrub(JSON.stringify(results, null, 2), secrets)}\n`);
      const { dir, name } = parse(out);
      await writeFile(join(dir, `${name}.md`), `${scrub(renderMarkdown(results), secrets)}\n`);
      log(`Results written to ${parse(out).base} and ${name}.md`);
    }
    return 0;
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    await rm(runDir, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const args = parseCliArgs(argv);
    if (args.command === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    return await runStore(args);
  } catch (error) {
    if (error instanceof UsageError || error instanceof UnsafeDirectoryError) {
      process.stderr.write(`${error.message}\n\n${error instanceof UsageError ? USAGE : ''}\n`);
      return 2;
    }
    process.stderr.write(
      `Measurement failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
