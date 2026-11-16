// SPDX-License-Identifier: MPL-2.0
import { describeEventLogConformance, describeStoreConformance } from '@otheater/sdk';
import { DRIVERS, openTempStore } from './test-helpers.js';

for (const driver of DRIVERS) {
  describeStoreConformance(`SqliteStore (${driver})`, async () => {
    const { store, clock, dispose } = await openTempStore(driver);
    return { store, clock, dispose };
  });

  describeEventLogConformance(`SqliteStore, synchronous=normal (${driver})`, async () => {
    const { store, clock, dispose } = await openTempStore(driver, { synchronous: 'normal' });
    return { events: store.events, clock, dispose };
  });
}
