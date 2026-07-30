import { useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { CanvasHandle } from '../InfiniteCanvas/InfiniteCanvas';
import type { Square } from '../../types';
import type { LibraryCluster } from '../../library';
import { ClusterThumbnail } from './ClusterThumbnail';
import styles from './LibraryPanel.module.css';

interface LibraryPanelProps {
  clusters: LibraryCluster[];
  canvasRef: RefObject<CanvasHandle>;
  /** Close the Library popup (called when a cluster is picked up to place). */
  onClose: () => void;
  /** Remove a saved cluster. */
  onDelete: (id: string) => void;
  /** Rename a saved cluster (empty title reverts to the default "Group N" label). */
  onRename: (id: string, name: string) => void;
  /** Persist a new saved-cluster order (the full list of ids, top to bottom). */
  onReorder: (orderedIds: string[]) => void;
}

/** Badge text: the user's title, or a sequential "Group N" default (by list position)
 *  when unnamed. The number is the cluster's place in the list, NOT its room count. */
function clusterLabel(cluster: LibraryCluster, index: number): string {
  return cluster.name || `Group ${index + 1}`;
}

/** Pointer travel (px) before a press on a thumbnail counts as a drag. */
const DRAG_THRESHOLD = 4;

/** True when two cluster lists are in the same id order. */
function sameOrder(a: LibraryCluster[] | null, b: LibraryCluster[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((c, i) => c.id === b[i].id);
}

/**
 * Contents of the Library popup: a scrollable list of saved clusters, each a fitted
 * thumbnail. A press-and-drag does one of two things depending on where the cursor is:
 *  - INSIDE the popup → reorder the list (the dragged card slots between the others).
 *  - OUTSIDE the popup border → arm the cursor-following canvas placement; release to drop.
 * A plain click arms placement on the next canvas click. A small × removes a cluster.
 */
export function LibraryPanel({
  clusters,
  canvasRef,
  onClose,
  onDelete,
  onRename,
  onReorder,
}: LibraryPanelProps) {
  // Which cluster's title is being edited, and the in-progress text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Begin renaming: seed the field with the label currently shown (the user's name or the
  // "Group N" default) so it can be highlighted-and-overwritten, like the TopBar title.
  const startEditing = (cluster: LibraryCluster, label: string) => {
    setEditingId(cluster.id);
    setDraft(label);
  };

  const commitName = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  // Per-active-gesture state (one pointer at a time). `mode` decides reorder vs. canvas
  // placement and flips as the cursor crosses the popup border.
  const gesture = useRef({
    active: false,
    mode: 'pending' as 'pending' | 'reorder' | 'canvas',
    startX: 0,
    startY: 0,
    id: '',
    shapes: [] as Square[],
  });

  // Live reorder preview. `dragOrder` (when set) is the order rendered mid-drag; refs mirror
  // the state so the pointer handlers read fresh values synchronously.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<LibraryCluster[] | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragOrderRef = useRef<LibraryCluster[] | null>(null);
  const setDrag = (id: string | null, order: LibraryCluster[] | null) => {
    dragIdRef.current = id;
    dragOrderRef.current = order;
    setDragId(id);
    setDragOrder(order);
  };

  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  /** The popup box's screen rect — the border that separates reorder from canvas drop. */
  const popupRect = (): DOMRect | null =>
    listRef.current?.closest('[role="dialog"]')?.getBoundingClientRect() ?? null;

  /** The reordered list for the current pointer Y: drop the dragged card before the first
   *  other card whose vertical midpoint is below the cursor. */
  const computeReorder = (pointerY: number): LibraryCluster[] => {
    const base = dragOrderRef.current ?? clusters;
    const dragged = base.find((c) => c.id === gesture.current.id);
    if (!dragged) return base;
    const others = base.filter((c) => c.id !== gesture.current.id);
    let insert = others.length;
    for (let i = 0; i < others.length; i++) {
      const el = itemRefs.current.get(others[i].id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (pointerY < r.top + r.height / 2) {
        insert = i;
        break;
      }
    }
    const next = others.slice();
    next.splice(insert, 0, dragged);
    return next;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, cluster: LibraryCluster) => {
    if (e.button !== 0) return;
    gesture.current = {
      active: true,
      mode: 'pending',
      startX: e.clientX,
      startY: e.clientY,
      id: cluster.id,
      shapes: cluster.shapes,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No such active pointer — the case for a synthesized gesture (the guided tour drags a card out
      // onto the canvas). Capture is an optimisation here, not the mechanism: the move/up handlers work
      // off coordinates, so losing it costs nothing, whereas letting it throw would abort the gesture on
      // its first event.
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.active) return;
    const handle = canvasRef.current;
    const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    if (g.mode === 'pending' && moved <= DRAG_THRESHOLD) return;

    const rect = popupRect();
    const inside =
      !!rect &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;

    if (inside) {
      // Reorder mode: cancel any armed canvas ghost, then slot the card into place.
      if (g.mode === 'canvas') handle?.cancelPlacement();
      g.mode = 'reorder';
      if (dragIdRef.current == null) setDrag(g.id, clusters.slice());
      const next = computeReorder(e.clientY);
      if (!sameOrder(next, dragOrderRef.current)) setDrag(g.id, next);
    } else {
      // Canvas mode: arm the ghost on first exit, then track the cursor.
      if (g.mode !== 'canvas') {
        g.mode = 'canvas';
        setDrag(null, null); // list returns to its normal order behind the popup
        handle?.startClusterPlacement(g.shapes, e.clientX, e.clientY);
      } else {
        handle?.updatePlacement(e.clientX, e.clientY);
      }
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.active) return;
    g.active = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released; ignore.
    }
    const handle = canvasRef.current;
    if (g.mode === 'canvas') {
      // Released outside: drop the cluster where it lies, then close the popup.
      handle?.commitPlacementAtClient(e.clientX, e.clientY);
      onClose();
    } else if (g.mode === 'reorder') {
      // Released inside: keep the new order; the popup stays open for more rearranging.
      if (dragOrderRef.current) onReorder(dragOrderRef.current.map((c) => c.id));
    } else {
      // Plain click: arm the ghost to follow the cursor and place on the next canvas click.
      handle?.startClusterPlacement(g.shapes, e.clientX, e.clientY);
      onClose();
    }
    g.mode = 'pending';
    setDrag(null, null);
  };

  if (clusters.length === 0) {
    return <div className={styles.empty}>Drag a selection here to save it.</div>;
  }

  const order = dragOrder ?? clusters;

  return (
    <div className={styles.list} ref={listRef}>
      {order.map((cluster, i) => (
        <div
          key={cluster.id}
          ref={(el) => {
            if (el) itemRefs.current.set(cluster.id, el);
            else itemRefs.current.delete(cluster.id);
          }}
          className={`${styles.item}${dragId === cluster.id ? ` ${styles.dragging}` : ''}`}
          data-demo={`library-item-${i}`}
          onPointerDown={(e) => onPointerDown(e, cluster)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <ClusterThumbnail shapes={cluster.shapes} />
          {editingId === cluster.id ? (
            <input
              className={styles.nameInput}
              value={draft}
              autoFocus
              spellCheck={false}
              // Like the TopBar title: highlight the whole label on focus, ready to
              // overwrite or delete (no placeholder prompt).
              onFocus={(e) => e.currentTarget.select()}
              // Keep the press from starting a pickup/placement gesture on the card.
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitName();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditingId(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.count}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => startEditing(cluster, clusterLabel(cluster, i))}
            >
              {clusterLabel(cluster, i)}
            </button>
          )}
          <button
            type="button"
            className={styles.delete}
            aria-label="Delete saved cluster"
            // Stop the press from starting a pickup gesture on the card.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onDelete(cluster.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
