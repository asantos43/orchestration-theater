// SPDX-License-Identifier: MPL-2.0
// postject ships no types. Only what `inject.ts` calls.
declare module 'postject' {
  export interface InjectOptions {
    machoSegmentName?: string;
    overwrite?: boolean;
    sentinelFuse?: string;
  }
  export function inject(
    filename: string,
    resourceName: string,
    resourceData: Buffer,
    options?: InjectOptions,
  ): Promise<void>;
}
