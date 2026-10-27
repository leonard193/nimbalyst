// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildCardSessionBaseTitle,
  buildCardSessionTitle,
  canWriteSessionTitle,
  nextAvailablePurpose,
  normalizeCardSessionIdentity,
  purposesTakenOnCard,
  readCardSessionIdentity,
  readSessionNamingFields,
  userRenameMetadata,
} from '../cardSessionNaming';

describe('buildCardSessionTitle', () => {
  it('joins key, card title and purpose', () => {
    expect(buildCardSessionTitle({ issueKey: 'LEO-20', cardTitle: 'Keep names correct', purpose: 'Implementation' }))
      .toBe('LEO-20 · Keep names correct — Implementation');
  });

  it('uses the card title alone when the card has no key', () => {
    expect(buildCardSessionTitle({ issueKey: undefined, cardTitle: 'Draft card', purpose: 'Implementation' }))
      .toBe('Draft card — Implementation');
    expect(buildCardSessionBaseTitle({ issueKey: '  ', cardTitle: 'Draft card' })).toBe('Draft card');
  });

  // Two chats on one card share a base title and differ only by purpose.
  it('gives chats on the same card a common base and distinct purposes', () => {
    const card = { issueKey: 'LEO-20', cardTitle: 'Keep names correct' };
    const implementation = buildCardSessionTitle({ ...card, purpose: 'Implementation' });
    const review = buildCardSessionTitle({ ...card, purpose: 'Independent review' });

    expect(implementation).not.toBe(review);
    expect(implementation.startsWith(buildCardSessionBaseTitle(card))).toBe(true);
    expect(review.startsWith(buildCardSessionBaseTitle(card))).toBe(true);
  });

  it('collapses whitespace from a multi-line card title', () => {
    expect(buildCardSessionTitle({ issueKey: 'LEO-20', cardTitle: '  Keep\n names   correct ', purpose: 'SYNTHETIC Codex check' }))
      .toBe('LEO-20 · Keep names correct — SYNTHETIC Codex check');
  });

  it('omits the purpose separator when there is no purpose', () => {
    expect(buildCardSessionTitle({ issueKey: 'LEO-20', cardTitle: 'Keep names correct', purpose: '' }))
      .toBe('LEO-20 · Keep names correct');
  });
});

describe('userRenameMetadata', () => {
  it('switches a card-named session to custom and leaves others alone', () => {
    expect(userRenameMetadata({ namingMode: 'card' })).toEqual({ namingMode: 'custom' });
    expect(userRenameMetadata(JSON.stringify({ namingMode: 'card' }))).toEqual({ namingMode: 'custom' });
    expect(userRenameMetadata({ namingMode: 'custom' })).toBeUndefined();
    expect(userRenameMetadata({})).toBeUndefined();
    expect(userRenameMetadata(null)).toBeUndefined();
  });
});

describe('canWriteSessionTitle', () => {
  it('lets only the user rename a card or custom name', () => {
    for (const mode of ['card', 'custom'] as const) {
      expect(canWriteSessionTitle(mode, 'user')).toBe(true);
      expect(canWriteSessionTitle(mode, 'agent')).toBe(false);
      expect(canWriteSessionTitle(mode, 'provisional')).toBe(false);
      expect(canWriteSessionTitle(mode, 'system')).toBe(false);
    }
    expect(canWriteSessionTitle(undefined, 'agent')).toBe(true);
  });
});

describe('normalizeCardSessionIdentity', () => {
  it('requires a card id and title and defaults the purpose', () => {
    expect(() => normalizeCardSessionIdentity({ cardTitle: 'Card' })).toThrow(/primaryTrackerId/);
    expect(() => normalizeCardSessionIdentity({ primaryTrackerId: 't1', cardTitle: '  ' })).toThrow(/cardTitle/);
    expect(normalizeCardSessionIdentity({ primaryTrackerId: 't1', cardTitle: 'Card', issueKey: '' }))
      .toEqual({ primaryTrackerId: 't1', cardTitle: 'Card', purpose: 'Implementation' });
  });

  it('round-trips through stored metadata', () => {
    const identity = normalizeCardSessionIdentity({ primaryTrackerId: 't1', issueKey: 'LEO-20', cardTitle: 'Card', purpose: 'Independent review' });
    expect(readCardSessionIdentity(JSON.stringify({ cardIdentity: identity }))).toEqual(identity);
  });
});

describe('nextAvailablePurpose', () => {
  it('keeps a purpose no other chat on the card uses', () => {
    expect(nextAvailablePurpose('Independent review', ['Implementation'])).toBe('Independent review');
  });

  it('numbers a repeated purpose from 2, skipping numbers already taken', () => {
    expect(nextAvailablePurpose('Implementation', ['Implementation'])).toBe('Implementation 2');
    expect(nextAvailablePurpose('Implementation', ['implementation', 'Implementation 2'])).toBe('Implementation 3');
    expect(nextAvailablePurpose('Implementation 2', ['Implementation', 'Implementation 2'])).toBe('Implementation 3');
  });

  it('defaults an empty purpose', () => {
    expect(nextAvailablePurpose('  ', [])).toBe('Implementation');
  });
});

describe('purposesTakenOnCard', () => {
  const identity = (primaryTrackerId: string, purpose: string) => ({ primaryTrackerId, cardTitle: 'Card', purpose });

  it('counts card and custom chats on the same primary card, not the chat itself or other cards', () => {
    const sessions = [
      { id: 'self', metadata: { namingMode: 'card', cardIdentity: identity('t1', 'Implementation') } },
      { id: 'a', metadata: { namingMode: 'card', cardIdentity: identity('t1', 'Implementation') } },
      { id: 'b', metadata: JSON.stringify({ namingMode: 'custom', cardIdentity: identity('t1', 'Independent review') }) },
      { id: 'c', metadata: { namingMode: 'card', cardIdentity: identity('t2', 'Investigation') } },
      { id: 'd', metadata: { cardIdentity: identity('t1', 'Stale') } },
    ];
    expect(purposesTakenOnCard(sessions, 't1', 'self')).toEqual(['Implementation', 'Independent review']);
  });
});

describe('readSessionNamingFields', () => {
  it('returns the mode and identity together, or nothing', () => {
    const cardIdentity = { primaryTrackerId: 't1', issueKey: 'LEO-21', cardTitle: 'Card', purpose: 'Implementation' };
    expect(readSessionNamingFields({ namingMode: 'card', cardIdentity })).toEqual({ namingMode: 'card', cardIdentity });
    expect(readSessionNamingFields({ namingMode: 'card' })).toEqual({});
    expect(readSessionNamingFields({ cardIdentity })).toEqual({});
    expect(readSessionNamingFields(null)).toEqual({});
  });
});
