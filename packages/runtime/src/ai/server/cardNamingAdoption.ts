/**
 * Planning the move of existing sessions into card-linked naming.
 *
 * Sessions created before card naming carry a plain title and, sometimes, a
 * direct link to one or more tracker items. This module decides, without
 * writing anything, which of them can adopt a card identity with their title
 * unchanged, which need an owner decision, and which stay as they are. A title
 * prefix that looks like an issue key is never treated as evidence of a link:
 * only `linkedTrackerItemIds` is.
 *
 * Applying a plan goes through `SessionManager.adoptCardIdentity`, which
 * checks the title still matches the preview and keeps an undo record.
 */

import {
  buildCardSessionBaseTitle,
  nextAvailablePurpose,
  readCardSessionIdentity,
  readSessionNamingMode,
  SYNTHETIC_MARKER,
  type CardSessionIdentity,
} from './cardSessionNaming';

/** Metadata key holding what adoption replaced, so it can be undone. */
export const CARD_NAMING_ADOPTION_METADATA_KEY = 'cardNamingAdoption';

export interface CardNamingAdoptionRecord {
  previousTitle: string;
  previousHasBeenNamed: boolean;
  adoptedTitle: string;
  adoptedAt: number;
}

export interface AdoptionSessionInput {
  id: string;
  title: string;
  createdAt: number;
  isArchived?: boolean;
  parentSessionId?: string | null;
  createdBySessionId?: string | null;
  /** The session's full metadata; read for links and any existing naming mode. */
  metadata: unknown;
}

export interface AdoptionCardInput {
  id: string;
  issueKey?: string | null;
  title: string;
}

/**
 * - `direct`: exactly one linked card, and the title is that card's name.
 * - `ambiguous`: linked, but which card is primary, or whether to rename, is the owner's call.
 * - `associated`: no direct link; tied to a card only through its parent or creating session.
 * - `general`: no card link or association.
 * - `adopted`: already has a naming mode; nothing to do.
 */
export type AdoptionGroup = 'direct' | 'ambiguous' | 'associated' | 'general' | 'adopted';

/**
 * - `adopt`: take the card identity; the title does not change.
 * - `adopt-renamed`: take the card identity with a new title (needs owner approval).
 * - `keep`: leave the session exactly as it is.
 */
export type AdoptionAction = 'adopt' | 'adopt-renamed' | 'keep';

export interface AdoptionCandidate {
  cardId: string;
  issueKey?: string;
  identity: CardSessionIdentity;
  proposedTitle: string;
}

export interface AdoptionEntry {
  sessionId: string;
  title: string;
  group: AdoptionGroup;
  action: AdoptionAction;
  /** Equal to `title` unless the action renames. */
  proposedTitle: string;
  identity?: CardSessionIdentity;
  /** True when the owner must choose before this entry may be applied. */
  needsDecision: boolean;
  /** Choices for an ambiguous entry; the proposed one comes first. */
  candidates?: AdoptionCandidate[];
  reason: string;
  synthetic: boolean;
  archived: boolean;
  /** Linked ids that resolve to no known card (another workspace, or deleted). */
  unresolvedLinks: string[];
  /** The linked card keys or titles, for the preview. */
  linkedCards: string[];
}

const PURPOSE_SEPARATOR = ' — ';

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

function linkedIds(metadata: unknown): string[] {
  const value = asObject(metadata).linkedTrackerItemIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && !!id) : [];
}

function cardLabel(card: AdoptionCardInput): string {
  return card.issueKey || card.title;
}

/**
 * The purpose a title carries for `card`, when the title is exactly
 * `<card base title> — <purpose>`; otherwise undefined.
 */
export function purposeFromCardTitle(title: string, card: AdoptionCardInput): string | undefined {
  const base = buildCardSessionBaseTitle({ issueKey: card.issueKey, cardTitle: card.title });
  if (!base) return undefined;
  const prefix = `${base}${PURPOSE_SEPARATOR}`;
  if (!title.startsWith(prefix)) return undefined;
  const purpose = title.slice(prefix.length);
  return purpose.trim() && purpose === purpose.trim() ? purpose : undefined;
}

function identityFor(card: AdoptionCardInput, purpose: string): CardSessionIdentity {
  return {
    primaryTrackerId: card.id,
    ...(card.issueKey ? { issueKey: card.issueKey } : {}),
    cardTitle: card.title,
    purpose,
  };
}

function titleFor(identity: CardSessionIdentity): string {
  return `${buildCardSessionBaseTitle(identity)}${PURPOSE_SEPARATOR}${identity.purpose}`;
}

/**
 * Plan the adoption of card naming for every session given. Pure: reads its
 * inputs only. Running it again after applying the `adopt` entries yields only
 * `adopted` and `keep` entries.
 */
export function planCardNamingAdoption(
  sessions: readonly AdoptionSessionInput[],
  cards: readonly AdoptionCardInput[],
): AdoptionEntry[] {
  const cardsById = new Map(cards.map(card => [card.id, card]));
  const sessionsById = new Map(sessions.map(session => [session.id, session]));

  const entries = sessions.map((session): AdoptionEntry => {
    const links = linkedIds(session.metadata);
    const linkedCards = links.map(id => cardsById.get(id)).filter((card): card is AdoptionCardInput => !!card);
    const base = {
      sessionId: session.id,
      title: session.title,
      proposedTitle: session.title,
      needsDecision: false,
      synthetic: session.title.includes(SYNTHETIC_MARKER),
      archived: !!session.isArchived,
      unresolvedLinks: links.filter(id => !cardsById.has(id)),
      linkedCards: linkedCards.map(cardLabel),
    };

    if (readSessionNamingMode(session.metadata)) {
      return {
        ...base,
        group: 'adopted',
        action: 'keep',
        identity: readCardSessionIdentity(session.metadata),
        reason: 'Already has a naming mode; nothing to change.',
      };
    }

    if (linkedCards.length === 0) {
      const related = [session.parentSessionId, session.createdBySessionId]
        .filter((id): id is string => !!id)
        .map(id => sessionsById.get(id))
        .find(other => other && linkedIds(other.metadata).some(id => cardsById.has(id)));
      if (related) {
        const relatedCards = linkedIds(related.metadata).map(id => cardsById.get(id)).filter((card): card is AdoptionCardInput => !!card);
        const how = related.id === session.parentSessionId ? 'workstream parent' : 'creating session';
        return {
          ...base,
          group: 'associated',
          action: 'keep',
          reason: `No direct card link. Its ${how} "${related.title}" links ${relatedCards.map(cardLabel).join(', ')}. Kept as is; linking it would be a separate, deliberate change.`,
        };
      }
      return {
        ...base,
        group: 'general',
        action: 'keep',
        reason: base.unresolvedLinks.length
          ? 'Its only links point to no card in this workspace. Kept as is.'
          : 'General chat with no card link. Kept as is.',
      };
    }

    const candidates: AdoptionCandidate[] = [];
    for (const card of linkedCards) {
      const purpose = purposeFromCardTitle(session.title, card);
      if (purpose === undefined) continue;
      const identity = identityFor(card, purpose);
      candidates.push({ cardId: card.id, ...(card.issueKey ? { issueKey: card.issueKey } : {}), identity, proposedTitle: titleFor(identity) });
    }

    if (candidates.length === 0) {
      return {
        ...base,
        group: 'direct',
        action: 'keep',
        reason: `Linked to ${base.linkedCards.join(', ')}, but its name is not that card's name. Treated as an intentional custom name and kept.`,
      };
    }

    if (linkedCards.length === 1 && candidates.length === 1) {
      const [candidate] = candidates;
      return {
        ...base,
        group: 'direct',
        action: 'adopt',
        identity: candidate.identity,
        proposedTitle: candidate.proposedTitle,
        reason: `Only link is ${base.linkedCards[0]} and the name is already that card's name. Adopting keeps the title and lets it follow the card.`,
      };
    }

    return {
      ...base,
      group: 'ambiguous',
      action: 'keep',
      needsDecision: true,
      candidates,
      reason: `Linked to ${base.linkedCards.join(', ')}. Which one is primary is not recorded; the name matches ${candidates.map(c => c.issueKey ?? c.identity.cardTitle).join(', ')}. Kept as is unless the owner picks a primary card.`,
    };
  });

  // Never reuse a name: a later adoption whose purpose another chat on the same
  // card already holds is renumbered, and that rename needs the owner.
  const holders = new Map<string, Array<{ entry: AdoptionEntry; createdAt: number }>>();
  for (const entry of entries) {
    const identity = entry.identity ?? entry.candidates?.[0]?.identity;
    if (!identity) continue;
    if (entry.group !== 'adopted' && entry.action !== 'adopt') continue;
    const list = holders.get(identity.primaryTrackerId) ?? [];
    list.push({ entry, createdAt: sessionsById.get(entry.sessionId)?.createdAt ?? 0 });
    holders.set(identity.primaryTrackerId, list);
  }
  for (const list of holders.values()) {
    // Adopted sessions keep their purpose; then the oldest chat keeps it.
    list.sort((a, b) => Number(b.entry.group === 'adopted') - Number(a.entry.group === 'adopted') || a.createdAt - b.createdAt);
    const taken: string[] = [];
    for (const { entry } of list) {
      const identity = entry.identity!;
      const purpose = nextAvailablePurpose(identity.purpose, taken);
      taken.push(purpose);
      if (purpose === identity.purpose || entry.group === 'adopted') continue;
      const renamed = { ...identity, purpose };
      entry.action = 'adopt-renamed';
      entry.identity = renamed;
      entry.proposedTitle = titleFor(renamed);
      entry.needsDecision = true;
      entry.reason = `An older chat on ${identity.issueKey ?? identity.cardTitle} already has the same name. Proposed "${purpose}" so the name is not reused; replacing the existing name needs the owner.`;
    }
  }

  return entries;
}
