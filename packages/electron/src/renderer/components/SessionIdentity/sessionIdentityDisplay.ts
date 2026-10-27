/**
 * What a session surface shows for a chat's identity.
 *
 * A chat whose name follows a primary card shows the card key, the card title
 * and its purpose as separate parts, so two chats on one card share a title
 * and differ by purpose. A custom-named card chat shows the user's name and
 * keeps the key. Every other chat shows its title and gets no card parts: a
 * key is never invented. A SYNTHETIC marker is lifted into its own part so a
 * narrow view can keep it visible while the text around it shortens.
 */

import {
  buildCardSessionBaseTitle,
  buildCardSessionTitle,
  SYNTHETIC_MARKER,
  type CardSessionIdentity,
  type SessionNamingMode,
} from '@nimbalyst/runtime/ai/server/cardSessionNaming';

export interface SessionIdentitySource {
  title?: string | null;
  namingMode?: SessionNamingMode;
  cardIdentity?: CardSessionIdentity;
}

export interface SessionIdentityDisplay {
  /** `card` when the chat has a primary card; `plain` otherwise. */
  kind: 'card' | 'plain';
  /** The main line: the card title, the custom name, or the chat title. */
  title: string;
  /** Present only when the card has a real key. */
  issueKey?: string;
  /** Stable id of the primary card, for navigation; present for card chats. */
  primaryTrackerId?: string;
  /** The purpose without its SYNTHETIC marker; shown for card-named chats only. */
  purpose?: string;
  synthetic: boolean;
  isCustomName: boolean;
  /** The complete identity for tooltips and screen readers. */
  fullLabel: string;
}

const SYNTHETIC_PATTERN = /(^|[^A-Za-z0-9])SYNTHETIC(?=[^A-Za-z0-9]|$)/i;

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Remove a SYNTHETIC marker and the separators left around it. */
function withoutSynthetic(value: string): { text: string; synthetic: boolean } {
  if (!SYNTHETIC_PATTERN.test(value)) return { text: value, synthetic: false };
  const text = clean(value.replace(SYNTHETIC_PATTERN, '$1'))
    .replace(/^[\s:·—–-]+|[\s:·—–-]+$/g, '')
    .trim();
  return { text, synthetic: true };
}

export function getSessionIdentityDisplay(
  session: SessionIdentitySource,
  untitledLabel = 'Untitled session',
): SessionIdentityDisplay {
  const sessionTitle = clean(session.title) || untitledLabel;
  const identity = session.namingMode ? session.cardIdentity : undefined;

  if (!identity) {
    const { text, synthetic } = withoutSynthetic(sessionTitle);
    return {
      kind: 'plain',
      title: text || sessionTitle,
      synthetic,
      isCustomName: false,
      fullLabel: sessionTitle,
    };
  }

  const issueKey = clean(identity.issueKey) || undefined;
  const cardName = buildCardSessionTitle(identity);

  if (session.namingMode === 'custom') {
    const { text, synthetic } = withoutSynthetic(sessionTitle);
    return {
      kind: 'card',
      title: text || sessionTitle,
      issueKey,
      primaryTrackerId: identity.primaryTrackerId,
      synthetic,
      isCustomName: true,
      fullLabel: `${sessionTitle} (custom name; card ${cardName})`,
    };
  }

  const purpose = withoutSynthetic(clean(identity.purpose));
  return {
    kind: 'card',
    title: clean(identity.cardTitle) || buildCardSessionBaseTitle(identity) || sessionTitle,
    issueKey,
    primaryTrackerId: identity.primaryTrackerId,
    ...(purpose.text ? { purpose: purpose.text } : {}),
    synthetic: purpose.synthetic,
    isCustomName: false,
    fullLabel: cardName,
  };
}

export { SYNTHETIC_MARKER };
