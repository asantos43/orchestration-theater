// Mapa de teclas da seção 5.13 da arquitetura (v0.32) + teclas auxiliares da TUI.
// `esperado`: nomes decodificados que contam como "chegou certo". `tmux`: nome da tecla para `tmux send-keys` na automação.
export const ITENS = [
  { id: 'enter', rotulo: 'Enter', esperado: ['Enter'], tmux: 'Enter', usoNaTui: 'enviar / responder decisão' },
  { id: 'ctrl_j', rotulo: 'Ctrl+J (tem de ser diferente do Enter)', esperado: ['Ctrl+J'], tmux: 'C-j', usoNaTui: 'abrir/fechar painel', nota: 'Ctrl+J é LF (0x0a); Enter é CR (0x0d). Terminais que mandam 0x0d para os dois não distinguem.' },
  { id: 'ctrl_b', rotulo: 'Ctrl+B', esperado: ['Ctrl+B'], tmux: 'C-b', usoNaTui: 'recolher/expandir lateral', nota: 'Dentro do tmux é o prefixo: o programa não recebe.' },
  { id: 'alt_b', rotulo: 'Alt+B (macOS: Option+B)', esperado: ['Alt+B'], tmux: 'M-b', usoNaTui: 'lateral (alternativa)', nota: 'No macOS sem "Option como Meta", chega "∫" em vez de ESC b.' },
  { id: 'alt_j', rotulo: 'Alt+J (macOS: Option+J)', esperado: ['Alt+J'], tmux: 'M-j', usoNaTui: 'painel (alternativa)', nota: 'No macOS sem "Option como Meta", chega "∆".' },
  { id: 'ctrl_left', rotulo: 'Ctrl+←', esperado: ['Ctrl+←'], tmux: 'C-Left', usoNaTui: 'largura do chat (Windows/Linux)', nota: 'No macOS o sistema captura (Mission Control).' },
  { id: 'ctrl_right', rotulo: 'Ctrl+→', esperado: ['Ctrl+→'], tmux: 'C-Right', usoNaTui: 'largura do chat (Windows/Linux)' },
  { id: 'ctrl_shift_left', rotulo: 'Ctrl+Shift+←', esperado: ['Ctrl+Shift+←'], tmux: 'C-S-Left', usoNaTui: 'largura do chat (macOS)' },
  { id: 'ctrl_shift_right', rotulo: 'Ctrl+Shift+→', esperado: ['Ctrl+Shift+→'], tmux: 'C-S-Right', usoNaTui: 'largura do chat (macOS)' },
  { id: 'ctrl_t', rotulo: 'Ctrl+T', esperado: ['Ctrl+T'], tmux: 'C-t', usoNaTui: 'abrir aba', nota: 'Terminais no navegador podem capturar.' },
  { id: 'alt_t', rotulo: 'Alt+T (macOS: Option+T)', esperado: ['Alt+T'], tmux: 'M-t', usoNaTui: 'abrir aba (alternativa)', nota: 'No macOS sem Meta chega "†".' },
  { id: 'ctrl_w', rotulo: 'Ctrl+W', esperado: ['Ctrl+W'], tmux: 'C-w', usoNaTui: 'fechar aba', nota: 'Terminais no navegador fecham a aba do navegador.' },
  { id: 'alt_w', rotulo: 'Alt+W (macOS: Option+W)', esperado: ['Alt+W'], tmux: 'M-w', usoNaTui: 'fechar aba (alternativa)', nota: 'No macOS sem Meta chega "∑".' },
  { id: 'ctrl_k', rotulo: 'Ctrl+K', esperado: ['Ctrl+K'], tmux: 'C-k', usoNaTui: 'paleta de comandos', nota: 'O terminal do VS Code pode capturar (a confirmar).' },
  { id: 'f1', rotulo: 'F1', esperado: ['F1'], tmux: 'F1', usoNaTui: 'paleta + ajuda' },
  { id: 'f5', rotulo: 'F5', esperado: ['F5'], tmux: 'F5', usoNaTui: 'Configurações', nota: 'No macOS exige Fn por padrão.' },
  { id: 'f6', rotulo: 'F6', esperado: ['F6'], tmux: 'F6', usoNaTui: 'Plugins' },
  { id: 'ctrl_q', rotulo: 'Ctrl+Q', esperado: ['Ctrl+Q'], tmux: 'C-q', usoNaTui: 'sair', nota: 'Fora do modo bruto é XON.' },
  { id: 'tab', rotulo: 'Tab', esperado: ['Tab'], tmux: 'Tab', usoNaTui: 'trocar o foco' },
  { id: 'shift_tab', rotulo: 'Shift+Tab', esperado: ['Shift+Tab'], tmux: 'BTab', usoNaTui: 'foco para trás' },
  { id: 'pgup', rotulo: 'PageUp', esperado: ['PageUp'], tmux: 'PageUp', usoNaTui: 'rolar', nota: 'Em notebooks costuma ser Fn+↑.' },
  { id: 'pgdn', rotulo: 'PageDown', esperado: ['PageDown'], tmux: 'PageDown', usoNaTui: 'rolar', nota: 'Em notebooks costuma ser Fn+↓.' },
  { id: 'up', rotulo: '↑', esperado: ['↑'], tmux: 'Up', usoNaTui: 'navegar / decisão' },
  { id: 'down', rotulo: '↓', esperado: ['↓'], tmux: 'Down', usoNaTui: 'navegar / decisão' },
  { id: 'shift_up', rotulo: 'Shift+↑', esperado: ['Shift+↑'], tmux: 'S-Up', usoNaTui: 'reordenar papéis' },
  { id: 'shift_down', rotulo: 'Shift+↓', esperado: ['Shift+↓'], tmux: 'S-Down', usoNaTui: 'reordenar papéis' },
  { id: 'space', rotulo: 'Espaço', esperado: ['Espaço'], tmux: 'Space', usoNaTui: 'marcar opção' },
  { id: 'esc', rotulo: 'Esc', esperado: ['Esc'], tmux: 'Escape', usoNaTui: 'depois / cancelar' },
  { id: 'ctrl_shift_p', rotulo: 'Ctrl+Shift+P (a arquitetura diz que NÃO distingue de Ctrl+P)', esperado: ['Ctrl+P'], tmux: 'C-S-p', usoNaTui: 'não usado', nota: 'Esperado: chegar igual a Ctrl+P (0x10). Só o protocolo kitty distingue. "ok" aqui = confirmou que não serve.' },
];

/** Compõe do macOS (teclado US) quando Option não age como Meta. */
export const MAC_OPTION = { '∫': 'Option+B sem Meta (compôs ∫)', '∆': 'Option+J sem Meta (compôs ∆)', '†': 'Option+T sem Meta (compôs †)', '∑': 'Option+W sem Meta (compôs ∑)' };
