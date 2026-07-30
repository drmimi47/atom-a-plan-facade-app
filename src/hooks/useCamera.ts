import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';
import type { Camera } from '../types';
import { MAX_SCALE, MIN_SCALE, ZOOM_SENSITIVITY } from '../constants';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Camera that starts with the world origin centred in the viewport. */
function createInitialCamera(): Camera {
  return {
    x: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
    y: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
    scale: 1,
  };
}

export interface UseCameraResult {
  /** Live camera, mutated in place. Read `.current` inside your draw loop. */
  cameraRef: MutableRefObject<Camera>;
  /** Recentre the world origin and reset zoom to 100%. */
  reset: () => void;
}

/**
 * Owns the camera and wheel-zoom, deliberately bypassing React state. The
 * camera lives in a ref and is mutated in place; after each change `onChange`
 * fires so the owner can schedule a redraw (e.g. via requestAnimationFrame).
 * This keeps React's reconciler off the 60–120Hz interaction path.
 *
 * Panning lives in the unified pointer controller (useCanvasInteractions) so it
 * can be arbitrated against shape selection/move/resize. The wheel listener is
 * attached imperatively so it can call preventDefault (React's onWheel is
 * passive).
 */
export function useCamera(
  targetRef: RefObject<HTMLElement>,
  onChange: () => void,
): UseCameraResult {
  const cameraRef = useRef<Camera>(createInitialCamera());

  // Keep the latest onChange in a ref so the listener effect never re-binds.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  // Mutated in place rather than replaced: the draw loop and every gesture read `.current` fresh, but a
  // running camera tween holds the object it started with — swapping in a new one would leave that tween
  // animating an orphan while the view sat frozen on the reset values.
  const reset = useCallback(() => {
    const next = createInitialCamera();
    const cam = cameraRef.current;
    cam.x = next.x;
    cam.y = next.y;
    cam.scale = next.scale;
    onChangeRef.current();
  }, []);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    // Cache the rect; refresh only on resize/scroll, not on every wheel tick.
    let rect = el.getBoundingClientRect();
    const refreshRect = () => {
      rect = el.getBoundingClientRect();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      const cam = cameraRef.current;
      const nextScale = clamp(
        cam.scale * Math.exp(-e.deltaY * ZOOM_SENSITIVITY),
        MIN_SCALE,
        MAX_SCALE,
      );
      if (nextScale === cam.scale) return;

      // Keep the world point under the cursor fixed while zooming.
      const worldX = (cursorX - cam.x) / cam.scale;
      const worldY = (cursorY - cam.y) / cam.scale;
      cam.scale = nextScale;
      cam.x = cursorX - worldX * nextScale;
      cam.y = cursorY - worldY * nextScale;
      onChangeRef.current();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', refreshRect);
    window.addEventListener('scroll', refreshRect, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', refreshRect);
      window.removeEventListener('scroll', refreshRect, true);
    };
  }, [targetRef]);

  return { cameraRef, reset };
}
