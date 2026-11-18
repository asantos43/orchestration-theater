// SPDX-License-Identifier: MPL-2.0
import type { EventLog, NewEvent } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  detailOf,
  SituationLog,
  situationSubject,
  situationText,
  writeSituation,
} from './situations.js';

/** An event log that keeps what is appended; `failFirst` makes the first writes fail. */
function fakeEvents(failFirst = 0): { events: Pick<EventLog, 'append'>; written: NewEvent[] } {
  const written: NewEvent[] = [];
  let failures = failFirst;
  const events: Pick<EventLog, 'append'> = {
    append: (event: NewEvent) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('the log is closed'));
      }
      written.push(event);
      return Promise.resolve({ id: written.length } as Awaited<ReturnType<EventLog['append']>>);
    },
  };
  return { events, written };
}

function fakeLogger(): {
  logger: { error: (fields: Record<string, unknown>, message: string) => void };
  errors: { fields: Record<string, unknown>; message: string }[];
} {
  const errors: { fields: Record<string, unknown>; message: string }[] = [];
  return {
    logger: { error: (fields, message) => void errors.push({ fields, message }) },
    errors,
  };
}

const notice = (subject: string) => ({ kind: 'client_warning', subject, detail: null }) as const;

describe('situations (P24)', () => {
  describe('writeSituation', () => {
    it('writes the event with the correlation of the situation', async () => {
      const { events, written } = fakeEvents();
      const { logger } = fakeLogger();
      await writeSituation(events, logger, 'daemon.notice', notice('codex'), {
        scenarioId: 's1',
        playId: 'p1',
        attemptId: 'a1',
      });
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        type: 'daemon.notice',
        schemaVersion: 1,
        payload: { kind: 'client_warning', subject: 'codex', detail: null },
        scenarioId: 's1',
        playId: 'p1',
        attemptId: 'a1',
      });
    });

    it('leaves the correlation out when there is none', async () => {
      const { events, written } = fakeEvents();
      await writeSituation(events, fakeLogger().logger, 'daemon.notice', notice('codex'));
      expect(written[0]).not.toHaveProperty('scenarioId');
      expect(written[0]).not.toHaveProperty('playId');
      expect(written[0]).not.toHaveProperty('attemptId');
    });

    it('never rejects: a write that fails is only logged, without the error text of the store', async () => {
      const { events } = fakeEvents(1);
      const { logger, errors } = fakeLogger();
      await expect(
        writeSituation(events, logger, 'daemon.notice', notice('codex')),
      ).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('a situation event was not written');
      expect(errors[0]?.fields).toMatchObject({ type: 'daemon.notice' });
    });

    it('does not write a payload that does not fit its schema, and says so in the log', async () => {
      const { events, written } = fakeEvents();
      const { logger, errors } = fakeLogger();
      await writeSituation(events, logger, 'daemon.notice', {
        kind: 'client_warning',
        subject: 'x'.repeat(300),
        detail: null,
      });
      expect(written).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });
  });

  describe('SituationLog', () => {
    it('keeps what is recorded before open() in a queue and writes it after, in order', async () => {
      const { events, written } = fakeEvents();
      const log = new SituationLog({ events, logger: fakeLogger().logger });
      log.record('daemon.notice', notice('one'));
      log.record('daemon.notice', notice('two'));
      await log.idle();
      expect(written).toHaveLength(0);
      log.open();
      log.record('daemon.notice', notice('three'));
      await log.idle();
      expect(written.map((event) => (event.payload as { subject: string }).subject)).toEqual([
        'one',
        'two',
        'three',
      ]);
    });

    it('writes at once when it starts open', async () => {
      const { events, written } = fakeEvents();
      const log = new SituationLog({ events, logger: fakeLogger().logger, open: true });
      log.record('daemon.notice', notice('now'));
      await log.idle();
      expect(written).toHaveLength(1);
    });

    it('open() twice writes nothing twice', async () => {
      const { events, written } = fakeEvents();
      const log = new SituationLog({ events, logger: fakeLogger().logger });
      log.record('daemon.notice', notice('once'));
      log.open();
      log.open();
      await log.idle();
      expect(written).toHaveLength(1);
    });

    it('a write that fails goes to logger.error and the next ones are still written', async () => {
      const { events, written } = fakeEvents(1);
      const { logger, errors } = fakeLogger();
      const log = new SituationLog({ events, logger, open: true });
      log.record('daemon.notice', notice('lost'));
      log.record('daemon.notice', notice('kept'));
      await log.idle();
      expect(errors).toHaveLength(1);
      expect(written.map((event) => (event.payload as { subject: string }).subject)).toEqual([
        'kept',
      ]);
    });

    it('idle() waits for the events recorded while it waits', async () => {
      const { events, written } = fakeEvents();
      const log = new SituationLog({ events, logger: fakeLogger().logger, open: true });
      log.record('daemon.notice', notice('a'));
      const idle = log.idle();
      log.record('daemon.notice', notice('b'));
      await idle;
      await log.idle();
      expect(written).toHaveLength(2);
    });
  });

  describe('texts', () => {
    it('masks a secret, flattens the lines and cuts the text', () => {
      const text = situationText(
        new Error(`bad\nkey sk-ant-api03-${'a'.repeat(40)} ${'x'.repeat(900)}`),
      );
      expect(text).not.toBeNull();
      expect(text).not.toContain('\n');
      expect(text).not.toContain('sk-ant-api03-aaaa');
      expect(text?.length).toBeLessThanOrEqual(512);
    });

    it('has no text for an empty value, and detailOf leaves the field out', () => {
      expect(situationText('')).toBeNull();
      expect(detailOf('')).toEqual({});
      expect(detailOf('why')).toEqual({ detail: 'why' });
    });

    it('cuts a subject at 256 characters', () => {
      expect(situationSubject('y'.repeat(400))?.length).toBe(256);
      expect(situationSubject('')).toBeNull();
    });
  });
});
