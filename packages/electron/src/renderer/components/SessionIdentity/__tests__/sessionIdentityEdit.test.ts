// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  initialIdentityEditorState,
  planIdentityEdit,
  resolveLinkedCards,
  type LinkedCardOption,
} from '../sessionIdentityEdit';

const getTitle = (item: { fields?: Record<string, unknown> }) => String(item.fields?.title ?? '');

const items = new Map([
  ['slice_21', { id: 'slice_21', issueKey: 'LEO-21', fields: { title: 'Show the card title' } }],
  ['slice_22', { id: 'slice_22', issueKey: 'LEO-22', fields: { title: 'Unavailable cards' } }],
  ['plan_1', { id: 'plan_1', fields: { title: 'Draft plan' }, system: { documentPath: 'plans/naming.md' } }],
]);

const cards: LinkedCardOption[] = [
  { trackerId: 'slice_21', issueKey: 'LEO-21', title: 'Show the card title' },
  { trackerId: 'slice_22', issueKey: 'LEO-22', title: 'Unavailable cards' },
];

const leo21 = { primaryTrackerId: 'slice_21', issueKey: 'LEO-21', cardTitle: 'Show the card title', purpose: 'Implementation' };

describe('resolveLinkedCards', () => {
  it('resolves item ids and file links in link order, skipping unloaded and duplicate links', () => {
    expect(resolveLinkedCards(['slice_22', 'missing', 'file:plans/naming.md', 'slice_22', 'slice_21'], items, getTitle)).toEqual([
      { trackerId: 'slice_22', issueKey: 'LEO-22', title: 'Unavailable cards' },
      { trackerId: 'plan_1', title: 'Draft plan' },
      { trackerId: 'slice_21', issueKey: 'LEO-21', title: 'Show the card title' },
    ]);
  });

  it('is empty for a general chat', () => {
    expect(resolveLinkedCards(undefined, items, getTitle)).toEqual([]);
  });
});

describe('initialIdentityEditorState', () => {
  // A later secondary link must not become primary by default.
  it('keeps the stored primary card even when another card was linked first or last', () => {
    const state = initialIdentityEditorState({ title: 't', namingMode: 'card', cardIdentity: { ...leo21 } }, [cards[1], cards[0]]);
    expect(state).toMatchObject({ primaryTrackerId: 'slice_21', purpose: 'Implementation', mode: 'card' });
  });

  it('offers the first linked card for a chat with no primary card yet', () => {
    expect(initialIdentityEditorState({ title: 'General chat' }, cards)).toMatchObject({ primaryTrackerId: 'slice_21', mode: 'card', customName: 'General chat' });
  });
});

describe('planIdentityEdit', () => {
  const session = { title: 'LEO-21 · Show the card title — Implementation', namingMode: 'card' as const, cardIdentity: leo21 };

  it('does nothing when nothing changed', () => {
    expect(planIdentityEdit('s1', session, cards, initialIdentityEditorState(session, cards))).toEqual([]);
  });

  it('changes the purpose by rewriting the identity, numbering a repeated purpose', () => {
    const calls = planIdentityEdit('s1', session, cards, { ...initialIdentityEditorState(session, cards), purpose: 'Independent review' });
    expect(calls).toEqual([{
      channel: 'sessions:set-card-identity',
      args: ['s1', { ...leo21, purpose: 'Independent review' }, { numberRepeatedPurpose: true }],
    }]);
  });

  it('switches the primary card explicitly', () => {
    const calls = planIdentityEdit('s1', session, cards, { ...initialIdentityEditorState(session, cards), primaryTrackerId: 'slice_22' });
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('sessions:set-card-identity');
    expect(calls[0].args[1]).toEqual({ primaryTrackerId: 'slice_22', issueKey: 'LEO-22', cardTitle: 'Unavailable cards', purpose: 'Implementation' });
  });

  it('switches to a custom name with a user rename and keeps the identity', () => {
    const calls = planIdentityEdit('s1', session, cards, { ...initialIdentityEditorState(session, cards), mode: 'custom', customName: ' My notes ' });
    expect(calls).toEqual([{ channel: 'sessions:update-title', args: ['s1', 'My notes'] }]);
  });

  it('returns a custom-named chat to the card name', () => {
    const custom = { title: 'My notes', namingMode: 'custom' as const, cardIdentity: leo21 };
    const calls = planIdentityEdit('s1', custom, cards, { ...initialIdentityEditorState(custom, cards), mode: 'card' });
    expect(calls).toEqual([{ channel: 'sessions:set-card-identity', args: ['s1', leo21, { numberRepeatedPurpose: true }] }]);
  });

  it('names a general chat after a linked card it chooses', () => {
    const general = { title: 'Refactor' };
    const calls = planIdentityEdit('s1', general, cards, initialIdentityEditorState(general, cards));
    expect(calls).toEqual([{ channel: 'sessions:set-card-identity', args: ['s1', leo21, { numberRepeatedPurpose: true }] }]);
  });

  it('refuses an empty custom name or an unknown card', () => {
    expect(planIdentityEdit('s1', session, cards, { ...initialIdentityEditorState(session, cards), mode: 'custom', customName: '  ' })).toEqual([]);
    expect(planIdentityEdit('s1', session, cards, { ...initialIdentityEditorState(session, cards), primaryTrackerId: 'gone' })).toEqual([]);
  });
});
