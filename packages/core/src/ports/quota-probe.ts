// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import type { Disposable } from '../disposable.js';
import type { Adapter } from './adapter.js';
import type { ProfileRef } from './executor.js';

/** Semver of the `QuotaProbe` port contract (architecture 5.18, "Versão dos contratos"). */
export const QUOTA_PROBE_PORT_VERSION = '0.1.0';

/**
 * One quota window of a profile. [proposta] The window name is a free string (`5h`, `7d`,
 * `primary`...) as in the `QuotaSignal` of `@otheater/protocol`; `resetsAt` is epoch ms (integer),
 * like the `Clock`, where the wire signal still carries text.
 */
export const QuotaWindowSchema = z.strictObject({
  window: z.string().min(1),
  usedPercent: z.number().min(0),
  resetsAt: z.int().min(0).optional(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/**
 * What a probe read, "validated by zod" (architecture 5.18). `QuotaReading` is not defined in the
 * architecture text: this shape is a [proposta]. The freshness rule (an old reading never
 * authorizes a route, 5.6) is the `QuotaService`'s, which is why `observedAt` is here.
 */
export const QuotaReadingSchema = z.strictObject({
  /** When the probe saw it, epoch ms. */
  observedAt: z.int().min(0),
  windows: z.array(QuotaWindowSchema),
  planType: z.string().min(1).optional(),
});
export type QuotaReading = z.infer<typeof QuotaReadingSchema>;

export const QUOTA_DELIVERIES = ['push', 'poll', 'both'] as const;
export const QUOTA_PRECISIONS = ['exact', 'approximate'] as const;

/** What a probe can tell (architecture 5.18): windows, push or polling, precision. */
export interface QuotaCapabilities {
  /** Window names the probe reports. */
  readonly windows: readonly string[];
  /** `push`: `watch` works. `poll`: only `read`. */
  readonly delivery: (typeof QUOTA_DELIVERIES)[number];
  readonly precision: (typeof QUOTA_PRECISIONS)[number];
}

/**
 * Reads the quota of a profile outside any conversation (architecture 5.6, 5.18). Each client
 * adapter offers one (its `quota` member); the daemon's `QuotaService` calls it.
 *
 * Contract:
 * - `read` resolves a reading that passes {@link QuotaReadingSchema}, or rejects with
 *   `AdapterUnavailable` (no source for this profile yet, for example the Claude statusline before
 *   the first reply) or `Transient`.
 * - `watch` is optional by the architecture's own text (`watch?`); it is the one optional method
 *   in a port. Without it, the service polls `read`. `dispose()` stops the watching.
 *
 * Dependency note: the quota SIGNAL schemas live in `@otheater/protocol`, which core cannot
 * import. The reading schema above is defined here, in core, for that reason.
 */
export interface QuotaProbe extends Adapter {
  capabilities(): QuotaCapabilities;
  read(profile: ProfileRef): Promise<QuotaReading>;
  watch?(profile: ProfileRef, onChange: (reading: QuotaReading) => void): Disposable;
}
