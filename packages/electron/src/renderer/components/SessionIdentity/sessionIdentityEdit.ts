/**
 * The choices behind the chat identity editor: which linked card is primary,
 * the purpose, and whether the name follows the card or is custom.
 */

import {
  DEFAULT_CARD_SESSION_PURPOSE,
  type CardSessionIdentity,
  type SessionNamingMode,
} from '@nimbalyst/runtime/ai/server/cardSessionNaming';

export interface LinkedCardOption {
  /** Tracker item id, used as the primary card id (as at launch). */
  trackerId: string;
  issueKey?: string;
  title: string;
}

interface TrackerRecordLike {
  id: string;
  issueKey?: string;
  fields?: Record<string, unknown>;
  system?: { documentPath?: string };
}

/**
 * The cards a session is linked to, in link order, resolved to loaded tracker
 * items. `file:<path>` links resolve through the item's document path. Links
 * whose item is not loaded are skipped: without a title they cannot name a chat.
 */
export function resolveLinkedCards(
  linkedTrackerItemIds: readonly string[] | undefined,
  items: ReadonlyMap<string, TrackerRecordLike>,
  getTitle: (item: TrackerRecordLike) => string,
): LinkedCardOption[] {
  if (!linkedTrackerItemIds?.length) return [];
  let byPath: Map<string, TrackerRecordLike> | null = null;
  const seen = new Set<string>();
  const cards: LinkedCardOption[] = [];
  for (const ref of linkedTrackerItemIds) {
    let item = items.get(ref);
    if (!item && ref.startsWith('file:')) {
      if (!byPath) {
        byPath = new Map();
        for (const candidate of items.values()) {
          if (candidate.system?.documentPath) byPath.set(candidate.system.documentPath, candidate);
        }
      }
      item = byPath.get(ref.slice('file:'.length));
    }
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    const title = getTitle(item).replace(/\s+/g, ' ').trim() || item.id;
    cards.push({ trackerId: item.id, ...(item.issueKey ? { issueKey: item.issueKey } : {}), title });
  }
  return cards;
}

export interface IdentityEditorState {
  primaryTrackerId: string;
  purpose: string;
  mode: SessionNamingMode;
  customName: string;
}

/** The editor's starting values for a session. */
export function initialIdentityEditorState(
  session: { title?: string; namingMode?: SessionNamingMode; cardIdentity?: CardSessionIdentity },
  cards: readonly LinkedCardOption[],
): IdentityEditorState {
  const identity = session.namingMode ? session.cardIdentity : undefined;
  return {
    primaryTrackerId: identity?.primaryTrackerId ?? cards[0]?.trackerId ?? '',
    purpose: identity?.purpose || DEFAULT_CARD_SESSION_PURPOSE,
    mode: session.namingMode === 'custom' ? 'custom' : 'card',
    customName: session.title ?? '',
  };
}

export type IdentityEditCall =
  | { channel: 'sessions:set-card-identity'; args: [string, CardSessionIdentity, { numberRepeatedPurpose: boolean }] }
  | { channel: 'sessions:update-title'; args: [string, string] };

/**
 * The IPC calls that apply the editor's state, in order. The identity is
 * written first whenever it changed or the name returns to the card; a custom
 * name is then written as a user rename, which keeps the identity and marks
 * the name custom. An empty list means nothing changed.
 */
export function planIdentityEdit(
  sessionId: string,
  session: { title?: string; namingMode?: SessionNamingMode; cardIdentity?: CardSessionIdentity },
  cards: readonly LinkedCardOption[],
  state: IdentityEditorState,
): IdentityEditCall[] {
  const card = cards.find((option) => option.trackerId === state.primaryTrackerId);
  if (!card) return [];
  const purpose = state.purpose.replace(/\s+/g, ' ').trim() || DEFAULT_CARD_SESSION_PURPOSE;
  const nextIdentity: CardSessionIdentity = {
    primaryTrackerId: card.trackerId,
    ...(card.issueKey ? { issueKey: card.issueKey } : {}),
    cardTitle: card.title,
    purpose,
  };
  const current = session.namingMode ? session.cardIdentity : undefined;
  const identityChanged = !current
    || current.primaryTrackerId !== nextIdentity.primaryTrackerId
    || current.purpose !== nextIdentity.purpose
    || current.cardTitle !== nextIdentity.cardTitle
    || (current.issueKey ?? '') !== (nextIdentity.issueKey ?? '');

  const calls: IdentityEditCall[] = [];
  if (state.mode === 'card') {
    if (identityChanged || session.namingMode !== 'card') {
      calls.push({ channel: 'sessions:set-card-identity', args: [sessionId, nextIdentity, { numberRepeatedPurpose: true }] });
    }
    return calls;
  }

  const customName = state.customName.replace(/\s+/g, ' ').trim();
  if (!customName) return [];
  if (identityChanged) {
    calls.push({ channel: 'sessions:set-card-identity', args: [sessionId, nextIdentity, { numberRepeatedPurpose: true }] });
  }
  if (identityChanged || session.namingMode !== 'custom' || customName !== (session.title ?? '').trim()) {
    calls.push({ channel: 'sessions:update-title', args: [sessionId, customName] });
  }
  return calls;
}
