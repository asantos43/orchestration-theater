// SPDX-License-Identifier: MPL-2.0
import type { Generated } from 'kysely';

/** Row of the `events` table (architecture section 7). */
export interface EventsTable {
  /** `INTEGER PRIMARY KEY AUTOINCREMENT`: ids are never reused, even after a rollback or crash. */
  id: Generated<number>;
  type: string;
  /** Epoch milliseconds from the `Clock`. */
  timestamp: number;
  schema_version: number;
  scenario_id: string | null;
  play_id: string | null;
  attempt_id: string | null;
  /** JSON object, as text. */
  payload: string;
}

/** Row of the `attempts` table: the per-attempt registry (architecture 5.21). */
export interface AttemptsTable {
  attempt_id: string;
  play_id: string;
  demand_id: string;
  attempt: number;
  client: string;
  profile: string;
  state: string;
  cause: string | null;
  session_id: string | null;
  worktree: string;
  branch: string;
  last_checkpoint: string | null;
  last_checkpoint_at: number | null;
  last_event_at: number | null;
  resumes: number;
  free_resumes: number;
  /** Epoch milliseconds from the `Clock`. */
  created_at: number;
  updated_at: number;
}

/** Tables of the store. Aggregates join as the phases that need them arrive. */
export interface StoreDatabase {
  events: EventsTable;
  attempts: AttemptsTable;
}
