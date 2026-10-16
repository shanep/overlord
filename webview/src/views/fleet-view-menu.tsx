// The Fleet's View menu: the choices about what the list shows, folded
// behind one button so the toolbar keeps room for the filter.

import type { ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { Icon } from '../components/icon.js';

export interface ViewChoice {
  readonly label: string;
  /** What the choice does, as its tooltip. */
  readonly tip: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** What the button says is in effect, so hidden rows never go unnoticed. */
function summary(hidden: readonly string[]): string {
  return hidden.length === 0
    ? 'Choose what the list shows'
    : `Choose what the list shows. Now: ${hidden.join(', ')}`;
}

export function FleetViewMenu(props: {
  readonly choices: readonly ViewChoice[];
  /** Short notes on choices that hide rows, such as "done hidden". */
  readonly hiding: readonly string[];
}): ReactElement {
  const { choices, hiding } = props;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  /** The last press inside the menu, which reaches the document after React has seen it. */
  const pressInside = useRef<Event | null>(null);

  // A click anywhere else or Escape closes the menu. Escape puts focus back on the button.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent): void => {
      if (event !== pressInside.current) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      className="view-menu"
      onPointerDown={(event) => {
        pressInside.current = event.nativeEvent;
      }}
    >
      <button
        type="button"
        ref={button}
        className="view-menu-button"
        aria-expanded={open}
        aria-controls={panelId}
        data-hiding={hiding.length > 0 ? 'true' : undefined}
        data-tip={summary(hiding)}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="sliders" />
        <span className="toolbar-label">View</span>
      </button>
      {open ? (
        <div id={panelId} className="view-menu-panel" role="group" aria-label="View">
          {choices.map((choice) => (
            <label key={choice.label} data-tip={choice.tip}>
              <input
                type="checkbox"
                checked={choice.checked}
                onChange={(event) => {
                  choice.onChange(event.target.checked);
                }}
              />
              {choice.label}
            </label>
          ))}
          <p className="view-menu-keys muted">
            <kbd>{'↑'}</kbd> <kbd>{'↓'}</kbd> move, <kbd>Enter</kbd> open, <kbd>k</kbd> interrupt,{' '}
            <kbd>m</kbd> project
          </p>
        </div>
      ) : null}
    </div>
  );
}
