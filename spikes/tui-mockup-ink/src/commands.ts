// Comandos da paleta (Ctrl+K). Não existem no mockup: ilustram a sobreposição com position="absolute".
import type { Action } from './state.js';

export interface Command { label: string; key: string; act: Action | { t: 'quit' } }
export const COMMANDS: Command[] = [
  { label: 'Alternar lateral', key: '^B', act: { t: 'toggleSide' } },
  { label: 'Alternar painel', key: '^J', act: { t: 'togglePanel' } },
  { label: 'Abrir aba', key: '^T', act: { t: 'openTab' } },
  { label: 'Fechar aba', key: '^W', act: { t: 'closeTab' } },
  { label: 'Tela: Principal', key: 'F2', act: { t: 'preset', id: 'main' } },
  { label: 'Tela: Trajetórias', key: 'F3', act: { t: 'preset', id: 'traj' } },
  { label: 'Tela: Configurações', key: 'F4', act: { t: 'preset', id: 'config' } },
  { label: 'Tela: Só o chat', key: 'F5', act: { t: 'preset', id: 'focus' } },
  { label: 'Abrir Configurações como aba', key: '', act: { t: 'openTab', id: 'config' } },
  { label: 'Reabrir a decisão do Produtor', key: '', act: { t: 'decision', op: 'reopen' } },
  { label: 'Sair', key: '^Q', act: { t: 'quit' } },
];
export function filterCommands(q: string): Command[] {
  const s = q.trim().toLowerCase();
  return s ? COMMANDS.filter(c => c.label.toLowerCase().includes(s)) : COMMANDS;
}
