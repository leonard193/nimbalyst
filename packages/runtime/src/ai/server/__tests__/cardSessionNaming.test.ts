// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildCardSessionBaseTitle,
  buildCardSessionTitle,
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
