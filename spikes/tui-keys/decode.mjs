// Decodificador de teclas: bytes (string latin1/utf8) → nome legível. Sem dependências.
import { MAC_OPTION } from './map.mjs';

const SPECIAL = { A: '↑', B: '↓', C: '→', D: '←', H: 'Home', F: 'End', Z: 'Shift+Tab' };
const TILDE = { 1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End', 11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5', 17: 'F6', 18: 'F7', 19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12' };
const SS3 = { P: 'F1', Q: 'F2', R: 'F3', S: 'F4', A: '↑', B: '↓', C: '→', D: '←', H: 'Home', F: 'End' };

/** modificadores do xterm: valor = 1 + bits (1 shift, 2 alt, 4 ctrl, 8 meta/super) */
function mods(m) {
  const v = Math.max(0, (Number(m) || 1) - 1);
  const out = [];
  if (v & 4) out.push('Ctrl');
  if (v & 2) out.push('Alt');
  if (v & 1) out.push('Shift');
  if (v & 8) out.push('Super');
  return out;
}
const join = (m, k) => [...m, k].join('+');

function ctrlName(c) {
  if (c === 0x00) return 'Ctrl+Espaço';
  if (c === 0x09) return 'Tab';
  if (c === 0x0d) return 'Enter';
  if (c === 0x08) return 'Ctrl+H (ou Backspace)';
  if (c === 0x1b) return 'Esc';
  if (c >= 1 && c <= 26) return 'Ctrl+' + String.fromCharCode(64 + c);
  if (c === 0x7f) return 'Backspace';
  return null;
}

/** Decodifica UMA tecla (uma sequência completa). `s` é a string recebida (utf8). */
export function decode(s) {
  if (!s) return '(nada)';
  const chars = Array.from(s);
  if (chars.length === 1) {
    const c = s.codePointAt(0);
    if (c === 0x20) return 'Espaço';
    const n = ctrlName(c);
    if (n) return n;
    if (MAC_OPTION[s]) return MAC_OPTION[s];
    if (c >= 0x20) return s.length === 1 && /[a-z]/i.test(s) ? s : `"${s}"`;
    return `0x${c.toString(16)}`;
  }
  if (s[0] === '\x1b') {
    const rest = s.slice(1);
    if (rest[0] === '\x1b') return join(['Alt'], decode(rest)); // ESC ESC [ A = Alt+↑ em alguns terminais
    if (rest[0] === '[') {
      let m;
      // kitty / CSI u:  ESC [ code ; mods u
      if ((m = /^\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)?)?(?:;[\d:]+)?u$/.exec(rest))) {
        const code = Number(m[1]);
        const k = code === 13 ? 'Enter' : code === 9 ? 'Tab' : code === 27 ? 'Esc' : code === 127 ? 'Backspace' : code === 32 ? 'Espaço' : String.fromCodePoint(code).toUpperCase();
        return join(mods(m[2]), k) + ' [kitty CSI u]';
      }
      // xterm modifyOtherKeys: ESC [ 27 ; mods ; code ~
      if ((m = /^\[27;(\d+);(\d+)~$/.exec(rest))) {
        const code = Number(m[2]);
        const k = code === 13 ? 'Enter' : code === 9 ? 'Tab' : code === 32 ? 'Espaço' : String.fromCodePoint(code).toUpperCase();
        return join(mods(m[1]), k) + ' [modifyOtherKeys]';
      }
      if ((m = /^\[(?:1;(\d+))?([A-DHFZ])$/.exec(rest))) {
        const mm = mods(m[1]);
        if (m[2] === 'Z') return join(mm.filter((x) => x !== 'Shift'), 'Shift+Tab').replace(/^Shift\+Tab$/, 'Shift+Tab');
        return join(mm, SPECIAL[m[2]]);
      }
      if ((m = /^\[(\d+)(?:;(\d+))?~$/.exec(rest))) {
        const k = TILDE[m[1]];
        if (k) return join(mods(m[2]), k);
      }
      if ((m = /^\[(?:1;(\d+))?([PQRS])$/.exec(rest))) return join(mods(m[1]), SS3[m[2]]);
      if (/^\[\[[A-E]$/.test(rest)) return 'F' + (rest.charCodeAt(2) - 64) + ' [console Linux]';
      if (/^\[<\d+;\d+;\d+[Mm]$/.test(rest)) return 'mouse SGR';
      return `CSI desconhecida ${JSON.stringify(rest)}`;
    }
    if (rest[0] === 'O') {
      const m = /^O(?:1;(\d+))?([A-Z])$/.exec(rest) || /^O(\d)([A-Z])$/.exec(rest);
      if (m && SS3[m[2]]) return join(mods(m[1]), SS3[m[2]]);
      return `SS3 desconhecida ${JSON.stringify(rest)}`;
    }
    // ESC + caractere = Alt+caractere (Meta como prefixo ESC)
    if (Array.from(rest).length === 1) {
      const c = rest.codePointAt(0);
      const n = ctrlName(c);
      if (n && c !== 0x1b) return 'Alt+' + n.replace('Backspace', 'Backspace');
      return 'Alt+' + (/[a-z]/.test(rest) ? rest.toUpperCase() : rest === ' ' ? 'Espaço' : rest);
    }
  }
  return `sequência desconhecida`;
}

export const hex = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => b.toString(16).padStart(2, '0')).join(' ');
export const repr = (s) => s.replace(/[\x00-\x1f\x7f]/g, (c) => (c === '\x1b' ? '\\e' : c === '\r' ? '\\r' : c === '\n' ? '\\n' : c === '\t' ? '\\t' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')));
