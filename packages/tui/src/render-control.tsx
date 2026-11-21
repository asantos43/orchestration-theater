// SPDX-License-Identifier: MPL-2.0
import { createContext, useContext, type ReactNode } from 'react';

/**
 * What the components need to know about how the frame is painted (decision N37, `ui.render.*`).
 * `afterKey` is called by a component right after it handled a key: in `flush` mode it makes Ink
 * paint the frame at once instead of waiting for its frame limiter.
 */
export interface RenderControl {
  readonly afterKey: () => void;
  /** `ui.render.memo`: whether the components that can be memoized are. */
  readonly memo: boolean;
}

const NOOP: RenderControl = {
  afterKey: () => undefined,
  memo: true,
};

const RenderControlContext = createContext<RenderControl>(NOOP);

export function RenderControlProvider(props: {
  readonly value: RenderControl;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RenderControlContext.Provider value={props.value}>
      {props.children}
    </RenderControlContext.Provider>
  );
}

export function useRenderControl(): RenderControl {
  return useContext(RenderControlContext);
}
