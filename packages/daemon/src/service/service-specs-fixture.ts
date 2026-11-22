// SPDX-License-Identifier: MPL-2.0
// Shared by the tests only (excluded from the build of the package).
import type { ServiceSpec } from './types.js';

/** The unit and the plist of the reference files: a data folder with a space, to test the quoting. */
export const POSIX_SPEC: ServiceSpec = {
  id: 'otheater-daemon',
  command: {
    command: '/opt/node/bin/node',
    args: ['/work/ot/dist/cli.js', 'daemon', '--data-dir', '/data/ot dir'],
  },
  dataDir: '/data/ot dir',
  restart: 'on_failure',
  autostart: 'logon',
  console: 'hidden',
  path: '/usr/local/bin:/usr/bin',
};

export const WINDOWS_SPEC: ServiceSpec = {
  id: 'otheater-daemon',
  command: {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [
      'C:\\ot\\dist\\cli.js',
      'daemon',
      '--data-dir',
      'C:\\Users\\Test User\\AppData\\Local\\OTheater',
    ],
  },
  dataDir: 'C:\\Users\\Test User\\AppData\\Local\\OTheater',
  restart: 'on_failure',
  autostart: 'logon',
  console: 'hidden',
  userId: 'PC\\tester',
};
