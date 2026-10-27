/**
 * Keeps card-named sessions in step with their primary tracker card.
 *
 * A session launched from a card stores the card's identity in metadata
 * (`namingMode: 'card'`, `cardIdentity`). When that card's title changes or it
 * gains an issue key on publication, the session title is rebuilt from the new
 * values. Custom-named sessions are left alone. Fed by local tracker writes
 * (`ElectronDocumentService.updateTrackerItem`) and by items the tracker room
 * applies (remote edits and server key assignment).
 */

import {
  nextAvailablePurpose,
  purposesTakenOnCard,
  readCardSessionIdentity,
  readSessionNamingMode,
  type CardSessionIdentity,
} from '@nimbalyst/runtime/ai/server/cardSessionNaming';

/**
 * Card-named sessions. `->>` on the JSON column reads the same on PGLite and
 * SQLite; the identity itself is parsed in JS from the whole column.
 */
export const CARD_SESSIONS_QUERY = `SELECT id, metadata FROM ai_sessions WHERE metadata->>'namingMode' = 'card'`;

/** Sessions with a card identity, in card or custom naming mode, archived included. */
export const NAMED_CARD_SESSIONS_QUERY = `SELECT id, metadata FROM ai_sessions WHERE metadata->>'namingMode' IN ('card', 'custom')`;

/**
 * Give a launch a purpose no other chat on the same card uses, so two
 * launches from one card read `Implementation` and `Implementation 2`.
 */
export async function numberRepeatedPurpose(
  sessionId: string,
  identity: CardSessionIdentity,
  listNamedCardSessions: () => Promise<Array<{ id: string; metadata: unknown }>>,
): Promise<CardSessionIdentity> {
  const taken = purposesTakenOnCard(await listNamedCardSessions(), identity.primaryTrackerId, sessionId);
  const purpose = nextAvailablePurpose(identity.purpose, taken);
  return purpose === identity.purpose ? identity : { ...identity, purpose };
}

export interface CardTrackerChange {
  /** Every id the card is known by (public id and row id may differ). */
  trackerIds: string[];
  title?: unknown;
  issueKey?: unknown;
}

export interface CardSessionTitleFollowerDeps {
  /** Sessions in card naming mode; filtering by card happens here. */
  listCardSessions(): Promise<Array<{ id: string; metadata: unknown }>>;
  setCardIdentity(sessionId: string, identity: CardSessionIdentity): Promise<string>;
  /** Tell renderers the new title and the identity it was built from. */
  notifyTitle(sessionId: string, title: string, identity: CardSessionIdentity): void;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

/** The identity after a card change, or null when the title would not change. */
export function nextCardIdentity(current: CardSessionIdentity, change: CardTrackerChange): CardSessionIdentity | null {
  if (!change.trackerIds.includes(current.primaryTrackerId)) return null;
  // A missing value means "not part of this change", never "cleared": a key
  // is not removed and a title is not blanked from a partial update.
  const issueKey = nonEmpty(change.issueKey) ?? current.issueKey;
  const cardTitle = nonEmpty(change.title) ?? current.cardTitle;
  const next: CardSessionIdentity = {
    ...current,
    ...(issueKey ? { issueKey } : {}),
    cardTitle,
  };
  if (next.issueKey === current.issueKey && next.cardTitle === current.cardTitle) return null;
  return next;
}

/**
 * Retitle every card-named session whose primary card appears in `changes`,
 * applying the changes in order. Returns the retitled session ids.
 */
export async function followCardChanges(
  changes: CardTrackerChange[],
  deps: CardSessionTitleFollowerDeps,
): Promise<string[]> {
  const relevant = changes
    .map((change) => ({ ...change, trackerIds: change.trackerIds.filter(Boolean) }))
    .filter((change) => change.trackerIds.length > 0);
  if (relevant.length === 0) return [];
  const retitled: string[] = [];
  for (const session of await deps.listCardSessions()) {
    if (readSessionNamingMode(session.metadata) !== 'card') continue;
    const current = readCardSessionIdentity(session.metadata);
    if (!current) continue;
    let next = current;
    for (const change of relevant) {
      next = nextCardIdentity(next, change) ?? next;
    }
    if (next === current) continue;
    const title = await deps.setCardIdentity(session.id, next);
    deps.notifyTitle(session.id, title, next);
    retitled.push(session.id);
  }
  return retitled;
}

let registeredDeps: CardSessionTitleFollowerDeps | null = null;
let pendingChanges: CardTrackerChange[] = [];
let flushScheduled = false;

/** Called once at startup by the session handlers, which own the SessionManager. */
export function setCardSessionTitleFollowerDeps(deps: CardSessionTitleFollowerDeps | null): void {
  registeredDeps = deps;
}

/**
 * Fire-and-forget entry point for tracker write paths. Changes arriving in the
 * same tick (a sync bootstrap applies many items) share one session lookup.
 * Never throws: a failed retitle must not fail the tracker write.
 */
export function notifyCardChanged(change: CardTrackerChange): void {
  if (!registeredDeps) return;
  pendingChanges.push(change);
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    const deps = registeredDeps;
    const changes = pendingChanges;
    pendingChanges = [];
    flushScheduled = false;
    if (!deps) return;
    void followCardChanges(changes, deps).catch((error) => {
      console.error('[CardSessionTitleFollower] Failed to retitle card sessions:', error);
    });
  }, 0);
}

export type SetPrimaryCardResult =
  | { applied: true; title: string }
  | { applied: false; reason: 'unavailable' | 'other-primary-card'; primaryTrackerId?: string };

/**
 * Make `trackerId` the session's primary card with an explicit purpose. Used
 * by deliberate linking (a review or child chat). Refuses to move a session
 * whose primary card is a different card: linking a second card never
 * reassigns the primary role.
 */
export async function setPrimaryCard(
  sessionId: string,
  identity: CardSessionIdentity,
  currentMetadata: unknown,
): Promise<SetPrimaryCardResult> {
  const deps = registeredDeps;
  if (!deps) return { applied: false, reason: 'unavailable' };
  const current = readCardSessionIdentity(currentMetadata);
  if (current && current.primaryTrackerId !== identity.primaryTrackerId) {
    return { applied: false, reason: 'other-primary-card', primaryTrackerId: current.primaryTrackerId };
  }
  const title = await deps.setCardIdentity(sessionId, identity);
  deps.notifyTitle(sessionId, title, identity);
  return { applied: true, title };
}
