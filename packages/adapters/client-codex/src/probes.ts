// SPDX-License-Identifier: MPL-2.0
import {
  PermissionDenied,
  type ConformanceProbe,
  type ExecutorConfig,
  type ProbeContext,
} from '@otheater/core';
import { VETOED_MODES, type ModePolicy } from './modes.js';

/**
 * Opens a fresh session through the adapter, reads the mode the client reports for it once the
 * adapter has pinned it, closes the session, and returns the mode id (`undefined`: the client did
 * not say). The composition root supplies it, because a probe has no transport of its own and this
 * package never starts a real client by itself.
 */
export type ReadSessionMode = (context: ProbeContext) => Promise<string | undefined>;

export const PINNED_MODE_PROBE_ID = 'codex-pinned-mode';
export const MODE_VETO_PROBE_ID = 'codex-mode-veto';

/**
 * Own probe of Codex: the session mode is the one pinned right after `session/new`. `codex-acp`
 * creates sessions in `agent` and returns them to it after `session/load` (Phase 0, items 2 and
 * 6) [V], so if the pin did not take, the session would run in a mode that asks nothing.
 */
export function pinnedModeProbe(
  modes: ModePolicy,
  read: ReadSessionMode | undefined,
): ConformanceProbe {
  return {
    id: PINNED_MODE_PROBE_ID,
    async run(context) {
      if (read === undefined) {
        return { ok: false, detail: 'no way to read the mode of a session was configured' };
      }
      const mode = await read(context);
      if (mode === modes.initial) return { ok: true, detail: `the session is in ${mode}` };
      return {
        ok: false,
        detail: `the session is in ${mode ?? 'an unknown mode'}, not in ${modes.initial}`,
      };
    },
  };
}

/**
 * The veto of `agent` and `agent-full-access` (and of any mode off the allow-list): the adapter
 * must refuse to map them to a config option, which it does through the veto hook of the base
 * (`configOptionsFor`). Local, it needs no client.
 */
export function modeVetoProbe(
  modes: ModePolicy,
  configOptionsFor: (want: ExecutorConfig) => Record<string, string>,
): ConformanceProbe {
  return {
    id: MODE_VETO_PROBE_ID,
    run() {
      const accepted: string[] = [];
      for (const mode of [...VETOED_MODES, '__not-a-mode__']) {
        try {
          configOptionsFor({ model: 'probe', mode });
          accepted.push(mode);
        } catch (error) {
          if (!(error instanceof PermissionDenied)) throw error;
        }
      }
      return Promise.resolve(
        accepted.length === 0
          ? { ok: true, detail: `only ${modes.allowed.join(', ')} can be selected` }
          : { ok: false, detail: `the adapter accepted the mode ${accepted.join(', ')}` },
      );
    },
  };
}
