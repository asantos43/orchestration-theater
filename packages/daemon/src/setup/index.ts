// SPDX-License-Identifier: MPL-2.0
export { SetupService, type SetupServiceOptions } from './service.js';
export { buildPlan, type PlanApply, type PlanInput, type PlanResult } from './plan.js';
export { discoverForPreset, presetHeads } from './discover.js';
export {
  confirmAccounts,
  detectClients,
  detectedProfileOf,
  detectProfiles,
  type InstalledClients,
} from './detect.js';
