// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope } from '@otheater/core';
import { isFinalPlayState, type AtifExportTrigger } from '@otheater/protocol';
import type { EventHub } from '../events/event-hub.js';
import type { Logger } from '../logger.js';
import type { AtifSettings } from './atif-config.js';
import type { AtifExporter } from './atif-exporter.js';

/** The events that end an attempt (`atif.export.on: attempt_end`). */
const ATTEMPT_END_EVENTS: ReadonlySet<string> = new Set([
  'attempt.submitted',
  'attempt.cancelled',
  'attempt.aborted',
]);

export interface AtifAutoExportDeps {
  readonly hub: Pick<EventHub, 'follow'>;
  readonly exporter: Pick<AtifExporter, 'export'>;
  readonly settings: () => AtifSettings;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * The automatic export (Phase 8, P5; N219). [proposta] It follows the log from now on, and at the
 * end of a play (`play.transitioned` to `DONE` or `CANCELLED`) or of an attempt writes the files
 * `atif.export.on` asks for; with `manual` it is not started at all. The exports run one at a
 * time, in the order of the log. A failed export is already an `atif.export_failed` event, so it
 * is only noticed here and never stops the loop, and never touches the play.
 */
export class AtifAutoExport {
  readonly #deps: AtifAutoExportDeps;
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;

  constructor(deps: AtifAutoExportDeps) {
    this.#deps = deps;
  }

  /** Begins to follow; a second call does nothing. */
  start(): void {
    if (this.#loop !== undefined) return;
    this.#loop = this.#run();
  }

  /** Ends the loop and waits for the export in progress. */
  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
  }

  async #run(): Promise<void> {
    try {
      for await (const event of this.#deps.hub.follow({
        filter: { typePrefixes: ['play.', 'attempt.'] },
        signal: this.#abort.signal,
      })) {
        await this.#handle(event);
      }
    } catch (error) {
      if (!this.#abort.signal.aborted) {
        this.#deps.logger.warn({ err: error }, 'the automatic ATIF export stopped');
      }
    }
  }

  async #handle(event: EventEnvelope): Promise<void> {
    const { playId, attemptId } = event;
    if (playId === undefined) return;
    const on: AtifExportTrigger = this.#deps.settings().on;
    try {
      if (on === 'play_end' && event.type === 'play.transitioned') {
        const to = (event.payload as { readonly to?: unknown } | null)?.to;
        if (typeof to === 'string' && isFinalPlayState(to)) {
          await this.#deps.exporter.export(playId, { on });
        }
      } else if (on === 'attempt_end' && ATTEMPT_END_EVENTS.has(event.type)) {
        if (attemptId !== undefined) await this.#deps.exporter.export(playId, { on, attemptId });
      }
    } catch (error) {
      // Already written as `atif.export_failed`; the log of the daemon only needs the line.
      this.#deps.logger.warn({ err: error, playId }, 'the automatic ATIF export failed');
    }
  }
}
