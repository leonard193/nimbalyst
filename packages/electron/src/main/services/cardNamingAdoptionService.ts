/**
 * Moves existing sessions into card naming on explicit request.
 *
 * The planner (`planCardNamingAdoption`) decides, read-only, which sessions in
 * a workspace can adopt a card identity. Applying is a separate call that
 * names each session, its expected current title, the card and the purpose:
 * nothing is adopted in bulk or in the background. Each write goes through
 * `SessionManager.adoptCardIdentity`, which refuses when the title changed
 * since the preview and keeps an undo record. Adoption never adds a card link;
 * the card must already be one of the session's linked items.
 */

import {
  planCardNamingAdoption,
  type AdoptionCardInput,
  type AdoptionEntry,
  type AdoptionSessionInput,
} from '@nimbalyst/runtime/ai/server/cardNamingAdoption';
import {
  buildCardSessionTitle,
  normalizeCardSessionIdentity,
  purposesTakenOnCard,
  type CardSessionIdentity,
} from '@nimbalyst/runtime/ai/server/cardSessionNaming';

/** Sessions of one workspace, archived included, with what the planner reads. */
export const ADOPTION_SESSIONS_QUERY = `SELECT id, title, created_at, is_archived, parent_session_id, created_by_session_id, metadata FROM ai_sessions WHERE workspace_id = $1`;

export interface CardNamingAdoptionDeps {
  adoptCardIdentity(
    sessionId: string,
    identity: CardSessionIdentity,
    options: { expectedTitle: string },
  ): Promise<{ status: 'applied' | 'conflict' | 'already-adopted' | 'missing'; title?: string }>;
  undoCardIdentityAdoption(
    sessionId: string,
  ): Promise<{ status: 'restored' | 'conflict' | 'not-adopted' | 'missing'; title?: string }>;
  /** Tell renderers a session now follows its card. */
  notifyAdopted(sessionId: string, title: string, identity: CardSessionIdentity): void;
  /** Tell renderers a session is back to its previous plain title. */
  notifyRestored(sessionId: string, title: string): void;
}

let registeredDeps: CardNamingAdoptionDeps | null = null;

/** Called once at startup by the session handlers, which own the SessionManager. */
export function setCardNamingAdoptionDeps(deps: CardNamingAdoptionDeps | null): void {
  registeredDeps = deps;
}

export function getCardNamingAdoptionDeps(): CardNamingAdoptionDeps | null {
  return registeredDeps;
}

function asObject(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export interface AdoptionCardRecord extends AdoptionCardInput {
  /** Other ids the same card is known by (the row id of a full-document item). */
  aliases?: string[];
}

/**
 * Planner input from database rows. Linked ids are mapped to each card's
 * public id, so a link stored under a row id still counts as that card.
 */
export function toAdoptionInputs(
  sessionRows: ReadonlyArray<Record<string, unknown>>,
  cards: readonly AdoptionCardRecord[],
): { sessions: AdoptionSessionInput[]; cards: AdoptionCardInput[] } {
  const canonical = new Map<string, string>();
  for (const card of cards) {
    canonical.set(card.id, card.id);
    for (const alias of card.aliases ?? []) canonical.set(alias, card.id);
  }
  const sessions = sessionRows.map((row): AdoptionSessionInput => {
    const metadata = asObject(row.metadata);
    const links = Array.isArray(metadata.linkedTrackerItemIds) ? metadata.linkedTrackerItemIds : [];
    const mapped = Array.from(new Set(
      links.filter((id): id is string => typeof id === 'string' && !!id).map(id => canonical.get(id) ?? id),
    ));
    return {
      id: String(row.id),
      title: typeof row.title === 'string' ? row.title : '',
      createdAt: toMillis(row.created_at),
      isArchived: !!row.is_archived,
      parentSessionId: (row.parent_session_id as string | null | undefined) ?? null,
      createdBySessionId: (row.created_by_session_id as string | null | undefined) ?? null,
      metadata: { ...metadata, linkedTrackerItemIds: mapped },
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
  return { sessions, cards: cards.map(({ id, issueKey, title }) => ({ id, issueKey, title })) };
}

export function previewCardNamingAdoption(
  sessions: readonly AdoptionSessionInput[],
  cards: readonly AdoptionCardInput[],
): { entries: AdoptionEntry[]; counts: Record<string, number> } {
  const entries = planCardNamingAdoption(sessions, cards);
  const counts: Record<string, number> = { total: entries.length };
  for (const entry of entries) {
    counts[entry.action] = (counts[entry.action] ?? 0) + 1;
    if (entry.needsDecision) counts.needsDecision = (counts.needsDecision ?? 0) + 1;
  }
  return { entries, counts };
}

export interface AdoptionApplyRequest {
  sessionId: string;
  /** The title the owner saw in the preview; the write is refused if it changed. */
  expectedTitle: string;
  /** Must already be one of the session's linked cards. */
  primaryTrackerId: string;
  purpose: string;
}

export type AdoptionApplyStatus =
  | 'applied'
  | 'conflict'
  | 'already-adopted'
  | 'missing'
  | 'not-linked'
  | 'card-missing'
  | 'purpose-taken'
  | 'unavailable';

export interface AdoptionApplyResult {
  sessionId: string;
  status: AdoptionApplyStatus;
  /** The stored title after the call: the new one, or the unchanged current one. */
  title?: string;
  /** The title before the call, for the evidence record. */
  previousTitle?: string;
  identity?: CardSessionIdentity;
  detail?: string;
}

/**
 * Apply explicitly chosen adoptions, one session at a time. A refusal for one
 * session never stops the others. A purpose another chat on the same card
 * already holds is refused rather than silently renumbered: the preview shows
 * the numbered name, and the owner approves it.
 */
export async function applyCardNamingAdoption(
  requests: readonly AdoptionApplyRequest[],
  context: { sessions: readonly AdoptionSessionInput[]; cards: readonly AdoptionCardInput[] },
  deps: CardNamingAdoptionDeps | null,
): Promise<AdoptionApplyResult[]> {
  const sessionsById = new Map(context.sessions.map(session => [session.id, session]));
  const cardsById = new Map(context.cards.map(card => [card.id, card]));
  // Named sessions as they stand, updated as this batch adopts.
  const named = new Map(context.sessions.map(session => [session.id, session.metadata]));
  const results: AdoptionApplyResult[] = [];

  for (const request of requests) {
    const session = sessionsById.get(request.sessionId);
    const previousTitle = session?.title;
    if (!deps) {
      results.push({ sessionId: request.sessionId, status: 'unavailable', detail: 'Session naming is not ready.' });
      continue;
    }
    if (!session) {
      results.push({ sessionId: request.sessionId, status: 'missing', detail: 'No session with this id in the workspace.' });
      continue;
    }
    const links = asObject(session.metadata).linkedTrackerItemIds;
    if (!Array.isArray(links) || !links.includes(request.primaryTrackerId)) {
      results.push({
        sessionId: request.sessionId,
        status: 'not-linked',
        title: session.title,
        previousTitle,
        detail: 'The card is not linked to this session. Adoption never adds a link; link it deliberately first.',
      });
      continue;
    }
    const card = cardsById.get(request.primaryTrackerId);
    if (!card) {
      results.push({ sessionId: request.sessionId, status: 'card-missing', title: session.title, previousTitle });
      continue;
    }
    const identity = normalizeCardSessionIdentity({
      primaryTrackerId: card.id,
      issueKey: card.issueKey ?? undefined,
      cardTitle: card.title,
      purpose: request.purpose,
    });
    const taken = purposesTakenOnCard(
      Array.from(named, ([id, metadata]) => ({ id, metadata })),
      card.id,
      session.id,
    ).map(purpose => purpose.toLowerCase());
    if (taken.includes(identity.purpose.toLowerCase())) {
      results.push({
        sessionId: request.sessionId,
        status: 'purpose-taken',
        title: session.title,
        previousTitle,
        identity,
        detail: `Another chat on this card already follows it as "${buildCardSessionTitle(identity)}". Re-run the preview for a numbered name.`,
      });
      continue;
    }

    const outcome = await deps.adoptCardIdentity(session.id, identity, { expectedTitle: request.expectedTitle });
    if (outcome.status === 'applied' && outcome.title) {
      named.set(session.id, { ...asObject(session.metadata), namingMode: 'card', cardIdentity: identity });
      deps.notifyAdopted(session.id, outcome.title, identity);
    }
    results.push({
      sessionId: request.sessionId,
      status: outcome.status,
      title: outcome.title,
      previousTitle,
      identity,
      ...(outcome.status === 'conflict'
        ? { detail: `The title is now "${outcome.title}", not the previewed "${request.expectedTitle}". Nothing changed.` }
        : {}),
    });
  }
  return results;
}

export async function undoCardNamingAdoption(
  sessionIds: readonly string[],
  deps: CardNamingAdoptionDeps | null,
): Promise<Array<{ sessionId: string; status: 'restored' | 'conflict' | 'not-adopted' | 'missing' | 'unavailable'; title?: string }>> {
  const results = [];
  for (const sessionId of sessionIds) {
    if (!deps) {
      results.push({ sessionId, status: 'unavailable' as const });
      continue;
    }
    const outcome = await deps.undoCardIdentityAdoption(sessionId);
    if (outcome.status === 'restored' && outcome.title !== undefined) {
      deps.notifyRestored(sessionId, outcome.title);
    }
    results.push({ sessionId, ...outcome });
  }
  return results;
}
