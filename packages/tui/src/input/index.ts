// SPDX-License-Identifier: MPL-2.0
// The text box of the Producer (N35; P10 of docs/18). P12 puts `TextBox` in the layout.
export { TextBox, type TextBoxProps } from './text-box.js';
export { KeyFeed, KeyFeedProvider, useFeedInput, type KeyListener } from './key-feed.js';
export {
  bindAttachments,
  draftsInText,
  markerFor,
  type AttachmentDraft,
  type BoundMessage,
  type ProducerMessage,
} from './attachments.js';
export {
  FileHistoryStore,
  MemoryHistoryStore,
  inputHistoryFile,
  type HistoryStore,
} from './history.js';
export { createBoxPorts, type BoxPorts } from './ports.js';
export { DEFAULT_INPUT_SETTINGS, parseInputSettings, type InputSettings } from './settings.js';
