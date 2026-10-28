import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../SessionManager';
import type {
  SessionStore,
  CreateSessionPayload,
  SessionMeta,
  UpdateSessionMetadataPayload,
} from '../../adapters/sessionStore';
import { shouldBlockStartedSessionProviderSwitch, type SessionData, type TranscriptViewMessage } from '../types';

class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async ensureReady(): Promise<void> {}

  async create(payload: CreateSessionPayload): Promise<void> {
    const now = Date.now();
    this.sessions.set(payload.id, {
      id: payload.id,
      provider: payload.provider,
      model: payload.model,
      title: payload.title,
      draftInput: undefined,
      messages: [],
      createdAt: now,
      updatedAt: now,
      metadata: {
        workspaceId: payload.workspaceId,
        filePath: payload.filePath,
        documentContext: payload.documentContext,
        providerConfig: payload.providerConfig,
        providerSessionId: payload.providerSessionId,
      },
    });
  }

  async appendMessage(sessionId: string, message: TranscriptViewMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    session.messages.push(message);
    session.updatedAt = Date.now();
  }

  async replaceMessages(sessionId: string, messages: TranscriptViewMessage[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    session.messages = [...messages];
    session.updatedAt = Date.now();
  }

  async updateMetadata(sessionId: string, metadata: UpdateSessionMetadataPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    session.metadata = {
      ...(session.metadata ?? {}),
      ...metadata,
    } as SessionData['metadata'];
    if (metadata.draftInput !== undefined) {
      session.draftInput = metadata.draftInput;
    }
    session.updatedAt = Date.now();
  }

  async get(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  private toMeta(session: SessionData): SessionMeta {
    return {
      id: session.id,
      provider: session.provider,
      model: session.model,
      title: session.title || 'Untitled Session',
      sessionType: session.sessionType || 'session',
      workspaceId: (session.metadata as any)?.workspaceId || '',
      worktreeId: session.worktreeId || null,
      parentSessionId: session.parentSessionId || null,
      childCount: 0,
      uncommittedCount: 0,
      createdAt: session.createdAt || 0,
      updatedAt: session.updatedAt || 0,
      messageCount: session.messages.length,
      isArchived: session.isArchived || false,
      isPinned: session.isPinned || false,
    };
  }

  async list(workspaceId: string): Promise<SessionMeta[]> {
    return [...this.sessions.values()]
      .filter(session => (session.metadata as any)?.workspaceId === workspaceId)
      .map(session => this.toMeta(session))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async search(workspaceId: string, query: string): Promise<SessionMeta[]> {
    // Simple in-memory search for testing
    if (!query || query.trim().length === 0) {
      return this.list(workspaceId);
    }

    const lowerQuery = query.toLowerCase();
    return [...this.sessions.values()]
      .filter(session => {
        if ((session.metadata as any)?.workspaceId !== workspaceId) {
          return false;
        }
        // Search in title
        if (session.title?.toLowerCase().includes(lowerQuery)) {
          return true;
        }
        // Search in messages
        return session.messages.some(msg => {
          const content = msg.text ?? '';
          return content.toLowerCase().includes(lowerQuery);
        });
      })
      .map(session => this.toMeta(session))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

describe('SessionManager (runtime server)', () => {
  let store: InMemorySessionStore;
  let manager: SessionManager;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    manager = new SessionManager(store);
    await manager.initialize();
  });

  it('persists inherited worktree, parent and manager together when creating a phone child', async () => {
    const insert = vi.spyOn(store, 'create');
    const session = await manager.createSession('claude-code', undefined, 'ws', undefined, 'claude-code:opus', 'session', 'agent', 'wt', '/ws/wt', 'ws', 'standard', 'parent', undefined, 'parent');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: 'parent', createdBySessionId: 'parent', worktreeId: 'wt', workspaceId: 'ws' }));
    expect(session).toMatchObject({ parentSessionId: 'parent', createdBySessionId: 'parent', worktreeId: 'wt' });
  });

  it('returns persisted tool messages when listing sessions', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');

    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);
    await manager.addMessage({
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolCall: {
        name: 'applyDiff',
        arguments: { replacements: [{ oldText: 'a', newText: 'b' }] },
        result: { success: true },
      },
    }, session.id);

    const sessions = await manager.getSessions('ws');
    expect(sessions).toHaveLength(1);
    expect(Array.isArray(sessions[0].messages)).toBe(true);
  });

  it('carries a caller-assigned name through loadSession, including the SQLite 0/1 flag', async () => {
    // The streaming handler decides the provisional title and the agent's
    // naming prompt from the loaded session, so a dropped flag re-titles a
    // session that was named at creation (spawn_session, extension-owned).
    // The transcript store is not under test; the row mapping is.
    vi.spyOn(manager as unknown as { loadCanonicalTranscript: () => Promise<unknown[]> }, 'loadCanonicalTranscript')
      .mockResolvedValue([]);
    const named = await manager.createSession('openai-codex', { content: 'text' }, 'ws');
    (await store.get(named.id))!.hasBeenNamed = 1 as unknown as boolean;
    expect((await manager.loadSession(named.id, 'ws'))?.hasBeenNamed).toBe(true);

    const unnamed = await manager.createSession('openai-codex', { content: 'text' }, 'ws');
    (await store.get(unnamed.id))!.hasBeenNamed = 0 as unknown as boolean;
    expect((await manager.loadSession(unnamed.id, 'ws'))?.hasBeenNamed).toBe(false);
  });

  it('blocks switching a started Claude Agent session to OpenAI Codex', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);

    await expect(
      manager.updateSessionProviderAndModel(session.id, 'openai-codex', 'openai-codex:openai-codex-cli')
    ).rejects.toThrow('Start a new session instead');
  });

  it('blocks switching a started Claude Agent session via model-only update', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);

    await expect(
      manager.updateSessionModel(session.id, 'openai-codex:openai-codex-cli')
    ).rejects.toThrow('Start a new session instead');
  });

  it('allows switching models within the same provider after a session has started', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.addMessage({ role: 'user', content: 'hello', timestamp: Date.now() }, session.id);

    await expect(
      manager.updateSessionProviderAndModel(session.id, 'claude-code', 'claude-code:opus')
    ).resolves.toBeUndefined();
  });

  it('only blocks started provider switches when an agent provider is involved', () => {
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'openai-codex', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('openai-codex', 'claude-code', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'claude', true)).toBe(true);
    expect(shouldBlockStartedSessionProviderSwitch('claude', 'openai', true)).toBe(false);
    expect(shouldBlockStartedSessionProviderSwitch('claude-code', 'openai-codex', false)).toBe(false);
  });

});

// NIM-2308 / GH #1098: when a provider reports its session expired, the dead
// provider session id must actually leave the database. The real store guards
// every column with `!== undefined`, so a clear expressed as `undefined` is
// dropped on the floor -- and the next prompt resumes the dead id again,
// looping the "conversation session has expired" error forever.
describe('SessionManager.updateProviderSessionData clears', () => {
  /** Mirrors PGLiteSessionStore.updateMetadata's `!== undefined` column guard. */
  class GuardedSessionStore extends InMemorySessionStore {
    readonly payloads: UpdateSessionMetadataPayload[] = [];

    async updateMetadata(sessionId: string, metadata: UpdateSessionMetadataPayload): Promise<void> {
      this.payloads.push(metadata);
      const applied = { ...metadata };
      for (const key of Object.keys(applied) as Array<keyof UpdateSessionMetadataPayload>) {
        if (applied[key] === undefined) delete applied[key];
      }
      await super.updateMetadata(sessionId, applied);
    }
  }

  let store: GuardedSessionStore;
  let manager: SessionManager;

  beforeEach(async () => {
    store = new GuardedSessionStore();
    manager = new SessionManager(store);
    await manager.initialize();
  });

  it('sends an explicit null so the column is actually written', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.updateProviderSessionData(session.id, 'claude-session-abc');

    await manager.updateProviderSessionData(session.id, undefined);

    const clearPayload = store.payloads.at(-1);
    expect(clearPayload).toEqual({ providerSessionId: null });
  });

  it('leaves no provider session id behind for the next turn to resume', async () => {
    const session = await manager.createSession('claude-code', { content: 'text' }, 'ws');
    await manager.updateProviderSessionData(session.id, 'claude-session-abc');

    await manager.updateProviderSessionData(session.id, undefined);

    const persisted = await store.get(session.id);
    expect(persisted?.metadata?.providerSessionId ?? null).toBeNull();
  });
});

/**
 * Mirrors PGLiteSessionStore.updateMetadata for naming: `title` and
 * `hasBeenNamed` are columns and `metadata` is shallow-merged JSON.
 */
class NamingSessionStore extends InMemorySessionStore {
  readonly rows = new Map<string, { title: string; hasBeenNamed: boolean; metadata: Record<string, unknown> }>();

  async create(payload: CreateSessionPayload): Promise<void> {
    await super.create(payload);
    this.rows.set(payload.id, { title: payload.title ?? 'Untitled', hasBeenNamed: payload.hasBeenNamed ?? false, metadata: {} });
  }

  async updateMetadata(sessionId: string, update: UpdateSessionMetadataPayload): Promise<void> {
    const row = this.rows.get(sessionId);
    if (!row) throw new Error('Session not found');
    if (update.title !== undefined) row.title = update.title;
    if (update.hasBeenNamed !== undefined) row.hasBeenNamed = update.hasBeenNamed;
    if (update.metadata !== undefined) row.metadata = { ...row.metadata, ...update.metadata };
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const session = await super.get(sessionId);
    const row = this.rows.get(sessionId);
    if (!session || !row) return null;
    return { ...session, title: row.title, hasBeenNamed: row.hasBeenNamed, metadata: row.metadata };
  }

  async updateTitleIfNotNamed(sessionId: string, title: string): Promise<boolean> {
    const row = this.rows.get(sessionId);
    if (!row || row.hasBeenNamed) return false;
    row.title = title;
    row.hasBeenNamed = true;
    return true;
  }
}

describe('SessionManager card-linked naming', () => {
  const card = { primaryTrackerId: 'delivery-slice_20', issueKey: 'LEO-20', cardTitle: 'Keep card-linked chat names correct automatically' };
  let store: NamingSessionStore;
  let manager: SessionManager;

  async function createSession(id: string): Promise<void> {
    await store.create({ id, provider: 'claude-code', model: 'claude-code:opus', title: 'New Session', workspaceId: 'ws' } as CreateSessionPayload);
  }

  beforeEach(async () => {
    store = new NamingSessionStore();
    manager = new SessionManager(store);
    await manager.initialize();
    await createSession('s1');
  });

  it('names the session from the card and marks it named before the first turn', async () => {
    const title = await manager.setCardIdentity('s1', { ...card, purpose: 'Implementation' });

    expect(title).toBe('LEO-20 · Keep card-linked chat names correct automatically — Implementation');
    expect(store.rows.get('s1')).toMatchObject({
      title,
      hasBeenNamed: true,
      metadata: { namingMode: 'card', cardIdentity: { ...card, purpose: 'Implementation' } },
    });
  });

  it('keeps a SYNTHETIC purpose through agent, provisional and auto-namer writes', async () => {
    const title = await manager.setCardIdentity('s1', { ...card, purpose: 'SYNTHETIC Codex check' });

    await expect(manager.updateSessionTitle('s1', 'Codex naming check', { force: true, markAsNamed: true, source: 'agent' })).resolves.toBe(false);
    await expect(manager.updateSessionTitle('s1', 'implement tracker item LEO-20', { force: true, markAsNamed: false, source: 'provisional' })).resolves.toBe(false);
    await expect(manager.updateSessionTitle('s1', 'Summary title', { force: true, markAsNamed: true })).resolves.toBe(false);

    expect(store.rows.get('s1')).toMatchObject({ title, hasBeenNamed: true });
    expect(title).toContain('SYNTHETIC Codex check');
  });

  it('treats a user rename as a custom name that agents cannot replace', async () => {
    await manager.setCardIdentity('s1', { ...card, purpose: 'Implementation' });

    await expect(manager.updateSessionTitle('s1', 'My own name', { force: true, markAsNamed: true, source: 'user' })).resolves.toBe(true);
    await expect(manager.updateSessionTitle('s1', 'Agent name', { force: true, markAsNamed: true, source: 'agent' })).resolves.toBe(false);

    expect(store.rows.get('s1')).toMatchObject({
      title: 'My own name',
      metadata: { namingMode: 'custom', cardIdentity: { ...card, purpose: 'Implementation' } },
    });
  });

  it('returns a custom-named session to the card name', async () => {
    await manager.setCardIdentity('s1', { ...card, purpose: 'Implementation' });
    await manager.updateSessionTitle('s1', 'My own name', { force: true, markAsNamed: true, source: 'user' });

    // Only the user switches a custom name back (the identity editor's request).
    await manager.setCardIdentity('s1', { ...card, purpose: 'Implementation' }, { source: 'user' });

    expect(store.rows.get('s1')).toMatchObject({
      title: 'LEO-20 · Keep card-linked chat names correct automatically — Implementation',
      metadata: { namingMode: 'card' },
    });
  });

  it('gives two chats on one card a common base and distinct purposes', async () => {
    await createSession('s2');

    const implementation = await manager.setCardIdentity('s1', { ...card, purpose: 'Implementation' });
    const review = await manager.setCardIdentity('s2', { ...card, purpose: 'Independent review' });

    expect(implementation).toBe('LEO-20 · Keep card-linked chat names correct automatically — Implementation');
    expect(review).toBe('LEO-20 · Keep card-linked chat names correct automatically — Independent review');
  });

  it('still refuses agent renames after a restart', async () => {
    const title = await manager.setCardIdentity('s1', { ...card, purpose: 'Implementation' });

    const restarted = new SessionManager(store);
    await restarted.initialize();

    await expect(restarted.updateSessionTitle('s1', 'Agent name', { force: true, markAsNamed: true, source: 'agent' })).resolves.toBe(false);
    expect(store.rows.get('s1')?.title).toBe(title);
  });

  it('leaves sessions without a card identity on the existing naming path', async () => {
    await expect(manager.updateSessionTitle('s1', 'Agent name', { force: true, markAsNamed: true, source: 'agent' })).resolves.toBe(true);
    await expect(manager.updateSessionTitle('s1', 'User name', { force: true, markAsNamed: true, source: 'user' })).resolves.toBe(true);

    expect(store.rows.get('s1')).toMatchObject({ title: 'User name', metadata: {} });
  });
});

describe('SessionManager card naming adoption', () => {
  // SYNTHETIC fixtures: invented cards and sessions, not real chats.
  const card = { primaryTrackerId: 'delivery-slice_syn', issueKey: 'SYN-22', cardTitle: 'SYNTHETIC adoption card' };
  const title = 'SYN-22 · SYNTHETIC adoption card — Implementation';
  const identity = { ...card, purpose: 'Implementation' };
  const otherMetadata = { linkedTrackerItemIds: ['delivery-slice_syn', 'delivery-slice_other'], tags: ['feature'], phase: 'validating' };
  let store: NamingSessionStore;
  let manager: SessionManager;

  beforeEach(async () => {
    store = new NamingSessionStore();
    manager = new SessionManager(store);
    await manager.initialize();
    await store.create({ id: 's1', provider: 'claude-code', model: 'claude-code:opus', title, workspaceId: 'ws', hasBeenNamed: true } as CreateSessionPayload);
    store.rows.get('s1')!.metadata = { ...otherMetadata };
    await store.appendMessage('s1', { id: 'm1', type: 'user_message', text: 'hello' } as unknown as TranscriptViewMessage);
  });

  it('adopts the card identity without changing the title, links, tags or transcript', async () => {
    await expect(manager.adoptCardIdentity('s1', identity, { expectedTitle: title })).resolves.toEqual({ status: 'applied', title });

    const row = store.rows.get('s1')!;
    expect(row).toMatchObject({ title, hasBeenNamed: true, metadata: { ...otherMetadata, namingMode: 'card', cardIdentity: identity } });
    expect(row.metadata.cardNamingAdoption).toMatchObject({ previousTitle: title, previousHasBeenNamed: true, adoptedTitle: title });
    expect((await store.get('s1'))?.messages).toHaveLength(1);
    // Now protected like a launched card chat.
    await expect(manager.updateSessionTitle('s1', 'Agent summary', { force: true, markAsNamed: true, source: 'agent' })).resolves.toBe(false);
  });

  it('writes nothing when the title changed after the preview', async () => {
    store.rows.get('s1')!.title = 'Renamed after preview';

    await expect(manager.adoptCardIdentity('s1', identity, { expectedTitle: title })).resolves.toEqual({ status: 'conflict', title: 'Renamed after preview' });
    expect(store.rows.get('s1')!.metadata).toEqual(otherMetadata);
  });

  it('changes nothing on a second run', async () => {
    await manager.adoptCardIdentity('s1', identity, { expectedTitle: title });
    const after = structuredClone(store.rows.get('s1'));
    const update = vi.spyOn(store, 'updateMetadata');

    await expect(manager.adoptCardIdentity('s1', identity, { expectedTitle: title })).resolves.toEqual({ status: 'already-adopted', title });
    expect(update).not.toHaveBeenCalled();
    expect(store.rows.get('s1')).toEqual(after);
  });

  it('records the old name when an approved adoption renumbers the purpose', async () => {
    const renumbered = { ...card, purpose: 'Implementation 2' };

    await expect(manager.adoptCardIdentity('s1', renumbered, { expectedTitle: title }))
      .resolves.toEqual({ status: 'applied', title: 'SYN-22 · SYNTHETIC adoption card — Implementation 2' });
    expect(store.rows.get('s1')!.metadata.cardNamingAdoption).toMatchObject({ previousTitle: title });
  });

  it('undoes an adoption back to the previous name and naming behavior', async () => {
    await manager.adoptCardIdentity('s1', { ...card, purpose: 'Implementation 2' }, { expectedTitle: title });

    await expect(manager.undoCardIdentityAdoption('s1')).resolves.toEqual({ status: 'restored', title });

    const row = store.rows.get('s1')!;
    expect(row).toMatchObject({ title, hasBeenNamed: true, metadata: { ...otherMetadata, namingMode: null, cardIdentity: null, cardNamingAdoption: null } });
    expect((await store.get('s1'))?.messages).toHaveLength(1);
    await expect(manager.undoCardIdentityAdoption('s1')).resolves.toEqual({ status: 'not-adopted', title });
    // Back on the pre-adoption path: an agent may rename again.
    await expect(manager.updateSessionTitle('s1', 'Agent summary', { force: true, markAsNamed: true, source: 'agent' })).resolves.toBe(true);
  });

  it('refuses to undo over a rename made after the adoption', async () => {
    await manager.adoptCardIdentity('s1', identity, { expectedTitle: title });
    await manager.updateSessionTitle('s1', 'My own name', { force: true, markAsNamed: true, source: 'user' });

    await expect(manager.undoCardIdentityAdoption('s1')).resolves.toEqual({ status: 'conflict', title: 'My own name' });
    expect(store.rows.get('s1')).toMatchObject({ title: 'My own name', metadata: { namingMode: 'custom' } });
  });

  it('reports a missing session', async () => {
    await expect(manager.adoptCardIdentity('nope', identity, { expectedTitle: title })).resolves.toEqual({ status: 'missing' });
    await expect(manager.undoCardIdentityAdoption('nope')).resolves.toEqual({ status: 'missing' });
  });
});

/** Holds the next metadata write until released, to interleave a second writer. */
class PausableNamingStore extends NamingSessionStore {
  private hold: { reached: () => void; release: Promise<void> } | null = null;
  private releaseHold: (() => void) | null = null;

  /** The next updateMetadata stops before writing; resolves once it is held. */
  pauseNextWrite(): Promise<void> {
    return new Promise((reached) => {
      const release = new Promise<void>((resolve) => { this.releaseHold = resolve; });
      this.hold = { reached, release };
    });
  }

  release(): void {
    this.releaseHold?.();
  }

  async updateMetadata(sessionId: string, update: UpdateSessionMetadataPayload): Promise<void> {
    const hold = this.hold;
    if (hold) {
      this.hold = null;
      hold.reached();
      await hold.release;
    }
    await super.updateMetadata(sessionId, update);
  }
}

describe('SessionManager naming writes under concurrency', () => {
  // SYNTHETIC fixtures: invented cards and sessions, not real chats.
  const card = { primaryTrackerId: 'delivery-slice_syn', issueKey: 'SYN-23', cardTitle: 'SYNTHETIC concurrency card' };
  const identity = { ...card, purpose: 'Implementation' };
  const cardTitle = 'SYN-23 · SYNTHETIC concurrency card — Implementation';
  let store: PausableNamingStore;
  let manager: SessionManager;

  beforeEach(async () => {
    store = new PausableNamingStore();
    manager = new SessionManager(store);
    await manager.initialize();
    await store.create({ id: 's1', provider: 'claude-code', model: 'claude-code:opus', title: 'Original', workspaceId: 'ws', hasBeenNamed: true } as CreateSessionPayload);
  });

  /** Start `rename` while another write is held, give it time to land, then release. */
  async function renameDuringHeldWrite(held: Promise<unknown>, rename: () => Promise<unknown>): Promise<void> {
    const pending = rename();
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 50))]);
    store.release();
    await held;
    await pending;
  }

  it('keeps a user rename that arrives while an adoption is writing', async () => {
    const paused = store.pauseNextWrite();
    const adoption = manager.adoptCardIdentity('s1', identity, { expectedTitle: 'Original' });
    await paused;
    await renameDuringHeldWrite(adoption, () => manager.updateSessionTitle('s1', 'Human custom name', { force: true, markAsNamed: true, source: 'user' }));

    await expect(adoption).resolves.toEqual({ status: 'applied', title: cardTitle });
    expect(store.rows.get('s1')).toMatchObject({ title: 'Human custom name', metadata: { namingMode: 'custom' } });
  });

  it('keeps a user rename that arrives while an undo is writing', async () => {
    await manager.adoptCardIdentity('s1', identity, { expectedTitle: 'Original' });
    const paused = store.pauseNextWrite();
    const undo = manager.undoCardIdentityAdoption('s1');
    await paused;
    await renameDuringHeldWrite(undo, () => manager.updateSessionTitle('s1', 'Human custom name', { force: true, markAsNamed: true, source: 'user' }));

    await expect(undo).resolves.toEqual({ status: 'restored', title: 'Original' });
    expect(store.rows.get('s1')!.title).toBe('Human custom name');
  });

  it('keeps a user rename that arrives while an automatic retitle is writing', async () => {
    await manager.setCardIdentity('s1', identity, { source: 'user' });
    const paused = store.pauseNextWrite();
    const retitle = manager.setCardIdentity('s1', { ...identity, cardTitle: 'Card renamed' }, { expectedPrimaryTrackerId: card.primaryTrackerId });
    await paused;
    await renameDuringHeldWrite(retitle, () => manager.updateSessionTitle('s1', 'Human custom name', { force: true, markAsNamed: true, source: 'user' }));

    expect(store.rows.get('s1')).toMatchObject({ title: 'Human custom name', metadata: { namingMode: 'custom' } });
  });

  it('lets only the user switch a custom name back to the card name', async () => {
    await manager.setCardIdentity('s1', identity, { source: 'user' });
    await manager.updateSessionTitle('s1', 'Human custom name', { force: true, markAsNamed: true, source: 'user' });

    await expect(manager.setCardIdentity('s1', { ...identity, cardTitle: 'Card renamed' })).resolves.toBeNull();
    expect(store.rows.get('s1')).toMatchObject({ title: 'Human custom name', metadata: { namingMode: 'custom' } });

    await expect(manager.setCardIdentity('s1', identity, { source: 'user' })).resolves.toBe(cardTitle);
    expect(store.rows.get('s1')).toMatchObject({ title: cardTitle, metadata: { namingMode: 'card' } });
  });

  it('skips an automatic retitle once the primary card changed', async () => {
    await manager.setCardIdentity('s1', { ...identity, primaryTrackerId: 'delivery-slice_other' }, { source: 'user' });
    const before = store.rows.get('s1')!.title;

    await expect(manager.setCardIdentity('s1', identity, { expectedPrimaryTrackerId: card.primaryTrackerId })).resolves.toBeNull();
    expect(store.rows.get('s1')!.title).toBe(before);
  });
});
