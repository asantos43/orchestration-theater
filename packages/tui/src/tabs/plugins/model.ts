// SPDX-License-Identifier: MPL-2.0
import type {
  ApiPanelBlock,
  ApiPlugin,
  ApiPluginDetail,
  ApiPluginPanel,
  PluginActionResult,
} from '@otheater/protocol';
import { cellWidth, fit, wrapText } from '../../layout/text.js';

/**
 * What the tab Plugins turns data into (P11 of Phase 9), with no screen in it: the state of a
 * plugin in a project, the lines of a panel block and of an action result, and the secrets to
 * show. Everything a plugin sends is untrusted text for the terminal of the Producer, so every
 * string that came from it goes through {@link safeText} before it is drawn, and a block the
 * screen cannot read becomes a line that says so, never an exception.
 */

/** The `t` of i18next as the model uses it. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The sections of the tab, in the order they are drawn. The ids name the tab, so no other tab shares one. */
export const SECTION_IDS = ['plugins.installed', 'plugins.detail', 'plugins.panel'] as const;
export type PluginsSection = (typeof SECTION_IDS)[number];

// ---- Text of a plugin ------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- the escape character is what the sequences start with
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./gu;
// eslint-disable-next-line no-control-regex -- every control character goes, the line breaks and the tab turn into spaces first
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * `text` as one line the terminal may draw: the escape sequences and the control characters of a
 * plugin do not reach the screen, and a line break or a tab is a space.
 */
export function safeText(text: string): string {
  return text
    .replaceAll(ESCAPES, '')
    .replaceAll(/[\n\r\t]+/gu, ' ')
    .replaceAll(CONTROLS, '')
    .replaceAll(/ {2,}/gu, ' ')
    .trim();
}

/** A JSON value of a cell as one line of text (`null` is empty, an object is its compact JSON). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return safeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return safeText(JSON.stringify(value));
  } catch {
    return '';
  }
}

// ---- State of a plugin in a project --------------------------------------------------------------------

/** `off`: installed and not on in the project (or no project is selected). */
export type PluginViewState = 'active' | 'needs_approval' | 'broken' | 'off';

export function stateOf(plugin: ApiPlugin, project: string | undefined): PluginViewState {
  if (plugin.problem !== null) return 'broken';
  if (project === undefined) return 'off';
  return plugin.projects.find((entry) => entry.project === project)?.state ?? 'off';
}

// ---- The panel ---------------------------------------------------------------------------------------------

/**
 * What the daemon's answer holds in place of a block this screen cannot read (an unknown type, a
 * shape that does not fit): the client keeps it where the block was, and the screen says so. Compared
 * by identity.
 */
export const UNREADABLE_BLOCK: ApiPanelBlock = Object.freeze({
  type: 'action',
  label: '',
  tool: '',
  approval: 'none',
});

export type PanelTone = 'title' | 'head' | 'text' | 'dim' | 'warn' | 'error' | 'action';

/** One line of the panel as drawn (before the wrap); `action` is the index in {@link PanelView.actions}. */
export interface PanelLine {
  readonly tone: PanelTone;
  readonly text: string;
  readonly action?: number | undefined;
}

export interface PanelAction {
  readonly label: string;
  readonly tool: string;
  readonly approval: 'none' | 'manifest' | 'policy';
}

export interface PanelView {
  readonly lines: readonly PanelLine[];
  /** The action blocks, in the order they appear: the ones the Producer may run with a key. */
  readonly actions: readonly PanelAction[];
}

const COLUMN_GAP = 2;
const MIN_COLUMN = 4;

/** Widths for the columns: the natural ones, narrowed from the widest down until the row fits. */
export function columnWidths(natural: readonly number[], available: number): number[] {
  const widths = natural.map((width) => Math.max(1, width));
  const gaps = COLUMN_GAP * Math.max(0, widths.length - 1);
  let total = widths.reduce((sum, width) => sum + width, 0) + gaps;
  while (total > available) {
    let widest = 0;
    widths.forEach((width, index) => {
      if (width > (widths[widest] ?? 0)) widest = index;
    });
    const current = widths[widest] ?? 0;
    if (current <= Math.min(MIN_COLUMN, 1 + Math.floor(available / Math.max(1, widths.length)))) {
      break;
    }
    widths[widest] = current - 1;
    total -= 1;
  }
  return widths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorLines(
  block: { source: string; error: { code: string; message: string } },
  t: Translate,
): PanelLine[] {
  const code = t(`plugins.errorCode.${block.error.code}`, { defaultValue: block.error.code });
  return [
    {
      tone: 'warn',
      text: t('plugins.block.error', {
        source: safeText(block.source),
        code,
        message: safeText(block.error.message),
      }),
    },
  ];
}

function truncatedLine(
  truncated: { reason: string; total: number; kept: number; limit: number } | null,
  t: Translate,
): PanelLine[] {
  if (truncated === null) return [];
  return [
    {
      tone: 'dim',
      text: t(truncated.reason === 'bytes' ? 'plugins.block.cutBytes' : 'plugins.block.cutRows', {
        kept: truncated.kept,
        total: truncated.total,
        limit: truncated.limit,
      }),
    },
  ];
}

/** The lines of one block, with the width the table has to fit in. Never throws. */
function blockLines(
  block: ApiPanelBlock,
  width: number,
  t: Translate,
  actions: PanelAction[],
): PanelLine[] {
  if (block === UNREADABLE_BLOCK || !isRecord(block)) {
    return [{ tone: 'warn', text: t('plugins.block.unreadable') }];
  }
  switch (block.type) {
    case 'action': {
      const index = actions.length;
      actions.push({
        label: safeText(block.label),
        tool: safeText(block.tool),
        approval: block.approval,
      });
      return [{ tone: 'action', text: '', action: index }];
    }
    case 'table': {
      const out: PanelLine[] = [{ tone: 'title', text: safeText(block.title) }];
      if (block.error !== null) return [...out, ...errorLines({ ...block, error: block.error }, t)];
      if (block.columns.length === 0) {
        return [...out, { tone: 'dim', text: t('plugins.block.noColumns') }];
      }
      const labels = block.columns.map((column) => safeText(column.label));
      const cells = block.rows.map((row) =>
        block.columns.map((column) => cellText(row[column.key])),
      );
      const natural = block.columns.map((_, index) =>
        Math.max(
          cellWidth(labels[index] ?? ''),
          ...cells.map((row) => cellWidth(row[index] ?? '')),
        ),
      );
      const widths = columnWidths(natural, Math.max(1, width));
      const draw = (values: readonly string[]): string =>
        values
          .map((value, index) => fit(value, widths[index] ?? 1))
          .join(' '.repeat(COLUMN_GAP))
          .trimEnd();
      out.push({ tone: 'head', text: draw(labels) });
      if (cells.length === 0) out.push({ tone: 'dim', text: t('plugins.block.empty') });
      for (const row of cells) out.push({ tone: 'text', text: draw(row) });
      return [...out, ...truncatedLine(block.truncated, t)];
    }
    case 'list': {
      const out: PanelLine[] = [{ tone: 'title', text: safeText(block.title) }];
      if (block.error !== null) return [...out, ...errorLines({ ...block, error: block.error }, t)];
      if (block.items.length === 0) out.push({ tone: 'dim', text: t('plugins.block.empty') });
      for (const item of block.items) out.push({ tone: 'text', text: `• ${cellText(item)}` });
      return [...out, ...truncatedLine(block.truncated, t)];
    }
    case 'metrics': {
      const out: PanelLine[] = [{ tone: 'title', text: safeText(block.title) }];
      if (block.error !== null) return [...out, ...errorLines({ ...block, error: block.error }, t)];
      if (block.metrics.length === 0) out.push({ tone: 'dim', text: t('plugins.block.empty') });
      for (const metric of block.metrics) {
        out.push({ tone: 'text', text: `${safeText(metric.key)}: ${cellText(metric.value)}` });
      }
      return [...out, ...truncatedLine(block.truncated, t)];
    }
    default:
      return [{ tone: 'warn', text: t('plugins.block.unreadable') }];
  }
}

/**
 * The lines of the panel of a plugin and its action blocks. A block that fails to turn into lines
 * (a shape the contract did not catch) becomes the "unreadable" line, and the rest is drawn.
 */
export function panelView(
  panel: Pick<ApiPluginPanel, 'blocks'>,
  width: number,
  t: Translate,
): PanelView {
  const lines: PanelLine[] = [];
  const actions: PanelAction[] = [];
  for (const block of panel.blocks) {
    const mark = actions.length;
    try {
      lines.push(...blockLines(block, width, t, actions));
    } catch {
      actions.length = mark;
      lines.push({ tone: 'warn', text: t('plugins.block.unreadable') });
    }
  }
  if (panel.blocks.length === 0) lines.push({ tone: 'dim', text: t('plugins.panel.noBlocks') });
  return { lines, actions };
}

// ---- Action result -------------------------------------------------------------------------------------------

/** Longest answer of an action drawn, in characters; the rest is cut with an ellipsis. [proposta] */
export const RESULT_TEXT_MAX = 300;

/** What an action answered, as lines with their tone (`error` when it failed, `ok` text otherwise). */
export function actionResultLines(
  label: string,
  result: PluginActionResult,
  t: Translate,
): { tone: 'ok' | 'warn' | 'error'; text: string }[] {
  const name = safeText(label);
  if (!result.ok) {
    const code =
      result.error === null
        ? ''
        : t(`plugins.errorCode.${result.error.code}`, {
            defaultValue: result.error.code,
          });
    const message = result.error === null ? '' : safeText(result.error.message);
    return [{ tone: 'error', text: t('plugins.action.failed', { action: name, code, message }) }];
  }
  const out: { tone: 'ok' | 'warn' | 'error'; text: string }[] = [];
  if (result.truncated !== null) {
    out.push({ tone: 'warn', text: t('plugins.action.tooBig', { action: name }) });
    return out;
  }
  const text = cellText(result.result);
  const shown = text.length > RESULT_TEXT_MAX ? `${text.slice(0, RESULT_TEXT_MAX - 1)}…` : text;
  out.push({
    tone: 'ok',
    text:
      shown === ''
        ? t('plugins.action.done', { action: name })
        : t('plugins.action.doneWith', { action: name, result: shown }),
  });
  return out;
}

// ---- Secrets -------------------------------------------------------------------------------------------------------

/** The command that sets a secret in the vault; there is no route to do it from the screen. */
export function secretCommand(pluginId: string, name: string, project: string | undefined): string {
  return `ot plugin secret set ${pluginId} ${name}${project === undefined ? '' : ` --project ${project}`}`;
}

export interface SecretRow {
  readonly name: string;
  /** `true` when a `plugin.secret_missing` event named it since the plugin was last turned on. */
  readonly missing: boolean;
}

/** The secrets the manifest declares plus the ones an event named, each once, with the missing ones first. */
export function secretRows(
  detail: Pick<ApiPluginDetail, 'summary'> | undefined,
  missing: readonly string[],
): SecretRow[] {
  const names = new Set<string>([...(detail?.summary.secrets ?? []), ...missing]);
  const gone = new Set(missing);
  return [...names]
    .map((name) => ({ name, missing: gone.has(name) }))
    .sort((a, b) => Number(b.missing) - Number(a.missing) || a.name.localeCompare(b.name));
}

/** The names a `plugin.secret_missing` payload carries, or none when the payload is not that shape. */
export function missingSecretsOf(
  payload: unknown,
): { plugin: string; project: string; secrets: string[] } | undefined {
  if (!isRecord(payload)) return undefined;
  const { plugin, project, secrets } = payload;
  if (typeof plugin !== 'string' || typeof project !== 'string' || !Array.isArray(secrets)) {
    return undefined;
  }
  return {
    plugin,
    project,
    secrets: secrets.filter(
      (name): name is string => typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name),
    ),
  };
}

// ---- Wrapping the lines of the activation ----------------------------------------------------------------------

/** The lines of the activation text of the daemon, each wrapped to `width` (none is cut). */
export function activationRows(
  detail: Pick<ApiPluginDetail, 'activation'>,
  width: number,
): string[] {
  return detail.activation.flatMap((line) => wrapText(safeText(line), Math.max(1, width)));
}
