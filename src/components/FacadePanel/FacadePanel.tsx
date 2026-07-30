import styles from './FacadePanel.module.css';

interface FacadePanelProps {
  /** Material-ID (segmentation) view on/off. */
  idView: boolean;
  /** Purely-visual drop shadow under the per-group frame bands on/off. */
  frameShadow: boolean;
  /** Whether the paint-by-number panel overlay is on. */
  optimizeActive: boolean;
  onToggleIdView: () => void;
  onToggleFrameShadow: () => void;
  /** Toggle the paint-by-number panel overlay. */
  onToggleOptimize: () => void;
}

/**
 * Right-docked card of Facade DISPLAY switches — how the elevation is drawn, nothing about what it is.
 *
 * It began as a catch-all "Facade Actions" panel; every actual action has since moved onto the canvas where
 * it can be scoped to what the user picked (border vs panel editing resolves from what the cursor is over,
 * the boolean unite/subtract is driven by clicking the overlap, and rationalization lives in the floating
 * panel bar's Optimize menu — per SHAPE). What remains is purely view state, hence the name, and the group
 * heading is gone: with one group left it only repeated the title.
 */
export function FacadePanel({
  idView,
  frameShadow,
  optimizeActive,
  onToggleIdView,
  onToggleFrameShadow,
  onToggleOptimize,
}: FacadePanelProps) {
  return (
    <aside className={styles.panel} aria-label="Display Toggles">
      <div className={styles.header}>
        <span className={styles.title}>Display Toggles</span>
      </div>

      <div className={styles.body}>
        <div className={styles.group}>
          <button
            type="button"
            className={`${styles.toggle} ${idView ? styles.idActive : ''}`}
            aria-pressed={idView}
            data-demo="toggle-idview"
            title="Toggle the Material-ID (segmentation) view"
            onClick={onToggleIdView}
          >
            <span>Material-ID</span>
            <span className={styles.toggleState}>{idView ? 'On' : 'Off'}</span>
          </button>
          {/* The paint-by-number overlay — a view switch, though it once doubled as the Optimize
              section's expander. */}
          <button
            type="button"
            className={`${styles.toggle} ${optimizeActive ? styles.optActive : ''}`}
            aria-pressed={optimizeActive}
            data-demo="toggle-numbers"
            title="Number each panel by shape group — identical panels share a number"
            onClick={onToggleOptimize}
          >
            <span>Panel Numbers</span>
            <span className={styles.toggleState}>{optimizeActive ? 'On' : 'Off'}</span>
          </button>
          <button
            type="button"
            className={`${styles.toggle} ${frameShadow ? styles.shadowActive : ''}`}
            aria-pressed={frameShadow}
            data-demo="toggle-shadow"
            title="Toggle a purely-visual drop shadow that lifts the frame assembly off the wall"
            onClick={onToggleFrameShadow}
          >
            <span>Frame Shadow</span>
            <span className={styles.toggleState}>{frameShadow ? 'On' : 'Off'}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
