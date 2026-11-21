// SPDX-License-Identifier: MPL-2.0
import {
  runControl,
  type ApiClient,
  type ControlAction,
  type ControlResult,
  type ControlTarget,
} from '@otheater/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmMode } from '../settings.js';

/** `pausePlay`, `resumePlay`, `pauseActor`, `resumeActor`: the ids the catalog has text for. */
export type ControlKind = 'pausePlay' | 'resumePlay' | 'pauseActor' | 'resumeActor';

export interface ControlRequest {
  readonly kind: ControlKind;
  readonly target: ControlTarget;
  readonly action: ControlAction;
  /** What the text names: the need of the play or the name of the Actor. */
  readonly subject: string;
}

export interface ControlOutcome {
  readonly request: ControlRequest;
  readonly result: ControlResult;
}

export interface ControlRunner {
  /** Waiting for the `y` of the person. */
  readonly pending: ControlRequest | undefined;
  /** A call is in flight: further requests are ignored until it answers. */
  readonly busy: boolean;
  /** How the last call ended; `undefined` before the first one and after the scenario changed. */
  readonly outcome: ControlOutcome | undefined;
  /** Asks for the control: with `confirm: always` it waits for {@link confirm}; with `off` it runs at once. */
  readonly request: (request: ControlRequest) => void;
  readonly confirm: () => void;
  readonly cancel: () => void;
}

/**
 * The pause and resume controls of the Overview (P13 of docs/18). The call is `runControl` of the
 * client, the same one `/pause` and `/resume` end in, so the effect and the events are the same;
 * the tab only decides when to ask. [proposta] `ui.overview.confirm: always` asks first.
 */
export function useControlRunner(
  client:
    Pick<ApiClient, 'pausePlay' | 'resumePlay' | 'pauseAttempt' | 'resumeAttempt'> | undefined,
  confirmMode: ConfirmMode,
  resetKey: string | undefined,
): ControlRunner {
  const [pending, setPending] = useState<ControlRequest | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ControlOutcome | undefined>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Another scenario: what was asked or answered belongs to the one the person left.
  useEffect(() => {
    setPending(undefined);
    setOutcome(undefined);
  }, [resetKey]);

  const run = useCallback(
    (request: ControlRequest): void => {
      if (client === undefined) return;
      setPending(undefined);
      setBusy(true);
      void runControl(client, request.target, request.action).then((result) => {
        if (!alive.current) return;
        setBusy(false);
        setOutcome({ request, result });
      });
    },
    [client],
  );

  const request = useCallback(
    (next: ControlRequest): void => {
      if (client === undefined || busy) return;
      setOutcome(undefined);
      if (confirmMode === 'off') run(next);
      else setPending(next);
    },
    [client, busy, confirmMode, run],
  );
  const confirm = useCallback((): void => {
    if (pending !== undefined) run(pending);
  }, [pending, run]);
  const cancel = useCallback((): void => {
    setPending(undefined);
  }, []);

  return { pending, busy, outcome, request, confirm, cancel };
}
