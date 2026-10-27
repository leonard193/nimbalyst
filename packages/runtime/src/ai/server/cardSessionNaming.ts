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
