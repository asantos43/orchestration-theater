// SPDX-License-Identifier: MPL-2.0

/**
 * Text measured in terminal cells, for the layout that draws to the column. The measure is
 * code-owned (no dependency): a combining mark and a zero-width character take no cell, a wide
 * East Asian character and an emoji take two, and everything else takes one. The characters of the
 * frame and of the bars (`█ ░ ━ ▾ ◂ ✓ ●`) are narrow.
 */

function isZeroWidth(code: number): boolean {
  return (
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0xfeff ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Cells one character takes (`0`, `1` or `2`). */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (isZeroWidth(code)) return 0;
  return isWide(code) ? 2 : 1;
}

/** Cells `text` takes on one line. */
export function cellWidth(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char);
  return total;
}

/** The start of `text` that fits in `width` cells (no ellipsis). */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  let used = 0;
  let out = '';
  for (const char of text) {
    const next = charWidth(char);
    if (used + next > width) break;
    used += next;
    out += char;
  }
  return out;
}

/** `text` in exactly `width` cells: cut with an ellipsis when longer, padded on the right when shorter. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const size = cellWidth(text);
  if (size === width) return text;
  if (size < width) return text + ' '.repeat(width - size);
  const head = clip(text, width - 1);
  return head + '…' + ' '.repeat(Math.max(0, width - 1 - cellWidth(head)));
}

/** `text` in exactly `width` cells, aligned to the right (cut at the start of the text when longer). */
export function fitRight(text: string, width: number): string {
  if (width <= 0) return '';
  const size = cellWidth(text);
  if (size >= width) return clip(text, width);
  return ' '.repeat(width - size) + text;
}

/** Breaks `text` into lines of at most `width` cells, at spaces where it can and inside a word where it must. */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      let rest = word;
      if (line === '') {
        // First word of the line.
      } else if (cellWidth(line) + 1 + cellWidth(rest) <= limit) {
        line += ' ' + rest;
        continue;
      } else {
        lines.push(line);
      }
      while (cellWidth(rest) > limit) {
        const head = clip(rest, limit);
        lines.push(head);
        rest = rest.slice(head.length);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}
