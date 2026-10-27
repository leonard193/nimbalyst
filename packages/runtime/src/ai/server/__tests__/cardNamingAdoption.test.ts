// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  planCardNamingAdoption,
  purposeFromCardTitle,
  type AdoptionCardInput,
  type AdoptionSessionInput,
} from '../cardNamingAdoption';

// SYNTHETIC fixtures: invented cards and sessions, not real chats.
const cards: AdoptionCardInput[] = [
  { id: 'card-1', issueKey: 'SYN-1', title: 'SYNTHETIC access acceptance' },
  { id: 'card-2', issueKey: 'SYN-2', title: 'S01 · Reconcile the plan' },
  { id: 'card-3', issueKey: 'SYN-3', title: 'Naming rule' },
  { id: 'draft', title: 'Unpublished draft card' },
];

let created = 0;
function session(id: string, title: string, extra: Partial<AdoptionSessionInput> & { links?: string[]; meta?: Record<string, unknown> } = {}): AdoptionSessionInput {
  const { links, meta, ...rest } = extra;
  created += 1;
  return {
    id,
    title,
    createdAt: created,
    metadata: { ...(links ? { linkedTrackerItemIds: links } : {}), tags: ['kept'], ...meta },
    ...rest,
  };
}

function byId(entries: ReturnType<typeof planCardNamingAdoption>) {
  return new Map(entries.map(entry => [entry.sessionId, entry]));
}

describe('purposeFromCardTitle', () => {
  it('reads the purpose only from an exact card name', () => {
    expect(purposeFromCardTitle('SYN-3 · Naming rule — Independent review 2', cards[2])).toBe('Independent review 2');
    expect(purposeFromCardTitle('SYN-3 · Naming rule', cards[2])).toBeUndefined();
    expect(purposeFromCardTitle('SYN-3 · Naming rules — Implementation', cards[2])).toBeUndefined();
    expect(purposeFromCardTitle('Unpublished draft card — Bootstrap', cards[3])).toBe('Bootstrap');
  });
});

describe('planCardNamingAdoption', () => {
  it('adopts a single-link chat whose name is already its card name, keeping the title', () => {
    const plan = planCardNamingAdoption([session('a', 'SYN-3 · Naming rule — Implementation', { links: ['card-3'] })], cards);

    expect(plan[0]).toMatchObject({
      group: 'direct',
      action: 'adopt',
      needsDecision: false,
      proposedTitle: 'SYN-3 · Naming rule — Implementation',
      identity: { primaryTrackerId: 'card-3', issueKey: 'SYN-3', cardTitle: 'Naming rule', purpose: 'Implementation' },
    });
  });

  it('uses the title alone for a card without a key', () => {
    const plan = planCardNamingAdoption([session('a', 'Unpublished draft card — Bootstrap', { links: ['draft'] })], cards);

    expect(plan[0]).toMatchObject({ action: 'adopt', identity: { primaryTrackerId: 'draft', cardTitle: 'Unpublished draft card', purpose: 'Bootstrap' } });
    expect(plan[0].identity).not.toHaveProperty('issueKey');
  });

  it('does not treat a key prefix in the name as a link', () => {
    const plan = planCardNamingAdoption([session('a', 'SYN-3 · Naming rule — Implementation')], cards);

    expect(plan[0]).toMatchObject({ group: 'general', action: 'keep', proposedTitle: 'SYN-3 · Naming rule — Implementation' });
  });

  it('keeps a linked chat with a custom name', () => {
    const plan = planCardNamingAdoption([session('a', 'Fresh-session resumption check', { links: ['card-3'] })], cards);

    expect(plan[0]).toMatchObject({ group: 'direct', action: 'keep', needsDecision: false, proposedTitle: 'Fresh-session resumption check' });
  });

  it('keeps a workstream child or a spawned chat as an association, never a link', () => {
    const plan = byId(planCardNamingAdoption([
      session('parent', 'SYN-1 · SYNTHETIC access acceptance — Codex test', { links: ['card-1'] }),
      session('child', 'SYN-1 · SYNTHETIC · Experts — Baseline', { parentSessionId: 'parent' }),
      session('spawned', 'SYN-1 · SYNTHETIC access acceptance — SYNTHETIC Claude check', { createdBySessionId: 'parent' }),
    ], cards));

    expect(plan.get('child')).toMatchObject({ group: 'associated', action: 'keep', synthetic: true, proposedTitle: 'SYN-1 · SYNTHETIC · Experts — Baseline' });
    expect(plan.get('child')!.reason).toContain('workstream parent');
    expect(plan.get('spawned')).toMatchObject({ group: 'associated', action: 'keep' });
    expect(plan.get('spawned')!.reason).toContain('creating session');
  });

  it('keeps a SYNTHETIC purpose exactly when adopting', () => {
    const plan = planCardNamingAdoption([session('a', 'SYN-2 · S01 · Reconcile the plan — SYNTHETIC MCP recheck', { links: ['card-2'] })], cards);

    expect(plan[0]).toMatchObject({ action: 'adopt', synthetic: true, proposedTitle: 'SYN-2 · S01 · Reconcile the plan — SYNTHETIC MCP recheck' });
    expect(plan[0].identity?.purpose).toBe('SYNTHETIC MCP recheck');
  });

  it('asks which card is primary when a chat links several', () => {
    const plan = planCardNamingAdoption([
      session('a', 'SYN-2 · S01 · Reconcile the plan — Planning', { links: ['draft', 'card-2', 'card-3'] }),
    ], cards);

    expect(plan[0]).toMatchObject({ group: 'ambiguous', action: 'keep', needsDecision: true, proposedTitle: 'SYN-2 · S01 · Reconcile the plan — Planning' });
    expect(plan[0].candidates?.map(candidate => candidate.cardId)).toEqual(['card-2']);
  });

  it('renumbers the newer of two identical names on one card and asks before renaming it', () => {
    const plan = byId(planCardNamingAdoption([
      session('newer', 'SYN-3 · Naming rule — Implementation', { links: ['card-3'], createdAt: 20 }),
      session('older', 'SYN-3 · Naming rule — Implementation', { links: ['card-3'], createdAt: 10, isArchived: true }),
    ], cards));

    expect(plan.get('older')).toMatchObject({ action: 'adopt', needsDecision: false, archived: true });
    expect(plan.get('newer')).toMatchObject({
      action: 'adopt-renamed',
      needsDecision: true,
      title: 'SYN-3 · Naming rule — Implementation',
      proposedTitle: 'SYN-3 · Naming rule — Implementation 2',
      identity: { purpose: 'Implementation 2' },
    });
  });

  it('lets an already adopted chat keep its purpose against a new duplicate', () => {
    const adopted = { namingMode: 'card', cardIdentity: { primaryTrackerId: 'card-3', issueKey: 'SYN-3', cardTitle: 'Naming rule', purpose: 'Implementation' } };
    const plan = byId(planCardNamingAdoption([
      session('legacy', 'SYN-3 · Naming rule — Implementation', { links: ['card-3'], createdAt: 1 }),
      session('launched', 'SYN-3 · Naming rule — Implementation', { links: ['card-3'], createdAt: 2, meta: adopted }),
    ], cards));

    expect(plan.get('launched')).toMatchObject({ group: 'adopted', action: 'keep' });
    expect(plan.get('legacy')).toMatchObject({ action: 'adopt-renamed', proposedTitle: 'SYN-3 · Naming rule — Implementation 2' });
  });

  it('reports links to cards outside the workspace', () => {
    const plan = planCardNamingAdoption([session('a', 'Overlap review', { links: ['plan-elsewhere'] })], cards);

    expect(plan[0]).toMatchObject({ group: 'general', action: 'keep', unresolvedLinks: ['plan-elsewhere'] });
  });

  it('proposes nothing further once the adoptions are applied', () => {
    const sessions = [
      session('a', 'SYN-3 · Naming rule — Implementation', { links: ['card-3'], createdAt: 1 }),
      session('b', 'SYN-3 · Naming rule — Implementation', { links: ['card-3'], createdAt: 2 }),
      session('c', 'Custom name', { links: ['card-3'] }),
      session('d', 'General chat'),
    ];
    const first = planCardNamingAdoption(sessions, cards);
    // Apply every adoption, including the approved rename, the way adoptCardIdentity stores it.
    const applied = sessions.map(input => {
      const entry = first.find(e => e.sessionId === input.id)!;
      if (entry.action === 'keep') return input;
      return {
        ...input,
        title: entry.proposedTitle,
        metadata: { ...(input.metadata as object), namingMode: 'card', cardIdentity: entry.identity },
      };
    });

    const second = planCardNamingAdoption(applied, cards);

    expect(first.filter(entry => entry.action !== 'keep')).toHaveLength(2);
    expect(second.filter(entry => entry.action !== 'keep')).toEqual([]);
    expect(second.map(entry => entry.proposedTitle)).toEqual(second.map(entry => entry.title));
  });
});
