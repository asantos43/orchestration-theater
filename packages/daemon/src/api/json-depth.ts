// SPDX-License-Identifier: MPL-2.0

/**
 * Whether the JSON `text` nests arrays and objects deeper than `max` levels. One pass over the text,
 * with no recursion and no allocation: it runs BEFORE the parse, so a body of a million `[` never
 * reaches `JSON.parse`, the schemas or `JSON.stringify` (which overflow the stack on it and turn a
 * request that is the client's fault into a 500). Brackets inside strings do not count. A text that
 * is not valid JSON is not this function's business: the parse says so.
 */
export function jsonDepthExceeds(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charCodeAt(at);
    if (inString) {
      if (char === 0x5c) at += 1; // a backslash: the next character is escaped
      else if (char === 0x22) inString = false;
    } else if (char === 0x22) {
      inString = true;
    } else if (char === 0x5b || char === 0x7b) {
      depth += 1;
      if (depth > max) return true;
    } else if ((char === 0x5d || char === 0x7d) && depth > 0) {
      depth -= 1;
    }
  }
  return false;
}
