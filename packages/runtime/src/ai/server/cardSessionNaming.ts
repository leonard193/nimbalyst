/**
 * Display titles for sessions whose identity comes from a primary tracker card.
 *
 * A card-linked session is titled `<issue key> · <card title> — <purpose>`. A
 * card without an issue key (an unpublished draft, a file-backed plan) uses
 * its title alone; a key is never invented. The full title is kept: shortening
 * for compact views is a presentation concern.
 */

export const DEFAULT_CARD_SESSION_PURPOSE = 'Implementation';

/** Purposes offered at launch and in the identity editor. Any other text is a custom purpose. */
export const CARD_SESSION_PURPOSE_PRESETS = [
  'Implementation',
  'Independent review',
  'Investigation',
  'SYNTHETIC check',
] as const;

/** Marks a test chat whose results are never real preferences or accepted work. */
export const SYNTHETIC_MARKER = 'SYNTHETIC';

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

/**
 * The naming fields a session list entry carries, read from its metadata.
 * Empty for ordinary sessions, so they keep no card identity in the UI.
 */
export function readSessionNamingFields(
  metadata: unknown,
): { namingMode?: SessionNamingMode; cardIdentity?: CardSessionIdentity } {
  const namingMode = readSessionNamingMode(metadata);
  const cardIdentity = namingMode ? readCardSessionIdentity(metadata) : undefined;
  if (!namingMode || !cardIdentity) return {};
  return { namingMode, cardIdentity };
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

/**
 * Metadata to merge when the user renames a session: a card-named session
 * becomes custom-named and keeps its card identity, so it can return to the
 * card name later. Undefined for every other session.
 */
export function userRenameMetadata(currentMetadata: unknown): Record<string, unknown> | undefined {
  return readSessionNamingMode(currentMetadata) === 'card'
    ? { [NAMING_MODE_METADATA_KEY]: 'custom' }
    : undefined;
}

/**
 * A purpose another chat on the same card does not already use: the purpose
 * itself, else the first free `<purpose> 2`, `<purpose> 3`, ... Comparison
 * ignores case and spacing. A purpose that already carries a number keeps
 * counting from its base (`Implementation 2` taken -> `Implementation 3`).
 */
export function nextAvailablePurpose(purpose: string, takenPurposes: Iterable<string>): string {
  const wanted = clean(purpose) || DEFAULT_CARD_SESSION_PURPOSE;
  const taken = new Set(Array.from(takenPurposes, (value) => clean(value).toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const numbered = /^(.*\S)\s+(\d+)$/.exec(wanted);
  const base = numbered ? numbered[1] : wanted;
  let n = numbered ? Number(numbered[2]) + 1 : 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

/**
 * Purposes already used by other sessions whose primary card is `primaryTrackerId`,
 * in card or custom naming mode. Archived sessions count: a name is never reused.
 */
export function purposesTakenOnCard(
  sessions: Iterable<{ id: string; metadata: unknown }>,
  primaryTrackerId: string,
  excludeSessionId?: string,
): string[] {
  const purposes: string[] = [];
  for (const session of sessions) {
    if (session.id === excludeSessionId) continue;
    if (!readSessionNamingMode(session.metadata)) continue;
    const identity = readCardSessionIdentity(session.metadata);
    if (identity?.primaryTrackerId === primaryTrackerId && identity.purpose) {
      purposes.push(identity.purpose);
    }
  }
  return purposes;
}
