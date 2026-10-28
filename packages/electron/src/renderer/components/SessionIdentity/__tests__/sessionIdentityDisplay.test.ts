// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { getSessionIdentityDisplay } from '../sessionIdentityDisplay';

const card = {
  primaryTrackerId: 'delivery-slice_21',
  issueKey: 'LEO-21',
  cardTitle: 'Show the card title and chat purpose consistently',
  purpose: 'Implementation',
};

describe('getSessionIdentityDisplay', () => {
  // The finish line: two chats on one card read as the same card with different purposes.
  it('gives two chats on one card the same key and title and different purposes', () => {
    const implementation = getSessionIdentityDisplay({
      title: 'LEO-21 · Show the card title and chat purpose consistently — Implementation',
      namingMode: 'card',
      cardIdentity: card,
    });
    const review = getSessionIdentityDisplay({
      title: 'LEO-21 · Show the card title and chat purpose consistently — Independent review',
      namingMode: 'card',
      cardIdentity: { ...card, purpose: 'Independent review' },
    });

    expect(implementation).toMatchObject({ kind: 'card', issueKey: 'LEO-21', primaryTrackerId: 'delivery-slice_21', title: card.cardTitle, purpose: 'Implementation' });
    expect(review).toMatchObject({ issueKey: 'LEO-21', title: card.cardTitle, purpose: 'Independent review' });
    expect(review.fullLabel).toBe('LEO-21 · Show the card title and chat purpose consistently — Independent review');
  });

  it('builds the title from the identity, not a stale stored title', () => {
    const display = getSessionIdentityDisplay({
      title: 'LEO-21 · Old title — Implementation',
      namingMode: 'card',
      cardIdentity: { ...card, cardTitle: 'Renamed card' },
    });
    expect(display.title).toBe('Renamed card');
    expect(display.fullLabel).toBe('LEO-21 · Renamed card — Implementation');
  });

  it('lifts SYNTHETIC out of the purpose so it can stay visible', () => {
    const display = getSessionIdentityDisplay({
      title: 'x',
      namingMode: 'card',
      cardIdentity: { ...card, purpose: 'SYNTHETIC Codex check' },
    });
    expect(display).toMatchObject({ synthetic: true, purpose: 'Codex check' });
    expect(display.fullLabel).toContain('SYNTHETIC Codex check');
  });

  it('lifts SYNTHETIC out of the card title too, keeping the full name for screen readers', () => {
    const display = getSessionIdentityDisplay({
      title: 'SYN-1 · SYNTHETIC validation card — Implementation',
      namingMode: 'card',
      cardIdentity: { ...card, issueKey: 'SYN-1', cardTitle: 'SYNTHETIC validation card' },
    });

    expect(display).toMatchObject({ title: 'validation card', purpose: 'Implementation', synthetic: true });
    expect(display.fullLabel).toBe('SYN-1 · SYNTHETIC validation card — Implementation');
  });

  it('does not treat a word containing the marker as SYNTHETIC', () => {
    const display = getSessionIdentityDisplay({ title: 'x', namingMode: 'card', cardIdentity: { ...card, purpose: 'Unsynthetically tested' } });
    expect(display.synthetic).toBe(false);
    expect(display.purpose).toBe('Unsynthetically tested');
  });

  it('shows a custom name with the card key and keeps the card name for screen readers', () => {
    const display = getSessionIdentityDisplay({ title: 'My review notes', namingMode: 'custom', cardIdentity: card });
    expect(display).toMatchObject({ kind: 'card', title: 'My review notes', issueKey: 'LEO-21', isCustomName: true });
    expect(display.purpose).toBeUndefined();
    expect(display.fullLabel).toBe('My review notes (custom name; card LEO-21 · Show the card title and chat purpose consistently — Implementation)');
  });

  it('shows a draft card without inventing a key', () => {
    const { issueKey: _key, ...draft } = card;
    const display = getSessionIdentityDisplay({ title: 'x', namingMode: 'card', cardIdentity: draft });
    expect(display.issueKey).toBeUndefined();
    expect(display.primaryTrackerId).toBe('delivery-slice_21');
    expect(display.fullLabel).toBe('Show the card title and chat purpose consistently — Implementation');
  });

  it('gives a general chat no card parts, even if a stray identity is present without a naming mode', () => {
    const display = getSessionIdentityDisplay({ title: 'Refactor the parser', cardIdentity: card });
    expect(display).toEqual({ kind: 'plain', title: 'Refactor the parser', synthetic: false, isCustomName: false, fullLabel: 'Refactor the parser' });
  });

  it('marks a general SYNTHETIC chat without a card badge', () => {
    const display = getSessionIdentityDisplay({ title: 'SYNTHETIC: naming probe' });
    expect(display).toMatchObject({ kind: 'plain', synthetic: true, title: 'naming probe', fullLabel: 'SYNTHETIC: naming probe' });
    expect(display.issueKey).toBeUndefined();
  });

  it('falls back to the untitled label', () => {
    expect(getSessionIdentityDisplay({ title: '  ' }).title).toBe('Untitled session');
  });
});
