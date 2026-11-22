// SPDX-License-Identifier: MPL-2.0

/**
 * The origins a plugin can be installed from (N236, Phase 9, P4): `path` (a local folder, used in
 * place), `npm` (an exact version of a package) and `git` (a repository pinned to a commit). The
 * list lives apart from `config.ts` so the configuration schema and the installer share it with no
 * import cycle.
 */
export const PLUGIN_INSTALL_SOURCES = ['path', 'npm', 'git'] as const;
export type PluginInstallSource = (typeof PLUGIN_INSTALL_SOURCES)[number];
