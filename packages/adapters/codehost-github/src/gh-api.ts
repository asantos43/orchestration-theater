// SPDX-License-Identifier: MPL-2.0
import { isAbsolute } from 'node:path';
import { AdapterUnavailable, InvalidInput, NotFound } from '@otheater/core';
import { z } from 'zod';
import { classifyToolFailure } from './failure.js';
import type { ToolRunner } from './runner.js';

/**
 * The calls of the REST API through `gh api` (Phase 11b, P7). `{owner}` and `{repo}` in an
 * endpoint are filled in by `gh` from the remotes of the checkout; the answer is JSON on stdout,
 * read here with a schema, so a change of shape is a clear `AdapterUnavailable`.
 */
export class GhApi {
  readonly #runner: ToolRunner;
  readonly #gh: string;

  constructor(runner: ToolRunner, gh: string) {
    this.#runner = runner;
    this.#gh = gh;
  }

  /**
   * Runs `gh api` and reads its JSON. `fields` go as `-f key=value` (a `key[]` repeated makes a
   * list); with `GET` they are the query string.
   */
  async json<S extends z.ZodType>(
    repo: string,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    schema: S,
    fields: readonly (readonly [string, string])[] = [],
  ): Promise<z.output<S>> {
    const stdout = await this.text(repo, method, endpoint, fields);
    return parseGhJson(`gh api ${endpoint}`, stdout, schema);
  }

  /** Runs `gh api` and returns what it printed. */
  async text(
    repo: string,
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    fields: readonly (readonly [string, string])[] = [],
  ): Promise<string> {
    const args = ['api', '--method', method, endpoint];
    for (const [key, value] of fields) args.push('-f', `${key}=${value}`);
    return this.run(repo, `gh api ${endpointName(endpoint)}`, args);
  }

  /** Runs `gh` with `args` and returns stdout; a failure is classified. */
  async run(repo: string, what: string, args: readonly string[]): Promise<string> {
    const result = await this.#runner.run(this.#gh, [...args], repo);
    if (result.code !== 0) throw classifyToolFailure(what, result);
    return result.stdout;
  }
}

/** The endpoint without its numbers, for the messages (`repos/{owner}/{repo}/issues/N`). */
function endpointName(endpoint: string): string {
  return endpoint.replace(/\/\d+(?=\/|$)/g, '/N');
}

/** Reads the JSON a `gh` call printed. Anything but the expected shape is `AdapterUnavailable`. */
export function parseGhJson<S extends z.ZodType>(
  what: string,
  stdout: string,
  schema: S,
): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new AdapterUnavailable(`${what} did not print JSON`, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterUnavailable(`${what} printed an unexpected shape`, { cause: parsed.error });
  }
  return parsed.data;
}

/** A time of the API (ISO 8601) in ms since the epoch. */
export function ghTime(what: string, iso: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new AdapterUnavailable(`${what} printed a bad date: ${iso}`);
  return value;
}

/** Labels of the API (`[{name}]`), sorted. */
export const LabelsJsonSchema = z.array(z.object({ name: z.string() }));

export function labelNames(labels: z.output<typeof LabelsJsonSchema>): readonly string[] {
  return [...new Set(labels.map((label) => label.name))].sort();
}

/** The author of an item of the API; `user` is null for a deleted account (`ghost`). */
export const UserJsonSchema = z.object({ login: z.string() }).nullable();

export function loginOf(user: z.output<typeof UserJsonSchema>): string {
  return user?.login ?? 'ghost';
}

export function assertAbsolutePath(path: string): void {
  if (path === '' || path.includes('\0') || !isAbsolute(path)) {
    throw new InvalidInput(`repo must be an absolute path: ${JSON.stringify(path)}`);
  }
}

/** A 404 of the API for `what`, or the error it was. */
export function notFoundAs(what: string, error: unknown): unknown {
  return error instanceof NotFound ? new NotFound(`No ${what}`, { cause: error }) : error;
}
