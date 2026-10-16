// One tooltip for the whole page. An element opts in with a data-tip
// attribute and the layer shows that text after a short hover. It replaces
// the native title tooltip, which waits about a second and starts over each
// time a live view moves the element under the pointer.

import type { ReactElement } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How long the pointer rests on an element before its tooltip shows. */
export const TIP_DELAY_MS = 250;
/** Space between the element and its tooltip. */
const GAP = 4;
/** Closest a tooltip comes to the edge of the view. */
const MARGIN = 4;

interface Tip {
  readonly text: string;
  readonly anchor: HTMLElement;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Place {
  readonly left: number;
  readonly top: number;
}

/**
 * Where a tooltip goes: centered under its element, or above it when there
 * is no room below, and always inside the view.
 */
export function placeTip(
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  size: Size,
  view: Size,
): Place {
  const below = anchor.bottom + GAP;
  const top =
    below + size.height + MARGIN <= view.height
      ? below
      : Math.max(MARGIN, anchor.top - GAP - size.height);
  const centered = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(MARGIN, Math.min(centered, view.width - size.width - MARGIN));
  return { left, top };
}

function tipAnchor(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
}

/** Mount once near the root. Pointer events still reach disabled buttons, so they get tips too. */
export function TooltipLayer(): ReactElement | null {
  const [tip, setTip] = useState<Tip | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The element under the pointer that has a tip, shown or waiting. */
    let current: HTMLElement | null = null;
    let shown = false;

    const hide = (): void => {
      clearTimeout(timer);
      shown = false;
      setTip(null);
    };
    const show = (anchor: HTMLElement): void => {
      const text = anchor.dataset['tip'] ?? '';
      if (!anchor.isConnected || text === '') {
        hide();
        return;
      }
      shown = true;
      setTip({ text, anchor });
    };
    const onOver = (event: PointerEvent): void => {
      const anchor = tipAnchor(event.target);
      if (anchor === current) {
        return;
      }
      clearTimeout(timer);
      current = anchor;
      if (anchor === null) {
        hide();
      } else if (shown) {
        // Moving along a toolbar shows the next tip at once.
        show(anchor);
      } else {
        timer = setTimeout(() => {
          show(anchor);
        }, TIP_DELAY_MS);
      }
    };
    const onOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) {
        current = null;
        hide();
      }
    };
    // A click or a key hides the tip until the pointer moves to another element.
    const dismiss = (): void => {
      hide();
    };
    // Keep the tip on its element as rows move, change text or go away.
    const observer = new MutationObserver(() => {
      if (shown && current !== null) {
        show(current);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-tip'],
    });
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    return (): void => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', dismiss);
    };
  }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (tip === null || box === null) {
      return;
    }
    const place = placeTip(tip.anchor.getBoundingClientRect(), box.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    box.style.left = `${place.left.toString()}px`;
    box.style.top = `${place.top.toString()}px`;
  }, [tip]);

  return tip === null ? null : (
    <div ref={boxRef} className="tooltip" role="tooltip">
      {tip.text}
    </div>
  );
}
