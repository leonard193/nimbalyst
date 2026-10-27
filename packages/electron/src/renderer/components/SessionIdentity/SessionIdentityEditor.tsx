import React, { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { buildCardSessionTitle, CARD_SESSION_PURPOSE_PRESETS } from '@nimbalyst/runtime/ai/server/cardSessionNaming';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import type { SessionMeta } from '../../store/atoms/sessions';
import {
  initialIdentityEditorState,
  planIdentityEdit,
  resolveLinkedCards,
  type IdentityEditorState,
} from './sessionIdentityEdit';

interface SessionIdentityEditorProps {
  session: Pick<SessionMeta, 'id' | 'title' | 'namingMode' | 'cardIdentity' | 'linkedTrackerItemIds'>;
  className?: string;
}

/**
 * The chat identity control: choose the primary card among the linked cards,
 * the purpose, and whether the name follows the card or is a custom name.
 * Shown only for a chat linked to at least one loaded card; a general chat
 * gets no card controls.
 */
export const SessionIdentityEditor: React.FC<SessionIdentityEditorProps> = ({ session, className = '' }) => {
  const items = useAtomValue(trackerItemsMapAtom);
  const cards = useMemo(
    () => resolveLinkedCards(session.linkedTrackerItemIds, items, (item) => getRecordTitle(item as TrackerRecord)),
    [session.linkedTrackerItemIds, items],
  );
  const menu = useFloatingMenu({ placement: 'bottom-start' });
  const [state, setState] = useState<IdentityEditorState>(() => initialIdentityEditorState(session, cards));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (cards.length === 0) return null;

  const plan = planIdentityEdit(session.id, session, cards, state);
  const selectedCard = cards.find((card) => card.trackerId === state.primaryTrackerId);
  const preview = state.mode === 'card' && selectedCard
    ? buildCardSessionTitle({ issueKey: selectedCard.issueKey, cardTitle: selectedCard.title, purpose: state.purpose })
    : state.customName.trim();

  const open = () => {
    setState(initialIdentityEditorState(session, cards));
    setError(null);
    menu.setIsOpen(true);
  };

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const call of plan) {
        await window.electronAPI.invoke(call.channel, ...call.args);
      }
      menu.setIsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const radioClass = 'flex items-center gap-2 rounded px-1.5 py-1 text-xs text-nim hover:bg-nim-hover cursor-pointer';

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        className={`session-identity-editor-trigger shrink-0 flex items-center justify-center rounded p-0.5 text-nim-muted hover:text-nim hover:bg-nim-hover ${className}`}
        aria-label="Chat name, card and purpose"
        aria-expanded={menu.isOpen}
        title="Chat name, card and purpose"
        onClick={() => (menu.isOpen ? menu.setIsOpen(false) : open())}
        data-testid="session-identity-editor-trigger"
      >
        <MaterialSymbol icon="badge" size={16} />
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            role="dialog"
            aria-label="Chat name, card and purpose"
            className="session-identity-editor z-[10000] w-[320px] rounded-md border border-nim bg-nim p-2 shadow-[0_4px_12px_rgba(0,0,0,0.18)]"
            data-testid="session-identity-editor"
          >
            {cards.length > 1 && (
              <fieldset className="m-0 mb-2 border-0 p-0">
                <legend className="mb-1 text-[11px] font-medium uppercase tracking-[0.5px] text-nim-muted">Primary card</legend>
                {cards.map((card) => (
                  <label key={card.trackerId} className={radioClass}>
                    <input
                      type="radio"
                      name="session-identity-primary"
                      checked={state.primaryTrackerId === card.trackerId}
                      onChange={() => setState((prev) => ({ ...prev, primaryTrackerId: card.trackerId }))}
                    />
                    {card.issueKey && <span className="shrink-0 font-mono text-[10px] text-nim-muted">{card.issueKey}</span>}
                    <span className="min-w-0 truncate">{card.title}</span>
                  </label>
                ))}
              </fieldset>
            )}

            <fieldset className="m-0 mb-2 border-0 p-0">
              <legend className="mb-1 text-[11px] font-medium uppercase tracking-[0.5px] text-nim-muted">Name</legend>
              <label className={radioClass}>
                <input
                  type="radio"
                  name="session-identity-mode"
                  checked={state.mode === 'card'}
                  onChange={() => setState((prev) => ({ ...prev, mode: 'card' }))}
                />
                Follow the card (automatic)
              </label>
              <label className={radioClass}>
                <input
                  type="radio"
                  name="session-identity-mode"
                  checked={state.mode === 'custom'}
                  onChange={() => setState((prev) => ({ ...prev, mode: 'custom' }))}
                />
                Custom name
              </label>
              {state.mode === 'custom' && (
                <input
                  className="mt-1 w-full rounded border border-nim bg-nim px-2 py-1 text-xs text-nim outline-none focus:border-nim-focus"
                  value={state.customName}
                  onChange={(event) => setState((prev) => ({ ...prev, customName: event.target.value }))}
                  aria-label="Custom name"
                  data-testid="session-identity-custom-name"
                />
              )}
            </fieldset>

            {/* Inline rather than a nested popover, so choosing a purpose cannot dismiss this one. */}
            <fieldset className="m-0 mb-2 border-0 p-0">
              <legend className="mb-1 text-[11px] font-medium uppercase tracking-[0.5px] text-nim-muted">Purpose</legend>
              <div className="flex flex-wrap gap-1">
                {CARD_SESSION_PURPOSE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={state.purpose === preset}
                    className={`rounded border px-1.5 py-0.5 text-[11px] ${state.purpose === preset ? 'border-nim-focus bg-nim-selected text-nim' : 'border-nim bg-transparent text-nim-muted hover:bg-nim-hover'}`}
                    onClick={() => setState((prev) => ({ ...prev, purpose: preset }))}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <input
                className="mt-1 w-full rounded border border-nim bg-nim px-2 py-1 text-xs text-nim outline-none focus:border-nim-focus"
                value={state.purpose}
                onChange={(event) => setState((prev) => ({ ...prev, purpose: event.target.value }))}
                aria-label="Purpose"
                maxLength={60}
                data-testid="session-identity-purpose"
              />
            </fieldset>

            {preview && (
              <p className="m-0 mb-2 rounded bg-nim-secondary px-2 py-1 text-[11px] text-nim-muted break-words select-text">
                {preview}
              </p>
            )}
            {error && <p className="m-0 mb-2 text-[11px] text-nim-error select-text">{error}</p>}

            <div className="flex justify-end gap-1">
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-nim-muted hover:bg-nim-hover"
                onClick={() => menu.setIsOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-nim-primary px-2 py-1 text-xs text-white hover:bg-nim-primary-hover disabled:opacity-50"
                disabled={saving || plan.length === 0}
                onClick={() => void apply()}
                data-testid="session-identity-apply"
              >
                {saving ? 'Saving…' : 'Apply'}
              </button>
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
