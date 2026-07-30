import { useState } from 'react';
import styles from './AdjacencyMatrix.module.css';
import { ADJACENCY, applyAdjacency, DEFAULT_ADJACENCY } from '../../rooms/roomAdjacency';
import {
  buildRankMatrix,
  composeNext,
  keyLabel,
  SOURCE_KEYS,
  TARGET_KEYS,
  type Adjacency,
  type RankMatrix,
} from './adjacencyMatrixModel';

interface AdjacencyMatrixProps {
  /** Close the card (re-openable from the Generate submenu's matrix button). */
  onClose: () => void;
  /**
   * Called with the new table after Apply/Reset, so the signed-in user's edits can be saved
   * to their account (in addition to the dev source-file write-back). No-op for guests.
   */
  onPersist?: (next: Record<string, Record<string, number>>) => void;
  /**
   * Catalog key of the room the cursor is hovering on the canvas (or null) — its row and
   * column get a grey infill so you can locate that program in the matrix at a glance.
   */
  hoveredKey?: string | null;
}

/** Grey infill for the hovered room's crossing row + column. */
const AXIS_HIGHLIGHT = '#dde1e7';

/** Cell shading: rank 1 is the darkest grey, fading to nothing by rank ~6. */
function cellShade(rank: number | undefined): string | undefined {
  if (!rank) return undefined;
  const alpha = Math.max(0, 0.4 - (rank - 1) * 0.07);
  return alpha > 0 ? `rgba(63, 63, 70, ${alpha.toFixed(3)})` : undefined;
}

/** A short "1. Kitchen · 2. …" preview of a row's top picks, from its current ranks. */
function rowPreview(rankRow: Record<string, number>): string {
  const top = Object.entries(rankRow)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([k], i) => `${i + 1}. ${keyLabel(k)}`);
  return top.length ? top.join('  ·  ') : 'no predictions';
}

/** POST the table to the dev write-back endpoint; resolves with ok + an optional message. */
async function persist(adjacency: Adjacency): Promise<{ ok: boolean; msg?: string }> {
  try {
    const res = await fetch('/__dev/adjacency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adjacency }),
    });
    if (res.status === 204) return { ok: true };
    return { ok: false, msg: (await res.text()) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, msg: err instanceof Error ? err.message : 'network error' };
  }
}

/**
 * Card that visualises and edits the real next-room prediction table ({@link ADJACENCY}). Rows/columns are
 * room programs; each cell is the predicted RANK (reverse logic: 1 = most likely, blank = never). Editing a
 * rank and pressing Apply rewrites the underlying weights — applied live to predictions AND persisted to
 * roomAdjacency.ts.
 *
 * Pinned to the same top-right slot as the Constraints and Library cards, with the same header/body/footer
 * split. The table is wider than that slot, so it scrolls inside the body with its row and column headers
 * stuck in place — the card matches its siblings and the matrix keeps its full 20 × 21 reach.
 */
export function AdjacencyMatrix({ onClose, onPersist, hoveredKey }: AdjacencyMatrixProps) {
  const [ranks, setRanks] = useState<RankMatrix>(() => buildRankMatrix(ADJACENCY));
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('1 = most likely · blank = never');
  // The cell the user last clicked into. Its row and column light up so you can trace a cell back to the
  // two programs it relates without counting across a 20-wide grid. Set on FOCUS rather than click, so
  // tabbing between cells moves the crosshair too.
  const [active, setActive] = useState<{ source: string; target: string } | null>(null);

  const setCell = (source: string, target: string, raw: string) => {
    setRanks((prev) => {
      const row = { ...prev[source] };
      const n = parseInt(raw, 10);
      if (raw.trim() === '' || !Number.isFinite(n) || n < 1) delete row[target];
      else row[target] = n;
      return { ...prev, [source]: row };
    });
    setDirty((prev) => new Set(prev).add(source));
  };

  const apply = async () => {
    const dirtyRows: RankMatrix = {};
    dirty.forEach((s) => {
      dirtyRows[s] = ranks[s];
    });
    const next = composeNext(ADJACENCY, dirtyRows);
    applyAdjacency(next); // live: predictions change immediately
    onPersist?.(next); // save to the signed-in user's account (no-op for guests)
    setStatus('Saving…');
    const r = await persist(next);
    setDirty(new Set());
    setStatus(r.ok ? 'Saved to source ✓ — predictions updated.' : `Applied live · file write failed: ${r.msg}`);
  };

  const reset = async () => {
    const next: Adjacency = JSON.parse(JSON.stringify(DEFAULT_ADJACENCY));
    applyAdjacency(next);
    onPersist?.(next); // mirror the reset to the signed-in user's account
    setRanks(buildRankMatrix(next));
    setDirty(new Set());
    setStatus('Saving…');
    const r = await persist(next);
    setStatus(r.ok ? 'Reset to defaults ✓' : `Reset live · file write failed: ${r.msg}`);
  };

  const revert = () => {
    setRanks(buildRankMatrix(ADJACENCY));
    setDirty(new Set());
    setStatus('Reverted unsaved edits.');
  };

  const hasEdits = dirty.size > 0;

  return (
    <div className={styles.panel} role="dialog" aria-label="Adjacency Matrix">
      <div className={styles.header}>
        <span className={styles.title}>Adjacency Matrix</span>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          title="Close"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className={styles.body}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th className={styles.corner} title="row = current room · column = predicted next room">
                from \ to
              </th>
              {TARGET_KEYS.map((t) => (
                <th
                  key={t}
                  className={`${styles.colHead} ${active?.target === t ? styles.axisHead : ''}`}
                  title={keyLabel(t)}
                  style={hoveredKey === t ? { background: AXIS_HIGHLIGHT } : undefined}
                >
                  <span className={styles.colLabel}>{t}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SOURCE_KEYS.map((s) => {
              const rowHi = hoveredKey === s;
              const inActiveRow = active?.source === s;
              return (
                <tr key={s}>
                  <th
                    className={`${styles.rowHead} ${dirty.has(s) ? styles.rowDirty : ''} ${
                      inActiveRow ? styles.axisHead : ''
                    }`}
                    title={`${keyLabel(s)} → ${rowPreview(ranks[s] ?? {})}`}
                    style={rowHi ? { background: AXIS_HIGHLIGHT } : undefined}
                  >
                    {keyLabel(s)}
                  </th>
                  {TARGET_KEYS.map((t) => {
                    const rank = ranks[s]?.[t];
                    const isDiag = s === t;
                    const axisHi = rowHi || hoveredKey === t;
                    const inActiveCol = active?.target === t;
                    const isActive = inActiveRow && inActiveCol;
                    // Crosshair beats the canvas-hover tint, which beats the rank shading.
                    const cross = isActive
                      ? styles.axisCell
                      : inActiveRow
                        ? styles.axisRow
                        : inActiveCol
                          ? styles.axisCol
                          : '';
                    return (
                      <td
                        key={t}
                        className={`${styles.cell} ${isDiag ? styles.diag : ''} ${cross}`}
                        style={{ background: axisHi ? AXIS_HIGHLIGHT : cellShade(rank) }}
                      >
                        <input
                          className={styles.cellInput}
                          value={rank ?? ''}
                          inputMode="numeric"
                          onChange={(e) => setCell(s, t, e.target.value)}
                          onFocus={() => setActive({ source: s, target: t })}
                          title={`${keyLabel(s)} → ${keyLabel(t)}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.footer}>
        <span className={styles.status}>{status}</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={reset}
            title="Restore the factory prediction table"
          >
            Reset defaults
          </button>
          <button type="button" className={styles.ghostBtn} onClick={revert} disabled={!hasEdits}>
            Revert
          </button>
          <button type="button" className={styles.primaryBtn} onClick={apply} disabled={!hasEdits}>
            Apply{hasEdits ? ` (${dirty.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
