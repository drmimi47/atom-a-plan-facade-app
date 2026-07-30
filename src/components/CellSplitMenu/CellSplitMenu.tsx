import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './CellSplitMenu.module.css';
import type { OptimizeStrategy, PanelKind, PanelMode } from '../../facade/partition';

/** The assignable panel materials: `short` is the chip text, `label` the full name (tooltip). */
const PANEL_KINDS: { kind: PanelKind; label: string; short: string }[] = [
  { kind: 'vision1', label: 'Vision Glass — Single', short: 'Vision 1' },
  { kind: 'vision2', label: 'Vision Glass — Double', short: 'Vision 2' },
  { kind: 'vision3', label: 'Vision Glass — Triple', short: 'Vision 3' },
  { kind: 'spandrel', label: 'Spandrel Glass', short: 'Spandrel' },
  { kind: 'solid', label: 'Solid Panel', short: 'Solid' },
  { kind: 'cladding', label: 'Heavy Cladding', short: 'Cladding' },
  { kind: 'louver', label: 'Louver / Screen', short: 'Louver' },
];

/**
 * The rationalization strategies, named for what you GET rather than for the algorithm. `edge-normalize`
 * is a one-shot edit; the other three are modes a border stays in, so the menu shows which one is live and
 * re-picking it clears it.
 */
const STRATEGIES: { id: OptimizeStrategy; label: string }[] = [
  { id: 'edge-normalize', label: 'Snap to Grid' },
  { id: 'edge-profile', label: 'Perimeter Trim' },
  { id: 'stepped-edge', label: 'Stair-Step' },
  { id: 'modular-cluster', label: 'Cut Families' },
];

/**
 * First-paint size estimates (px) only. The bar sizes itself to its content — hard-coding a width here and
 * a layout in the stylesheet is what let the buttons outgrow the card — so these seed the centring for the
 * single layout pass before the real size is measured.
 */
const BAR_WIDTH = 320;
const BAR_HEIGHT = 44;
/** Roughly the dropdown's height — used only to decide whether it opens downward or flips above the bar. */
const ASSIGN_MENU_HEIGHT = 250;

interface CellSplitMenuProps {
  /**
   * Screen anchor (client px): the horizontal CENTRE of the selected panel(s) and the y just below their
   * bottom edge. Republished by the canvas every frame, so the bar tracks the selection as it's dragged,
   * panned, or zoomed — a menu attached to the thing it acts on, never covering it.
   */
  x: number;
  y: number;
  /**
   * Whether the shape has been split into panels yet. Before the first split a border is one bare
   * pseudo-panel — the raw elevation — so there is nothing to frame or give a material to, and Edit /
   * Assign are hidden rather than shown acting on nothing.
   */
  canEditPanels?: boolean;
  onApply: (cols: number, rows: number) => void;
  /** Dismiss the bar. No × on the bar itself — Esc, an outside click, or dropping the selection. */
  onClose: () => void;
  /** Fires on mount and on every cols/rows change — drives the faint on-canvas split preview. */
  onChange?: (cols: number, rows: number) => void;
  /** Edit the clicked panel's frame. */
  onEdit: () => void;
  /** Assign a material kind to the selected panels (null clears it). */
  onAssignKind: (kind: PanelKind | null) => void;
  /**
   * Hovering an option in the Assign menu previews it on the selected panels; null stops previewing.
   * Render-only — the canvas paints it, nothing is written until the option is clicked.
   */
  onPreviewKind?: (preview: { kind: PanelKind | null } | null) => void;
  /** The rationalization mode this shape is currently in — ticked in the Optimize menu. */
  panelMode?: PanelMode | null;
  /** Apply a rationalization to this shape. Re-picking the live mode clears it. */
  onOptimize?: (strategy: OptimizeStrategy) => void;
  /**
   * Hovering an Optimize option previews exactly what clicking it would do; null stops previewing. The
   * strategy is passed through untouched — the canvas runs the real operation on a clone, so the menu
   * doesn't have to know which strategies are modes and which are one-shot edits.
   */
  onPreviewStrategy?: (strategy: OptimizeStrategy | null) => void;
}

/**
 * The floating panel menu for the Facade Layers tool — one horizontal bar hanging under the SELECTED
 * panel(s), opened by selecting them rather than by any right-click: split into `cols × rows`, edit the
 * frame, or assign a material. A faint preview of the subdivision shows on the canvas as the counts change.
 * Closes on Esc, on an outside click, or when the selection it belongs to is dropped. `1 × 1` collapses the
 * cell back to a leaf.
 */
export function CellSplitMenu({
  x,
  y,
  canEditPanels = false,
  onApply,
  onClose,
  onChange,
  onEdit,
  onAssignKind,
  onPreviewKind,
  panelMode = null,
  onOptimize,
  onPreviewStrategy,
}: CellSplitMenuProps) {
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(2);
  // When true, the bar shows the material picker instead of the split controls.
  const [assigning, setAssigning] = useState(false);
  // Which dropdown is open. Only ever one — two menus hanging off the same bar would overlap.
  const [optimizing, setOptimizing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Push the live counts to the canvas preview (on mount and whenever they change).
  useEffect(() => {
    onChange?.(cols, rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, rows]);

  // Whatever ends the interaction — closing the menu, closing the bar, unmounting — must drop the preview,
  // or the last hovered material stays painted on panels that were never assigned it.
  // Held in refs so the teardown effects below depend on NOTHING. Depending on the callbacks themselves
  // was self-defeating: a parent that passes an inline arrow gets a fresh identity on every render — including
  // the render its own preview triggers — so the cleanup fired and cancelled the preview the instant it was
  // set, and the hover appeared to do nothing at all.
  const previewKindRef = useRef(onPreviewKind);
  previewKindRef.current = onPreviewKind;
  const previewStrategyRef = useRef(onPreviewStrategy);
  previewStrategyRef.current = onPreviewStrategy;

  useEffect(() => {
    if (!assigning) previewKindRef.current?.(null);
  }, [assigning]);
  useEffect(() => {
    if (!optimizing) previewStrategyRef.current?.(null);
  }, [optimizing]);
  // Unmount only.
  useEffect(
    () => () => {
      previewKindRef.current?.(null);
      previewStrategyRef.current?.(null);
    },
    [],
  );

  // Close on outside click or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // The bar's real size, measured from the DOM. Reading it back — rather than trusting a constant to match
  // what the buttons actually need — is what keeps the centring honest as the contents change.
  const [size, setSize] = useState({ w: BAR_WIDTH, h: BAR_HEIGHT });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Runs before paint, so the seeded estimate above is never actually shown.
    const measure = () =>
      setSize((prev) => {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Centre the bar under the anchor, then keep it on-screen: nudge horizontally so neither end clips, and
  // lift it clear of the bottom edge when there's no room below.
  const MARGIN = 8;
  const left = Math.max(MARGIN, Math.min(x - size.w / 2, window.innerWidth - size.w - MARGIN));
  const top = Math.max(MARGIN, Math.min(y, window.innerHeight - size.h - MARGIN));
  // The bar hangs under the selection, so near the bottom of the screen a downward dropdown would run off.
  const flipUp = top + size.h + ASSIGN_MENU_HEIGHT > window.innerHeight - MARGIN;

  // Default view: one horizontal toolbar — split counts, Split, then the panel actions.
  return (
    <div
      ref={ref}
      className={styles.menu}
      style={{ left, top }}
      role="dialog"
      aria-label="Panel actions"
    >
      <Field label="Columns" value={cols} onChange={setCols} demoId="spin-cols" />
      <span className={styles.times} aria-hidden="true">×</span>
      <Field label="Rows" value={rows} onChange={setRows} demoId="spin-rows" />
      <button
        type="button"
        className={styles.apply}
        data-demo="bar-split"
        title={`Split this panel into ${cols} × ${rows}`}
        onClick={() => onApply(cols, rows)}
      >
        Split
      </button>
      {canEditPanels && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <button
            type="button"
            className={styles.panelBtn}
            data-demo="bar-edit"
            title="Edit the selected panels' frame"
            onClick={onEdit}
          >
            Edit
          </button>
          {/* Assign owns a dropdown anchored to itself, so the bar never swaps out from under the user —
              the split controls stay put and the material list appears where the button is. */}
          {/* Optimize: rationalizes THIS shape (its own mode, independent of any other shape on the
              elevation). Hovering an option repanelizes it live so the trade-off is visible before it lands. */}
          <span className={styles.assignWrap}>
            <button
              type="button"
              className={`${styles.panelBtn} ${optimizing ? styles.panelBtnOpen : ''}`}
              data-demo="bar-optimize"
              title="Rationalize this shape's panels"
              aria-haspopup="menu"
              aria-expanded={optimizing}
              onClick={() => {
                setAssigning(false);
                setOptimizing((v) => !v);
              }}
            >
              Optimize
              <span className={styles.caret} aria-hidden="true">
                <Chevron />
              </span>
            </button>
            {optimizing && (
              <div
                className={`${styles.assignMenu} ${flipUp ? styles.assignMenuUp : ''}`}
                role="menu"
                aria-label="Rationalization"
                onMouseLeave={() => onPreviewStrategy?.(null)}
              >
                {STRATEGIES.map(({ id, label }) => {
                  const live = id === panelMode;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={live}
                      className={`${styles.kindItem} ${live ? styles.kindItemOn : ''}`}
                      data-demo={`opt-${id}`}
                      title={live ? `${label} — pick again to clear` : label}
                      // Every option previews the same way — the canvas runs the real operation on a
                      // clone, so re-picking the live mode previews clearing it and Snap to Grid previews
                      // the outline moving onto the lattice.
                      onMouseEnter={() => onPreviewStrategy?.(id)}
                      onFocus={() => onPreviewStrategy?.(id)}
                      onClick={() => {
                        onPreviewStrategy?.(null);
                        onOptimize?.(id);
                        setOptimizing(false);
                      }}
                    >
                      <span className={styles.kindName}>{label}</span>
                      {live && <span className={styles.kindTick} aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </span>
          <span className={styles.assignWrap}>
            <button
              type="button"
              className={`${styles.panelBtn} ${assigning ? styles.panelBtnOpen : ''}`}
              data-demo="bar-assign"
              title="Assign a material to the selected panels"
              aria-haspopup="menu"
              aria-expanded={assigning}
              onClick={() => {
                setOptimizing(false);
                setAssigning((v) => !v);
              }}
            >
              Assign
              <span className={styles.caret} aria-hidden="true">
                <Chevron />
              </span>
            </button>
            {assigning && (
              <div
                className={`${styles.assignMenu} ${flipUp ? styles.assignMenuUp : ''}`}
                role="menu"
                aria-label="Panel material"
                onMouseLeave={() => onPreviewKind?.(null)}
              >
                {PANEL_KINDS.map(({ kind, label, short }) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className={styles.kindItem}
                    data-demo={`kind-${kind}`}
                    title={label}
                    onMouseEnter={() => onPreviewKind?.({ kind })}
                    onFocus={() => onPreviewKind?.({ kind })}
                    onClick={() => {
                      onPreviewKind?.(null);
                      onAssignKind(kind);
                      setAssigning(false);
                    }}
                  >
                    <span className={styles.kindName}>{short}</span>
                    <span className={styles.kindFull}>{label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.kindItem} ${styles.kindClear}`}
                  title="Clear the assigned material"
                  onMouseEnter={() => onPreviewKind?.({ kind: null })}
                  onFocus={() => onPreviewKind?.({ kind: null })}
                  onClick={() => {
                    onPreviewKind?.(null);
                    onAssignKind(null);
                    setAssigning(false);
                  }}
                >
                  <span className={styles.kindName}>None</span>
                  <span className={styles.kindFull}>Clear the assignment</span>
                </button>
              </div>
            )}
          </span>
        </>
      )}
    </div>
  );
}

/** Chevron glyph for the spinner — `up` points it up, otherwise down. */
function Chevron({ up }: { up?: boolean }) {
  return (
    <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
      <path
        d={up ? 'M1 4.5 L4.5 1 L8 4.5' : 'M1 1.5 L4.5 5 L8 1.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A count field: the number, with its increment/decrement chevrons STACKED against its right edge inside
 * one bordered box. The earlier `− n +` laid all three out in a row, which cost roughly twice the width for
 * the same two controls — the bar carries two of these, so the saving is what keeps it compact.
 */
function Field({
  label,
  value,
  onChange,
  demoId,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** Prefix for the guided tour's `data-demo` hooks on the two chevrons. */
  demoId: string;
}) {
  const clamp = (n: number) => Math.max(1, Math.min(20, Math.round(n)));
  return (
    <div className={styles.field}>
      <input
        className={styles.input}
        type="number"
        min={1}
        max={20}
        aria-label={label}
        title={label}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      <span className={styles.spin}>
        <button
          type="button"
          className={styles.spinBtn}
          data-demo={`${demoId}-up`}
          aria-label={`increase ${label}`}
          tabIndex={-1}
          onClick={() => onChange(clamp(value + 1))}
        >
          <Chevron up />
        </button>
        <button
          type="button"
          className={styles.spinBtn}
          data-demo={`${demoId}-down`}
          aria-label={`decrease ${label}`}
          tabIndex={-1}
          onClick={() => onChange(clamp(value - 1))}
        >
          <Chevron />
        </button>
      </span>
    </div>
  );
}
