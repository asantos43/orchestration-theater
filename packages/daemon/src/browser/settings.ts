// SPDX-License-Identifier: MPL-2.0
import type { BrowserProfileMode, ScenarioRecord, Store } from '@otheater/core';
import { z } from 'zod';
import {
  BROWSER_DOMAIN_MODES,
  BROWSER_FALLBACK_MODES,
  BROWSER_FILE_URL_MODES,
  BROWSER_LOCAL_URL_MODES,
  BROWSER_PROFILE_CONFIG_MODES,
  BROWSER_SCREENSHOT_MODES,
  BROWSER_WRITE_APPROVAL_MODES,
  BrowserConfigSchema,
  type BrowserConfig,
} from '../config.js';
import { ToolFailure } from '../mcp/handlers.js';
import { ToolRefusal } from '../tools/context.js';
import { blockOverrideOf, mergeDeep, type Plain } from '../tools/settings.js';

/**
 * What a project or a scenario may override of `browser` (architecture 5.19, N40). Only the keys
 * about what the AGENT may do: the machine's own keys (`timeout_ms`, `min_free_memory_mb`,
 * `max_instances`, `sandbox`, `executable_path`, `idle_close_ms`) are the owner's, global only, and a
 * scenario that names one is refused like any unknown key.
 */
export const BrowserOverrideSchema = z.strictObject({
  profile: z.enum(BROWSER_PROFILE_CONFIG_MODES).optional(),
  fallback: z.enum(BROWSER_FALLBACK_MODES).optional(),
  domains: z.enum(BROWSER_DOMAIN_MODES).optional(),
  blocked_domains: z.array(z.string().min(1)).optional(),
  local_urls: z.enum(BROWSER_LOCAL_URL_MODES).optional(),
  file_urls: z.enum(BROWSER_FILE_URL_MODES).optional(),
  write_approval: z.enum(BROWSER_WRITE_APPROVAL_MODES).optional(),
  action_screenshots: z.enum(BROWSER_SCREENSHOT_MODES).optional(),
  read_max_chars: z.int().min(1).optional(),
});
export type BrowserOverride = z.infer<typeof BrowserOverrideSchema>;

/** The `browser` part of a `configOverride`, validated (same two spellings as `tools`). */
export function browserOverrideOf(
  configOverride: Parameters<typeof blockOverrideOf>[0],
): BrowserOverride {
  const parsed = BrowserOverrideSchema.safeParse(blockOverrideOf(configOverride, 'browser'));
  if (!parsed.success) {
    throw new ToolFailure(
      'invalid_config',
      `The "browser" override of the scenario is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** The settings of one browser call. */
export interface BrowserSettings {
  readonly config: BrowserConfig;
  /** The scenario of the call: whose page it is, and whose folders `file_urls: scenario` allows. */
  readonly scenario: ScenarioRecord;
  /** The play of the call, for the key of its side effects. */
  readonly playId: string;
}

export type BrowserSettingsStore = Pick<Store, 'plays' | 'scenarios' | 'attempts'>;

/**
 * The settings in force for one call, as `resolveToolSettings` does for `tools`: the global block,
 * then the `configOverride` of the scenario the call's scenario was promoted from, then the
 * call's own. A call with no scenario is refused (`no_scenario`): the page belongs to one. An
 * override that does not validate refuses the call (`invalid_config`): a broken rule never falls
 * back to a wider one.
 */
export async function resolveBrowserSettings(
  base: BrowserConfig,
  store: BrowserSettingsStore,
  attemptId: string,
  playId: string | undefined,
): Promise<BrowserSettings> {
  const effectivePlayId = playId ?? (await store.attempts.get(attemptId))?.playId;
  const play = effectivePlayId === undefined ? undefined : await store.plays.get(effectivePlayId);
  const own = play === undefined ? undefined : await store.scenarios.get(play.scenarioId);
  if (play === undefined || own === undefined) {
    throw new ToolFailure(
      'no_scenario',
      'The browser belongs to a scenario, and this session is not tied to one.',
    );
  }
  const origin =
    own.originScenarioId === null ? undefined : await store.scenarios.get(own.originScenarioId);
  let merged: Plain = base;
  for (const scenario of [origin, own]) {
    if (scenario === undefined) continue;
    merged = mergeDeep(merged, browserOverrideOf(scenario.configOverride));
  }
  const checked = BrowserConfigSchema.safeParse(merged);
  if (!checked.success) {
    throw new ToolFailure(
      'invalid_config',
      `The "browser" settings of this scenario are invalid: ${z.prettifyError(checked.error)}`,
    );
  }
  return { config: checked.data, scenario: own, playId: play.id };
}

/**
 * The profile a call runs in. `shared` and `per_scenario` are the adapter's. `extension` is the
 * Producer's own browser (Phase 12): until an adapter for it exists it falls to `browser.fallback`
 * (N40, [proposta]): `shared` (default) runs in the shared profile; `wait` and `fail` both refuse,
 * because nothing can connect in this phase, so waiting would only be a slow refusal. `import`
 * (Phase 12) is refused.
 */
export function effectiveProfile(
  config: Pick<BrowserConfig, 'profile' | 'fallback'>,
): BrowserProfileMode {
  switch (config.profile) {
    case 'shared':
    case 'per_scenario':
      return config.profile;
    case 'import':
      throw new ToolRefusal(
        'profile_unavailable',
        'browser.profile "import" needs the browser extension (Phase 12) and is not available yet.',
      );
    case 'extension':
      if (config.fallback === 'shared') return 'shared';
      throw new ToolRefusal(
        'profile_unavailable',
        `browser.profile "extension" needs the browser extension (Phase 12), which is not connected, and browser.fallback is "${config.fallback}". Set browser.profile to "shared" or "per_scenario", or browser.fallback to "shared".`,
      );
  }
}
