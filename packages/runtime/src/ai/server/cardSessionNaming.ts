/**
 * Display titles for sessions whose identity comes from a primary tracker card.
 *
 * A card-linked session is titled `<issue key> · <card title> — <purpose>`. A
 * card without an issue key (an unpublished draft, a file-backed plan) uses
 * its title alone; a key is never invented. The full title is kept: shortening
 * for compact views is a presentation concern.
 */

export const DEFAULT_CARD_SESSION_PURPOSE = 'Implementation';

const KEY_SEPARATOR = ' · ';
const PURPOSE_SEPARATOR = ' — ';

export interface CardSessionTitleParts {
  issueKey?: string | null;
  cardTitle: string;
  purpose?: string | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** `<issue key> · <card title>`, or the card title alone when there is no key. */
export function buildCardSessionBaseTitle(parts: Pick<CardSessionTitleParts, 'issueKey' | 'cardTitle'>): string {
  const issueKey = clean(parts.issueKey);
  const cardTitle = clean(parts.cardTitle);
  if (!issueKey) return cardTitle;
  if (!cardTitle) return issueKey;
  return `${issueKey}${KEY_SEPARATOR}${cardTitle}`;
}

/** `<base title> — <purpose>`, or the base title alone when there is no purpose. */
export function buildCardSessionTitle(parts: CardSessionTitleParts): string {
  const base = buildCardSessionBaseTitle(parts);
  const purpose = clean(parts.purpose);
  if (!purpose) return base;
  if (!base) return purpose;
  return `${base}${PURPOSE_SEPARATOR}${purpose}`;
}

/**
 * How a session's title is maintained.
 * - `card`: built from `cardIdentity`; only a user rename or the card itself changes it.
 * - `custom`: a user renamed a card session; kept until the user returns it to `card`.
 * Absent on every other session, which keeps the existing naming behavior.
 */
export type SessionNamingMode = 'card' | 'custom';

/** Who is writing a title. Only `user` may override a card or custom name. */
export type SessionTitleSource = 'user' | 'agent' | 'provisional' | 'system';

export const NAMING_MODE_METADATA_KEY = 'namingMode';
export const CARD_IDENTITY_METADATA_KEY = 'cardIdentity';

/** Stored in session metadata, separate from the display title. */
export interface CardSessionIdentity {
  /** Stable tracker item id (or `file:` link id); never the issue key. */
  primaryTrackerId: string;
  /** Absent until the card is published; never invented. */
  issueKey?: string;
  cardTitle: string;
  purpose: string;
}

function parseMetadataObject(metadata: unknown): Record<string, unknown> {
  // SQLite returns JSON columns as strings; PGLite returns objects.
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

export function readSessionNamingMode(metadata: unknown): SessionNamingMode | undefined {
  const mode = parseMetadataObject(metadata)[NAMING_MODE_METADATA_KEY];
  return mode === 'card' || mode === 'custom' ? mode : undefined;
}

export function readCardSessionIdentity(metadata: unknown): CardSessionIdentity | undefined {
  const raw = parseMetadataObject(metadata)[CARD_IDENTITY_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.primaryTrackerId !== 'string' || !value.primaryTrackerId) return undefined;
  if (typeof value.cardTitle !== 'string') return undefined;
  return {
    primaryTrackerId: value.primaryTrackerId,
    ...(typeof value.issueKey === 'string' && value.issueKey ? { issueKey: value.issueKey } : {}),
    cardTitle: value.cardTitle,
    purpose: typeof value.purpose === 'string' ? value.purpose : '',
  };
}

/** Validate an identity from IPC or a tool call. Throws on a missing field. */
export function normalizeCardSessionIdentity(input: unknown): CardSessionIdentity {
  if (!input || typeof input !== 'object') {
    throw new Error('cardIdentity is required');
  }
  const value = input as Record<string, unknown>;
  const primaryTrackerId = typeof value.primaryTrackerId === 'string' ? value.primaryTrackerId.trim() : '';
  if (!primaryTrackerId) throw new Error('cardIdentity.primaryTrackerId is required');
  const cardTitle = typeof value.cardTitle === 'string' ? clean(value.cardTitle) : '';
  if (!cardTitle) throw new Error('cardIdentity.cardTitle is required');
  const issueKey = typeof value.issueKey === 'string' ? clean(value.issueKey) : '';
  const purpose = typeof value.purpose === 'string' ? clean(value.purpose) : '';
  return {
    primaryTrackerId,
    ...(issueKey ? { issueKey } : {}),
    cardTitle,
    purpose: purpose || DEFAULT_CARD_SESSION_PURPOSE,
  };
}

/**
 * Whether a title write may proceed. A card or custom name is changed only by
 * the user; provider summaries, provisional first-prompt titles and agent
 * metadata calls leave it alone.
 */
export function canWriteSessionTitle(mode: SessionNamingMode | undefined, source: SessionTitleSource): boolean {
  if (!mode) return true;
  return source === 'user';
}
