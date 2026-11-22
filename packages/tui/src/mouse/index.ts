// SPDX-License-Identifier: MPL-2.0
export {
  MouseLayer,
  useCopyToClipboard,
  useMouseCopy,
  useSuspendTerminal,
  type MouseLayerProps,
} from './provider.js';
export {
  ClickTarget,
  MouseModalScope,
  useMouseTarget,
  type ClickTargetProps,
  type MouseTargetOptions,
  type MouseTargetState,
} from './target.js';
export type { DragInfo, LocalPoint, TargetHandlers } from './registry.js';
export type { Selection, SelectionRange } from './selection.js';
export type { CopyOutcome } from './clipboard.js';
export type { MouseTerminal } from './modes.js';
