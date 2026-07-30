import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './DemoOverlay.module.css';
import type { Mode } from '../TopBar/TopBar';
import { DEMOS, type DemoContext, type DemoView } from '../../demo/demoScript';
import type { DemoSnapshot } from '../InfiniteCanvas/InfiniteCanvas';
import type { Rect } from '../../facade/partition';
import { DemoAborted, DemoDriver, type CursorState } from '../../demo/demoDriver';

/** Everything a finished step leaves behind — the whole app state, not just the canvas. */
interface StepState {
  canvas: DemoSnapshot;
  view: DemoView;
  scene: { rect: Rect | null; stage: number };
}

interface DemoOverlayProps {
  /** Everything the script is allowed to drive, minus the driver (owned here). */
  ctx: Omit<DemoContext, 'ui'>;
  /** Leave the tour (Esc, ×, or finishing the last step). */
  onExit: () => void;
}

/**
 * The guided walkthrough: a mode chooser, then a stepper docked top-centre.
 *
 * It drives the REAL application — each step runs against the same canvas handle and state setters the UI
 * uses — so the tour can never drift from the product. Deliberately NOT a modal: there is no backdrop and
 * nothing is blocked, because half the steps end in "now you try", and a tour that locks the app can't do
 * that. It sits in the gap between the two top pill clusters, wide and short, so the canvas below it, the
 * right-hand card and the nav pill all stay reachable.
 */
export function DemoOverlay({ ctx, onExit }: DemoOverlayProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState<CursorState>({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    press: 0,
    visible: false,
  });
  const steps = mode ? DEMOS[mode] : [];
  const step = steps[index];

  // The context object is rebuilt by the parent on every render; hold it in a ref so running a step never
  // depends on that identity (the same trap that silently broke the Optimize preview).
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // One driver per step. Leaving the step aborts it, so a half-finished sequence stops driving an app the
  // user has already moved on from — the alternative is a cursor still clicking things two steps later.
  const driverRef = useRef<DemoDriver | null>(null);
  // The in-flight step, or null once it has finished. Navigating FORWARDS while this is set jumps it to its
  // end rather than abandoning it: every step builds on the one before, so a step cut off half-way would
  // leave the next one to rebuild the whole scene from an empty canvas.
  const runningRef = useRef<Promise<void> | null>(null);
  // True while a fast-forward is draining. The controls are held for those few frames so a second press
  // can't start a third step against a scene two steps are still writing to.
  const [skipping, setSkipping] = useState(false);
  // True while the current step is still performing its gestures. Drives the footer indicator: the steps
  // run for tens of seconds, and without it there is nothing on screen to say whether the cursor is still
  // going to do something or the step has finished and it is the user's turn.
  const [busy, setBusy] = useState(false);
  // Which run the `busy` flag belongs to. Leaving a step aborts it, and the rejection lands a microtask
  // LATER than the next step's effect — without this token that late settle would clear the new step's
  // spinner the moment it appeared.
  const runSeqRef = useRef(0);

  // The state each completed step ended in, by step number. The tour is CUMULATIVE — every step builds on
  // the one before — so an earlier step's ending state is one the app has genuinely been in, and going back
  // to it is a restore rather than a rebuild.
  const statesRef = useRef(new Map<number, StepState>());
  // Set to the step the restore has already put on screen, so the effect below doesn't then re-enact it.
  const restoredRef = useRef<number | null>(null);
  // The live step number, for a `goTo` that must know which way it is being asked to move.
  const indexRef = useRef(index);
  indexRef.current = index;

  /** Capture the app as a finished step left it. */
  const capture = useCallback((at: number) => {
    const c = ctxRef.current;
    const canvas = c.canvas?.demoSnapshot();
    if (!canvas) return;
    statesRef.current.set(at, {
      canvas,
      view: c.getView(),
      scene: { rect: c.scene.rect, stage: c.scene.stage },
    });
  }, []);

  /** Put one back: the view first, then the canvas, then the scene bookkeeping the script reads. */
  const restore = useCallback(async (s: StepState) => {
    const c = ctxRef.current;
    const modeChanged = s.view.mode !== c.getMode();
    if (modeChanged) c.setMode(s.view.mode);
    c.setLayersActive(s.view.layers);
    c.setIdView(s.view.idView);
    c.setPanelNumbers(s.view.panelNumbers);
    c.setFrameShadow(s.view.frameShadow);
    c.setStatsVisible(s.view.stats);
    c.setConstraintHighlights(s.view.highlights);
    c.openPanel(s.view.panel);
    // A mode change stashes one workspace and restores the other in an effect. Writing the canvas before
    // that lands would have the swap throw the restore away — the same ordering `gotoMode` has to respect.
    if (modeChanged) {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
    c.canvas?.demoRestore(s.canvas);
    c.scene.rect = s.scene.rect;
    c.scene.stage = s.scene.stage;
  }, []);

  // Run the active step. Keyed on mode+index rather than the step object so a re-render can't re-fire it:
  // steps mutate the document, and running one twice on a stray render would be visible.
  useEffect(() => {
    if (!mode) return;
    driverRef.current?.abort();
    runningRef.current = null;
    // Arrived here by restoring this step's own ending state — there is nothing left to perform, and
    // re-running it would replay the step's gestures on top of a scene that already has them.
    if (restoredRef.current === index) {
      restoredRef.current = null;
      runSeqRef.current++; // the restore IS the state; nothing is running to wait for
      setBusy(false);
      return;
    }
    const driver = new DemoDriver(setCursor, { x: cursorRef.current.x, y: cursorRef.current.y });
    driverRef.current = driver;
    const run = DEMOS[mode][index]?.run;
    const seq = ++runSeqRef.current;
    if (!run) {
      setBusy(false);
      return;
    }
    setBusy(true);
    let completed = true;
    const pending: Promise<void> = run({ ...ctxRef.current, ui: driver })
      .catch((err) => {
        completed = false;
        if (!(err instanceof DemoAborted)) throw err; // a real failure should still surface
      })
      .finally(() => {
        // Only a step that ran to the end describes a state worth returning to. A fast-forwarded one does
        // (it performed every gesture); an aborted one is half-built, and its own snapshot would be a trap.
        if (completed) capture(index);
        if (runningRef.current === pending) runningRef.current = null;
        if (runSeqRef.current === seq) setBusy(false);
      });
    runningRef.current = pending;
    return () => driver.abort();
  }, [mode, index, capture]);

  // A tour switch starts a different script: the recorded states belong to the old one.
  useEffect(() => {
    statesRef.current.clear();
  }, [mode]);

  // Latest cursor position, so a new step's driver picks up where the last one left off.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  /**
   * Go to a step. Pressing Back or Next mid-animation is answered at once, in one of two ways:
   *
   *  • BACKWARDS onto a step that has already been played: its ending state is restored outright. Nothing
   *    is replayed and nothing is rewound gesture by gesture — the app simply is where it was. This is the
   *    whole point of recording the states: the tour is cumulative, so the alternative is rebuilding the
   *    scene from an empty canvas every time the user glances at the previous step.
   *
   *  • FORWARDS while a step is still animating: the step is skipped straight to its end rather than
   *    abandoned — every step builds on the one before, so a step cut off half-way would leave the next one
   *    with nothing to build on. Fast-forwarding performs every remaining click, drag and stroke in one go,
   *    with no pauses, no cursor travel and no camera eases, so it costs frames rather than seconds.
   *
   * The forward wait is capped: a step that somehow never settles must not lock the tour.
   */
  const goTo = useCallback(
    (to: number) => {
      const back = to < indexRef.current;
      const saved = statesRef.current.get(to);
      if (back && saved) {
        driverRef.current?.abort(); // lets go of any held press before unwinding
        runningRef.current = null;
        restoredRef.current = to;
        setIndex(to);
        void restore(saved);
        return;
      }
      const pending = runningRef.current;
      if (!pending) {
        setIndex(to);
        return;
      }
      setSkipping(true);
      driverRef.current?.fastForward();
      const capped = new Promise<void>((r) => window.setTimeout(r, 4000));
      void Promise.race([pending, capped]).then(() => {
        setSkipping(false);
        setIndex(to);
      });
    },
    [restore],
  );

  const exit = useCallback(() => {
    driverRef.current?.abort();
    runningRef.current = null;
    ctxRef.current.openPanel(null);
    onExit();
  }, [onExit]);

  // Esc leaves from anywhere in the tour, including the chooser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        exit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [exit]);

  const cursorEl = cursor.visible ? (
    <div
      className={styles.cursor}
      style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
      aria-hidden="true"
    >
      <svg width="22" height="22" viewBox="0 0 22 22">
        <path
          d="M4 2 L4 16.5 L8 12.8 L10.6 18.6 L13.4 17.3 L10.8 11.7 L16 11.4 Z"
          fill="#18181b"
          stroke="#ffffff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {/* Keyed on the press counter so each click restarts the ripple animation. */}
      <span key={cursor.press} className={styles.ripple} />
    </div>
  ) : null;

  if (!mode) {
    return (
      <>
        {cursorEl}
        <div className={styles.card} data-demo="tour-card" role="dialog" aria-label="Choose a demo">
        <button type="button" className={styles.close} aria-label="Close demo" onClick={exit}>
          ×
        </button>
        <div className={styles.chooserHead}>
          <span className={styles.eyebrow}>Guided tour</span>
          <h2 className={styles.chooserTitle}>Which side would you like to see?</h2>
        </div>
        <div className={styles.choices}>
          <button type="button" className={styles.choice} onClick={() => setMode('Plan')}>
            <span className={styles.choiceName}>Plan</span>
            <span className={styles.choiceBlurb}>
              Rooms reshaped and combined, a rule broken and fixed by the wand, then saved to the
              Library.
            </span>
            <span className={styles.choiceMeta}>{DEMOS.Plan.length} steps</span>
          </button>
          <button type="button" className={styles.choice} onClick={() => setMode('Facade')}>
            <span className={styles.choiceName}>Facade</span>
            <span className={styles.choiceBlurb}>
              An angled elevation split into panels, tuned and rationalized, then framed and glazed.
            </span>
            <span className={styles.choiceMeta}>{DEMOS.Facade.length} steps</span>
          </button>
        </div>
          <p className={styles.escHint}>
            Press <kbd className={styles.kbd}>Esc</kbd> at any point to leave the tour.
          </p>
        </div>
      </>
    );
  }

  const last = index === steps.length - 1;
  return (
    <>
      {cursorEl}
      <div className={styles.card} data-demo="tour-card" role="dialog" aria-label={`${mode} demo`}>
      <button type="button" className={styles.close} aria-label="Close demo" onClick={exit}>
        ×
      </button>

      <div className={styles.head}>
        <h2 className={styles.title}>{step.title}</h2>
      </div>

      <p className={styles.body}>{step.body}</p>
      {step.tryIt && (
        <p className={styles.tryIt}>
          <span className={styles.tryItTag}>Try it</span>
          {step.tryIt}
        </p>
      )}

      <div className={styles.foot}>
        <div className={styles.progress}>
          <span className={styles.eyebrow}>
            {mode} · {index + 1}/{steps.length}
          </span>
          {/* Dots double as a jump target — a tour you can only walk forwards through is a slideshow. */}
          <div className={styles.dots}>
            {steps.map((s, i) => (
              <button
                key={s.title}
                type="button"
                className={`${styles.dot} ${i === index ? styles.dotOn : ''}`}
                aria-label={`Step ${i + 1}: ${s.title}`}
                aria-current={i === index}
                disabled={skipping}
                onClick={() => goTo(i)}
              />
            ))}
          </div>
        </div>
        <div className={styles.actions}>
          {/* Is the step still being performed, or is it over and the canvas is yours? */}
          <span
            className={styles.status}
            role="status"
            aria-live="polite"
            title={busy ? 'Playing this step…' : 'Step finished'}
          >
            {busy ? (
              <span className={styles.spinner} aria-label="Playing this step" />
            ) : (
              <svg
                className={styles.done}
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-label="Step finished"
                role="img"
              >
                <path
                  d="M2.6 7.4 L5.6 10.4 L11.4 3.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <button
            type="button"
            className={styles.ghost}
            disabled={index === 0 || skipping}
            onClick={() => goTo(Math.max(0, index - 1))}
          >
            Back
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={skipping}
            onClick={() => (last ? exit() : goTo(index + 1))}
          >
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
      </div>
    </>
  );
}
