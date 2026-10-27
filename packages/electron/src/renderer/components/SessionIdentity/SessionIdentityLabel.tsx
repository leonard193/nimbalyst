import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import {
  getSessionIdentityDisplay,
  SYNTHETIC_MARKER,
  type SessionIdentitySource,
} from './sessionIdentityDisplay';

interface SessionIdentityLabelProps {
  session: SessionIdentitySource;
  /**
   * `inline`: one line for rows and tabs; the purpose follows the title.
   * `stacked`: the purpose on a second line, for headers and detail lists.
   */
  layout?: 'inline' | 'stacked';
  /** Opens the primary card. Without it the key is shown but not clickable. */
  onOpenCard?: (primaryTrackerId: string) => void;
  className?: string;
  titleClassName?: string;
  untitledLabel?: string;
  /** Set false where a host already shows the full identity on hover. */
  nativeTitle?: boolean;
  /**
   * Set false inside a host that is itself a button (a list row): its
   * children are hidden from assistive tech, so the key is a pointer shortcut
   * there and the row's own label carries the identity.
   */
  keyFocusable?: boolean;
}

/**
 * A chat's identity: the card key, the card title and the chat's purpose for a
 * card-named chat; the title alone for any other chat. The title shortens
 * first; the key and the SYNTHETIC marker never do, and the purpose keeps up
 * to half the width. Screen readers get the complete identity.
 */
export const SessionIdentityLabel: React.FC<SessionIdentityLabelProps> = ({
  session,
  layout = 'inline',
  onOpenCard,
  className = '',
  titleClassName = '',
  untitledLabel,
  nativeTitle = true,
  keyFocusable = true,
}) => {
  const display = getSessionIdentityDisplay(session, untitledLabel);
  const { primaryTrackerId } = display;

  // A general chat reads as its title; no parts, no duplicate screen-reader text.
  if (display.kind === 'plain' && !display.synthetic) {
    return (
      <span
        className={`session-identity-label session-identity-label--plain block min-w-0 truncate ${className}`}
        title={nativeTitle ? display.fullLabel : undefined}
        data-session-identity="plain"
      >
        {display.title}
      </span>
    );
  }

  const openCard = (event: React.SyntheticEvent) => {
    if (!primaryTrackerId || !onOpenCard) return;
    // Rows that host this label open the session on click.
    event.stopPropagation();
    event.preventDefault();
    onOpenCard(primaryTrackerId);
  };

  let keyPart: React.ReactNode = null;
  if (display.kind === 'card') {
    const keyText = display.issueKey;
    const chipClass = 'session-identity-key shrink-0 inline-flex items-center rounded px-1 text-[10px] font-medium leading-4 tabular-nums border border-nim';
    if (onOpenCard && primaryTrackerId) {
      keyPart = (
        <span
          role="button"
          tabIndex={keyFocusable ? 0 : -1}
          className={`${chipClass} cursor-pointer text-nim-link hover:text-nim-link-hover hover:bg-nim-hover`}
          aria-label={keyText ? `Open card ${keyText}` : 'Open card'}
          title={keyText ? `Open card ${keyText}` : 'Open card'}
          onClick={openCard}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') openCard(event);
          }}
          data-testid="session-identity-key"
        >
          {keyText ?? <MaterialSymbol icon="assignment" size={12} />}
        </span>
      );
    } else if (keyText) {
      keyPart = (
        <span className={`${chipClass} text-nim-muted`} aria-hidden="true" data-testid="session-identity-key">
          {keyText}
        </span>
      );
    }
  }

  const titlePart = (
    <span
      className={`session-identity-title min-w-0 truncate ${titleClassName}`}
      aria-hidden="true"
      data-testid="session-identity-title"
    >
      {display.title}
    </span>
  );

  const purposePart = display.purpose ? (
    <span
      className={`session-identity-purpose min-w-0 truncate text-nim-muted ${layout === 'inline' ? 'shrink-0 max-w-[50%]' : ''}`}
      aria-hidden="true"
      data-testid="session-identity-purpose"
    >
      {display.purpose}
    </span>
  ) : null;

  const syntheticPart = display.synthetic ? (
    <span
      className="session-identity-synthetic shrink-0 rounded px-1 text-[9px] font-semibold leading-4 tracking-[0.04em] text-nim-warning border border-[color:var(--nim-warning)]"
      aria-hidden="true"
      data-testid="session-identity-synthetic"
    >
      {SYNTHETIC_MARKER}
    </span>
  ) : null;

  const customHint = layout === 'stacked' && display.isCustomName ? (
    <span className="session-identity-custom text-nim-faint" aria-hidden="true">Custom name</span>
  ) : null;

  const srLabel = <span className="sr-only">{display.fullLabel}</span>;

  if (layout === 'stacked') {
    const hasSecondLine = purposePart || syntheticPart || customHint;
    return (
      <span
        className={`session-identity-label session-identity-label--stacked flex min-w-0 flex-col ${className}`}
        title={nativeTitle ? display.fullLabel : undefined}
        data-session-identity={display.kind}
      >
        {srLabel}
        <span className="flex min-w-0 items-center gap-1.5">
          {keyPart}
          {titlePart}
        </span>
        {hasSecondLine && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
            {syntheticPart}
            {purposePart}
            {customHint}
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      className={`session-identity-label session-identity-label--inline flex min-w-0 items-center gap-1.5 ${className}`}
      title={nativeTitle ? display.fullLabel : undefined}
      data-session-identity={display.kind}
    >
      {srLabel}
      {keyPart}
      {titlePart}
      {syntheticPart}
      {purposePart}
    </span>
  );
};
