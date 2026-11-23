// SPDX-License-Identifier: MPL-2.0

export { TOKEN } from './palette.js';

/** `color` and `backgroundColor` as props, leaving out what is not set (Ink does not take `undefined`). */
export function paint(
  color?: string,
  background?: string,
): { color?: string; backgroundColor?: string } {
  return {
    ...(color === undefined ? {} : { color }),
    ...(background === undefined ? {} : { backgroundColor: background }),
  };
}
