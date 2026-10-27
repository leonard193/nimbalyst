// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { buildCardSessionTitle, type CardSessionIdentity } from '@nimbalyst/runtime/ai/server/cardSessionNaming';

import {
  CARD_SESSIONS_QUERY,
  followCardChanges,
  nextCardIdentity,
  type CardSessionTitleFollowerDeps,
} from '../cardSessionTitleFollower';

const draft: CardSessionIdentity = {
  primaryTrackerId: 'delivery-slice_20',
  cardTitle: 'Keep card-linked chat names correct automatically',
  purpose: 'Implementation',
};

function harness(sessions: Array<{ id: string; metadata: unknown }>) {
  const titles = new Map<string, string>();
  const deps: CardSessionTitleFollowerDeps = {
    listCardSessions: vi.fn(async () => sessions),
    setCardIdentity: vi.fn(async (sessionId: string, identity: CardSessionIdentity) => {
      const title = buildCardSessionTitle(identity);
      titles.set(sessionId, title);
      return title;
    }),
    notifyTitle: vi.fn(),
  };
  return { deps, titles };
}

describe('followCardChanges', () => {
  it('adds the issue key when a draft card is published', async () => {
    const { deps, titles } = harness([{ id: 's1', metadata: { namingMode: 'card', cardIdentity: draft } }]);

    const retitled = await followCardChanges([{ trackerIds: ['delivery-slice_20'], issueKey: 'LEO-20' }], deps);

    expect(retitled).toEqual(['s1']);
    expect(titles.get('s1')).toBe('LEO-20 · Keep card-linked chat names correct automatically — Implementation');
    expect(deps.notifyTitle).toHaveBeenCalledWith('s1', titles.get('s1'));
  });

  it('follows a card title edit and keeps each chat purpose', async () => {
    const card = { ...draft, issueKey: 'LEO-20' };
    const { deps, titles } = harness([
      { id: 'impl', metadata: { namingMode: 'card', cardIdentity: card } },
      { id: 'review', metadata: { namingMode: 'card', cardIdentity: { ...card, purpose: 'Independent review' } } },
    ]);

    await followCardChanges([{ trackerIds: ['delivery-slice_20'], title: 'Keep chat names right' }], deps);

    expect(titles.get('impl')).toBe('LEO-20 · Keep chat names right — Implementation');
    expect(titles.get('review')).toBe('LEO-20 · Keep chat names right — Independent review');
  });

  it('leaves custom-named sessions and sessions of other cards alone', async () => {
    const { deps } = harness([
      { id: 'custom', metadata: { namingMode: 'custom', cardIdentity: draft } },
      { id: 'other', metadata: { namingMode: 'card', cardIdentity: { ...draft, primaryTrackerId: 'delivery-slice_21' } } },
    ]);

    const retitled = await followCardChanges([{ trackerIds: ['delivery-slice_20'], title: 'Renamed' }], deps);

    expect(retitled).toEqual([]);
    expect(deps.setCardIdentity).not.toHaveBeenCalled();
  });

  it('skips the write when nothing visible changed', async () => {
    const { deps } = harness([{ id: 's1', metadata: { namingMode: 'card', cardIdentity: { ...draft, issueKey: 'LEO-20' } } }]);

    await followCardChanges([{ trackerIds: ['delivery-slice_20'], title: draft.cardTitle, issueKey: 'LEO-20' }], deps);

    expect(deps.setCardIdentity).not.toHaveBeenCalled();
  });

  // SQLite hands back the metadata column as a JSON string.
  it('reads card identity from string metadata', async () => {
    const { deps, titles } = harness([{ id: 's1', metadata: JSON.stringify({ namingMode: 'card', cardIdentity: draft }) }]);

    await followCardChanges([{ trackerIds: ['row-id', 'delivery-slice_20'], issueKey: 'LEO-20' }], deps);

    expect(titles.get('s1')).toContain('LEO-20 · ');
  });

  it('applies a batch of changes in order with one session lookup', async () => {
    const { deps, titles } = harness([{ id: 's1', metadata: { namingMode: 'card', cardIdentity: draft } }]);

    await followCardChanges([
      { trackerIds: ['delivery-slice_20'], issueKey: 'LEO-20' },
      { trackerIds: ['delivery-slice_20'], title: 'Second title' },
    ], deps);

    expect(deps.listCardSessions).toHaveBeenCalledTimes(1);
    expect(deps.setCardIdentity).toHaveBeenCalledTimes(1);
    expect(titles.get('s1')).toBe('LEO-20 · Second title — Implementation');
  });
});

describe('nextCardIdentity', () => {
  // A partial update (status only) carries no title or key; it must not blank either.
  it('treats a missing title or key as unchanged', () => {
    const card = { ...draft, issueKey: 'LEO-20' };
    expect(nextCardIdentity(card, { trackerIds: ['delivery-slice_20'], title: '', issueKey: undefined })).toBeNull();
  });
});

// SQLite coverage for the same query lives in SQLiteStoreAdapter.test.ts.
describe('CARD_SESSIONS_QUERY on PGLite', () => {
  it('returns only card-named sessions with parsed metadata', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, metadata JSONB)`);
      await pg.query(`INSERT INTO ai_sessions (id, metadata) VALUES ($1, $2::jsonb), ($3, $4::jsonb), ($5, NULL)`, [
        'card', JSON.stringify({ namingMode: 'card', cardIdentity: draft }),
        'custom', JSON.stringify({ namingMode: 'custom', cardIdentity: draft }),
        'plain',
      ]);

      const { rows } = await pg.query<{ id: string; metadata: unknown }>(CARD_SESSIONS_QUERY);

      expect(rows.map((row) => row.id)).toEqual(['card']);
      const { deps, titles } = harness(rows);
      await followCardChanges([{ trackerIds: [draft.primaryTrackerId], issueKey: 'LEO-20' }], deps);
      expect(titles.get('card')).toBe('LEO-20 · Keep card-linked chat names correct automatically — Implementation');
    } finally {
      await pg.close();
    }
  });
});
