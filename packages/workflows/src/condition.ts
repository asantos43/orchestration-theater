// SPDX-License-Identifier: MPL-2.0
import {
  describeType,
  isEnumType,
  isListType,
  scalarKind,
  typeAtPath,
  type FieldType,
} from './field-types.js';

/**
 * The closed condition language of the edges (docs/24, §4; plan of Phase 11b, P1). [proposta]
 *
 * ```
 * expr       := or
 * or         := and ("or" and)*
 * and        := unary ("and" unary)*
 * unary      := "not" unary | "(" expr ")" | comparison
 * comparison := operand (op operand)?          op: == != < <= > >= in
 * operand    := path | string | number | true | false | null | list
 * path       := ("output" | "inputs") ("." name)*
 * list       := "[" (literal ("," literal)*)? "]"
 * ```
 *
 * There is no call, no loop, no arithmetic and no access outside `output` (the typed output of
 * the step the edge leaves) and `inputs` (the inputs of the run). A condition is data: it is parsed
 * once, checked against the types, and evaluated by walking the tree.
 */

export type ConditionRoot = 'output' | 'inputs';
export type ConditionLiteral = string | number | boolean | null;
export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';

export type ConditionOperand =
  | { readonly kind: 'path'; readonly root: ConditionRoot; readonly path: readonly string[] }
  | { readonly kind: 'literal'; readonly value: ConditionLiteral }
  | { readonly kind: 'list'; readonly items: readonly ConditionLiteral[] };

export type Condition =
  | { readonly kind: 'and'; readonly items: readonly Condition[] }
  | { readonly kind: 'or'; readonly items: readonly Condition[] }
  | { readonly kind: 'not'; readonly item: Condition }
  | {
      readonly kind: 'compare';
      readonly op: CompareOp;
      readonly left: ConditionOperand;
      readonly right: ConditionOperand;
    }
  /** A bare operand: a boolean path or `true`/`false`. */
  | { readonly kind: 'test'; readonly operand: ConditionOperand };

/**
 * The limits of one condition [proposta]: a condition is short; a long one is a sign of misuse.
 * The caller may pass others (the daemon takes them from its configuration).
 */
export interface ConditionLimits {
  readonly maxLength: number;
  readonly maxDepth: number;
}
export const DEFAULT_CONDITION_LIMITS: ConditionLimits = { maxLength: 500, maxDepth: 32 };

export class ConditionSyntaxError extends Error {
  constructor(
    message: string,
    /** Offset in the text, 0-based. */
    readonly position: number,
  ) {
    super(`${message} (at ${String(position + 1)})`);
    this.name = 'ConditionSyntaxError';
  }
}

type Token =
  | { readonly t: 'name'; readonly v: string; readonly at: number }
  | { readonly t: 'string'; readonly v: string; readonly at: number }
  | { readonly t: 'number'; readonly v: number; readonly at: number }
  | { readonly t: 'punct'; readonly v: string; readonly at: number }
  | { readonly t: 'end'; readonly at: number };

const PUNCT = ['==', '!=', '<=', '>=', '<', '>', '(', ')', '[', ']', ',', '.'] as const;
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'true', 'false', 'null']);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i] ?? '')) i += 1;
      tokens.push({ t: 'name', v: text.slice(start, i), at: start });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9]/.test(text[i] ?? '')) i += 1;
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
        i += 1;
        while (i < text.length && /[0-9]/.test(text[i] ?? '')) i += 1;
      }
      tokens.push({ t: 'number', v: Number(text.slice(start, i)), at: start });
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      let value = '';
      for (;;) {
        const ch = text[i];
        if (ch === undefined) throw new ConditionSyntaxError('unterminated string', start);
        if (ch === c) break;
        if (ch === '\\') {
          const next = text[i + 1];
          if (next !== c && next !== '\\') {
            throw new ConditionSyntaxError('only \\" , \\\' and \\\\ are escapes', i);
          }
          value += next;
          i += 2;
          continue;
        }
        value += ch;
        i += 1;
      }
      i += 1;
      tokens.push({ t: 'string', v: value, at: start });
      continue;
    }
    const punct = PUNCT.find((p) => text.startsWith(p, i));
    if (punct === undefined) throw new ConditionSyntaxError(`unexpected "${c}"`, i);
    tokens.push({ t: 'punct', v: punct, at: i });
    i += punct.length;
  }
  tokens.push({ t: 'end', at: text.length });
  return tokens;
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly maxDepth: number,
  ) {}

  parse(): Condition {
    const condition = this.or();
    const next = this.peek();
    if (next.t !== 'end') throw new ConditionSyntaxError('unexpected text', next.at);
    return condition;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { t: 'end', at: 0 };
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private isName(value: string): boolean {
    const token = this.peek();
    return token.t === 'name' && token.v === value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.t === 'punct' && token.v === value;
  }

  private expectPunct(value: string): void {
    const token = this.take();
    if (token.t !== 'punct' || token.v !== value) {
      throw new ConditionSyntaxError(`expected "${value}"`, token.at);
    }
  }

  private nest<T>(at: number, run: () => T): T {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      throw new ConditionSyntaxError(`nested deeper than ${String(this.maxDepth)}`, at);
    }
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }

  private or(): Condition {
    const items = [this.and()];
    while (this.isName('or')) {
      this.take();
      items.push(this.and());
    }
    return items.length === 1 && items[0] !== undefined ? items[0] : { kind: 'or', items };
  }

  private and(): Condition {
    const items = [this.unary()];
    while (this.isName('and')) {
      this.take();
      items.push(this.unary());
    }
    return items.length === 1 && items[0] !== undefined ? items[0] : { kind: 'and', items };
  }

  private unary(): Condition {
    const token = this.peek();
    if (this.isName('not')) {
      this.take();
      return this.nest(token.at, () => ({ kind: 'not', item: this.unary() }));
    }
    if (this.isPunct('(')) {
      this.take();
      const inner = this.nest(token.at, () => this.or());
      this.expectPunct(')');
      return inner;
    }
    return this.comparison();
  }

  private comparison(): Condition {
    const left = this.operand();
    const token = this.peek();
    let op: CompareOp | null = null;
    if (token.t === 'punct' && ['==', '!=', '<', '<=', '>', '>='].includes(token.v)) {
      op = token.v as CompareOp;
    } else if (this.isName('in')) {
      op = 'in';
    }
    if (op === null) return { kind: 'test', operand: left };
    this.take();
    return { kind: 'compare', op, left, right: this.operand() };
  }

  private literal(): ConditionLiteral {
    const token = this.take();
    if (token.t === 'string' || token.t === 'number') return token.v;
    if (token.t === 'name' && token.v === 'true') return true;
    if (token.t === 'name' && token.v === 'false') return false;
    if (token.t === 'name' && token.v === 'null') return null;
    throw new ConditionSyntaxError('expected a value', token.at);
  }

  private operand(): ConditionOperand {
    const token = this.peek();
    if (token.t === 'punct' && token.v === '[') {
      this.take();
      const items: ConditionLiteral[] = [];
      if (!this.isPunct(']')) {
        items.push(this.literal());
        while (this.isPunct(',')) {
          this.take();
          items.push(this.literal());
        }
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.t === 'name' && !KEYWORDS.has(token.v)) {
      this.take();
      if (token.v !== 'output' && token.v !== 'inputs') {
        throw new ConditionSyntaxError(
          `"${token.v}": a path starts with output or inputs`,
          token.at,
        );
      }
      const path: string[] = [];
      while (this.isPunct('.')) {
        this.take();
        const segment = this.take();
        if (segment.t !== 'name')
          throw new ConditionSyntaxError('expected a field name', segment.at);
        path.push(segment.v);
      }
      return { kind: 'path', root: token.v, path };
    }
    return { kind: 'literal', value: this.literal() };
  }
}

/** Parses a condition. Throws {@link ConditionSyntaxError} with the position. */
export function parseCondition(
  text: string,
  limits: ConditionLimits = DEFAULT_CONDITION_LIMITS,
): Condition {
  if (text.length > limits.maxLength) {
    throw new ConditionSyntaxError(`longer than ${String(limits.maxLength)} characters`, 0);
  }
  if (text.trim() === '') throw new ConditionSyntaxError('empty condition', 0);
  return new Parser(tokenize(text), limits.maxDepth).parse();
}

/** What a condition can read, by type. */
export interface ConditionScope<T> {
  readonly output: T;
  readonly inputs: T;
}

function literalKind(value: ConditionLiteral): 'string' | 'number' | 'boolean' | 'null' {
  if (value === null) return 'null';
  return typeof value as 'string' | 'number' | 'boolean';
}

function showPath(operand: { root: ConditionRoot; path: readonly string[] }): string {
  return [operand.root, ...operand.path].join('.');
}

type Resolved =
  | { readonly kind: 'type'; readonly type: FieldType; readonly label: string }
  | { readonly kind: 'literal'; readonly value: ConditionLiteral }
  | { readonly kind: 'list'; readonly items: readonly ConditionLiteral[] };

function literalFits(type: FieldType, value: ConditionLiteral): string | null {
  if (value === null) return null;
  const kind = scalarKind(type);
  if (kind === null) return `cannot compare ${describeType(type)} with a value`;
  if (kind === 'unknown') return 'a field of unknown type can only be compared with null';
  if (kind !== literalKind(value)) {
    return `${describeType(type)} compared with ${literalKind(value)} ${JSON.stringify(value)}`;
  }
  if (isEnumType(type) && !type.enum.includes(value as string)) {
    return `${JSON.stringify(value)} is not one of ${type.enum.join(', ')}`;
  }
  return null;
}

/**
 * Checks a condition against the types it reads. Returns the problems, empty when it is fine:
 * a path that does not exist, a comparison of different kinds, an enum value that is not in the
 * enum, an order (`<`) on something that is not a number, a bare path that is not a boolean.
 */
export function checkCondition(
  condition: Condition,
  scope: ConditionScope<FieldType>,
): readonly string[] {
  const problems: string[] = [];

  const resolve = (operand: ConditionOperand): Resolved | null => {
    if (operand.kind === 'literal') return { kind: 'literal', value: operand.value };
    if (operand.kind === 'list') return { kind: 'list', items: operand.items };
    const type = typeAtPath(scope[operand.root], operand.path);
    const label = showPath(operand);
    if (type === null) {
      problems.push(`${label} does not exist`);
      return null;
    }
    return { kind: 'type', type, label };
  };

  const visit = (node: Condition): void => {
    switch (node.kind) {
      case 'and':
      case 'or':
        node.items.forEach(visit);
        return;
      case 'not':
        visit(node.item);
        return;
      case 'test': {
        const operand = resolve(node.operand);
        if (operand === null) return;
        if (operand.kind === 'literal' && typeof operand.value === 'boolean') return;
        if (operand.kind === 'type' && operand.type === 'boolean') return;
        problems.push(
          operand.kind === 'type'
            ? `${operand.label} is ${describeType(operand.type)}, not boolean: compare it`
            : 'a bare value must be true or false',
        );
        return;
      }
      case 'compare': {
        const left = resolve(node.left);
        const right = resolve(node.right);
        if (left === null || right === null) return;
        if (left.kind === 'list') {
          problems.push('a list can only be on the right of in');
          return;
        }
        if (node.op === 'in') {
          if (left.kind === 'literal') {
            // `"bug" in output.labels`: a value in a list field.
            if (right.kind !== 'type') {
              problems.push('the left of in must be a field, or the right a list field');
              return;
            }
            if (!isListType(right.type)) {
              problems.push(`${right.label} is ${describeType(right.type)}, not a list`);
              return;
            }
            const problem = literalFits(right.type.list, left.value);
            if (problem !== null) problems.push(`${right.label}: ${problem}`);
            return;
          }
          if (right.kind === 'literal') {
            problems.push('the right of in must be a list');
            return;
          }
          if (right.kind === 'list') {
            for (const item of right.items) {
              const problem = literalFits(left.type, item);
              if (problem !== null) problems.push(`${left.label}: ${problem}`);
            }
            return;
          }
          if (!isListType(right.type)) {
            problems.push(`${right.label} is ${describeType(right.type)}, not a list`);
            return;
          }
          const a = scalarKind(left.type);
          const b = scalarKind(right.type.list);
          if (a === null || b === null || a !== b) {
            problems.push(
              `${left.label} (${describeType(left.type)}) in ${right.label} (${describeType(right.type)})`,
            );
          }
          return;
        }
        if (right.kind === 'list') {
          problems.push('a list can only be on the right of in');
          return;
        }
        if (left.kind === 'literal' && right.kind === 'literal') {
          problems.push('a comparison of two values is constant: compare a field');
          return;
        }
        const ordered = node.op !== '==' && node.op !== '!=';
        if (left.kind === 'type' && right.kind === 'type') {
          const a = scalarKind(left.type);
          const b = scalarKind(right.type);
          if (a === null || b === null || a === 'unknown' || b === 'unknown' || a !== b) {
            problems.push(
              `${left.label} (${describeType(left.type)}) ${node.op} ${right.label} (${describeType(right.type)})`,
            );
          } else if (ordered && a !== 'number') {
            problems.push(`${node.op} needs numbers`);
          }
          return;
        }
        const field = left.kind === 'type' ? left : (right as Extract<Resolved, { kind: 'type' }>);
        const value =
          left.kind === 'literal'
            ? left.value
            : (right as Extract<Resolved, { kind: 'literal' }>).value;
        if (ordered && (scalarKind(field.type) !== 'number' || typeof value !== 'number')) {
          problems.push(`${node.op} needs numbers (${field.label} is ${describeType(field.type)})`);
          return;
        }
        const problem = literalFits(field.type, value);
        if (problem !== null) problems.push(`${field.label}: ${problem}`);
        return;
      }
    }
  };

  visit(condition);
  return problems;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
    if (!Object.hasOwn(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

/**
 * Evaluates a condition over the actual values. A missing field reads as `null`; a comparison of
 * different kinds is `false` (the validator already refused it for typed outputs); a bare path is
 * true only for `true`.
 */
export function evaluateCondition(condition: Condition, scope: ConditionScope<unknown>): boolean {
  const read = (operand: ConditionOperand): unknown => {
    if (operand.kind === 'literal') return operand.value;
    if (operand.kind === 'list') return operand.items;
    return valueAt(scope[operand.root], operand.path);
  };
  switch (condition.kind) {
    case 'and':
      return condition.items.every((item) => evaluateCondition(item, scope));
    case 'or':
      return condition.items.some((item) => evaluateCondition(item, scope));
    case 'not':
      return !evaluateCondition(condition.item, scope);
    case 'test':
      return read(condition.operand) === true;
    case 'compare': {
      const left = read(condition.left);
      const right = read(condition.right);
      switch (condition.op) {
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case 'in':
          return Array.isArray(right) && right.includes(left);
        default:
          if (typeof left !== 'number' || typeof right !== 'number') return false;
          if (condition.op === '<') return left < right;
          if (condition.op === '<=') return left <= right;
          if (condition.op === '>') return left > right;
          return left >= right;
      }
    }
  }
}
