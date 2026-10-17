// The Fleet's View menu: the choices about what the list shows, folded
// behind one button so the toolbar keeps room for the filter.

import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode, RefObject } from 'react';
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

/**
 * Closes an open toolbar menu on a click anywhere else or on Escape, which
 * also puts focus back on its button. The menu's wrapper takes the returned
 * handler as onPointerDown.
 */
export function useMenuDismiss(
  open: boolean,
  setOpen: (open: boolean) => void,
  button: RefObject<HTMLButtonElement | null>,
): (event: ReactPointerEvent) => void {
  /** The last press inside the menu, which reaches the document after React has seen it. */
  const pressInside = useRef<Event | null>(null);
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
  }, [open, setOpen, button]);
  return (event) => {
    pressInside.current = event.nativeEvent;
  };
}

export function FleetViewMenu(props: {
  readonly choices: readonly ViewChoice[];
  /** Short notes on choices that hide rows, such as "done hidden". */
  readonly hiding: readonly string[];
  /** More choices under the checkboxes, such as the agent filter. */
  readonly children?: ReactNode;
}): ReactElement {
  const { choices, hiding } = props;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const onPointerDown = useMenuDismiss(open, setOpen, button);
  return (
    <div className="view-menu" onPointerDown={onPointerDown}>
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
          {props.children}
          <p className="view-menu-keys muted">
            <kbd>{'↑'}</kbd> <kbd>{'↓'}</kbd> move, <kbd>Enter</kbd> open, <kbd>k</kbd> interrupt,{' '}
            <kbd>m</kbd> project
          </p>
        </div>
      ) : null}
    </div>
  );
}
