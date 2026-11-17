// SPDX-License-Identifier: MPL-2.0

/** What stands where the value of a password field was. */
export const REDACTED = '[redacted]';

/** More valued text boxes than this are all redacted without looking: the check costs a round trip each. */
export const MAX_FIELD_CHECKS = 200;

/**
 * A line of the accessibility snapshot that is a text box:
 * `- textbox "Secret" [ref=f1e5]: hunter2`. The role of an `<input type=password>` is `textbox`, so
 * the line alone does not say which field is a password; {@link redactPasswordValues} asks.
 *
 * The grammar is strict on purpose: the name is a quoted string the PAGE writes (an `aria-label` can
 * say `[ref=x]`), so the `ref` is read only from the attributes AFTER the closing quote of the name.
 * Group 1: the line up to the value, 2: the attributes, 3: the value part (`: ...`), when there is one.
 */
const TEXTBOX_LINE =
  /^(\s*-\s+textbox(?:\s+"(?:[^"\\]|\\.)*")?((?:\s+\[[A-Za-z0-9_=.-]*\])*))(:.*)?$/;
const TEXTBOX_START = /^\s*-\s+textbox\b/;
const REF_ATTRIBUTE = /\[ref=([a-z0-9]+)\]/;

/**
 * Takes the value of every password field out of an accessibility snapshot (architecture 5.19:
 * "senhas nunca"). `isSecretField(ref)` says whether the element behind a `ref` is one; it must
 * answer `true` when it cannot tell (the caller fails closed). Fails closed here too: a text box line
 * that does not follow the grammar, or has no `ref`, loses its value; so do the fields past
 * {@link MAX_FIELD_CHECKS}. [V] The snapshot of Chromium 1248 does show the value of a password
 * input, so this step is needed.
 */
export async function redactPasswordValues(
  tree: string,
  isSecretField: (ref: string) => Promise<boolean>,
): Promise<{ tree: string; redacted: number }> {
  const lines = tree.split('\n');
  let checks = 0;
  let redacted = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!TEXTBOX_START.test(line)) continue;
    const match = TEXTBOX_LINE.exec(line);
    if (match === null) {
      // Not the shape we know: keep nothing of it but the role.
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      lines[index] = `${indent}- textbox: ${REDACTED}`;
      redacted += 1;
      continue;
    }
    const [, head, attributes, value] = match;
    if (value === undefined || head === undefined || value.slice(1).trim() === '') continue;
    const ref = REF_ATTRIBUTE.exec(attributes ?? '')?.[1];
    checks += 1;
    const secret = ref === undefined || checks > MAX_FIELD_CHECKS ? true : await isSecretField(ref);
    if (!secret) continue;
    lines[index] = `${head}: ${REDACTED}`;
    redacted += 1;
  }
  return { tree: lines.join('\n'), redacted };
}
