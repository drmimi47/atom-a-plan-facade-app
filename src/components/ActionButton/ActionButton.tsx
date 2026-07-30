import { useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import type { CanvasHandle } from '../InfiniteCanvas/InfiniteCanvas';
import styles from './ActionButton.module.css';

interface ActionButtonProps {
  canvasRef: RefObject<CanvasHandle>;
  /**
   * Facade mode: render the cube as a 2×2×2 subdivided wireframe (white panels with
   * thin dark grid lines) instead of the solid shaded cube.
   */
  facade?: boolean;
  /**
   * Facade mode only: invoked at the start of a cube gesture to ACTIVATE the Facade Layers tool, so the
   * placement that follows commits a trim BORDER (12'×12' default) instead of a room.
   */
  onArmFacadeBorder?: () => void;
}

/** Pointer travel (px) before a press is treated as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/**
 * Primary action, pinned bottom-centre. Renders an isometric 3D cube.
 *
 * Two ways to place a square, both showing a cursor-following preview:
 *  - Click: arms placement; the preview follows the mouse and commits on the
 *    next click on the canvas.
 *  - Drag: while dragging from the button, the preview follows under the cursor
 *    (pointer capture keeps events on the button) and commits where released.
 *  - Keyboard (Enter/Space, detail === 0): arms from the viewport centre.
 */
export function ActionButton({ canvasRef, facade = false, onArmFacadeBorder }: ActionButtonProps) {
  const gesture = useRef({ active: false, dragging: false, startX: 0, startY: 0 });

  // The cube jumps periodically to invite the first click. Once the user
  // interacts at all, it rests for the remainder of the session.
  const [inviting, setInviting] = useState(true);

  // While the pointer rests over the button we suppress further hops — but only
  // at a loop boundary (cube grounded), so an in-flight jump is never cut off.
  const [paused, setPaused] = useState(false);
  const hoveringRef = useRef(false);

  const handlePointerEnter = () => {
    hoveringRef.current = true;
  };

  const handlePointerLeave = () => {
    hoveringRef.current = false;
    setPaused(false); // resume; the next cycle may hop again
  };

  // Fires at each loop boundary, where the cube is grounded and at rest. Pausing
  // here holds that resting pose instead of starting the next hop.
  const handleAnimationIteration = () => {
    if (hoveringRef.current) setPaused(true);
  };

  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    setInviting(false);
    // In Facade mode, arm the Layers tool so the placement this gesture starts commits a trim border.
    if (facade) onArmFacadeBorder?.();
    gesture.current = { active: true, dragging: false, startX: e.clientX, startY: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No such active pointer — the case for a synthesized gesture (the guided tour drags this cube).
      // Capture is an optimisation here, not the mechanism: the move/up handlers work off coordinates, so
      // losing it costs nothing, whereas letting it throw would abort the gesture on its first event.
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g.active) return;
    const handle = canvasRef.current;
    if (!handle) return;

    if (!g.dragging) {
      const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (moved <= DRAG_THRESHOLD) return;
      g.dragging = true;
      handle.startPlacement(e.clientX, e.clientY);
    } else {
      handle.updatePlacement(e.clientX, e.clientY);
    }
  };

  const handlePointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g.active) return;
    g.active = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released; ignore.
    }

    const handle = canvasRef.current;
    if (!handle) return;
    if (g.dragging) {
      // Drag-and-drop: commit where the cursor was released.
      handle.commitPlacementAtClient(e.clientX, e.clientY);
    } else {
      // Plain click: arm placement to follow the cursor until the next click.
      handle.startPlacement(e.clientX, e.clientY);
    }
  };

  // Keyboard activation fires a click with detail 0 (no pointer gesture ran).
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    setInviting(false);
    if (e.detail === 0) {
      if (facade) onArmFacadeBorder?.();
      canvasRef.current?.startPlacement(window.innerWidth / 2, window.innerHeight / 2);
    }
  };

  return (
    <button
      type="button"
      className={styles.button}
      aria-label="Space"
      data-demo="cube"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
    >
      <span
        className={`${styles.cubeJump} ${inviting ? styles.inviting : ''} ${
          paused ? styles.paused : ''
        }`}
        aria-hidden="true"
        onAnimationIteration={handleAnimationIteration}
      >
        <span className={`${styles.cube} ${facade ? styles.facade : ''}`}>
          <span className={`${styles.face} ${styles.front}`} />
          <span className={`${styles.face} ${styles.back}`} />
          <span className={`${styles.face} ${styles.right}`} />
          <span className={`${styles.face} ${styles.left}`} />
          <span className={`${styles.face} ${styles.top}`} />
          <span className={`${styles.face} ${styles.bottom}`} />
        </span>
      </span>
    </button>
  );
}
