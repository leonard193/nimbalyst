import React, { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { CARD_SESSION_PURPOSE_PRESETS } from '@nimbalyst/runtime/ai/server/cardSessionNaming';

import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';

interface PurposePickerProps {
  value: string;
  onChange: (purpose: string) => void;
  /** Prefix shown on the trigger, e.g. "For". */
  label?: string;
  disabled?: boolean;
  className?: string;
  testIdBase?: string;
}

/**
 * Choose why a chat exists: one of the presets or a custom purpose. Used at
 * launch (the default needs no interaction) and in the chat identity editor.
 */
export const PurposePicker: React.FC<PurposePickerProps> = ({
  value,
  onChange,
  label = 'Purpose',
  disabled,
  className = '',
  testIdBase = 'purpose-picker',
}) => {
  const menu = useFloatingMenu({ placement: 'bottom-start' });
  const isPreset = (CARD_SESSION_PURPOSE_PRESETS as readonly string[]).includes(value);
  const [customDraft, setCustomDraft] = useState(isPreset ? '' : value);

  const choose = (purpose: string) => {
    const trimmed = purpose.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    onChange(trimmed);
    menu.setIsOpen(false);
  };

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        disabled={disabled}
        className={`purpose-picker-trigger flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-nim-muted hover:text-nim hover:bg-nim-tertiary transition-colors disabled:opacity-60 ${className}`}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        aria-label={`${label}: ${value}. Change purpose`}
        title={`${label}: ${value}`}
        onClick={() => {
          setCustomDraft(isPreset ? '' : value);
          menu.setIsOpen(!menu.isOpen);
        }}
        data-testid={`${testIdBase}-trigger`}
      >
        <span className="shrink-0 text-nim-faint">{label}:</span>
        <span className="min-w-0 truncate font-medium">{value}</span>
        <MaterialSymbol icon="expand_more" size={14} />
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            role="menu"
            className="purpose-picker-menu z-[10000] min-w-[220px] rounded-md border border-nim bg-nim p-1 shadow-[0_4px_12px_rgba(0,0,0,0.18)]"
            data-testid={`${testIdBase}-menu`}
          >
            {CARD_SESSION_PURPOSE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="menuitemradio"
                aria-checked={preset === value}
                className="purpose-picker-option flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-nim hover:bg-nim-hover"
                onClick={() => choose(preset)}
              >
                <span className="w-4 shrink-0">
                  {preset === value && <MaterialSymbol icon="check" size={14} />}
                </span>
                {preset}
              </button>
            ))}
            <form
              className="mt-1 flex items-center gap-1 border-t border-nim px-1 pt-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                choose(customDraft);
              }}
            >
              <input
                className="min-w-0 flex-1 rounded border border-nim bg-nim px-2 py-1 text-xs text-nim outline-none focus:border-nim-focus"
                value={customDraft}
                onChange={(event) => setCustomDraft(event.target.value)}
                placeholder="Custom purpose"
                aria-label="Custom purpose"
                maxLength={60}
                data-testid={`${testIdBase}-custom-input`}
              />
              <button
                type="submit"
                className="rounded px-2 py-1 text-xs text-nim hover:bg-nim-hover disabled:opacity-50"
                disabled={!customDraft.trim()}
              >
                Use
              </button>
            </form>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
