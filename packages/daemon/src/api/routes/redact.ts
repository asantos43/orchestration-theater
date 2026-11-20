// SPDX-License-Identifier: MPL-2.0
import { REDACTED_VALUE } from '@otheater/protocol';
import type { JsonObject, JsonValue } from '@otheater/core';

/**
 * What the read routes hold back from a configuration tree (P5 of docs/17). [proposta] The
 * configuration has no key whose value is a secret today (a key that reads one names an environment
 * variable, `api_key_env`, or points into the vault by a reference), but it has free text (the
 * literal `env` of a client, a URL, a command line) where somebody could write one. So the rule is
 * the safe side of a guess, and the paths it holds back are listed so nobody is misled:
 * - every value under an `env` key (the literal variables of a client: "not for secrets");
 * - a string whose key names a secret (`token`, `secret`, `password`, `passphrase`, `credential`,
 *   `api_key`, `private_key`, `bearer`), except a key that only names where one is (`..._env`,
 *   `..._file`, `..._path`, `..._store`, as `clients.codex.credentials_store`, a mode) and `api.token`, which is the mode of the token, not the token;
 * - a URL with a user and password in it;
 * - a string that has the shape of a well known key (`sk-...`, `ghp_...`, `xoxb-...`, `AKIA...`).
 */

const SECRET_KEY =
  /(^|[_-])(secret|secrets|token|password|passwd|passphrase|credential|credentials|api_?key|private_?key|bearer)($|[_-])/i;
const REFERENCE_KEY = /(_env|_file|_path|_store)$/i;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;
const KEY_SHAPE =
  /(\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b)/;

/** Paths whose value looks like a secret by name and is not (a mode, not the token itself). */
const NOT_SECRET_PATHS: ReadonlySet<string> = new Set(['api.token']);

function holdBack(key: string, path: string, value: string, inEnv: boolean): boolean {
  if (value === '') return false;
  if (inEnv) return true;
  if (NOT_SECRET_PATHS.has(path)) return false;
  if (SECRET_KEY.test(key) && !REFERENCE_KEY.test(key)) return true;
  return URL_WITH_PASSWORD.test(value) || KEY_SHAPE.test(value);
}

export interface Redacted<Value> {
  readonly value: Value;
  /** The paths whose value was replaced, in the order they were met. */
  readonly paths: readonly string[];
}

function walk(
  value: JsonValue,
  key: string,
  path: string,
  inEnv: boolean,
  paths: string[],
): JsonValue {
  if (typeof value === 'string') {
    if (!holdBack(key, path, value, inEnv)) return value;
    paths.push(path);
    return REDACTED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, key, `${path}[${String(index)}]`, inEnv, paths));
  }
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [name, child] of Object.entries(value)) {
      const childPath = path === '' ? name : `${path}.${name}`;
      out[name] = walk(child, name, childPath, inEnv || name === 'env', paths);
    }
    return out;
  }
  return value;
}

/** A copy of `tree` with what could be a secret replaced. `tree` must be plain JSON. */
export function redactTree(tree: JsonObject, prefix = ''): Redacted<JsonObject> {
  const paths: string[] = [];
  const out: JsonObject = {};
  for (const [name, child] of Object.entries(tree)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    out[name] = walk(child, name, path, name === 'env', paths);
  }
  return { value: out, paths };
}

/** The configuration as plain JSON (what `JSON.stringify` keeps), redacted. */
export function redactConfig(config: unknown): Redacted<JsonObject> {
  return redactTree(JSON.parse(JSON.stringify(config)) as JsonObject);
}
