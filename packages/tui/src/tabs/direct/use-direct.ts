// SPDX-License-Identifier: MPL-2.0
import type { ApiDirectSession, ApiDirectSessionDetail } from '@otheater/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectApi } from './api.js';

/** How often the conversation of a session that runs is read again (the text of a turn grows in place). */
export const POLL_MS = 400;

export interface DirectSessions {
  readonly sessions: readonly ApiDirectSession[];
  /** The picked session when it is on the list, else the newest one. */
  readonly selectedId: string | undefined;
  /** The conversation of the selected session; `undefined` before the first read. */
  readonly detail: ApiDirectSessionDetail | undefined;
  /** True after the first list came (so "no sessions" is not drawn while it is still loading). */
  readonly loaded: boolean;
  /** Reads the list and the selected session again now. */
  readonly refresh: () => void;
}

/**
 * The sessions of the scenario and the conversation of the selected one (P19). The daemon has the
 * events `direct.session.*` for what changes (a session opened, a turn that ended, a closing): the
 * hook reads again when `signal` (the id of the last of them in the stream) moves. The text the
 * Actor is writing is in no event until the turn ends, so while the session runs the detail is read
 * every {@link POLL_MS}. An answer that comes after a newer request is dropped.
 */
export function useDirectSessions(
  api: DirectApi | undefined,
  scenarioId: string | undefined,
  pickedId: string | undefined,
  signal: number,
): DirectSessions {
  const [sessions, setSessions] = useState<readonly ApiDirectSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<ApiDirectSessionDetail | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

  const refresh = useCallback((): void => {
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    listRequest.current += 1;
    const mine = listRequest.current;
    if (api === undefined || scenarioId === undefined) {
      setSessions([]);
      setLoaded(false);
      return;
    }
    api.list(scenarioId).then(
      (list) => {
        if (mine !== listRequest.current) return;
        setSessions(list);
        setLoaded(true);
      },
      () => {
        // The tab keeps what it had; the next event or key reads again.
        if (mine === listRequest.current) setLoaded(true);
      },
    );
  }, [api, scenarioId, signal, tick]);

  const selectedId =
    pickedId !== undefined && sessions.some((session) => session.id === pickedId)
      ? pickedId
      : sessions[0]?.id;

  const running = detail?.id === selectedId && detail?.state === 'running';
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setPoll((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running]);

  useEffect(() => {
    detailRequest.current += 1;
    const mine = detailRequest.current;
    if (api === undefined || selectedId === undefined) {
      setDetail(undefined);
      return;
    }
    api.get(selectedId).then(
      (read) => {
        if (mine === detailRequest.current) setDetail(read);
      },
      () => {
        // A session that is gone (daemon restarted) leaves the conversation as it was.
      },
    );
  }, [api, selectedId, signal, tick, poll]);

  return {
    sessions,
    selectedId,
    detail: detail?.id === selectedId ? detail : undefined,
    loaded,
    refresh,
  };
}
