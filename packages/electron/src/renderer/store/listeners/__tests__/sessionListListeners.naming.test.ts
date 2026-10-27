// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../index', () => ({ store: { get: vi.fn(), set: vi.fn() } }));

import { sessionNamingUpdate } from '../sessionListListeners';

describe('sessionNamingUpdate', () => {
  const cardIdentity = { primaryTrackerId: 't1', issueKey: 'LEO-21', cardTitle: 'Card', purpose: 'Independent review' };

  it('carries the mode and identity of a card-named retitle', () => {
    expect(sessionNamingUpdate({ title: 'x', namingMode: 'card', cardIdentity })).toEqual({ namingMode: 'card', cardIdentity });
  });

  // A user rename sends only the mode; the registry keeps its stored identity.
  it('carries only the mode for a user rename', () => {
    expect(sessionNamingUpdate({ title: 'Mine', namingMode: 'custom' })).toEqual({ namingMode: 'custom' });
  });

  it('ignores ordinary updates and malformed values', () => {
    expect(sessionNamingUpdate({ title: 'x', phase: 'planning' })).toEqual({});
    expect(sessionNamingUpdate({ namingMode: 'other', cardIdentity: { cardTitle: 'no id' } })).toEqual({});
  });
});
