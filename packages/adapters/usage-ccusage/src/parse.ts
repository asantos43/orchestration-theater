// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, type UsageSourceEntry } from '@otheater/core';

/**
 * Reads the JSON `ccusage <client> daily --json` prints and keeps only the numbers of consumption
 * and the model name. Everything else in the output (a session id, the path of a project, a
 * summary, anything the tool may add) is never looked at and never returned.
 *
 * [N] The shape is the one of `ccusage` up to the 17 line, which the owner's request relied on:
 * `{ "daily": [ { "date", "inputTokens", "outputTokens", "cacheCreationTokens",
 * "cacheReadTokens", "totalCost", "modelBreakdowns": [ { "modelName", ..., "cost" } ] } ] }`.
 * The Codex source of that line names the fields `cachedInputTokens` and `costUSD` and keys the
 * models in an object (`models`). v20.0.48 was not run (its native binary was not downloaded), so
 * every name is accepted in its known spellings, and an output with no `daily` array is refused
 * instead of guessed. The first run against the real binary (`OT_CCUSAGE_BIN`) confirms or fixes it.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Row = Readonly<Record<string, unknown>>;

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function bad(what: string): never {
  throw new AdapterUnavailable(`ccusage answered something that is not understood: ${what}`);
}

/** The first of `names` the row has; `null` when none is there. A value of the wrong type fails. */
function pick(row: Row, names: readonly string[], kind: 'count' | 'money'): number | null {
  for (const name of names) {
    if (!Object.hasOwn(row, name)) continue;
    const value = row[name];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return bad(`"${name}" is not a valid ${kind}`);
    }
    if (kind === 'count' && !Number.isInteger(value)) return bad(`"${name}" is not a whole number`);
    return value;
  }
  return null;
}

function figures(row: Row): Omit<UsageSourceEntry, 'day' | 'model'> {
  return {
    inputTokens: pick(row, ['inputTokens'], 'count'),
    outputTokens: pick(row, ['outputTokens'], 'count'),
    cacheReadTokens: pick(row, ['cacheReadTokens', 'cachedInputTokens'], 'count'),
    cacheWriteTokens: pick(row, ['cacheCreationTokens', 'cacheWriteTokens'], 'count'),
    costUsd: pick(row, ['totalCost', 'costUSD', 'costUsd', 'cost'], 'money'),
  };
}

/** The per-model rows of a day: `modelBreakdowns` (a list) or `models` (an object by name). */
function breakdown(row: Row): { model: string; row: Row }[] {
  const list = row.modelBreakdowns;
  if (Array.isArray(list)) {
    return list.map((item: unknown) => {
      if (!isRow(item)) return bad('a model breakdown is not an object');
      const name = item.modelName ?? item.model;
      if (typeof name !== 'string' || name.length === 0) return bad('a model has no name');
      return { model: name, row: item };
    });
  }
  const models = row.models;
  if (isRow(models)) {
    return Object.entries(models).map(([model, item]) => {
      if (!isRow(item)) return bad('a model entry is not an object');
      return { model, row: item };
    });
  }
  return [];
}

/**
 * The entries of one `ccusage ... --json` output. An empty output is "no data" (`[]`) [N]; any
 * other thing that is not the shape above rejects with `AdapterUnavailable`, with no part of the
 * output in the message.
 */
export function parseCcusageOutput(text: string): UsageSourceEntry[] {
  if (text.trim().length === 0) return [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return bad('the output is not JSON');
  }
  const days = Array.isArray(root) ? root : isRow(root) ? root.daily : undefined;
  if (!Array.isArray(days)) return bad('no "daily" list');
  const entries: UsageSourceEntry[] = [];
  for (const item of days as unknown[]) {
    if (!isRow(item)) return bad('a day is not an object');
    const day = item.date;
    if (typeof day !== 'string' || !DAY.test(day)) return bad('a day has no valid "date"');
    const models = breakdown(item);
    if (models.length === 0) {
      entries.push({ day, model: null, ...figures(item) });
      continue;
    }
    for (const { model, row } of models) entries.push({ day, model, ...figures(row) });
  }
  return entries;
}

/** Whether `text` is a day as the port writes it (`YYYY-MM-DD`) that exists in the calendar. */
export function isCalendarDay(text: string): boolean {
  if (!DAY.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text;
}
