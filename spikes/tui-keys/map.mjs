// Mapa de teclas da seção 5.13 da arquitetura (v0.40; atalhos da N35, preset `agents`) + teclas da caixa de texto.
// Até 2026-11-15 o mapa era o da v0.32 (Ctrl+B, Ctrl+T, Ctrl+W, Ctrl+K como atalhos do layout).
// `esperado`: nomes decodificados que contam como "chegou certo". `tmux`: nome da tecla para `tmux send-keys` na automação.
// `indistinguivel`: nome que, se chegar no lugar do esperado, vira o estado "indistinguível do <nome>".
export const ITENS = [
  // caixa de texto: enviar e nova linha
  { id: 'enter', grupo: 'caixa', rotulo: 'Enter', esperado: ['Enter'], tmux: 'Enter', usoNaTui: 'enviar / responder decisão' },
  { id: 'ctrl_j', grupo: 'caixa', rotulo: 'Ctrl+J (tem de ser diferente do Enter)', esperado: ['Ctrl+J'], indistinguivel: 'Enter', tmux: 'C-j', usoNaTui: 'nova linha (N35)', nota: 'Ctrl+J é LF (0x0a); Enter é CR (0x0d). Terminais que mandam 0x0d para os dois não distinguem.' },
  { id: 'shift_enter', grupo: 'caixa', rotulo: 'Shift+Enter (só onde o terminal distingue do Enter)', esperado: ['Shift+Enter'], indistinguivel: 'Enter', tmux: 'S-Enter', usoNaTui: 'nova linha (N35)', nota: 'Sem protocolo kitty ou modifyOtherKeys, a maioria dos terminais manda CR, igual ao Enter.' },
  // layout (preset agents, N35)
  { id: 'alt_s', grupo: 'layout', rotulo: 'Alt+S (macOS: Option+S)', esperado: ['Alt+S'], tmux: 'M-s', usoNaTui: 'recolher/expandir lateral', nota: 'No macOS sem "Option como Meta", chega "ß".' },
  { id: 'alt_j', grupo: 'layout', rotulo: 'Alt+J (macOS: Option+J)', esperado: ['Alt+J'], tmux: 'M-j', usoNaTui: 'abrir/fechar painel', nota: 'No macOS sem "Option como Meta", chega "∆".' },
  { id: 'ctrl_shift_left', grupo: 'layout', rotulo: 'Ctrl+Shift+←', esperado: ['Ctrl+Shift+←'], tmux: 'C-S-Left', usoNaTui: 'largura do chat' },
  { id: 'ctrl_shift_right', grupo: 'layout', rotulo: 'Ctrl+Shift+→', esperado: ['Ctrl+Shift+→'], tmux: 'C-S-Right', usoNaTui: 'largura do chat' },
  { id: 'alt_a', grupo: 'layout', rotulo: 'Alt+A (macOS: Option+A)', esperado: ['Alt+A'], tmux: 'M-a', usoNaTui: 'abrir aba', nota: 'No macOS sem Meta chega "å".' },
  { id: 'alt_w', grupo: 'layout', rotulo: 'Alt+W (macOS: Option+W)', esperado: ['Alt+W'], tmux: 'M-w', usoNaTui: 'fechar aba', nota: 'No macOS sem Meta chega "∑".' },
  { id: 'alt_k', grupo: 'layout', rotulo: 'Alt+K (macOS: Option+K)', esperado: ['Alt+K'], tmux: 'M-k', usoNaTui: 'paleta de comandos', nota: 'No macOS sem Meta chega "˚".' },
  { id: 'f1', grupo: 'layout', rotulo: 'F1', esperado: ['F1'], tmux: 'F1', usoNaTui: 'paleta + ajuda' },
  { id: 'f5', grupo: 'layout', rotulo: 'F5', esperado: ['F5'], tmux: 'F5', usoNaTui: 'Configurações', nota: 'No macOS exige Fn por padrão.' },
  { id: 'f6', grupo: 'layout', rotulo: 'F6', esperado: ['F6'], tmux: 'F6', usoNaTui: 'Plugins' },
  { id: 'ctrl_q', grupo: 'layout', rotulo: 'Ctrl+Q', esperado: ['Ctrl+Q'], tmux: 'C-q', usoNaTui: 'sair', nota: 'Fora do modo bruto é XON.' },
  // caixa de texto: edição no estilo do readline (N35)
  { id: 'ctrl_a', grupo: 'caixa', rotulo: 'Ctrl+A', esperado: ['Ctrl+A'], tmux: 'C-a', usoNaTui: 'início da linha', nota: 'Prefixo comum do screen e de tmux reconfigurado.' },
  { id: 'ctrl_e', grupo: 'caixa', rotulo: 'Ctrl+E', esperado: ['Ctrl+E'], tmux: 'C-e', usoNaTui: 'fim da linha' },
  { id: 'ctrl_b', grupo: 'caixa', rotulo: 'Ctrl+B', esperado: ['Ctrl+B'], tmux: 'C-b', usoNaTui: 'um caractere para trás (era a lateral até a v0.32)', nota: 'Dentro do tmux é o prefixo: o programa não recebe.' },
  { id: 'ctrl_f', grupo: 'caixa', rotulo: 'Ctrl+F', esperado: ['Ctrl+F'], tmux: 'C-f', usoNaTui: 'um caractere para frente' },
  { id: 'ctrl_k', grupo: 'caixa', rotulo: 'Ctrl+K', esperado: ['Ctrl+K'], tmux: 'C-k', usoNaTui: 'apagar até o fim (era a paleta até a v0.32)', nota: 'O terminal do VS Code pode capturar (a confirmar).' },
  { id: 'ctrl_u', grupo: 'caixa', rotulo: 'Ctrl+U', esperado: ['Ctrl+U'], tmux: 'C-u', usoNaTui: 'apagar até o início' },
  { id: 'ctrl_w', grupo: 'caixa', rotulo: 'Ctrl+W', esperado: ['Ctrl+W'], tmux: 'C-w', usoNaTui: 'apagar palavra (era fechar aba até a v0.32)', nota: 'Terminais no navegador fecham a aba do navegador.' },
  { id: 'ctrl_y', grupo: 'caixa', rotulo: 'Ctrl+Y', esperado: ['Ctrl+Y'], tmux: 'C-y', usoNaTui: 'colar o que foi apagado', nota: 'No macOS, fora do modo bruto, é DSUSP.' },
  { id: 'alt_b', grupo: 'caixa', rotulo: 'Alt+B (macOS: Option+B)', esperado: ['Alt+B'], tmux: 'M-b', usoNaTui: 'palavra para trás', nota: 'No macOS sem "Option como Meta", chega "∫".' },
  { id: 'alt_f', grupo: 'caixa', rotulo: 'Alt+F (macOS: Option+F)', esperado: ['Alt+F'], tmux: 'M-f', usoNaTui: 'palavra para frente', nota: 'No macOS sem Meta chega "ƒ".' },
  { id: 'alt_d', grupo: 'caixa', rotulo: 'Alt+D (macOS: Option+D)', esperado: ['Alt+D'], tmux: 'M-d', usoNaTui: 'apagar palavra à frente', nota: 'No macOS sem Meta chega "∂".' },
  { id: 'ctrl_left', grupo: 'caixa', rotulo: 'Ctrl+←', esperado: ['Ctrl+←'], tmux: 'C-Left', usoNaTui: 'palavra para trás (era a largura do chat)', nota: 'No macOS o sistema captura (Mission Control).' },
  { id: 'ctrl_right', grupo: 'caixa', rotulo: 'Ctrl+→', esperado: ['Ctrl+→'], tmux: 'C-Right', usoNaTui: 'palavra para frente' },
  { id: 'ctrl_r', grupo: 'caixa', rotulo: 'Ctrl+R', esperado: ['Ctrl+R'], tmux: 'C-r', usoNaTui: 'buscar no histórico' },
  { id: 'ctrl_g', grupo: 'caixa', rotulo: 'Ctrl+G', esperado: ['Ctrl+G'], tmux: 'C-g', usoNaTui: 'escrever no $EDITOR' },
  { id: 'ctrl_v', grupo: 'caixa', rotulo: 'Ctrl+V', esperado: ['Ctrl+V'], tmux: 'C-v', usoNaTui: 'colar imagem', nota: 'Windows Terminal e VS Code costumam colar texto no Ctrl+V; então a tecla não chega.' },
  // navegação e decisão
  { id: 'tab', grupo: 'navegação', rotulo: 'Tab', esperado: ['Tab'], tmux: 'Tab', usoNaTui: 'trocar o foco' },
  { id: 'shift_tab', grupo: 'navegação', rotulo: 'Shift+Tab', esperado: ['Shift+Tab'], tmux: 'BTab', usoNaTui: 'foco para trás' },
  { id: 'pgup', grupo: 'navegação', rotulo: 'PageUp', esperado: ['PageUp'], tmux: 'PageUp', usoNaTui: 'rolar', nota: 'Em notebooks costuma ser Fn+↑.' },
  { id: 'pgdn', grupo: 'navegação', rotulo: 'PageDown', esperado: ['PageDown'], tmux: 'PageDown', usoNaTui: 'rolar', nota: 'Em notebooks costuma ser Fn+↓.' },
  { id: 'up', grupo: 'navegação', rotulo: '↑', esperado: ['↑'], tmux: 'Up', usoNaTui: 'histórico / decisão' },
  { id: 'down', grupo: 'navegação', rotulo: '↓', esperado: ['↓'], tmux: 'Down', usoNaTui: 'histórico / decisão' },
  { id: 'shift_up', grupo: 'navegação', rotulo: 'Shift+↑', esperado: ['Shift+↑'], tmux: 'S-Up', usoNaTui: 'reordenar papéis' },
  { id: 'shift_down', grupo: 'navegação', rotulo: 'Shift+↓', esperado: ['Shift+↓'], tmux: 'S-Down', usoNaTui: 'reordenar papéis' },
  { id: 'space', grupo: 'navegação', rotulo: 'Espaço', esperado: ['Espaço'], tmux: 'Space', usoNaTui: 'marcar opção' },
  { id: 'esc', grupo: 'navegação', rotulo: 'Esc', esperado: ['Esc'], tmux: 'Escape', usoNaTui: 'depois / cancelar' },
  // preset classic (v0.7) e conferência
  { id: 'ctrl_t', grupo: 'classic', rotulo: 'Ctrl+T (só no preset classic)', esperado: ['Ctrl+T'], tmux: 'C-t', usoNaTui: 'abrir aba no preset classic', nota: 'Terminais no navegador podem capturar.' },
  { id: 'ctrl_shift_p', grupo: 'conferência', rotulo: 'Ctrl+Shift+P (a arquitetura diz que NÃO distingue de Ctrl+P)', esperado: ['Ctrl+P'], tmux: 'C-S-p', usoNaTui: 'não usado', nota: 'Esperado: chegar igual a Ctrl+P (0x10). Só o protocolo kitty distingue. "ok" aqui = confirmou que não serve.' },
];

/** Compõe do macOS (teclado US) quando Option não age como Meta. */
export const MAC_OPTION = {
  '∫': 'Option+B sem Meta (compôs ∫)', '∆': 'Option+J sem Meta (compôs ∆)', '†': 'Option+T sem Meta (compôs †)', '∑': 'Option+W sem Meta (compôs ∑)',
  'ß': 'Option+S sem Meta (compôs ß)', 'å': 'Option+A sem Meta (compôs å)', '˚': 'Option+K sem Meta (compôs ˚)', 'ƒ': 'Option+F sem Meta (compôs ƒ)', '∂': 'Option+D sem Meta (compôs ∂)',
};
