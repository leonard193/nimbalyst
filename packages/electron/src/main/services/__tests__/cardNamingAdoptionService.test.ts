// @vitest-environment node
// All fixtures are SYNTHETIC: invented sessions, cards and keys.
import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { buildCardSessionTitle, type CardSessionIdentity } from '@nimbalyst/runtime/ai/server/cardSessionNaming';

import {
  ADOPTION_SESSIONS_QUERY,
  applyCardNamingAdoption,
  previewCardNamingAdoption,
  toAdoptionInputs,
  undoCardNamingAdoption,
  type CardNamingAdoptionDeps,
} from '../cardNamingAdoptionService';

const card = { id: 'task_1', issueKey: 'SYN-1', title: 'SYNTHETIC Adopt existing chats' };
const plainTitle = 'SYN-1 · SYNTHETIC Adopt existing chats — Implementation';

/** A store that guards like SessionManager.adoptCardIdentity / undoCardIdentityAdoption. */
function fakeDeps(initial: Record<string, { title: string; metadata?: Record<string, unknown> }>) {
  const store = new Map(Object.entries(initial).map(([id, s]) => [id, { title: s.title, metadata: { ...(s.metadata ?? {}) } as Record<string, any> }]));
  const deps: CardNamingAdoptionDeps = {
    adoptCardIdentity: vi.fn(async (sessionId: string, identity: CardSessionIdentity, { expectedTitle }: { expectedTitle: string }) => {
      const s = store.get(sessionId);
      if (!s) return { status: 'missing' as const };
      if (s.metadata.namingMode) return { status: 'already-adopted' as const, title: s.title };
      if (s.title !== expectedTitle) return { status: 'conflict' as const, title: s.title };
      const title = buildCardSessionTitle(identity);
      s.metadata = { ...s.metadata, namingMode: 'card', cardIdentity: identity, cardNamingAdoption: { previousTitle: s.title, adoptedTitle: title } };
      s.title = title;
      return { status: 'applied' as const, title };
    }),
    undoCardIdentityAdoption: vi.fn(async (sessionId: string) => {
      const s = store.get(sessionId);
      if (!s) return { status: 'missing' as const };
      const record = s.metadata.cardNamingAdoption;
      if (!record) return { status: 'not-adopted' as const, title: s.title };
      if (s.metadata.namingMode !== 'card' || s.title !== record.adoptedTitle) return { status: 'conflict' as const, title: s.title };
      s.title = record.previousTitle;
      s.metadata = { ...s.metadata, namingMode: null, cardIdentity: null, cardNamingAdoption: null };
      return { status: 'restored' as const, title: s.title };
    }),
    notifyAdopted: vi.fn(),
    notifyRestored: vi.fn(),
  };
  return { deps, store };
}

function sessionRow(id: string, title: string, metadata: Record<string, unknown>, createdAt = '2026-10-27T10:00:00.000Z') {
  return { id, title, created_at: createdAt, is_archived: 0, parent_session_id: null, created_by_session_id: null, metadata: JSON.stringify(metadata) };
}

describe('toAdoptionInputs', () => {
  it('maps a link stored under a row id to the card and reads both date forms', () => {
    const { sessions } = toAdoptionInputs(
      [
        sessionRow('b', 'Later', { linkedTrackerItemIds: ['row-1', 'task_1'] }, '2026-10-27T12:00:00.000Z'),
        { ...sessionRow('a', 'Earlier', {}), created_at: new Date('2026-10-27T09:00:00.000Z') },
      ],
      [{ ...card, aliases: ['row-1'] }],
    );
    expect(sessions.map(s => s.id)).toEqual(['a', 'b']);
    expect((sessions[1].metadata as any).linkedTrackerItemIds).toEqual(['task_1']);
  });
});

describe('applyCardNamingAdoption', () => {
  const linked = { linkedTrackerItemIds: ['task_1'] };

  it('adopts with the title unchanged, then changes nothing on a second run', async () => {
    const inputs = toAdoptionInputs([sessionRow('s1', plainTitle, linked)], [card]);
    const { deps, store } = fakeDeps({ s1: { title: plainTitle, metadata: linked } });
    const request = { sessionId: 's1', expectedTitle: plainTitle, primaryTrackerId: 'task_1', purpose: 'Implementation' };

    const [first] = await applyCardNamingAdoption([request], inputs, deps);
    expect(first).toMatchObject({ status: 'applied', title: plainTitle, previousTitle: plainTitle });
    expect(deps.notifyAdopted).toHaveBeenCalledTimes(1);
    expect(store.get('s1')!.metadata.linkedTrackerItemIds).toEqual(['task_1']);

    const reread = toAdoptionInputs([sessionRow('s1', store.get('s1')!.title, store.get('s1')!.metadata)], [card]);
    const [second] = await applyCardNamingAdoption([request], reread, deps);
    expect(second.status).toBe('already-adopted');
    expect(deps.notifyAdopted).toHaveBeenCalledTimes(1);
    expect(previewCardNamingAdoption(reread.sessions, reread.cards).counts).toEqual({ total: 1, keep: 1 });
  });

  it('refuses when the title changed after the preview', async () => {
    const inputs = toAdoptionInputs([sessionRow('s1', 'Renamed by hand', linked)], [card]);
    const { deps, store } = fakeDeps({ s1: { title: 'Renamed by hand', metadata: linked } });
    const [result] = await applyCardNamingAdoption(
      [{ sessionId: 's1', expectedTitle: plainTitle, primaryTrackerId: 'task_1', purpose: 'Implementation' }],
      inputs,
      deps,
    );
    expect(result.status).toBe('conflict');
    expect(store.get('s1')!.title).toBe('Renamed by hand');
    expect(deps.notifyAdopted).not.toHaveBeenCalled();
  });

  it('never adds a card link', async () => {
    const inputs = toAdoptionInputs([sessionRow('s1', plainTitle, {})], [card]);
    const { deps } = fakeDeps({ s1: { title: plainTitle } });
    const [result] = await applyCardNamingAdoption(
      [{ sessionId: 's1', expectedTitle: plainTitle, primaryTrackerId: 'task_1', purpose: 'Implementation' }],
      inputs,
      deps,
    );
    expect(result.status).toBe('not-linked');
    expect(deps.adoptCardIdentity).not.toHaveBeenCalled();
  });

  it('refuses a purpose another chat on the card holds, including one adopted earlier in the batch', async () => {
    const inputs = toAdoptionInputs(
      [sessionRow('s1', plainTitle, linked), sessionRow('s2', plainTitle, linked, '2026-10-27T11:00:00.000Z')],
      [card],
    );
    const { deps } = fakeDeps({ s1: { title: plainTitle, metadata: linked }, s2: { title: plainTitle, metadata: linked } });
    const results = await applyCardNamingAdoption(
      ['s1', 's2'].map(sessionId => ({ sessionId, expectedTitle: plainTitle, primaryTrackerId: 'task_1', purpose: 'Implementation' })),
      inputs,
      deps,
    );
    expect(results.map(r => r.status)).toEqual(['applied', 'purpose-taken']);
  });

  it('applies a numbered name the owner approved', async () => {
    const inputs = toAdoptionInputs(
      [sessionRow('s1', plainTitle, linked), sessionRow('s2', plainTitle, linked, '2026-10-27T11:00:00.000Z')],
      [card],
    );
    const plan = previewCardNamingAdoption(inputs.sessions, inputs.cards).entries;
    expect(plan.find(e => e.sessionId === 's2')).toMatchObject({ action: 'adopt-renamed', needsDecision: true });
    const { deps, store } = fakeDeps({ s1: { title: plainTitle, metadata: linked }, s2: { title: plainTitle, metadata: linked } });
    const results = await applyCardNamingAdoption(
      plan.filter(e => e.identity).map(e => ({ sessionId: e.sessionId, expectedTitle: e.title, primaryTrackerId: e.identity!.primaryTrackerId, purpose: e.identity!.purpose })),
      inputs,
      deps,
    );
    expect(results.map(r => r.status)).toEqual(['applied', 'applied']);
    expect(store.get('s2')!.title).toBe('SYN-1 · SYNTHETIC Adopt existing chats — Implementation 2');
  });

  it('reports every request when naming is unavailable', async () => {
    const inputs = toAdoptionInputs([sessionRow('s1', plainTitle, linked)], [card]);
    const results = await applyCardNamingAdoption(
      [{ sessionId: 's1', expectedTitle: plainTitle, primaryTrackerId: 'task_1', purpose: 'Implementation' }, { sessionId: 'nope', expectedTitle: 'x', primaryTrackerId: 'task_1', purpose: 'x' }],
      inputs,
      null,
    );
    expect(results.map(r => r.status)).toEqual(['unavailable', 'unavailable']);
  });
});

describe('undoCardNamingAdoption', () => {
  it('restores an adopted session and refuses one renamed since', async () => {
    const linked = { linkedTrackerItemIds: ['task_1'] };
    const { deps, store } = fakeDeps({
      s1: { title: 'Old name', metadata: linked },
      s2: { title: 'Old name 2', metadata: linked },
    });
    const identity = { primaryTrackerId: 'task_1', issueKey: 'SYN-1', cardTitle: card.title, purpose: 'Implementation' };
    await deps.adoptCardIdentity('s1', identity, { expectedTitle: 'Old name' });
    await deps.adoptCardIdentity('s2', { ...identity, purpose: 'Review' }, { expectedTitle: 'Old name 2' });
    store.get('s2')!.title = 'User renamed it';

    const results = await undoCardNamingAdoption(['s1', 's2', 's3'], deps);
    expect(results.map(r => r.status)).toEqual(['restored', 'conflict', 'missing']);
    expect(store.get('s1')!.title).toBe('Old name');
    expect(store.get('s2')!.title).toBe('User renamed it');
    expect(deps.notifyRestored).toHaveBeenCalledTimes(1);
    expect(deps.notifyRestored).toHaveBeenCalledWith('s1', 'Old name');
  });
});

describe('ADOPTION_SESSIONS_QUERY', () => {
  it('reads one workspace, archived sessions included, on real PGLite', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, is_archived BOOLEAN DEFAULT FALSE,
        parent_session_id TEXT, created_by_session_id TEXT, metadata JSONB DEFAULT '{}')`);
      await pg.query(
        `INSERT INTO ai_sessions (id, workspace_id, title, is_archived, metadata) VALUES
          ($1, '/ws', $2, FALSE, $3::jsonb), ($4, '/ws', 'Archived', TRUE, '{}'::jsonb), ($5, '/other', 'Elsewhere', FALSE, '{}'::jsonb)`,
        ['s1', plainTitle, JSON.stringify({ linkedTrackerItemIds: ['task_1'] }), 's2', 's3'],
      );
      const { rows } = await pg.query<Record<string, unknown>>(ADOPTION_SESSIONS_QUERY, ['/ws']);
      const { sessions } = toAdoptionInputs(rows, [card]);
      expect(sessions.map(s => s.id).sort()).toEqual(['s1', 's2']);
      expect(sessions.find(s => s.id === 's2')!.isArchived).toBe(true);
      expect(sessions.find(s => s.id === 's1')!.createdAt).toBeGreaterThan(0);
      expect(previewCardNamingAdoption(sessions, [card]).entries.find(e => e.sessionId === 's1')).toMatchObject({ group: 'direct', action: 'adopt' });
    } finally {
      await pg.close();
    }
  });
});
