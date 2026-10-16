import type { KeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef } from 'react';

/** Inline confirmation strip. Takes focus so Enter confirms and Escape cancels. */
export function ConfirmBar(props: {
  readonly message: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onCancel();
    }
  };
  return (
    <div className="confirm" role="group" aria-label="Confirm">
      <span>{props.message}</span>
      <button
        ref={confirmRef}
        type="button"
        className="danger"
        onClick={props.onConfirm}
        onKeyDown={onKeyDown}
      >
        {props.confirmLabel}
      </button>
      <button type="button" onClick={props.onCancel} onKeyDown={onKeyDown}>
        Cancel
      </button>
    </div>
  );
}
