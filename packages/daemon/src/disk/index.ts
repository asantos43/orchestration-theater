// SPDX-License-Identifier: MPL-2.0
export { DiskGuard, isDiskFull } from './guard.js';
export type {
  DiskArea,
  DiskGuardLogger,
  DiskGuardOptions,
  DiskNoticeKind,
  DiskState,
  DiskStatus,
} from './guard.js';
export { freeBytesOf, sizeText } from './free-space.js';
export {
  DEFAULT_DISK_CHECK_EVERY,
  DEFAULT_DISK_MIN_FREE,
  DISK_NOTIFY_MODES,
  DISK_ON_FULL_MODES,
  diskSettingsOf,
  type DiskNotify,
  type DiskOnFull,
  type DiskSettings,
} from './settings.js';
