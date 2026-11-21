// SPDX-License-Identifier: MPL-2.0
import type { DaemonEventPayloads, DaemonEventType } from '@otheater/protocol';
import type { SituationCorrelation, SituationSink } from '../situations.js';

/** A situation as the fixture saw it. */
export interface RecordedSituation {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly correlation: SituationCorrelation;
}

/** A {@link SituationSink} that keeps what it was told, for the tests of the waits (P15). */
export class RecordingSituations implements SituationSink {
  readonly told: RecordedSituation[] = [];

  record<T extends DaemonEventType>(
    type: T,
    payload: DaemonEventPayloads[T],
    correlation: SituationCorrelation = {},
  ): void {
    this.told.push({ type, payload: { ...payload }, correlation });
  }

  /** The types told, in order. */
  get types(): string[] {
    return this.told.map((entry) => entry.type);
  }
}
