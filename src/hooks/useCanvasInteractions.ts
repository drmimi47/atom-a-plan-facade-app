import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type {
  Camera,
  DrawLayer,
  Footprint,
  LengthUnit,
  Marquee,
  PendingPlacement,
  Square,
} from '../types';
import { footprintAsShape } from '../canvas/footprint';
import {
  resolveWallSnap,
  emptySnapState,
  SNAP_ENGAGE_WIDE_PX,
  type SnapState,
  type AlignGuide,
} from '../canvas/snapping';
import type { Constraints } from '../../backend/types';
import { clampDragToConstraints } from '../../backend/clamp';
import { screenToWorld, worldToScreen } from '../canvas/coords';
import {
  resizeShape,
  resizeWall,
  resizeAllWalls,
  differenceWallEdges,
  moveVertex,
  stretchEdge,
  recenterCorners,
  cornerIndexForHandle,
  cursorForHandle,
  edgeFace,
  hitCorner,
  hitCornerHandle,
  hitCornerDot,
  hitDimensionLabel,
  hitWallDimensionLabel,
  hitCenterLabel,
  hitCenterLock,
  hitEdgePlus,
  polygonShape,
  hitPredictionOption,
  adjacentCopyOffset,
  adjacentRoomPlacement,
  defaultWalls,
  scaledToArea,
  areaLockAnchorWorld,
  hitShapeEdge,
  hitTopShape,
  pointInSelectedOverlapBand,
  overlapBandAt,
  overlapInteriorAt,
  differenceCorners,
  unionCorners,
  unionWallEdges,
  type DimensionLabelHit,
  type WallDimensionLabelHit,
  type CenterLabelHit,
  type EdgeFace,
  type HandleId,
  type HoverRegion,
} from '../canvas/shapes';
import {
  MIN_SHAPE_SCREEN_SIZE,
  MIN_WALL_WORLD,
  ROTATE_CURSOR,
  ROTATION_SNAP_DEG,
  WORLD_UNITS_PER_FOOT,
  DEFAULT_WALL_WORLD,
  BORDER_DIM_GAP,
} from '../constants';
import { findRoomDef } from '../rooms/roomCatalog';
import { predictRoomOptions, type PredictionOption } from '../rooms/roomAdjacency';
import {
  activeLayer as partitionActiveLayer,
  hasBoundary as partitionHasBoundary,
  hitCell as hitPartitionCell,
  polyBBox as partitionPolyBBox,
  cellRefRect as partitionCellRefRect,
  hitBoundaryEdge as hitPartitionBoundaryEdge,
  hitBorderCorner as hitPartitionCorner,
  moveBorderCorner as movePartitionCorner,
  rotateBorder as rotatePartitionBorder,
  borderIndexAt as partitionBorderIndexAt,
  borderBooleanHoverAt,
  uniteBorders as unitePartitionBorders,
  differenceBorders as differencePartitionBorders,
  moveBorder as movePartitionBorder,
  hitAnyLine as hitPartitionLine,
  moveLine as movePartitionLine,
  duplicateLine as duplicatePartitionLine,
  lineCandidates as partitionLineCandidates,
  hitGridSegment as hitPartitionGridSegment,
  isSplitSegment as partitionIsSplitSegment,
  panelBorderEdges as partitionPanelBorderEdges,
  moveGridSegment as movePartitionGridSegment,
  duplicateSegment as duplicatePartitionSegment,
  moveSegmentExtra as movePartitionSegmentExtra,
  moveLatticePreservingFrames as partitionPreserveFrames,
  cellGroupAt as partitionCellGroupAt,
  groupCellKeys as partitionGroupCellKeys,
  cellKeyAt as partitionCellKeyAt,
  isSubdivided as partitionIsSubdivided,
  borderMode as partitionBorderMode,
  pointInBorder as partitionPointInBorder,
  cellKeysInRect as partitionCellKeysInRect,
  cellRectsOf as partitionCellRectsOf,
  cellGroups as partitionCellGroups,
  cellKey as partitionCellKey,
  duplicateBorder as partitionDuplicateBorder,
  panelFrameAt as partitionPanelFrame,
  frameInnerRect as partitionFrameInnerRect,
  setPanelFrame as partitionSetPanelFrame,
  type BorderBooleanHover,
  type FacadeLayer,
  type CellRef,
  type PanelMode,
  type ExtraSegHandle,
  type FacadeDoc,
  type LineHandle,
  type Rect,
  type SegmentRef,
} from '../facade/partition';

/** Radius (screen px) of a border corner's rotation zone, and how far out along the bisector it sits. */
const BORDER_ROTATE_RADIUS = 11;

/**
 * Is the screen point inside a border corner's ROTATION zone — the ring just outside the corner, centred
 * on its exterior bisector where {@link drawCornerRotationArcs} paints the arc? Mirrors the arc's geometry
 * so the grab area matches what's drawn, and sits clear of the corner grip itself (which deforms).
 */
function hitBorderRotateZone(
  poly: { x: number; y: number }[],
  screenX: number,
  screenY: number,
  camera: Camera,
): boolean {
  const n = poly.length;
  if (n < 3) return false;
  const off = BORDER_DIM_GAP / 2; // the arc's radius
  for (let i = 0; i < n; i++) {
    const c = worldToScreen(poly[i].x, poly[i].y, camera);
    const prev = worldToScreen(poly[(i + n - 1) % n].x, poly[(i + n - 1) % n].y, camera);
    const next = worldToScreen(poly[(i + 1) % n].x, poly[(i + 1) % n].y, camera);
    let d1x = prev.x - c.x;
    let d1y = prev.y - c.y;
    let d2x = next.x - c.x;
    let d2y = next.y - c.y;
    const l1 = Math.hypot(d1x, d1y) || 1;
    const l2 = Math.hypot(d2x, d2y) || 1;
    d1x /= l1;
    d1y /= l1;
    d2x /= l2;
    d2y /= l2;
    const bx = -(d1x + d2x); // exterior bisector, away from the interior
    const by = -(d1y + d2y);
    const bl = Math.hypot(bx, by);
    if (bl < 1e-3) continue; // near-straight corner draws no arc, so nothing to grab
    const zx = c.x + (bx / bl) * off;
    const zy = c.y + (by / bl) * off;
    if ((screenX - zx) ** 2 + (screenY - zy) ** 2 <= BORDER_ROTATE_RADIUS ** 2) return true;
  }
  return false;
}

/**
 * Screen cursor for a boundary edge. Derived from the edge's own direction rather than a compass face, so
 * it stays correct on the angled edges a boolean union/difference leaves behind: a mostly-horizontal edge
 * stretches vertically, and vice versa.
 */
function cursorForBoundaryEdge(a: { x: number; y: number }, b: { x: number; y: number }): string {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'ns-resize' : 'ew-resize';
}

/**
 * Resize cursor for the diagonal border-cut frame edge, where the drag axis is the edge's perpendicular
 * (its inward normal). To look identical to the vertical/horizontal frame-line cursors we reuse the SAME
 * native glyphs: a more-horizontal drag (normal closer to horizontal) is `col-resize`, like sliding a
 * vertical line; a more-vertical drag is `row-resize`, like sliding a horizontal one.
 */
function cursorForNormal(nx: number, ny: number): string {
  return Math.abs(nx) >= Math.abs(ny) ? 'col-resize' : 'row-resize';
}

/**
 * Snap a dragged line coordinate to the nearest parallel grid line within the (screen-px) engage zone —
 * reusing the same alignment threshold as the wall snapper, so lines align with each other when close.
 * Returns the snapped world coordinate and the guide position (or null when free).
 */
function snapLineCoord(
  target: number,
  candidates: number[],
  scale: number,
): { value: number; guide: number | null } {
  let best: number | null = null;
  let bestDist = SNAP_ENGAGE_WIDE_PX;
  for (const c of candidates) {
    const d = Math.abs(target - c) * scale;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best != null ? { value: best, guide: best } : { value: target, guide: null };
}

interface InteractionParams {
  canvasRef: RefObject<HTMLCanvasElement>;
  cameraRef: MutableRefObject<Camera>;
  shapesRef: MutableRefObject<Square[]>;
  selectionRef: MutableRefObject<Set<string>>;
  /**
   * Active region of the selection: a handle id when a single wall edge is the
   * stretch target, or null when the white infill is selected (move target).
   */
  activeEdgeRef: MutableRefObject<HandleId | null>;
  /** Nearer face of the active edge under the pointer (glows magenta), or null. */
  edgeHoverRef: MutableRefObject<EdgeFace | null>;
  /** Shift held over the active edge face: light ALL inner/outer faces so a drag
   * stretches the whole boundary at once. */
  edgeFaceAllRef: MutableRefObject<boolean>;
  /** True once the active edge was armed by a clean click (no drag) — gates the
   * per-edge wall length/thickness dimensions. */
  wallDimsArmedRef: MutableRefObject<boolean>;
  /** Shape + region under the pointer, for the hover-preview darkening. */
  hoverRef: MutableRefObject<{ id: string; region: HoverRegion } | null>;
  /** Cursor in canvas-local screen px (null off-canvas / mid-drag), for the
   * shared-overlap-edge yellow hover when both rooms are selected. */
  hoverPointRef: MutableRefObject<{ x: number; y: number } | null>;
  /** Shape id whose centre name/area readout is hovered (draws the edit box). */
  centerHoverRef: MutableRefObject<string | null>;
  /** Edge-plus button under the pointer / being dragged ({shape id, dir 0=n/1=e/
   * 2=s/3=w, copy count}), or null — drives the translucent duplicate preview(s). */
  edgePlusHoverRef: MutableRefObject<{ id: string; dir: number; count: number } | null>;
  /** True while an edge stretch is dragging (keeps dimensions live). */
  resizingRef: MutableRefObject<boolean>;
  /** While rotating: the shape + grabbed corner, driving the live angle readout. */
  rotatingRef: MutableRefObject<{ id: string; corner: HandleId } | null>;
  /** Active measurement unit; dimension labels are read/edited in this unit. */
  unitRef: MutableRefObject<LengthUnit>;
  /** Active rubber-band rectangle, or null. */
  marqueeRef: MutableRefObject<Marquee | null>;
  /** Armed placement preview, or null. When set, pointer input places a square. */
  placementRef: MutableRefObject<PendingPlacement | null>;
  /** All committed building footprints (white slab behind every room). */
  footprintsRef: MutableRefObject<Footprint[]>;
  /** True while the footprint tool is armed (next canvas drag draws one). */
  footprintArmRef: MutableRefObject<boolean>;
  /** The footprint being drag-drawn (live preview), or null. */
  footprintDraftRef: MutableRefObject<Footprint | null>;
  /**
   * Shrink-into-Library animation state (render-only): `target` is set by this hook
   * as a selection drag enters/leaves the Library button; InfiniteCanvas eases
   * `scale` toward it and renders the selected shapes collapsing into the button.
   */
  libraryShrinkRef: MutableRefObject<{
    scale: number;
    target: number;
    /** World point the shapes collapse toward (the live mouse pointer). */
    pivot: { x: number; y: number };
  }>;
  /** Active next-room prediction fan (opened shape + dragged edge arrow), or null. */
  predictionDragRef: MutableRefObject<{
    shapeId: string;
    dir: number;
    hovered: number | null;
    dragging: boolean;
    /** Length-3, POSITION order (index 1 = middle = most confident). */
    options: (PredictionOption | null)[];
  } | null>;
  /** Commit the armed placement at a canvas-local screen point. */
  commitPlacement: (sx: number, sy: number) => void;
  /** Open the inline editor for a clicked dimension label. */
  beginDimensionEdit: (shapeId: string, hit: DimensionLabelHit) => void;
  /** Open the inline editor for a clicked centre readout (room name or area). */
  beginCenterEdit: (shapeId: string, hit: CenterLabelHit) => void;
  /** Open the inline editor for a clicked wall (edge) length/thickness label. */
  beginWallDimensionEdit: (shapeId: string, hit: WallDimensionLabelHit) => void;
  /** Snapshot the shapes into undo history after a completed mutation. */
  commitHistory: () => void;
  requestDraw: (layer?: DrawLayer) => void;
  /** Active constraints: a hard lock that clamps edits so they never violate. */
  constraintsRef: MutableRefObject<Constraints>;
  /** Client rect of the Library button (or null) — a move-drop here saves instead. */
  libraryDropRef?: MutableRefObject<DOMRect | null>;
  /** Client rect of the open Library popup (or null) — also a save drop-target. */
  libraryPopupDropRef?: MutableRefObject<DOMRect | null>;
  /** Fires true/false as a move drag enters/leaves the Library button. */
  onLibraryHover?: (over: boolean) => void;
  /** Fires with the dragged shapes when dropped onto the Library button. */
  onLibraryDrop?: (shapes: Square[]) => void;
  /**
   * Fires with the hovered room's catalog key (or `null` off any room) as the pointer
   * moves between rooms — drives the dev Adjacency Matrix's row/column highlight.
   */
  onHoverRoomKey?: (key: string | null) => void;
  /**
   * Dismisses any active smart-find highlight. Called when a room is actually edited
   * (stretch, vertex move, wall stretch, rotate) — navigation and moves don't call it.
   */
  clearFindHighlight?: () => void;
  /** Holds the active wall-alignment guide lines during a move drag (drawn green). */
  alignGuidesRef: MutableRefObject<AlignGuide[] | null>;
  /**
   * Facade mode flag. When set, a wall-thickness drag moves ALL four faces together (the mullion/joint
   * band is uniform per panel), so the inspector's single band value always stays in sync.
   */
  facadeRef?: MutableRefObject<boolean | undefined>;
  /**
   * Facade Layers tool (uniform sticky-cell partition). When `layersActiveRef` is true the pointer edits
   * the partition document instead of rooms. There is ONE editing mode, split by depth rather than by a
   * toggle: at shape level a border is selected, dragged, and reshaped by its handles; double-clicking
   * steps inside it, where the pointer edits mullions and paint-selects panels. Empty space outside every
   * border rubber-band selects panels. Rooms are bypassed.
   */
  layersActiveRef?: MutableRefObject<boolean | undefined>;
  /**
   * Index of the border the user has DOUBLE-CLICKED into, or null. This is the shape-vs-contents split that
   * replaced the Border/Panels switch:
   *
   *  - Outside it, a border is a SHAPE — click to select it, drag to move it, drag a handle to reshape it.
   *  - Inside it, the pointer edits that border's CONTENTS — mullions, cell splits, and paint-selecting
   *    panels — and the floating panel bar is open.
   *
   * Only one border is ever entered. A click outside it, or Escape, steps back out.
   */
  partitionEnteredRef?: MutableRefObject<number | null>;
  /**
   * Live edge-plus duplicate preview for the renderer: the border being copied, the per-copy step, and how
   * many copies the drag currently spans. Null when no plus drag is in flight.
   */
  partitionPlusRef?: MutableRefObject<{
    border: number;
    dx: number;
    dy: number;
    count: number;
  } | null>;
  /**
   * Edit-a-panel session. When set, the pointer edits the per-edge frame of the selected group(s): hovering a
   * representative-panel edge highlights it, dragging it sets that side's frame width (mirrored to every key),
   * and `hoverSide` is written back for the renderer. Null when no session is active.
   */
  frameEditRef?: MutableRefObject<{
    keys: string[];
    rect: Rect;
    hoverSide: 'n' | 'e' | 's' | 'w' | 'b' | null;
    allSides: boolean;
  } | null>;
  partitionDocRef?: MutableRefObject<FacadeDoc>;
  /** The shift-selected inner line segment (highlighted, jog-draggable), or null. */
  partitionSelSegRef?: MutableRefObject<SegmentRef | null>;
  /** Selected panels as per-CELL keys: a click expands the clicked panel's whole material group into the
   *  set, a rubber-band sweep adds only the panels it covered. */
  partitionCellSelRef?: MutableRefObject<Set<string>>;
  /** Border indices picked (shift-click, Border mode) for a boolean unite/difference op, in selection order. */
  partitionBorderSelRef?: MutableRefObject<Set<number>>;
  /** Right-click a cell → open the split + Edit/Assign menu at that screen point for that cell. */
  /**
   * Open (or close, with null) the floating panel menu. Reports the cell REF, not a screen point — the
   * owner recomputes the position from `onCellMenuAnchor` so the menu tracks the panel as it moves.
   */
  onCellMenu?: (
    info: {
      ref: CellRef;
      rect: Rect | null;
      subdivided: boolean;
      /** The shape's rationalization mode, so the Optimize menu can tick the live one. */
      mode: PanelMode | null;
    } | null,
  ) => void;
  /** Exit the active Edit-a-panel session (a clean click outside the border / on another group acts as Done). */
  onExitFrameEdit?: () => void;
}

type Mode =
  | 'none'
  | 'pan'
  | 'move'
  | 'resize'
  | 'thickness'
  | 'rotate'
  | 'marquee'
  | 'vertex'
  | 'plusdrag'
  | 'predictdrag'
  | 'footdraw'
  | 'boundaryEdge'
  | 'cornerDrag'
  | 'borderMove'
  | 'lineDrag'
  | 'segmentDrag'
  | 'segExtraDrag'
  | 'partitionFrame'
  | 'partitionMarquee'
  | 'partitionPaint'
  | 'partitionPlus'
  | 'partitionRotate';

/** Most copies a single edge-plus drag can spawn (matches the prompt cap). */
const MAX_PLUS_COPIES = 50;

/** A footprint drag shorter than this (world units, ~1 ft) is treated as a cancel. */
const MIN_FOOTPRINT_WORLD = WORLD_UNITS_PER_FOOT;

/** Target scale the dragged selection shrinks to while it hovers the Library button. */
const LIBRARY_SHRINK_MIN = 0.14;

/**
 * True when a key event's target already owns the keyboard: a text field, or any
 * focusable control Space would activate. Canvas shortcuts stand down for these.
 */
function isKeyboardTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return (
    t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.tagName === 'BUTTON' ||
    t.tagName === 'A'
  );
}

/** Fresh shape id, mirroring InfiniteCanvas's generator. */
function createId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sq_${Math.random().toString(36).slice(2)}`;
}

/** Snapshot of a shape's geometry at gesture start, for delta-based edits. */
interface DragItem {
  shape: Square;
  orig: Square;
}

/**
 * Single pointer controller for the canvas. On pointer-down it arbitrates, in
 * priority order: (0!) Space held → pan (the only camera gesture), (0) commit an
 * armed placement, (1) shift → additive rubber-band marquee, (2) the rotation knob
 * of a single selection → rotate, (3) an edge/corner of the selection → stretch the
 * whole selection, (4) a square body → select + move the whole selection, (5) empty
 * space → deselect + rubber-band marquee. All state lives in closure variables and
 * refs — no React state — so dragging never triggers a re-render.
 */
export function useCanvasInteractions({
  canvasRef,
  cameraRef,
  shapesRef,
  selectionRef,
  activeEdgeRef,
  edgeHoverRef,
  edgeFaceAllRef,
  wallDimsArmedRef,
  hoverRef,
  hoverPointRef,
  centerHoverRef,
  edgePlusHoverRef,
  resizingRef,
  rotatingRef,
  unitRef,
  marqueeRef,
  placementRef,
  predictionDragRef,
  footprintsRef,
  footprintArmRef,
  footprintDraftRef,
  libraryShrinkRef,
  commitPlacement,
  beginDimensionEdit,
  beginCenterEdit,
  beginWallDimensionEdit,
  commitHistory,
  requestDraw,
  constraintsRef,
  libraryDropRef,
  libraryPopupDropRef,
  onLibraryHover,
  onLibraryDrop,
  onHoverRoomKey,
  clearFindHighlight,
  alignGuidesRef,
  facadeRef,
  layersActiveRef,
  partitionEnteredRef,
  partitionPlusRef,
  frameEditRef,
  partitionDocRef,
  partitionSelSegRef,
  partitionCellSelRef,
  partitionBorderSelRef,
  onCellMenu,
  onExitFrameEdit,
}: InteractionParams): void {
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    let mode: Mode = 'none';
    // Space-drag is the ONLY pan gesture — a bare pointer drag always selects or edits.
    let spaceHeld = false;
    let lastClientX = 0;
    let lastClientY = 0;
    let dragStartX = 0; // world-space anchor for move/resize
    let dragStartY = 0;
    // Cursor position at the LAST move frame. Constrained drags (resize/vertex/
    // thickness) work off the per-frame increment from here (re-baselining item.orig
    // to each clamped result), so the no-worsening clamp ratchets continuously: once a
    // metric passes its bound mid-drag it can't be dragged back across it.
    let dragLastX = 0;
    let dragLastY = 0;
    let dragItems: DragItem[] = [];
    // Per-axis wall-snap lock for the current move drag (hysteresis across frames).
    let snapState: SnapState = emptySnapState();
    let handle: HandleId | null = null;
    let thicknessFace: EdgeFace | null = null; // which wall face a thickness drag moves
    let thicknessAll = false; // Shift held → drag stretches all walls' faces at once
    let rotateTarget: Square | null = null;
    let rotateStartAngle = 0; // pointer angle at grab (deg)
    let rotateStartRotation = 0; // shape rotation at grab (deg)
    // World-space anchor corner of an in-progress footprint draw (the press point).
    let footStart = { x: 0, y: 0 };
    // Active Layers-tool drag target: a trim corner being deformed, a border edge being slid (reveal), an
    // inner grid line / segment being moved, or the world-space anchor of an in-progress boundary draw.
    let partitionCorner: number | null = null;
    let partitionCornerBorder = 0; // which border (index) the grabbed corner belongs to
    let partitionMoveBorder: number | null = null; // which border (index) is being dragged by its interior
    // Snapshot of the dragged border quad + the cursor at grab, so the move can snap (via resolveWallSnap)
    // against the FREE delta from grab — matching how room moves snap — then apply incrementally.
    let partitionMoveOrig: { x: number; y: number }[] | null = null;
    let partitionMoveStart = { x: 0, y: 0 };
    // Index of the grabbed border edge (poly[i] → poly[i+1]); null when no edge drag is in flight.
    let partitionEdge: number | null = null;
    let partitionEdgeBorder = 0; // which border (index) the grabbed edge belongs to
    // Snapshot of the border quad + cursor at the start of a boundary-edge stretch (reuses the room's
    // delta-based `stretchEdge`, so an angled edge stretches exactly like a default shape's edge).
    let partitionEdgeOrig: { x: number; y: number }[] | null = null;
    let partitionEdgeStart = { x: 0, y: 0 };
    let partitionLine: LineHandle | null = null;
    let partitionSeg: SegmentRef | null = null;
    let partitionSegExtra: ExtraSegHandle | null = null;
    // A clean click on a cell (no line/edge/corner hit) selects it on release; captured here.
    let partitionCellCandidate: { x: number; y: number; shift: boolean } | null = null;
    // Paint-select: the selection as it stood when the stroke began. A plain drag paints onto an empty
    // base (so the stroke REPLACES), Shift paints onto the existing one (so it ADDS). Keeping the base
    // separate is what lets every pointer-move recompute the result rather than accumulate irreversibly.
    let paintBase: Set<string> | null = null;
    // In-flight edge-plus duplicate on a border: which shape and side, the per-copy step, the world point
    // the press started at, and how many copies the drag has reached so far.
    // In-flight border rotation: which shape, its outline at grab time, and the pointer angle + snapped
    // rotation the gesture started from — so each frame applies an ABSOLUTE angle to the original.
    let partitionRotate: {
      border: number;
      orig: { x: number; y: number }[];
      startAngle: number;
    } | null = null;
    let partitionPlus: {
      border: number;
      dir: number;
      stepX: number;
      stepY: number;
      startX: number;
      startY: number;
      count: number;
    } | null = null;
    // Cells the stroke itself has touched, and the last world point sampled — the stroke is walked as a
    // SEGMENT between pointer-moves, not sampled at them, so a fast drag can't skip over a panel.
    let painted = new Set<string>();
    let paintLast: { x: number; y: number } | null = null;
    // Edit-a-panel frame drag: the grabbed side, the snapshot transient Square at grab, the world press
    // point, and whether Shift (all sides at once) was held.
    let frameEditSide: 'n' | 'e' | 's' | 'w' | 'b' | null = null;
    let frameEditOrig: Square | null = null;
    let frameEditStart = { x: 0, y: 0 };
    let frameEditAll = false;
    // For a border-edge ('b') frame drag: the cut-edge anchor + inward unit normal, plus `grab` (= current
    // band width − the cursor's perpendicular distance at grab) so the band tracks RELATIVE to where it was
    // grabbed instead of snapping to the cursor's absolute distance from the border on the first move.
    let frameEditBorder: { ax: number; ay: number; nx: number; ny: number; grab: number } | null = null;
    // True once the current Layers gesture has changed the partition (drives one undo step on release).
    let partitionMutated = false;
    // True while a 'move' drag is hovering the Library button (drop there = save).
    let overLibrary = false;

    // Is a client point within a given rect (null ⇒ never)?
    const inRect = (r: DOMRect | null | undefined, clientX: number, clientY: number): boolean =>
      !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;

    // The transient Square for the Edit-a-panel session: interior = the inset glass rect, walls = the group's
    // per-edge frame widths, so its outer footprint is exactly the representative cell rect. This lets the
    // standard-shape edge code (hitShapeEdge / resizeWall) drive per-edge frame editing. Null when no session.
    /** Every panel in the Edit selection, as world rects — each one is a grabbable set of mullions. */
    const frameEditRects = (): Rect[] => {
      const fe = frameEditRef?.current;
      const doc = partitionDocRef?.current;
      if (!fe || !doc) return [];
      const rects = partitionCellRectsOf(partitionActiveLayer(doc), new Set(fe.keys));
      // The representative first, so a cursor over two overlapping candidates resolves to the one the
      // session was opened on.
      return rects.length ? rects : [fe.rect];
    };

    /**
     * A selected panel's frame as a zero-rotation `Square` (inner glass + per-side wall = the mullion),
     * so the shared room edge hit-test can pick its faces.
     */
    const frameEditSquareOf = (rect: Rect): Square | null => {
      const fe = frameEditRef?.current;
      const doc = partitionDocRef?.current;
      if (!fe || !doc) return null;
      const f = partitionPanelFrame(partitionActiveLayer(doc), fe.keys[0]);
      if (!f) return null;
      const inner = partitionFrameInnerRect(rect, f);
      return {
        id: 'frame-edit',
        x: inner.x,
        y: inner.y,
        width: inner.w,
        height: inner.h,
        rotation: 0,
        walls: { n: f.n, e: f.e, s: f.s, w: f.w },
        dots: false,
      };
    };

    /**
     * Which selected panel's mullion face is under the cursor, if any. Every panel in the selection is
     * tested, not just the one the session opened on — the drag writes the new width to ALL of them, so
     * any of them is a legitimate place to grab it. Restricting the grab to one made the others look
     * inert even though they were changing.
     */
    const frameEditFaceAt = (
      sx2: number,
      sy2: number,
      cam2: Camera,
    ): { sq: Square; side: 'n' | 'e' | 's' | 'w' } | null => {
      for (const rect of frameEditRects()) {
        const sq = frameEditSquareOf(rect);
        if (!sq) continue;
        const hit = hitShapeEdge(sx2, sy2, sq, cam2);
        if (hit === 'n' || hit === 'e' || hit === 's' || hit === 'w') return { sq, side: hit };
      }
      return null;
    };

    // Distance from a world point to a world segment (for grabbing the diagonal border-cut frame edge).
    const distPointSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };

    // The representative panel's diagonal border-cut edge NEAREST a world point, with its INWARD unit normal
    // and the cursor's distance to it — or null. A corner panel can have two such edges; we grab the closest.
    // The border-frame width is the cursor's perpendicular distance inside the border edge.
    const frameBorderEdgeInfoAt = (
      px: number,
      py: number,
    ): { a: { x: number; y: number }; b: { x: number; y: number }; nx: number; ny: number; dist: number } | null => {
      const fe = frameEditRef?.current;
      const doc = partitionDocRef?.current;
      if (!fe || !doc) return null;
      const layer2 = partitionActiveLayer(doc);
      let best: { a: { x: number; y: number }; b: { x: number; y: number }; nx: number; ny: number; dist: number } | null =
        null;
      // Any selected panel that the trim slices offers its cut edge as a handle, not just the first.
      const edges: { seg: [{ x: number; y: number }, { x: number; y: number }]; cx: number; cy: number }[] = [];
      for (const rect of frameEditRects()) {
        for (const seg of partitionPanelBorderEdges(layer2, rect)) {
          edges.push({ seg, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 });
        }
      }
      for (const { seg: [a, b], cx, cy } of edges) {
        const dist = distPointSeg(px, py, a.x, a.y, b.x, b.y);
        if (best && dist >= best.dist) continue;
        let nx = b.y - a.y;
        let ny = -(b.x - a.x);
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        if ((cx - (a.x + b.x) / 2) * nx + (cy - (a.y + b.y) / 2) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        best = { a, b, nx, ny, dist };
      }
      return best;
    };

    // The current border-frame ('b') width of the edited group (falls back to the side average).
    const currentBorderBand = (): number => {
      const doc = partitionDocRef?.current;
      const fe = frameEditRef?.current;
      if (!doc || !fe) return 0;
      const f = partitionPanelFrame(partitionActiveLayer(doc), fe.keys[0]);
      return f ? f.b ?? (f.n + f.e + f.s + f.w) / 4 : 0;
    };

    // Over a save drop-target: the Library button OR the open Library popup. Dropping on
    // either saves the dragged arrangement to the Library.
    const overLibraryButton = (clientX: number, clientY: number): boolean =>
      inRect(libraryDropRef?.current, clientX, clientY) ||
      inRect(libraryPopupDropRef?.current, clientX, clientY);

    // Click-vs-drag tracking. The magenta edge faces are armed only by a clean
    // click on an edge (press + release with no drag) — never by the release
    // that ends a stretch — so finishing a drag never makes them flash.
    let pressClientX = 0;
    let pressClientY = 0;
    /**
     * Capture the pointer for a drag, tolerating failure. A pointerId that is not an ACTIVE pointer — a
     * synthesized event, or one the browser has already released — makes `setPointerCapture` throw, which
     * would abort the gesture handler halfway through and leave the interaction in a half-armed state.
     * Releasing is already guarded the same way throughout.
     */
    const capturePointer = (id: number) => {
      try {
        el.setPointerCapture(id);
      } catch {
        // not an active pointer; the gesture still works, it just isn't captured.
      }
    };

    let draggedSinceDown = false;
    let edgeClickArmed = false;
    let gestureDuplicated = false; // an Alt-drag copy was made this gesture
    // Shared-overlap band pressed this gesture: a clean click runs the boolean
    // trim on pointer-up; a drag instead moves the shape (pull-apart).
    let pendingBoolean: { target: Square; other: Square } | null = null;
    // Two selected rooms whose interiors overlap under the press: a clean click in
    // that region merges them (boolean union); a drag instead moves the shape.
    let pendingUnion: { a: Square; b: Square } | null = null;
    // Facade Border mode: two picked, overlapping borders with the press over their shared interior (unite)
    // or a bounding edge (subtract). A clean release runs the boolean; a drag moves the border (pull-apart).
    let pendingBorderBool: BorderBooleanHover | null = null;
    // An edge-plus drag in progress: the source shape, the outward direction, the
    // per-copy world offset, where the press began, and the live copy count (driven
    // by how far the cursor has dragged outward).
    let plusDrag: {
      shape: Square;
      dir: number;
      stepX: number;
      stepY: number;
      startX: number;
      startY: number;
      count: number;
    } | null = null;
    const CLICK_SLOP = 3; // px of travel before a press counts as a drag

    // Only write cursor on change to avoid redundant style work per move.
    let currentCursor = '';
    const setCursor = (c: string) => {
      if (c !== currentCursor) {
        currentCursor = c;
        el.style.cursor = c;
      }
    };

    // Cache the canvas rect and refresh only on resize/scroll, so pointer moves
    // never trigger a synchronous layout read.
    let rect = el.getBoundingClientRect();
    const refreshRect = () => {
      rect = el.getBoundingClientRect();
    };

    const localPoint = (e: PointerEvent) => ({
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
    });

    const selectedShapes = (): Square[] =>
      shapesRef.current.filter((s) => selectionRef.current.has(s.id));

    const singleSelected = (): Square | null => {
      if (selectionRef.current.size !== 1) return null;
      return selectedShapes()[0] ?? null;
    };

    // Create a predicted room from the chosen fan option: placed flush against the
    // source's edge `dir` (corner-aligned), selected, and opened for further chaining.
    // Shared by the drag-release and the click-a-dot paths. One undo step.
    const createPredictedRoom = (sourceId: string, dir: number, option: PredictionOption): void => {
      const source = shapesRef.current.find((s) => s.id === sourceId);
      if (!source) return;
      const wWorld = option.widthFt * WORLD_UNITS_PER_FOOT;
      const hWorld = option.heightFt * WORLD_UNITS_PER_FOOT;
      const place = adjacentRoomPlacement(source, dir, wWorld, hWorld, DEFAULT_WALL_WORLD);
      const room: Square = {
        id: createId(),
        x: place.x,
        y: place.y,
        width: wWorld,
        height: hWorld,
        rotation: place.rotation,
        walls: defaultWalls(),
        dots: true,
        name: option.label,
      };
      shapesRef.current.push(room);
      selectionRef.current = new Set([room.id]);
      activeEdgeRef.current = null;
      commitHistory();
    };

    // Top-most edge of any selected shape under the screen point, with the shape
    // it belongs to (its rotation orients the resize cursor).
    const hitSelectionEdge = (
      sx: number,
      sy: number,
      cam: Camera,
    ): { shape: Square; handle: HandleId } | null => {
      const sel = selectedShapes();
      for (let i = sel.length - 1; i >= 0; i--) {
        const h = hitShapeEdge(sx, sy, sel[i], cam);
        if (h) return { shape: sel[i], handle: h };
      }
      return null;
    };

    // Top-most edge of ANY shape under the point (selected or not). Lets a
    // stretch start on whichever wall edge the cursor is over, with no prior
    // selection required.
    const hitAnyEdge = (
      sx: number,
      sy: number,
      cam: Camera,
    ): { shape: Square; handle: HandleId } | null => {
      const shapes = shapesRef.current;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const h = hitShapeEdge(sx, sy, shapes[i], cam);
        if (h) return { shape: shapes[i], handle: h };
      }
      return null;
    };

    // Top-most shape whose vertex dot (shown after double-click) is under the
    // point, with the corner handle that dot drives. Only dots-enabled shapes
    // qualify, so this is inert until the user double-clicks to show them.
    const hitAnyVertexDot = (
      sx: number,
      sy: number,
      cam: Camera,
    ): { shape: Square; handle: HandleId } | null => {
      const shapes = shapesRef.current;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const h = hitCornerDot(sx, sy, shapes[i], cam);
        if (h) return { shape: shapes[i], handle: h };
      }
      return null;
    };

    // Clone the current selection in place (new ids, on top of the z-order) and
    // make the copies the live selection. Used for Alt-drag duplication.
    const duplicateSelection = () => {
      const copies = selectedShapes().map((s) => ({
        ...s,
        id: createId(),
        walls: { ...s.walls },
        corners: s.corners?.map((p) => ({ ...p })),
        wallEdges: s.wallEdges?.slice(),
      }));
      for (const copy of copies) shapesRef.current.push(copy);
      selectionRef.current = new Set(copies.map((c) => c.id));
    };

    /**
     * Open the floating panel menu for the cell at `world`. Reports the cell REF rather than a fixed screen
     * point — the menu's position is recomputed every scene draw from the live selection, so it rides along
     * as the panels are dragged, panned, or zoomed. A world point that hits no cell closes the menu. The ref
     * is what Split and Edit act on; the bar's placement and dimensions come from the whole selection.
     */
    const openCellMenu = (layer: FacadeLayer, world: { x: number; y: number }) => {
      const ref = hitPartitionCell(layer, world);
      if (!ref) {
        onCellMenu?.(null);
        return;
      }
      // `subdivided` gates the panel actions in the bar: before the first split a border is one bare
      // pseudo-panel — the raw elevation — so there is nothing to frame or assign a material to yet.
      onCellMenu?.({
        ref,
        rect: partitionCellRefRect(layer, ref),
        subdivided: partitionIsSubdivided(layer, ref.border),
        mode: partitionBorderMode(layer, ref.border),
      });
    };

    /**
     * Extend the paint stroke from `paintLast` to `to`, adding every panel the segment crosses. Sampling the
     * whole segment (rather than just the pointer-move positions) is what makes the brush feel solid: at a
     * fast drag, or a low frame rate, consecutive moves can be several panels apart.
     */
    const paintTo = (layer: FacadeLayer, to: { x: number; y: number }) => {
      const from = paintLast ?? to;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      // One sample per ~4 screen px, so the cost tracks how far the cursor moved on screen, not in world
      // units — a zoomed-out flick and a zoomed-in nudge do comparable work. Capped for a pathological jump.
      const stepWorld = 4 / cameraRef.current.scale;
      const steps = Math.min(512, Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepWorld)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const k = partitionCellKeyAt(layer, { x: from.x + dx * t, y: from.y + dy * t });
        if (k) painted.add(k);
      }
      paintLast = { x: to.x, y: to.y };
      // The live result is always base ∪ stroke, recomputed rather than accumulated, so the Shift/plain
      // distinction stays exact for the whole gesture.
      if (partitionCellSelRef) {
        partitionCellSelRef.current = new Set([...(paintBase ?? []), ...painted]);
      }
    };

    /**
     * Re-point the menu at the current cell selection. Used by the gestures that select without a click on a
     * specific panel (the rubber-band sweep): the first selected panel becomes the Split/Edit target, and an
     * empty selection closes the bar.
     */
    const syncCellMenuToSelection = (layer: FacadeLayer, cells: Set<string>) => {
      if (!cells.size) {
        onCellMenu?.(null);
        return;
      }
      // Anchor on a panel's CLIPPED CENTROID, never its rect centre. A panel the border slices keeps its
      // full rect, and on a diagonal that rect's centre often lies OUTSIDE the boundary — `hitCell` finds
      // nothing there and the bar closes even though panels are plainly selected. The centroid of the
      // visible (clipped) shape is always inside it. Every selected panel is tried, so one awkward shape
      // can't sink the whole gesture.
      for (const g of partitionCellGroups(layer)) {
        if (!cells.has(partitionCellKey(g.rect))) continue;
        const ref = hitPartitionCell(layer, { x: g.cx, y: g.cy });
        if (ref) {
          onCellMenu?.({
            ref,
            rect: partitionCellRefRect(layer, ref),
            subdivided: partitionIsSubdivided(layer, ref.border),
            mode: partitionBorderMode(layer, ref.border),
          });
          return;
        }
      }
      onCellMenu?.(null);
    };

    // Deep-enough clone of a shape's geometry, for re-baselining a drag's per-frame
    // origin to the latest clamped result.
    const cloneGeom = (s: Square): Square => ({
      ...s,
      walls: { ...s.walls },
      corners: s.corners?.map((p) => ({ ...p })),
      wallEdges: s.wallEdges?.slice(),
    });

    const snapshotSelection = (world: { x: number; y: number }) => {
      dragStartX = world.x;
      dragStartY = world.y;
      dragLastX = world.x;
      dragLastY = world.y;
      dragItems = selectedShapes().map((s) => ({ shape: s, orig: cloneGeom(s) }));
      snapState = emptySnapState();
    };

    const selectFromMarquee = (m: Marquee, cam: Camera) => {
      const a = screenToWorld(m.x0, m.y0, cam);
      const b = screenToWorld(m.x1, m.y1, cam);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);

      // Additive: holding shift extends the current selection.
      const next = new Set(selectionRef.current);
      for (const s of shapesRef.current) {
        const intersects =
          s.x <= maxX && s.x + s.width >= minX && s.y <= maxY && s.y + s.height >= minY;
        if (intersects) next.add(s.id);
      }
      selectionRef.current = next;
    };

    const updateHoverCursor = (e: PointerEvent) => {
      // Space held → the open hand, the one cursor that means "drag to pan". It outranks
      // every hover cursor below, matching the pointer-down priority.
      if (spaceHeld) return setCursor('grab');
      // Layers tool: crosshair while drawing the boundary; resize cursors over boundary edges / cell cuts.
      if (layersActiveRef?.current) {
        const { sx: lx, sy: ly } = localPoint(e);
        const cam = cameraRef.current;
        const world = screenToWorld(lx, ly, cam);
        const doc = partitionDocRef?.current;
        const layer = doc ? partitionActiveLayer(doc) : null;
        // Edit-a-panel session: hovering ANY selected panel's mullion highlights it (resize cursor); the
        // rest is inert. Every selected panel is a handle, since the drag drives them all.
        if (frameEditRef?.current) {
          const face = frameEditFaceAt(lx, ly, cam);
          let side: 'n' | 'e' | 's' | 'w' | 'b' | null = face ? face.side : null;
          // Falling on no axis-aligned face, test the diagonal border-cut edge(s) (grab to set the border frame).
          let borderCursor: string | null = null;
          if (!side) {
            const bi = frameBorderEdgeInfoAt(world.x, world.y);
            if (bi) {
              const tolW = 8 / cam.scale;
              if (bi.dist <= Math.max(tolW, currentBorderBand() + tolW * 0.5)) {
                side = 'b';
                borderCursor = cursorForNormal(bi.nx, bi.ny);
              }
            }
          }
          // Shift over any frame edge (a side OR the border) previews scaling every edge uniformly.
          const all = side != null && e.shiftKey;
          if (frameEditRef.current.hoverSide !== side || frameEditRef.current.allSides !== all) {
            frameEditRef.current.hoverSide = side;
            frameEditRef.current.allSides = all;
            requestDraw('scene');
          }
          setCursor(
            side === 'b'
              ? borderCursor ?? 'move'
              : side === 'n' || side === 's'
                ? 'row-resize'
                : side
                  ? 'col-resize'
                  : 'grab',
          );
          return;
        }
        if (!layer || !partitionHasBoundary(layer)) {
          setCursor('grab'); // nothing drawn yet — a boundary arrives via the cube, not a drag
          return;
        }
        const tol = 8 / cam.scale;
        const selBorders = partitionBorderSelRef?.current ?? new Set<number>();
        // The hover mirrors the press exactly (see the pointer-down pick order). Border affordances come
        // first but only on a SELECTED border, so an unselected outline never steals the paint cursor.
        // A dimension label (clickable to type a size) → text cursor.
        for (const bi of selBorders) {
          if (bi < 0 || bi >= layer.borders.length) continue;
          const bb = partitionPolyBBox(layer.borders[bi]);
          const sq: Square = {
            id: `__border__${bi}`,
            x: bb.x,
            y: bb.y,
            width: bb.w,
            height: bb.h,
            rotation: 0,
            walls: { n: 0, e: 0, s: 0, w: 0 },
            dots: false,
          };
          if (hitDimensionLabel(lx, ly, sq, cam, unitRef.current, BORDER_DIM_GAP)) {
            setCursor('text');
            return;
          }
        }
        // An edge-plus button on the single-selected shape → the click adds a copy.
        if (selBorders.size === 1 && (partitionEnteredRef?.current ?? null) !== [...selBorders][0]) {
          const poly = layer.borders[[...selBorders][0]];
          if (poly && hitEdgePlus(lx, ly, polygonShape(poly), cam) != null) {
            setCursor('pointer');
            return;
          }
        }
        // Two borders picked & overlapping: track the cursor (live cyan union grid / subtract hatch preview)
        // and hint that a click acts — taking precedence over everything inside the shared region.
        if (selBorders.size === 2) {
          hoverPointRef.current = { x: lx, y: ly };
          requestDraw('scene');
          if (borderBooleanHoverAt(layer, selBorders, world, tol)) {
            setCursor('pointer');
            return;
          }
        }
        // A selected border's vertices (deform), then the rotation ring around them, then its edges.
        const hoverCorner = hitPartitionCorner(layer, world, tol);
        if (hoverCorner != null && selBorders.has(hoverCorner.border)) {
          setCursor('move');
          return;
        }
        if (selBorders.size === 1 && (partitionEnteredRef?.current ?? null) === null) {
          const rpoly = layer.borders[[...selBorders][0]];
          if (rpoly && hitBorderRotateZone(rpoly, lx, ly, cam)) {
            setCursor(ROTATE_CURSOR);
            return;
          }
        }
        const hoverEdge = hitPartitionBoundaryEdge(layer, world, tol);
        if (hoverEdge && selBorders.has(hoverEdge.border)) {
          setCursor(cursorForBoundaryEdge(hoverEdge.a, hoverEdge.b));
          return;
        }
        // A border the user hasn't stepped into is an object: the whole interior reads as "drag me"
        // (Alt = drop a copy). Its contents are sealed until a double-click goes in.
        const hoverIdx = partitionBorderIndexAt(layer, world);
        if (hoverIdx != null && hoverIdx !== (partitionEnteredRef?.current ?? null)) {
          setCursor(e.altKey ? 'copy' : 'move');
          return;
        }
        // Inner grid: Shift hovers a single segment; Alt duplicates the line; otherwise a whole inner line.
        if (e.shiftKey) {
          const seg = hitPartitionGridSegment(layer, world, tol);
          if (seg) {
            setCursor(seg.axis === 'v' ? 'col-resize' : 'row-resize');
            return;
          }
        } else {
          // An already-split segment is grabbable on a plain hover (no Shift), like a first-class line.
          const splitSeg = hitPartitionGridSegment(layer, world, tol);
          if (splitSeg && !e.altKey && partitionIsSplitSegment(layer, splitSeg)) {
            setCursor(splitSeg.axis === 'v' ? 'col-resize' : 'row-resize');
            return;
          }
          const line = hitPartitionLine(layer, world, tol);
          if (line) {
            setCursor(e.altKey ? 'copy' : line.axis === 'v' ? 'col-resize' : 'row-resize');
            return;
          }
        }
        // Inside the entered shape with nothing structural in the way → the brush. Outside → sweep.
        setCursor(hoverIdx != null ? 'cell' : 'crosshair');
        return;
      }
      // Footprint tool armed → the whole canvas is a draw surface (crosshair).
      if (footprintArmRef.current) {
        setCursor('crosshair');
        return;
      }
      const { sx, sy } = localPoint(e);
      const cam = cameraRef.current;
      const single = singleSelected();
      let redraw = false;

      // A prediction fan left open by a click: track which dot the cursor is over so
      // it grows and its room ghost previews, and show the pointer cursor there.
      const openFan = predictionDragRef.current;
      if (openFan && openFan.dragging) {
        const fanShape = shapesRef.current.find((s) => s.id === openFan.shapeId);
        const hit = fanShape ? hitPredictionOption(sx, sy, fanShape, cam, openFan.dir) : null;
        const hovered = hit != null && openFan.options[hit] ? hit : null;
        if (hovered !== openFan.hovered) {
          openFan.hovered = hovered;
          requestDraw('scene');
        }
        if (hovered != null) return setCursor('pointer');
        // Not over a dot → fall through so arrows/edges still resolve their cursors.
      }

      // Magenta face highlight: only when a single shape has a deliberately
      // selected edge and the pointer is over that same edge's band. Light just
      // the one face (inner or outer) the cursor is nearer.
      const active = activeEdgeRef.current;
      const overActiveEdge =
        edgeClickArmed &&
        !!single &&
        active !== null &&
        hitShapeEdge(sx, sy, single, cam) === active;
      const face: EdgeFace | null =
        overActiveEdge && single && active ? edgeFace(sx, sy, single, cam, active) : null;
      if (face !== edgeHoverRef.current) {
        edgeHoverRef.current = face;
        redraw = true;
      }
      // Shift over that face lights ALL inner/outer faces (stretch the whole boundary).
      const faceAll = face !== null && e.shiftKey;
      if (faceAll !== edgeFaceAllRef.current) {
        edgeFaceAllRef.current = faceAll;
        redraw = true;
      }

      // Hover-preview region: which shape + region the pointer is over, mirroring
      // what a click would act on (selection edges, then any edge, then a body).
      // Edges stay stretchable (hover-darken + resize cursor) even with the
      // vertices showing; the dots only win right at the corners.
      // Inside a shared-overlap yellow band, the wall isn't stretchable, so don't
      // treat it as a grabbable edge (no resize cursor, no edge hover-darken).
      const inOverlapBand = pointInSelectedOverlapBand(
        { x: sx, y: sy },
        shapesRef.current,
        selectionRef.current,
        cam,
      );
      const hitEdge = inOverlapBand
        ? null
        : hitSelectionEdge(sx, sy, cam) ?? hitAnyEdge(sx, sy, cam);
      let hover: { id: string; region: HoverRegion } | null = null;
      if (hitEdge) {
        hover = { id: hitEdge.shape.id, region: hitEdge.handle };
      } else {
        const world = screenToWorld(sx, sy, cam);
        const body = hitTopShape(shapesRef.current, world);
        if (body) hover = { id: body.id, region: 'infill' };
      }
      const prev = hoverRef.current;
      if (hover?.id !== prev?.id || hover?.region !== prev?.region) {
        hoverRef.current = hover;
        redraw = true;
      }
      // Notify the hovered room's catalog key (only when the room changes) so the dev
      // Adjacency Matrix can highlight that program's row + column.
      if (onHoverRoomKey && hover?.id !== prev?.id) {
        const hoveredShape = hover ? shapesRef.current.find((s) => s.id === hover.id) : null;
        onHoverRoomKey(
          hoveredShape ? findRoomDef(hoveredShape.name ?? '')?.key ?? 'default' : null,
        );
      }

      // Track the cursor for the shared-overlap-edge yellow hover. With two or
      // more shapes selected, redraw every move so the highlight follows live.
      hoverPointRef.current = { x: sx, y: sy };
      if (selectionRef.current.size >= 2) redraw = true;

      // Centre readout (name/area) hover → show the editable box around it.
      const overCenter =
        single && active === null ? hitCenterLabel(sx, sy, single, cam, unitRef.current) : null;
      const centerId = overCenter ? single!.id : null;
      if (centerId !== centerHoverRef.current) {
        centerHoverRef.current = centerId;
        redraw = true;
      }

      if (redraw) requestDraw('scene');

      if (e.shiftKey) {
        // Over an armed edge face, Shift drags ALL faces → show the resize double-
        // arrow so it reads as draggable; elsewhere Shift hints the marquee.
        if (face !== null && single && active) {
          return setCursor(cursorForHandle(active, single));
        }
        return setCursor('crosshair');
      }
      // Rotation is only offered while the shape's dimensions are showing (infill-
      // selected, no active edge) — the same state the rotate knob appears in. After an
      // edge stretch the edge stays active, so a corner there stretches, never rotates.
      if (
        single &&
        !single.dots &&
        activeEdgeRef.current === null &&
        hitCorner(sx, sy, single, cam)
      ) {
        return setCursor(ROTATE_CURSOR);
      }
      // A visible vertex dot is draggable to reshape the room. It uses the plain
      // default pointer (not the resize double-arrow) to read as "grab this point".
      const dotHover = hitAnyVertexDot(sx, sy, cam);
      if (dotHover) return setCursor('default');
      // Edge-plus duplicate buttons + the area-lock padlock are clickable while the
      // shape's dimensions are shown. Track which plus is hovered so the scene can
      // ghost the to-be-dropped copy; redraw whenever that changes.
      const dimsShown = single && (single.corners ? true : active === null);
      const plusDir = dimsShown && single ? hitEdgePlus(sx, sy, single, cam) : null;
      // On an OPENED shape (dots) the edge button is a prediction arrow, not a
      // duplicate "+": show a grab cursor and never ghost a copy.
      const arrowHover = plusDir != null && !!single?.dots;
      const plusHover =
        plusDir != null && !arrowHover && single ? { id: single.id, dir: plusDir, count: 1 } : null;
      const prevPlus = edgePlusHoverRef.current;
      if (
        plusHover?.id !== prevPlus?.id ||
        plusHover?.dir !== prevPlus?.dir ||
        plusHover?.count !== prevPlus?.count
      ) {
        edgePlusHoverRef.current = plusHover;
        requestDraw('scene');
      }
      if (arrowHover) return setCursor('pointer');
      if (plusHover) return setCursor('pointer');
      if (dimsShown && single && hitCenterLock(sx, sy, single, cam)) {
        return setCursor('pointer');
      }
      // A dimension label of the infill-selected shape is editable on click.
      if (
        single &&
        active === null &&
        (overCenter || hitDimensionLabel(sx, sy, single, cam, unitRef.current))
      ) {
        return setCursor('text');
      }
      // The active wall edge's length/thickness labels are editable too (once armed).
      if (
        single &&
        active !== null &&
        wallDimsArmedRef.current &&
        hitWallDimensionLabel(sx, sy, single, cam, active, unitRef.current)
      ) {
        return setCursor('text');
      }
      if (hitEdge) return setCursor(cursorForHandle(hitEdge.handle, hitEdge.shape));
      setCursor(hover ? 'move' : 'default');
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // primary button / touch only
      const { sx, sy } = localPoint(e);
      const cam = cameraRef.current;

      // The magenta face under the cursor (non-null only on an armed, hovered
      // edge) — captured before we clear it, since grabbing it drags thickness.
      const grabbedFace = edgeHoverRef.current;

      // Start fresh click-vs-drag tracking, and hide any armed magenta faces for
      // the duration of this gesture (they only re-arm on a clean edge release).
      draggedSinceDown = false;
      gestureDuplicated = false;
      overLibrary = false;
      pressClientX = e.clientX;
      pressClientY = e.clientY;
      edgeClickArmed = false;
      pendingBoolean = null;
      pendingUnion = null;
      pendingBorderBool = null;
      edgeHoverRef.current = null;
      hoverPointRef.current = null; // hide the overlap-edge hover during gestures
      centerHoverRef.current = null; // hide the editable-readout box during gestures
      edgePlusHoverRef.current = null; // clear any duplicate-preview ghost

      // 0!) Space held → pan, whatever is under the cursor (room, handle, Layers border).
      //     This is the only gesture that moves the camera; every other press below
      //     selects or edits.
      if (spaceHeld) {
        mode = 'pan';
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        setCursor('grabbing');
        capturePointer(e.pointerId);
        return;
      }

      // 0a) Layers tool (Facade partition) fully owns the gesture: draw the boundary if there isn't one,
      //     else stretch a boundary edge / cell cut; empty space rubber-band selects. Room interaction is bypassed.
      if (layersActiveRef?.current) {
        // An armed border placement (from the cube) commits on the next canvas click, even though the
        // Layers tool otherwise owns the gesture — this block returns before the shared placement check below.
        if (placementRef.current) {
          commitPlacement(sx, sy);
          setCursor('crosshair');
          return;
        }
        const doc = partitionDocRef?.current;
        const layer = doc ? partitionActiveLayer(doc) : null;
        partitionCorner = null;
        partitionEdge = null;
        partitionLine = null;
        partitionSeg = null;
        partitionSegExtra = null;
        partitionCellCandidate = null;
        paintBase = null;
        painted = new Set();
        paintLast = null;
        partitionPlus = null;
        partitionRotate = null;
        if (partitionPlusRef) partitionPlusRef.current = null;
        partitionMutated = false;
        frameEditSide = null;
        frameEditOrig = null;
        frameEditBorder = null;
        // Edit-a-panel session owns the gesture: grab a representative-panel edge to set its frame width
        // (mirrored to the group); anywhere else is inert.
        if (frameEditRef?.current) {
          const world = screenToWorld(sx, sy, cam);
          // Grab the mullion of ANY selected panel — whichever is under the cursor becomes the drag basis,
          // and the resulting width is written to every panel in the selection.
          const face = frameEditFaceAt(sx, sy, cam);
          if (face) {
            const { sq, side } = face;
            mode = 'partitionFrame';
            frameEditSide = side;
            frameEditOrig = sq;
            frameEditStart = { x: world.x, y: world.y };
            frameEditAll = e.shiftKey;
            frameEditRef.current.hoverSide = side;
            frameEditRef.current.allSides = frameEditAll;
            setCursor(side === 'n' || side === 's' ? 'row-resize' : 'col-resize');
            capturePointer(e.pointerId);
            return;
          }
          // Grab the nearest diagonal border-cut frame edge → drag to set the border ('b') mullion width.
          const bi = frameBorderEdgeInfoAt(world.x, world.y);
          if (bi) {
            const tolW = 9 / cam.scale;
            if (bi.dist <= Math.max(tolW, currentBorderBand() + tolW * 0.5)) {
              mode = 'partitionFrame';
              frameEditSide = 'b';
              // Invert the inward normal so the band tracks the cursor the same way the n/e/s/w mullions do
              // (with the raw inward normal the drag read reversed — moving the mouse shrank the band).
              const nx = -bi.nx;
              const ny = -bi.ny;
              // Offset so the band picks up from its current width at the grab point (no first-move jump).
              const d0 = (world.x - bi.a.x) * nx + (world.y - bi.a.y) * ny;
              frameEditBorder = { ax: bi.a.x, ay: bi.a.y, nx, ny, grab: currentBorderBand() - d0 };
              frameEditAll = e.shiftKey;
              frameEditRef.current.hoverSide = 'b';
              frameEditRef.current.allSides = frameEditAll;
              setCursor(cursorForNormal(bi.nx, bi.ny));
              capturePointer(e.pointerId);
              return;
            }
          }
          // Off every frame edge: an inert press. A clean click here ends the session
          // (handled on pointer-up); Space-drag is what pans.
          mode = 'none';
          return;
        }
        // Shift-drag BEGINNING OUTSIDE the trim border → rubber-band multi-select of panel groups, ADDING to
        // the current selection (the plain sweep below replaces it instead).
        // Inside the border, Shift keeps its existing meaning (grab a segment); outside there's nothing to grab.
        if (layer && partitionHasBoundary(layer) && e.shiftKey && partitionCellSelRef) {
          const world = screenToWorld(sx, sy, cam);
          if (!partitionPointInBorder(layer, world)) {
            mode = 'partitionMarquee';
            marqueeRef.current = { x0: sx, y0: sy, x1: sx, y1: sy };
            setCursor('crosshair');
            capturePointer(e.pointerId);
            return;
          }
        }
        // ONE editing mode. What the cursor is over — and what is currently selected — decides the gesture;
        // there is no Border/Panels switch. Pick order, most specific first:
        //
        //   1. a selected border's dimension label   → type a size
        //   2. a boolean over two picked borders     → unite / subtract
        //   3. a SELECTED border's corner or edge    → deform / stretch  (selecting reveals the handles)
        //   4. an inner grid line or segment         → move / duplicate the mullion
        //   5. anywhere else inside a border         → PAINT panel selection (drag) or pick a group (click)
        //   6. outside every border                  → rubber-band marquee
        //
        // Border geometry lives at 3 because a border becomes selected by clicking inside it (step 5's
        // click also picks the border), so "click the shape, then drag its edges/vertices" works without
        // ever leaving panel editing.
        if (layer) {
          const world = screenToWorld(sx, sy, cam);
          // Borders are placed via the cube (armed placement); there is no drag-to-draw here. With no border
          // yet, fall through to the empty-space branch below.
          if (partitionHasBoundary(layer)) {
            const tol = 9 / cam.scale;
            const selBorders = partitionBorderSelRef?.current ?? new Set<number>();
            const enteredIdx = partitionEnteredRef?.current ?? null;
            // A border's own width/height dimension label (sits outside the trim) → edit it by typing, exactly
            // like a room/footprint dimension. Tested first since labels hang clear of the corners/edges. Only
            // the single-selected border draws them, so only it can be hit — otherwise a click in the empty
            // space where a hidden label WOULD sit would open an invisible editor.
            const dimBorders =
              partitionBorderSelRef && partitionBorderSelRef.current.size === 1
                ? [...partitionBorderSelRef.current]
                : [];
            for (const bi of dimBorders) {
              if (bi < 0 || bi >= layer.borders.length) continue;
              const bb = partitionPolyBBox(layer.borders[bi]);
              const sq: Square = {
                id: `__border__${bi}`,
                x: bb.x,
                y: bb.y,
                width: bb.w,
                height: bb.h,
                rotation: 0,
                walls: { n: 0, e: 0, s: 0, w: 0 },
                dots: false,
              };
              const dimHit = hitDimensionLabel(sx, sy, sq, cam, unitRef.current, BORDER_DIM_GAP);
              if (dimHit) {
                e.preventDefault();
                beginDimensionEdit(sq.id, dimHit);
                return;
              }
            }
            // An edge-plus button on the single-selected shape → duplicate it that way, exactly like the
            // Plan-mode room buttons: a clean click drops one copy against that side, dragging outward runs
            // a row. Tested here with the other affordances that hang OUTSIDE the outline, before anything
            // that hit-tests the border itself. Hidden (so inert) while inside a shape.
            if (
              selBorders.size === 1 &&
              enteredIdx !== [...selBorders][0] &&
              partitionBorderSelRef
            ) {
              const bi = [...selBorders][0];
              const poly = layer.borders[bi];
              const shape = poly ? polygonShape(poly) : null;
              const dir = shape ? hitEdgePlus(sx, sy, shape, cam) : null;
              if (shape && dir != null) {
                e.preventDefault();
                const { dx, dy } = adjacentCopyOffset(shape, dir);
                mode = 'partitionPlus';
                partitionPlus = {
                  border: bi,
                  dir,
                  stepX: dx,
                  stepY: dy,
                  startX: world.x,
                  startY: world.y,
                  count: 1,
                };
                if (partitionPlusRef) partitionPlusRef.current = { border: bi, dx, dy, count: 1 };
                capturePointer(e.pointerId);
                requestDraw('scene');
                return;
              }
            }
            // Two borders picked & overlapping: the boolean claims the click BEFORE corner/edge editing,
            // matching the hover feedback exactly (pointer cursor + the cyan union grid / subtract hatch).
            // It has to come first: the difference trigger IS an edge of one border lying inside the other,
            // so the edge hit-test below would otherwise grab those very edges for a stretch and difference
            // could never fire. Outside the shared region nothing changes — those edges still stretch. A
            // border move is still armed so a drag past the click slop pulls the two apart instead; the
            // boolean only fires on a clean release (handled on pointer-up).
            if (!e.shiftKey && partitionBorderSelRef && partitionBorderSelRef.current.size === 2) {
              const bh = borderBooleanHoverAt(layer, partitionBorderSelRef.current, world, tol);
              if (bh) {
                pendingBorderBool = bh;
                const mi =
                  partitionBorderIndexAt(layer, world) ??
                  (bh.kind === 'union' ? bh.a : bh.target);
                mode = 'borderMove';
                partitionMoveBorder = mi;
                partitionMoveStart = { x: world.x, y: world.y };
                partitionMoveOrig = layer.borders[mi].map((p) => ({ x: p.x, y: p.y }));
                snapState = emptySnapState();
                setCursor('move');
                capturePointer(e.pointerId);
                return;
              }
            }
            // Border geometry — but ONLY on a border the user has already selected, so an unselected
            // outline never steals a gesture. Corner wins (deform into an angle), then edge (slide).
            const corner = hitPartitionCorner(layer, world, tol);
            if (corner != null && selBorders.has(corner.border)) {
              mode = 'cornerDrag';
              partitionCorner = corner.corner;
              partitionCornerBorder = corner.border;
              setCursor('move');
              capturePointer(e.pointerId);
              return;
            }
            // ...then the rotation ring just BEYOND that corner, where the arc is drawn. Inner target
            // first: the grip sits ON the corner (deform), the ring around it turns the whole shape — the
            // same nesting a selected room uses in Plan mode.
            if (selBorders.size === 1 && enteredIdx === null) {
              const rbi = [...selBorders][0];
              const rpoly = layer.borders[rbi];
              if (rpoly && hitBorderRotateZone(rpoly, sx, sy, cam)) {
                const bb = partitionPolyBBox(rpoly);
                const cx = bb.x + bb.w / 2;
                const cy = bb.y + bb.h / 2;
                mode = 'partitionRotate';
                partitionRotate = {
                  border: rbi,
                  orig: rpoly.map((p) => ({ x: p.x, y: p.y })),
                  startAngle: Math.atan2(world.y - cy, world.x - cx) * (180 / Math.PI),
                };
                setCursor(ROTATE_CURSOR);
                capturePointer(e.pointerId);
                return;
              }
            }
            const edge = hitPartitionBoundaryEdge(layer, world, tol);
            if (edge && selBorders.has(edge.border)) {
              mode = 'boundaryEdge';
              partitionEdge = edge.edge;
              partitionEdgeBorder = edge.border;
              partitionEdgeOrig = layer.borders[edge.border].map((p) => ({ x: p.x, y: p.y }));
              partitionEdgeStart = { x: world.x, y: world.y };
              setCursor(cursorForBoundaryEdge(edge.a, edge.b));
              capturePointer(e.pointerId);
              return;
            }
            const moveIdx = partitionBorderIndexAt(layer, world);
            // A border the user has NOT stepped into is a SHAPE, and behaves like one: the press selects it
            // and a drag moves it bodily (Alt drops a copy and drags that, like Alt-dragging a room). Its
            // contents are sealed — no mullion grabs, no cell painting — because a press inside it can only
            // sensibly mean one thing, and at shape level that thing is "move me". Double-click to go in.
            if (moveIdx != null && moveIdx !== enteredIdx) {
              let dragIdx = moveIdx;
              if (e.altKey) {
                const copy = partitionDuplicateBorder(layer, moveIdx);
                if (copy != null) {
                  dragIdx = copy;
                  partitionMutated = true; // the Layers path's own "commit one undo step" flag
                }
              }
              if (partitionBorderSelRef) {
                // Shift adds to the pick (that's how two are armed for a boolean); plain replaces it.
                if (e.shiftKey && !e.altKey) {
                  const next = new Set(partitionBorderSelRef.current);
                  if (next.has(dragIdx)) next.delete(dragIdx);
                  else next.add(dragIdx);
                  partitionBorderSelRef.current = next;
                } else {
                  partitionBorderSelRef.current = new Set([dragIdx]);
                }
              }
              // Stepping from one shape into another isn't a thing — leaving this one exits.
              if (partitionEnteredRef) partitionEnteredRef.current = null;
              onCellMenu?.(null);
              mode = 'borderMove';
              partitionMoveBorder = dragIdx;
              partitionMoveStart = { x: world.x, y: world.y };
              partitionMoveOrig = layer.borders[dragIdx].map((p) => ({ x: p.x, y: p.y }));
              snapState = emptySnapState();
              setCursor('move');
              capturePointer(e.pointerId);
              requestDraw('scene');
              return;
            }
            // --- Inside the entered shape: its contents are what the pointer edits. Everything below
            // is unreachable until the user double-clicks in, which is what frees the plain drag above
            // to move the shape instead of being swallowed by a cell selection. ---
            if (moveIdx != null && moveIdx === enteredIdx) {
              // Alt → DUPLICATE. If a single segment is selected, copy just that segment (a partial divider);
              // otherwise copy the whole line under the cursor. Shift → grab a single SEGMENT (select + jog
              // it). Plain → drag the whole line (Excel-style).
              if (e.altKey && partitionSelSegRef?.current) {
                const dupSeg = duplicatePartitionSegment(layer, partitionSelSegRef.current);
                if (dupSeg) {
                  mode = 'segExtraDrag';
                  partitionSegExtra = dupSeg;
                  partitionMutated = true; // the copied segment exists even without a drag
                  setCursor(dupSeg.axis === 'v' ? 'col-resize' : 'row-resize');
                  capturePointer(e.pointerId);
                  requestDraw('scene');
                  return;
                }
              }
              if (e.altKey) {
                const line = hitPartitionLine(layer, world, tol);
                if (line) {
                  const pos = line.axis === 'v' ? world.x : world.y;
                  const dup = duplicatePartitionLine(layer, line.border, line.axis, pos);
                  if (dup) {
                    mode = 'lineDrag';
                    partitionLine = dup;
                    partitionMutated = true; // the duplicate exists even without a drag
                    if (partitionSelSegRef?.current) partitionSelSegRef.current = null;
                    setCursor(dup.axis === 'v' ? 'col-resize' : 'row-resize');
                    capturePointer(e.pointerId);
                    requestDraw('scene');
                    return;
                  }
                }
              } else if (e.shiftKey) {
                // Over a mullion Shift still grabs a single SEGMENT; over a cell it means "add to the
                // selection". The two never compete for the same pixel, so both readings coexist.
                const seg = hitPartitionGridSegment(layer, world, tol);
                if (seg) {
                  mode = 'segmentDrag';
                  partitionSeg = seg;
                  if (partitionSelSegRef) partitionSelSegRef.current = seg;
                  setCursor(seg.axis === 'v' ? 'col-resize' : 'row-resize');
                  capturePointer(e.pointerId);
                  requestDraw('scene');
                  return;
                }
              } else {
                // An already-split segment moves on a plain drag (no Shift) — it behaves like a normal line now.
                const splitSeg = hitPartitionGridSegment(layer, world, tol);
                if (splitSeg && partitionIsSplitSegment(layer, splitSeg)) {
                  mode = 'segmentDrag';
                  partitionSeg = splitSeg;
                  if (partitionSelSegRef) partitionSelSegRef.current = splitSeg;
                  setCursor(splitSeg.axis === 'v' ? 'col-resize' : 'row-resize');
                  capturePointer(e.pointerId);
                  requestDraw('scene');
                  return;
                }
                // A plain click anywhere in the grid clears the segment selection.
                if (partitionSelSegRef?.current) {
                  partitionSelSegRef.current = null;
                  requestDraw('scene');
                }
                const line = hitPartitionLine(layer, world, tol);
                if (line) {
                  mode = 'lineDrag';
                  partitionLine = line;
                  setCursor(line.axis === 'v' ? 'col-resize' : 'row-resize');
                  capturePointer(e.pointerId);
                  return;
                }
              }
              // Nothing structural under the cursor: this press is about the panels. It arms both readings
              // and lets the release decide — a click takes the panel's whole material group, any movement
              // turns the same press into a paint stroke over individual cells.
              if (partitionCellSelRef && partitionCellGroupAt(layer, world)) {
                partitionCellCandidate = { x: world.x, y: world.y, shift: e.shiftKey };
                // Shift extends the existing selection; a plain stroke starts empty, so it replaces.
                paintBase = e.shiftKey ? new Set(partitionCellSelRef.current) : new Set();
                painted = new Set();
                paintLast = { x: world.x, y: world.y };
                mode = 'partitionPaint';
              }
              capturePointer(e.pointerId);
              return;
            }
            // Outside every border → step back out of whatever was entered and drop any boolean-op pick.
            if (partitionEnteredRef?.current != null) {
              partitionEnteredRef.current = null;
              if (partitionCellSelRef) partitionCellSelRef.current = new Set();
              onCellMenu?.(null);
              requestDraw('scene');
            }
            if (partitionBorderSelRef?.current.size) {
              partitionBorderSelRef.current = new Set();
              requestDraw('scene');
            }
          }
        }
        // Empty space OUTSIDE the trim border → rubber-band multi-select of panel groups,
        // the same sweep the Shift branch above runs, now the plain default. Clearing the
        // selection first makes a plain sweep replace it (the sweep itself is additive) and
        // a no-drag click deselect. Inside the border the press stays inert so the armed
        // group-select still resolves on pointer-up. Panning is Space-drag only.
        if (layer && partitionHasBoundary(layer) && partitionCellSelRef) {
          const world = screenToWorld(sx, sy, cam);
          if (!partitionPointInBorder(layer, world)) {
            if (partitionCellSelRef.current.size) {
              partitionCellSelRef.current = new Set();
              onCellMenu?.(null); // the bar belongs to the selection it was cleared with
              requestDraw('scene');
            }
            mode = 'partitionMarquee';
            marqueeRef.current = { x0: sx, y0: sy, x1: sx, y1: sy };
            setCursor('crosshair');
            capturePointer(e.pointerId);
            return;
          }
        }
        mode = 'none';
        return;
      }

      // 0) Armed placement → click commits the preview as a real square.
      if (placementRef.current) {
        commitPlacement(sx, sy);
        setCursor('move');
        return;
      }

      // 0.3) A prediction fan left open by a click: clicking one of its dots places
      //      that room; clicking anywhere else dismisses the fan (then falls through
      //      to normal handling, so a fresh click can re-open / arm another arrow).
      const openPd = predictionDragRef.current;
      if (openPd && openPd.dragging) {
        const fanShape = shapesRef.current.find((s) => s.id === openPd.shapeId);
        const hit = fanShape ? hitPredictionOption(sx, sy, fanShape, cam, openPd.dir) : null;
        if (fanShape && hit != null && openPd.options[hit]) {
          createPredictedRoom(openPd.shapeId, openPd.dir, openPd.options[hit]!);
          predictionDragRef.current = null;
          setCursor('move');
          requestDraw('scene');
          return;
        }
        predictionDragRef.current = null;
        requestDraw('scene');
      }

      // 0.5) Footprint tool armed → click-drag draws a building footprint (a white
      //      slab behind the rooms). The draft tracks the cursor until release.
      if (footprintArmRef.current) {
        const w0 = screenToWorld(sx, sy, cam);
        footStart = { x: w0.x, y: w0.y };
        footprintDraftRef.current = { id: createId(), x: w0.x, y: w0.y, width: 0, height: 0 };
        mode = 'footdraw';
        setCursor('crosshair');
        capturePointer(e.pointerId);
        return;
      }

      // 1) Shift → ADDITIVE rubber-band marquee from anywhere, including over a room
      //    (a bare drag there moves it; branch 5 gives the bare marquee off empty space).
      //    UNLESS the cursor is on an armed magenta edge face, where Shift instead drags
      //    all walls' faces at once (handled by the thickness branch below).
      if (e.shiftKey && !grabbedFace) {
        mode = 'marquee';
        marqueeRef.current = { x0: sx, y0: sy, x1: sx, y1: sy };
        setCursor('crosshair');
        capturePointer(e.pointerId);
        return;
      }

      const world = screenToWorld(sx, sy, cam);

      // 2) Corner of a single selection → rotate about the centre.
      const single = singleSelected();

      // 1.3) Press an edge-plus button (shown while dimensions are) → begin a
      //      duplicate gesture in that direction. A click (no drag) drops one copy;
      //      dragging outward spawns more — one extra copy per room-length travelled
      //      — with a live ghost per copy. The copies are committed on pointer-up.
      const dimsForLock = !!single && (single.corners ? true : activeEdgeRef.current === null);
      if (single && dimsForLock) {
        const dir = hitEdgePlus(sx, sy, single, cam);
        if (dir != null) {
          e.preventDefault();
          if (single.dots) {
            // Opened shape: the edge button is a prediction arrow. Arm the fan; it
            // only renders once the press becomes a drag (set in onPointerMove).
            // Predict the likely neighbours now (confidence-ranked) and slot them by
            // position: middle (index 1) = most confident, then index 0, then 2.
            const sourceKey = findRoomDef(single.name ?? '')?.key ?? 'default';
            const ranked = predictRoomOptions(sourceKey, 3);
            const positionForRank = [1, 0, 2];
            const options: (PredictionOption | null)[] = [null, null, null];
            ranked.forEach((opt) => {
              options[positionForRank[opt.rank]] = opt;
            });
            mode = 'predictdrag';
            predictionDragRef.current = {
              shapeId: single.id,
              dir,
              hovered: null,
              dragging: false,
              options,
            };
            edgePlusHoverRef.current = null; // no duplicate ghost in this mode
            setCursor('pointer');
            capturePointer(e.pointerId);
            return;
          }
          const { dx, dy } = adjacentCopyOffset(single, dir);
          mode = 'plusdrag';
          plusDrag = {
            shape: single,
            dir,
            stepX: dx,
            stepY: dy,
            startX: world.x,
            startY: world.y,
            count: 1,
          };
          edgePlusHoverRef.current = { id: single.id, dir, count: 1 };
          capturePointer(e.pointerId);
          requestDraw('scene');
          return;
        }
      }

      // 1.4) Click the area-lock padlock (under the ft² readout, shown while this
      //      room's dimensions are) → toggle preserving its square footage on edits.
      if (single && dimsForLock && hitCenterLock(sx, sy, single, cam)) {
        e.preventDefault();
        single.areaLocked = !single.areaLocked;
        commitHistory();
        requestDraw('scene');
        return;
      }

      // 1.5) Click a dimension label of the infill-selected shape → edit it.
      //      preventDefault keeps the press from moving focus off the editor
      //      input that's about to mount.
      if (single && activeEdgeRef.current === null) {
        const dimHit = hitDimensionLabel(sx, sy, single, cam, unitRef.current);
        if (dimHit) {
          e.preventDefault();
          beginDimensionEdit(single.id, dimHit);
          return;
        }
        // Click the centre readout to rename the room or set its square footage.
        const centerHit = hitCenterLabel(sx, sy, single, cam, unitRef.current);
        if (centerHit) {
          e.preventDefault();
          beginCenterEdit(single.id, centerHit);
          return;
        }
      }

      // 1.6) Click the active wall edge's own length/thickness label → edit it. Shown
      //      whenever a single shape has an active edge; the labels sit off the wall,
      //      so this never collides with the magenta face-grab or the edge stretch.
      if (single && activeEdgeRef.current !== null && wallDimsArmedRef.current) {
        const wallHit = hitWallDimensionLabel(
          sx,
          sy,
          single,
          cam,
          activeEdgeRef.current,
          unitRef.current,
        );
        if (wallHit) {
          e.preventDefault();
          beginWallDimensionEdit(single.id, wallHit);
          return;
        }
      }

      // Corner-grab rotates ONLY while the shape's dimensions are showing (infill-
      // selected, no active edge) — i.e. the rotate knob is actually visible. This
      // prevents an accidental rotate right after an edge stretch (which leaves the
      // edge active, dimensions hidden) and while the editable vertices are showing.
      const rotateCorner =
        single && !single.dots && activeEdgeRef.current === null
          ? hitCornerHandle(sx, sy, single, cam)
          : null;
      if (single && rotateCorner) {
        mode = 'rotate';
        rotateTarget = single;
        rotatingRef.current = { id: single.id, corner: rotateCorner };
        const cx = single.x + single.width / 2;
        const cy = single.y + single.height / 2;
        rotateStartAngle = Math.atan2(world.y - cy, world.x - cx) * (180 / Math.PI);
        rotateStartRotation = single.rotation;
        setCursor(ROTATE_CURSOR);
        capturePointer(e.pointerId);
        return;
      }

      // 2.5) A magenta face of an armed selected edge → drag to change that wall's
      //      thickness (inner or outer face, whichever was lit). With Shift held the
      //      drag stretches ALL walls' faces of that kind at once (whole boundary).
      const activeEdge = activeEdgeRef.current;
      if (grabbedFace && activeEdge && single) {
        mode = 'thickness';
        handle = activeEdge;
        thicknessFace = grabbedFace;
        // Facade panels keep a uniform band, so a thickness drag always moves all four faces (no Shift
        // needed); the inspector's single mullion/joint value then stays in sync with the canvas.
        thicknessAll = e.shiftKey || !!facadeRef?.current;
        // Re-arm the lit face for the whole drag (pointer-down cleared it above), so
        // the magenta stretch line and the wall's length/thickness dimensions stay
        // visible and auto-update as the wall is stretched.
        edgeHoverRef.current = grabbedFace;
        edgeFaceAllRef.current = thicknessAll;
        snapshotSelection(world);
        setCursor(cursorForHandle(activeEdge, single));
        capturePointer(e.pointerId);
        return;
      }

      // 2.7) A visible vertex dot → drag that corner to reshape the room. It's a
      //      corner resize: the two adjacent edges follow the cursor while the
      //      opposite corner stays anchored, so width/height/area/dimensions all
      //      update parametrically. Wins over an edge grab (the dot sits at the
      //      interior corner where two edges meet).
      const dot = hitAnyVertexDot(sx, sy, cam);
      if (dot) {
        if (!selectionRef.current.has(dot.shape.id)) {
          selectionRef.current = new Set([dot.shape.id]);
        }
        // Treat as an infill (non-edge) selection so the live dimensions show
        // while reshaping; the corner handle drives the resize.
        activeEdgeRef.current = null;
        resizingRef.current = true;
        mode = 'vertex';
        handle = dot.handle;
        snapshotSelection(world);
        setCursor('default'); // plain pointer while dragging a vertex point
        capturePointer(e.pointerId);
        requestDraw('scene');
        return;
      }

      // 3) A wall edge → stretch it. Edges of the current selection win (so a
      //    multi-selection resizes together); otherwise grab whichever shape's
      //    edge is under the cursor, selecting just that shape. Either way, the
      //    grabbed edge becomes the active (darkened) region.
      // Edge-stretching stays available even while a shape's editable vertices
      // are showing: a grab right on a dot already became a vertex reshape in 2.7,
      // so anywhere else along the wall stretches the edge. Free-form quads
      // stretch by edge just like rectangles do.
      // Edge-stretch is disabled inside a shared-overlap band (the wall-over-
      // infill strip between two selected, overlapping rooms): a clean click there
      // performs the boolean trim (handled on pointer-up), and a drag falls
      // through to move the shape (pull-apart). Never stretches.
      pendingBoolean = overlapBandAt({ x: sx, y: sy }, shapesRef.current, selectionRef.current, cam);
      // Inside the shared INTERIOR-overlap region (both rooms' infill), a clean click
      // merges the two (boolean union); a drag still moves the shape (pull-apart).
      pendingUnion = overlapInteriorAt({ x: sx, y: sy }, shapesRef.current, selectionRef.current, cam);
      const edge = pendingBoolean ? null : hitSelectionEdge(sx, sy, cam) ?? hitAnyEdge(sx, sy, cam);
      if (edge) {
        // Dimensions persist through a stretch only if they were already showing
        // (this shape infill-selected) before the grab — never summoned by a
        // stretch that began on the edge.
        const dimsWereShowing =
          activeEdgeRef.current === null &&
          selectionRef.current.size === 1 &&
          selectionRef.current.has(edge.shape.id);
        if (!selectionRef.current.has(edge.shape.id)) {
          selectionRef.current = new Set([edge.shape.id]);
        }
        mode = 'resize';
        handle = edge.handle;
        activeEdgeRef.current = edge.handle;
        resizingRef.current = dimsWereShowing;
        // Fresh grab of an (un-armed) edge: hold the wall dimensions off during the
        // drag. A clean release (no drag) re-arms them on pointer-up below.
        wallDimsArmedRef.current = false;
        snapshotSelection(world);
        setCursor(cursorForHandle(edge.handle, edge.shape));
        capturePointer(e.pointerId);
        requestDraw('scene');
        return;
      }

      // 4) A square body (white infill) → select (if not already) and move the
      //    whole selection; the infill becomes the active (darkened) region.
      //    Holding Alt drags a fresh copy, leaving the originals in place.
      const hit = hitTopShape(shapesRef.current, world);
      if (hit) {
        if (!selectionRef.current.has(hit.id)) {
          selectionRef.current = new Set([hit.id]);
        }
        if (e.altKey) {
          duplicateSelection();
          gestureDuplicated = true;
        }
        activeEdgeRef.current = null;
        mode = 'move';
        snapshotSelection(world);
        setCursor('move');
        capturePointer(e.pointerId);
        requestDraw('scene');
        return;
      }

      // 4.5) A building footprint's own Length/Width dimension label (these sit in
      //      open space beyond the slab, behind the rooms) → edit it by typing.
      for (const fp of footprintsRef.current) {
        const fpHit = hitDimensionLabel(sx, sy, footprintAsShape(fp), cam, unitRef.current);
        if (fpHit) {
          e.preventDefault();
          beginDimensionEdit(fp.id, fpHit);
          return;
        }
      }

      // 5) Empty space → rubber-band marquee select (no modifier needed). Dropping the
      //    old selection here is what makes a plain sweep REPLACE it: the marquee itself
      //    is additive, so what it sweeps becomes the whole new selection, and a click
      //    with no drag sweeps nothing and simply deselects. (Shift skips the clear via
      //    branch 1, so a Shift-sweep extends instead.) Panning is Space-drag only.
      if (selectionRef.current.size > 0) {
        selectionRef.current = new Set();
        activeEdgeRef.current = null;
        requestDraw('scene');
      }
      mode = 'marquee';
      marqueeRef.current = { x0: sx, y0: sy, x1: sx, y1: sy };
      setCursor('crosshair');
      capturePointer(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      // Armed placement → the preview tracks the cursor. Show the four-arrow move
      // cursor (as when dragging a shape's infill), since this drops/moves a shape.
      if (placementRef.current) {
        const { sx, sy } = localPoint(e);
        placementRef.current.sx = sx;
        placementRef.current.sy = sy;
        setCursor('move');
        requestDraw('scene');
        return;
      }

      if (mode === 'none') {
        updateHoverCursor(e);
        return;
      }

      // Once the pointer travels past the slop, this gesture is a drag — which
      // keeps a stretch's closing release from arming the magenta edge faces.
      if (!draggedSinceDown) {
        const moved = Math.hypot(e.clientX - pressClientX, e.clientY - pressClientY);
        if (moved > CLICK_SLOP) draggedSinceDown = true;
      }

      // A real geometry edit (stretch, vertex move, wall-thickness drag, rotate)
      // dismisses any active smart-find highlight, like pressing Esc. Navigation
      // (pan/zoom), selection, and plain moves keep it. Idempotent, so the per-frame
      // call is cheap once cleared.
      if (
        draggedSinceDown &&
        (mode === 'resize' || mode === 'vertex' || mode === 'thickness' || mode === 'rotate')
      ) {
        clearFindHighlight?.();
      }

      const cam = cameraRef.current;

      if (mode === 'pan') {
        cam.x += e.clientX - lastClientX;
        cam.y += e.clientY - lastClientY;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        requestDraw('all'); // shapes move with the camera, so both layers
        return;
      }

      if (mode === 'marquee' || mode === 'partitionMarquee') {
        const { sx, sy } = localPoint(e);
        const m = marqueeRef.current;
        if (m) {
          m.x1 = sx;
          m.y1 = sy;
          requestDraw('scene');
        }
        return;
      }

      // Rotate a border about its bounding-box centre, snapped to ROTATION_SNAP_DEG like a room. The angle
      // is measured from the grab, so the grabbed corner tracks the cursor, and applied to the ORIGINAL
      // outline each frame rather than compounding onto the live one.
      if (mode === 'partitionRotate' && partitionRotate && partitionDocRef?.current) {
        const { sx: rx, sy: ry } = localPoint(e);
        const rw = screenToWorld(rx, ry, cam);
        const layer = partitionActiveLayer(partitionDocRef.current);
        const bb = partitionPolyBBox(partitionRotate.orig);
        const cx = bb.x + bb.w / 2;
        const cy = bb.y + bb.h / 2;
        const angle = Math.atan2(rw.y - cy, rw.x - cx) * (180 / Math.PI);
        const raw = angle - partitionRotate.startAngle;
        const deg = Math.round(raw / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
        // Keep per-group frames attached as the rotated boundary re-slices the panels it clips.
        partitionPreserveFrames(layer, () =>
          rotatePartitionBorder(layer, partitionRotate!.border, partitionRotate!.orig, deg),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }

      // Edge-plus duplicate on a border: copy count = how many shape-lengths the cursor has travelled
      // outward along the duplicate direction, at least one. Same rule as the Plan-mode room buttons.
      if (mode === 'partitionPlus' && partitionPlus) {
        const { sx: px, sy: py } = localPoint(e);
        const pw = screenToWorld(px, py, cam);
        const stepLen = Math.hypot(partitionPlus.stepX, partitionPlus.stepY) || 1;
        const ux = partitionPlus.stepX / stepLen;
        const uy = partitionPlus.stepY / stepLen;
        const projected = (pw.x - partitionPlus.startX) * ux + (pw.y - partitionPlus.startY) * uy;
        const count = Math.max(1, Math.min(MAX_PLUS_COPIES, Math.floor(projected / stepLen) + 1));
        if (count !== partitionPlus.count) {
          partitionPlus.count = count;
          if (partitionPlusRef) {
            partitionPlusRef.current = {
              border: partitionPlus.border,
              dx: partitionPlus.stepX,
              dy: partitionPlus.stepY,
              count,
            };
          }
          requestDraw('scene');
        }
        return;
      }

      // Paint-select: brush panels into the selection as the cursor sweeps over them. The highlight updates
      // live, so the user sees exactly what they are picking up while they drag. Nothing is painted until
      // the press clears the click slop — inside it the gesture may still resolve as a click, and a click
      // means something different (take the whole material group), so it must not disturb the selection.
      if (mode === 'partitionPaint' && partitionDocRef?.current) {
        if (!draggedSinceDown) return;
        const { sx, sy } = localPoint(e);
        paintTo(partitionActiveLayer(partitionDocRef.current), screenToWorld(sx, sy, cam));
        requestDraw('scene');
        return;
      }

      if (mode === 'footdraw') {
        const { sx, sy } = localPoint(e);
        const w = screenToWorld(sx, sy, cam);
        const d = footprintDraftRef.current;
        if (d) {
          d.x = Math.min(footStart.x, w.x);
          d.y = Math.min(footStart.y, w.y);
          d.width = Math.abs(w.x - footStart.x);
          d.height = Math.abs(w.y - footStart.y);
          requestDraw('scene');
        }
        return;
      }

      const { sx, sy } = localPoint(e);
      const world = screenToWorld(sx, sy, cam);

      // Edit-a-panel: drag the diagonal BORDER frame edge — the new border ('b') width is the cursor's
      // perpendicular distance inside the border. Shift scales every edge (n/e/s/w + b) to this one width;
      // otherwise only `b` changes (the n/e/s/w widths are preserved).
      if (mode === 'partitionFrame' && frameEditSide === 'b' && frameEditBorder && frameEditRef?.current) {
        frameEditAll = e.shiftKey;
        frameEditRef.current.allSides = frameEditAll;
        const { ax, ay, nx, ny, grab } = frameEditBorder;
        setCursor(cursorForNormal(nx, ny));
        const maxB = Math.min(frameEditRef.current.rect.w, frameEditRef.current.rect.h) * 0.9;
        const b = Math.max(MIN_WALL_WORLD, Math.min(maxB, (world.x - ax) * nx + (world.y - ay) * ny + grab));
        const doc = partitionDocRef?.current;
        if (doc) {
          const layer = partitionActiveLayer(doc);
          const cur = partitionPanelFrame(layer, frameEditRef.current.keys[0]);
          const next = frameEditAll ? { n: b, e: b, s: b, w: b, b } : cur ? { ...cur, b } : null;
          if (next) partitionSetPanelFrame(layer, frameEditRef.current.keys, next);
          partitionMutated = true;
          requestDraw('scene');
        }
        return;
      }

      // Edit-a-panel: drag the grabbed side's frame width (inner face → outer cell rect stays grid-fixed).
      // Shift resizes all four sides at once. The new widths are written to every selected group key (mirror).
      if (mode === 'partitionFrame' && frameEditSide && frameEditSide !== 'b' && frameEditOrig && frameEditRef?.current) {
        // Toggling Shift mid-drag switches between this side and all four (the highlight follows).
        frameEditAll = e.shiftKey;
        frameEditRef.current.allSides = frameEditAll;
        const dx = world.x - frameEditStart.x;
        const dy = world.y - frameEditStart.y;
        const minInterior = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        const next = frameEditAll
          ? resizeAllWalls(frameEditOrig, frameEditSide, 'inner', dx, dy, MIN_WALL_WORLD, minInterior)
          : resizeWall(frameEditOrig, frameEditSide, 'inner', dx, dy, MIN_WALL_WORLD, minInterior);
        const doc = partitionDocRef?.current;
        if (doc) {
          const cur = partitionPanelFrame(partitionActiveLayer(doc), frameEditRef.current.keys[0]);
          partitionSetPanelFrame(partitionActiveLayer(doc), frameEditRef.current.keys, {
            n: next.walls.n,
            e: next.walls.e,
            s: next.walls.s,
            w: next.walls.w,
            // Shift = uniform: scale the border frame with the sides; otherwise preserve the user-set border.
            b: frameEditAll ? next.walls.n : cur?.b,
          });
          partitionMutated = true;
          requestDraw('scene');
        }
        return;
      }

      // Layers tool: deform a trim corner, stretch a boundary edge, or drag a cell cut
      // (the two adjacent cells reflow; the rest stays put).
      if (mode === 'cornerDrag' && partitionCorner != null && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        // Keep per-group frames attached as the border reshapes the panels it slices.
        partitionPreserveFrames(layer, () =>
          movePartitionCorner(layer, partitionCornerBorder, partitionCorner!, world),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'borderMove' && partitionMoveBorder != null && partitionMoveOrig && partitionDocRef?.current) {
        // While a two-border boolean is pending, hold the move until the gesture is clearly a drag, so a clean
        // click commits the boolean (on pointer-up) instead of nudging the border by sub-slop jitter.
        if (pendingBorderBool && !draggedSinceDown) return;
        const layer = partitionActiveLayer(partitionDocRef.current);
        // Snap the FREE delta (from grab) onto a nearby OTHER border's edge/corner, surfacing the green guides,
        // exactly like a room move. Then apply it as an incremental delta against the live quad so
        // movePartitionBorder's per-border lattice carry-along stays intact.
        const dragged = polygonShape(partitionMoveOrig);
        const statics: Square[] = [];
        layer.borders.forEach((poly, i) => {
          if (i !== partitionMoveBorder) statics.push(polygonShape(poly));
        });
        const freeDx = world.x - partitionMoveStart.x;
        const freeDy = world.y - partitionMoveStart.y;
        const snapped = resolveWallSnap([dragged], statics, freeDx, freeDy, cam.scale, snapState);
        alignGuidesRef.current = snapped.guides.length > 0 ? snapped.guides : null;
        const live = layer.borders[partitionMoveBorder];
        const targetX = partitionMoveOrig[0].x + snapped.dx;
        const targetY = partitionMoveOrig[0].y + snapped.dy;
        // Carry each panel's frame and material along with it. Panel properties are keyed by cell POSITION,
        // and a move translates every cell — so without this the whole elevation's materials orphan the
        // instant the shape is nudged, while the lattice itself (stored as a grid, not by position)
        // survives. Every other geometry gesture already wraps its mutation this way.
        partitionPreserveFrames(layer, () =>
          movePartitionBorder(layer, partitionMoveBorder!, targetX - live[0].x, targetY - live[0].y),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      // `partitionEdge` is an index, so 0 is a valid edge — compare against null, not truthiness.
      if (mode === 'boundaryEdge' && partitionEdge != null && partitionEdgeOrig && partitionDocRef?.current) {
        // Reuse the room/shape edge stretch: offsets the grabbed edge along its outward normal and slides
        // the endpoints along the two adjacent edges — so an angled border edge behaves like a default shape.
        const layer = partitionActiveLayer(partitionDocRef.current);
        const borderSquare = polygonShape(partitionEdgeOrig);
        // Keep per-group frames attached as the border edge reshapes the panels it slices.
        partitionPreserveFrames(layer, () => {
          const next = stretchEdge(
            borderSquare,
            partitionEdge!,
            world.x - partitionEdgeStart.x,
            world.y - partitionEdgeStart.y,
          );
          if (next.corners && layer.borders[partitionEdgeBorder])
            layer.borders[partitionEdgeBorder] = next.corners.map((p) => ({ x: p.x, y: p.y }));
        });
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'lineDrag' && partitionLine && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        const axis = partitionLine.axis;
        const cands = partitionLineCandidates(layer, partitionLine.border, axis, partitionLine);
        const snap = snapLineCoord(axis === 'v' ? world.x : world.y, cands, cam.scale);
        alignGuidesRef.current = snap.guide != null ? [{ axis: axis === 'v' ? 'x' : 'y', world: snap.guide }] : null;
        partitionPreserveFrames(layer, () =>
          movePartitionLine(
            layer,
            partitionLine!,
            axis === 'v' ? { x: snap.value, y: world.y } : { x: world.x, y: snap.value },
          ),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'segmentDrag' && partitionSeg && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        const axis = partitionSeg.axis;
        const cands = partitionLineCandidates(layer, partitionSeg.border, axis);
        const snap = snapLineCoord(axis === 'v' ? world.x : world.y, cands, cam.scale);
        alignGuidesRef.current = snap.guide != null ? [{ axis: axis === 'v' ? 'x' : 'y', world: snap.guide }] : null;
        partitionPreserveFrames(layer, () =>
          movePartitionGridSegment(
            layer,
            partitionSeg!,
            axis === 'v' ? { x: snap.value, y: world.y } : { x: world.x, y: snap.value },
          ),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'segExtraDrag' && partitionSegExtra && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        const axis = partitionSegExtra.axis;
        const cands = partitionLineCandidates(layer, partitionSegExtra.border, axis);
        const snap = snapLineCoord(axis === 'v' ? world.x : world.y, cands, cam.scale);
        alignGuidesRef.current = snap.guide != null ? [{ axis: axis === 'v' ? 'x' : 'y', world: snap.guide }] : null;
        partitionPreserveFrames(layer, () =>
          movePartitionSegmentExtra(
            layer,
            partitionSegExtra!,
            axis === 'v' ? { x: snap.value, y: world.y } : { x: world.x, y: snap.value },
          ),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }

      if (mode === 'rotate' && rotateTarget) {
        const cx = rotateTarget.x + rotateTarget.width / 2;
        const cy = rotateTarget.y + rotateTarget.height / 2;
        // Rotate relative to the grab so the grabbed corner tracks the cursor.
        const angle = Math.atan2(world.y - cy, world.x - cx) * (180 / Math.PI);
        let deg = rotateStartRotation + (angle - rotateStartAngle);
        deg = Math.round(deg / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
        rotateTarget.rotation = ((deg % 360) + 360) % 360;
        requestDraw('scene');
        return;
      }

      if (mode === 'plusdrag' && plusDrag) {
        // Copy count = how many room-lengths the cursor has dragged outward (along
        // the duplicate direction), at least 1. Each step adds one more ghost.
        const stepLen = Math.hypot(plusDrag.stepX, plusDrag.stepY) || 1;
        const ux = plusDrag.stepX / stepLen;
        const uy = plusDrag.stepY / stepLen;
        const projected = (world.x - plusDrag.startX) * ux + (world.y - plusDrag.startY) * uy;
        const count = Math.max(1, Math.min(MAX_PLUS_COPIES, Math.floor(projected / stepLen) + 1));
        if (count !== plusDrag.count) {
          plusDrag.count = count;
          edgePlusHoverRef.current = { id: plusDrag.shape.id, dir: plusDrag.dir, count };
          requestDraw('scene');
        }
        return;
      }

      if (mode === 'predictdrag') {
        const pd = predictionDragRef.current;
        const shape = pd ? shapesRef.current.find((s) => s.id === pd.shapeId) : undefined;
        if (pd && shape) {
          // The fan appears once the press becomes a drag; then track which option the
          // cursor is over (it grows) as the user sweeps across the arc.
          const wasDragging = pd.dragging;
          if (!pd.dragging && draggedSinceDown) pd.dragging = true;
          if (pd.dragging) {
            const hit = hitPredictionOption(sx, sy, shape, cam, pd.dir);
            // Only a slot with an actual prediction is hoverable.
            const hovered = hit != null && pd.options[hit] ? hit : null;
            if (hovered !== pd.hovered || !wasDragging) {
              pd.hovered = hovered;
              requestDraw('scene');
            }
          }
        }
        return;
      }

      const dx = world.x - dragStartX;
      const dy = world.y - dragStartY;
      // Per-frame increment for the constrained drags: they build off the previous
      // frame's clamped geometry (item.orig, re-baselined below) rather than the
      // drag-start snapshot, so a metric that passes its bound mid-drag stays passed.
      const idx = world.x - dragLastX;
      const idy = world.y - dragLastY;

      if (mode === 'move') {
        // Wall-alignment snapping: pull the free delta onto a nearby wall axis (with a
        // breakout once the cursor strays far enough), and surface the green guide lines.
        const draggedOrig = dragItems.map((it) => it.orig);
        const statics = shapesRef.current.filter((s) => !selectionRef.current.has(s.id));
        const snapped = resolveWallSnap(draggedOrig, statics, dx, dy, cam.scale, snapState);
        alignGuidesRef.current = snapped.guides.length > 0 ? snapped.guides : null;
        for (const item of dragItems) {
          item.shape.x = item.orig.x + snapped.dx;
          item.shape.y = item.orig.y + snapped.dy;
        }
        // Light up the Library button when the dragged cluster is over it (dropping
        // there saves the arrangement instead of relocating it).
        const over = overLibraryButton(e.clientX, e.clientY);
        if (over !== overLibrary) {
          overLibrary = over;
          setCursor(over ? 'copy' : 'move');
          onLibraryHover?.(over);
          // Drive the shrink-into-Library animation: collapse while over, restore on leave.
          libraryShrinkRef.current.target = over ? LIBRARY_SHRINK_MIN : 1;
        }
        // Track the pointer so the shrink collapses toward the cursor, not the group.
        libraryShrinkRef.current.pivot = { x: world.x, y: world.y };
        requestDraw('scene'); // grid is static — only the scene changed
      } else if (mode === 'resize' && handle) {
        const minWorld = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        const k = constraintsRef.current;
        const h = handle;
        for (const item of dragItems) {
          // A free-form quad stretches by translating the whole grabbed edge; a
          // rectangle stretches axis-locked so it stays rectangular. With the area
          // lock on, the candidate is scaled back to the original footage. The clamp
          // then stops the drag at the constraint boundary (hard lock).
          const orig = item.orig;
          // Anchor the edit at the opposite edge so a locked room scales in place.
          const anchor = orig.areaLocked ? areaLockAnchorWorld(orig, h, false) : null;
          const next = clampDragToConstraints(
            (ddx, ddy) => {
              const cand = orig.corners
                ? stretchEdge(orig, h, ddx, ddy)
                : resizeShape(orig, h, ddx, ddy, minWorld);
              return anchor ? scaledToArea(cand, orig, anchor) : cand;
            },
            orig,
            idx,
            idy,
            k,
          );
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.corners = next.corners;
          item.orig = cloneGeom(next); // re-baseline for the next frame's increment
        }
        requestDraw('scene');
      } else if (mode === 'vertex' && handle) {
        // Move just the one grabbed interior corner; the room becomes a free
        // quadrilateral and width/height/area/centre renormalise around it.
        const item = dragItems[0];
        if (item) {
          const h = handle;
          const orig = item.orig;
          // Anchor at the opposite corner so a locked room scales in place.
          const anchor = orig.areaLocked ? areaLockAnchorWorld(orig, h, true) : null;
          const next = clampDragToConstraints(
            (ddx, ddy) => {
              const cand = moveVertex(orig, cornerIndexForHandle(h), ddx, ddy);
              return anchor ? scaledToArea(cand, orig, anchor) : cand;
            },
            orig,
            idx,
            idy,
            constraintsRef.current,
          );
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.corners = next.corners;
          item.orig = cloneGeom(next);
          requestDraw('scene');
        }
      } else if (mode === 'thickness' && handle && thicknessFace) {
        // Single-shape gesture: drag the lit face to retire/grow that wall. With
        // Shift (thicknessAll) the drag stretches every wall's face of that kind at
        // once, insetting/outsetting the whole interior or outer boundary together.
        const minWorld = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        const item = dragItems[0];
        if (item) {
          const h = handle;
          const face = thicknessFace;
          const all = thicknessAll;
          const orig = item.orig;
          const next = clampDragToConstraints(
            (ddx, ddy) =>
              all
                ? resizeAllWalls(orig, h, face, ddx, ddy, MIN_WALL_WORLD, minWorld)
                : resizeWall(orig, h, face, ddx, ddy, MIN_WALL_WORLD, minWorld),
            orig,
            idx,
            idy,
            constraintsRef.current,
          );
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.walls = next.walls;
          item.shape.corners = next.corners;
          item.shape.wallEdges = next.wallEdges;
          item.orig = cloneGeom(next);
          requestDraw('scene');
        }
      }

      // Advance the per-frame cursor anchor so the next move's increment (idx/idy) is
      // measured from here — the basis of the continuous, ratcheting constrained drag.
      dragLastX = world.x;
      dragLastY = world.y;
    };

    const onPointerUp = (e: PointerEvent) => {
      // A Space-pan is pure navigation — it must not fall into the selection, arming, or
      // Layers-tool click handling below, so a Space-click leaves the drawing exactly as
      // it found it. Only the pan's own arming reset (matching every other gesture) stays.
      if (mode === 'pan') {
        mode = 'none';
        partitionCellCandidate = null;
        edgeClickArmed = false;
        wallDimsArmedRef.current = false;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        updateHoverCursor(e);
        return;
      }

      // Layers tool: end any edge/cut/corner drag cleanly. (Borders arrive via the cube placement,
      // not a drag-to-draw, so there is no in-progress boundary draw to commit here.)
      if (layersActiveRef?.current) {
        // Commit an edge-plus duplicate: drop `count` copies of the shape stepping away from the grabbed
        // side, each carrying its own lattice and panels. The last copy becomes the selection, so a chain
        // of clicks walks a row outward the way it does in Plan mode.
        if (mode === 'partitionPlus' && partitionPlus && partitionDocRef?.current) {
          const { border, stepX, stepY, count } = partitionPlus;
          const layer = partitionActiveLayer(partitionDocRef.current);
          let last: number | null = null;
          for (let i = 1; i <= count; i++) {
            const copy = partitionDuplicateBorder(layer, border, stepX * i, stepY * i);
            if (copy != null) last = copy;
          }
          if (last != null && partitionBorderSelRef) {
            partitionBorderSelRef.current = new Set([last]);
            partitionMutated = true;
          }
          partitionPlus = null;
          if (partitionPlusRef) partitionPlusRef.current = null;
          mode = 'none';
          if (partitionMutated) {
            commitHistory();
            partitionMutated = false;
          }
          try {
            el.releasePointerCapture(e.pointerId);
          } catch {
            // already released; ignore.
          }
          requestDraw('scene');
          updateHoverCursor(e);
          return;
        }
        // End of a paint stroke. The selection was already built live during the drag, so there is nothing
        // to compute here — just bring the panel bar up over what was painted. A press that never moved
        // isn't a stroke at all: it falls through to the click handling below, which picks the whole
        // material group instead (paint = "these exact panels", click = "every panel like this one").
        if (mode === 'partitionPaint') {
          const strokePainted = draggedSinceDown && painted.size > 0;
          paintBase = null;
          painted = new Set();
          paintLast = null;
          mode = 'none';
          if (strokePainted && partitionDocRef?.current && partitionCellSelRef) {
            const layer = partitionActiveLayer(partitionDocRef.current);
            syncCellMenuToSelection(layer, partitionCellSelRef.current);
            partitionCellCandidate = null; // a real stroke — don't also run the click's group-select
                try {
              el.releasePointerCapture(e.pointerId);
            } catch {
              // already released; ignore.
            }
            requestDraw('scene');
            updateHoverCursor(e);
            return;
          }
        }
        // Marquee that began outside the border → add every panel group it swept to the selection. (A plain
        // sweep cleared the selection on pointer-down, so it reads as a replace; Shift keeps it and extends.)
        if (mode === 'partitionMarquee') {
          const m = marqueeRef.current;
          marqueeRef.current = null;
          // As with rooms, only a real sweep selects — a no-drag click just clears (done on down).
          if (m && draggedSinceDown && partitionCellSelRef && partitionDocRef?.current) {
            const layer = partitionActiveLayer(partitionDocRef.current);
            const a = screenToWorld(m.x0, m.y0, cameraRef.current);
            const b = screenToWorld(m.x1, m.y1, cameraRef.current);
            const rect = {
              x: Math.min(a.x, b.x),
              y: Math.min(a.y, b.y),
              w: Math.abs(a.x - b.x),
              h: Math.abs(a.y - b.y),
            };
            // Cell keys, not group keys: the sweep takes the panels it actually covered and leaves their
            // identical twins elsewhere on the facade alone — the same "only what's in the box" rule a
            // Plan-mode marquee follows.
            const next = new Set(partitionCellSelRef.current);
            for (const k of partitionCellKeysInRect(layer, rect)) next.add(k);
            partitionCellSelRef.current = next;
            // A sweep is a selection like any other, so it brings the bar with it — anchored under the
            // bottom centre of everything it caught.
            syncCellMenuToSelection(layer, next);
          }
          mode = 'none';
          try {
            el.releasePointerCapture(e.pointerId);
          } catch {
            // already released; ignore.
          }
          requestDraw('scene');
          updateHoverCursor(e);
          return;
        }

        // Two-border boolean: a clean release (no drag) over the shared interior UNITES the picked borders;
        // over a bounding edge it SUBTRACTS that edge's border from the other. A drag was a pull-apart move
        // (finalized by the borderMove cleanup below), so only fire on a clean click.
        if (pendingBorderBool && partitionDocRef?.current) {
          const bh = pendingBorderBool;
          pendingBorderBool = null;
          if (!draggedSinceDown && partitionBorderSelRef) {
            const layer = partitionActiveLayer(partitionDocRef.current);
            const ok =
              bh.kind === 'union'
                ? unitePartitionBorders(layer, bh.a, bh.b)
                : differencePartitionBorders(layer, bh.target, bh.other);
            if (ok) {
              partitionBorderSelRef.current = new Set();
              if (partitionCellSelRef) partitionCellSelRef.current = new Set(); // cells move after reshaping
              commitHistory();
            }
            partitionMoveBorder = null;
            partitionMoveOrig = null;
            mode = 'none';
            try {
              el.releasePointerCapture(e.pointerId);
            } catch {
              // already released; ignore.
            }
            requestDraw('scene');
            updateHoverCursor(e);
            return;
          }
        }

        // Edit-a-panel auto-exit: a clean click (not a drag, not on a frame edge) that lands OUTSIDE the
        // border or on a DIFFERENT panel group acts as "Done" and closes the session. Click-drag never exits.
        const wasEditing = !!frameEditRef?.current;
        if (
          wasEditing &&
          e.button === 0 &&
          !draggedSinceDown &&
          mode !== 'partitionFrame' &&
          partitionDocRef?.current
        ) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          const { sx, sy } = localPoint(e);
          // `keys` are CELL keys now, so compare against the cell under the cursor.
          const clicked = partitionCellKeyAt(layer, screenToWorld(sx, sy, cameraRef.current));
          if (clicked == null || !frameEditRef?.current?.keys.includes(clicked)) {
            onExitFrameEdit?.();
          }
        }
        // A clean LEFT-click on a panel (no drag) selects THAT panel; Shift-click takes every panel of the
        // same type. A clean click on empty space clears. (Render-only — the selection is not history.)
        if (
          e.button === 0 &&
          partitionCellSelRef &&
          !draggedSinceDown &&
          !wasEditing && // during (or ending) an Edit session, the click doesn't change the selection
          partitionDocRef?.current
        ) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          const set = partitionCellSelRef.current;
          if (partitionCellCandidate) {
            // A plain click takes exactly the ONE panel under the cursor. Identical panels are everywhere
            // on a facade, so taking the whole material group lit up the elevation and made it impossible
            // to act on a single unit.
            //
            // SHIFT-click is the deliberate "select similar": it takes every panel sharing this one's
            // shape — the material-ID group — so a whole type can still be Assigned or Edited in one go.
            // That is the only gesture that reaches for the group; everything else speaks in single cells.
            const pt = { x: partitionCellCandidate.x, y: partitionCellCandidate.y };
            const key = partitionCellKeyAt(layer, pt);
            if (key) {
              if (partitionCellCandidate.shift) {
                const grp = partitionCellGroupAt(layer, pt);
                const twins = grp ? partitionGroupCellKeys(layer, grp) : [key];
                // Toggle the type as a unit: drop it when it's already fully selected, else take all of it.
                if (twins.every((c) => set.has(c))) for (const c of twins) set.delete(c);
                else for (const c of twins) set.add(c);
              } else {
                partitionCellSelRef.current = new Set([key]);
              }
              // ...and brings the floating menu with it. Selecting IS how the bar opens — there is no
              // right-click and no second gesture. The panel just clicked stays the Split/Edit target as
              // long as it's still selected; a Shift-click that toggled it back OFF hands that role to
              // what's left (and closes the bar once nothing is).
              const sel = partitionCellSelRef.current;
              if (sel.has(key)) {
                openCellMenu(layer, {
                  x: partitionCellCandidate.x,
                  y: partitionCellCandidate.y,
                });
              } else {
                syncCellMenuToSelection(layer, sel);
              }
            }
          } else if (!e.shiftKey && set.size) {
            partitionCellSelRef.current = new Set();
          }
          // A click that landed on no panel dismisses the bar, like any popover.
          if (!partitionCellCandidate) onCellMenu?.(null);
        }
        partitionCellCandidate = null;
        // One undo step per gesture that actually changed the partition (draw, deform, line/segment move,
        // duplicate). Selections and no-op clicks leave it untouched.
        if (partitionMutated) {
          commitHistory();
          // Panels are selected by POSITION, so any gesture that moves or resizes the lattice leaves those
          // keys pointing at cells that no longer exist. Drop the selection outright rather than let the
          // highlight quietly evaporate on some panels and not others.
          if (partitionCellSelRef?.current.size) {
            partitionCellSelRef.current = new Set();
            onCellMenu?.(null); // the bar is the selection's — it goes with it
          }
        }
        partitionMutated = false;
        partitionCorner = null;
        partitionMoveBorder = null;
        partitionMoveOrig = null;
        partitionEdge = null;
        partitionEdgeOrig = null;
        partitionLine = null;
        partitionSeg = null;
        partitionSegExtra = null;
        frameEditSide = null;
        frameEditOrig = null;
        frameEditBorder = null;
        alignGuidesRef.current = null; // drop any line-snap guide
        mode = 'none';
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Footprint draw: commit the slab if the drag covered a real area; a tiny
      // drag (or a plain click) cancels. Either way the tool disarms (single-shot).
      if (mode === 'footdraw') {
        const d = footprintDraftRef.current;
        footprintDraftRef.current = null;
        footprintArmRef.current = false;
        mode = 'none';
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        if (d && d.width >= MIN_FOOTPRINT_WORLD && d.height >= MIN_FOOTPRINT_WORLD) {
          footprintsRef.current.push(d);
          commitHistory();
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      if (mode === 'none' && !pendingBoolean && !pendingUnion) return;

      // Next-room prediction fan. A DRAG that releases on an option creates that
      // predicted room and closes the fan. A plain CLICK on the arrow (no drag)
      // instead leaves the fan OPEN, so the user can then click a dot to pick one.
      if (mode === 'predictdrag') {
        const pd = predictionDragRef.current;
        if (pd) {
          if (draggedSinceDown) {
            const option = pd.hovered != null ? pd.options[pd.hovered] : null;
            if (option) createPredictedRoom(pd.shapeId, pd.dir, option);
            predictionDragRef.current = null;
          } else {
            // Click-to-open: keep the fan visible and waiting for a dot click.
            pd.dragging = true;
            pd.hovered = null;
          }
        }
        mode = 'none';
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Edge-plus duplicate gesture: commit `count` copies in a row (one per
      // room-length the cursor dragged outward; a clean click → 1), then select
      // them. One undo step for the whole batch.
      if (mode === 'plusdrag' && plusDrag) {
        const { shape, dir, count } = plusDrag;
        const { dx, dy } = adjacentCopyOffset(shape, dir);
        const ids: string[] = [];
        // A click-and-drag keeps the original in the resulting multi-selection
        // alongside its copies; a plain click selects just the new copy.
        if (draggedSinceDown) ids.push(shape.id);
        for (let i = 1; i <= count; i++) {
          const copy: Square = {
            ...shape,
            id: createId(),
            walls: { ...shape.walls },
            corners: shape.corners?.map((p) => ({ ...p })),
            wallEdges: shape.wallEdges?.slice(),
            x: shape.x + dx * i,
            y: shape.y + dy * i,
          };
          shapesRef.current.push(copy);
          ids.push(copy.id);
        }
        selectionRef.current = new Set(ids);
        activeEdgeRef.current = null;
        edgePlusHoverRef.current = null;
        plusDrag = null;
        commitHistory();
        mode = 'none';
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Shared-overlap band, clean click (no drag): trim `target` by subtracting
      // `other`'s footprint, so `target` becomes an N-gon that inherits the
      // not-clicked wall as its new edge. A drag instead pulled the shape apart.
      if (pendingBoolean && !draggedSinceDown) {
        const { target, other } = pendingBoolean;
        pendingBoolean = null;
        const newCorners = differenceCorners(target, other);
        if (newCorners) {
          // Per-edge wall thicknesses BEFORE re-centring (computed in target's local
          // frame); recentre preserves the edge order, so they stay aligned. Kept
          // walls keep their thickness; the new cut edge inherits the other's wall.
          const wallEdges = differenceWallEdges(target, other, newCorners);
          target.corners = newCorners;
          const r = recenterCorners(target);
          target.x = r.x;
          target.y = r.y;
          target.width = r.width;
          target.height = r.height;
          target.corners = r.corners;
          target.wallEdges = wallEdges;
          // Drop the selection so the freshly trimmed rooms read as committed
          // (no lingering edges/overlap cues), like finishing any other edit.
          selectionRef.current = new Set();
          activeEdgeRef.current = null;
          commitHistory();
        }
        mode = 'none';
        handle = null;
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Interior-overlap region, clean click (no drag): UNION the two rooms into one.
      // `a` absorbs `b` (keeping `a`'s title); each merged edge retains its source
      // room's wall thickness. A drag instead moved the shape (pull-apart).
      if (pendingUnion && !draggedSinceDown) {
        const { a, b } = pendingUnion;
        pendingUnion = null;
        const merged = unionCorners(a, b);
        if (merged) {
          const wallEdges = unionWallEdges(a, b, merged);
          a.corners = merged;
          a.wallEdges = wallEdges;
          const r = recenterCorners(a);
          a.x = r.x;
          a.y = r.y;
          a.width = r.width;
          a.height = r.height;
          a.corners = r.corners;
          // Remove the absorbed room; the merged room is one space with one title.
          shapesRef.current = shapesRef.current.filter((s) => s.id !== b.id);
          selectionRef.current = new Set();
          activeEdgeRef.current = null;
          commitHistory();
        }
        mode = 'none';
        handle = null;
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Drop a dragged selection onto the Library button → save the arrangement and
      // snap the shapes back where they started (the drag was a "save", not a move).
      if (mode === 'move' && draggedSinceDown && overLibrary) {
        for (const item of dragItems) {
          item.shape.x = item.orig.x;
          item.shape.y = item.orig.y;
        }
        onLibraryDrop?.(dragItems.map((item) => cloneGeom(item.orig)));
        // Clear the selection so the saved cluster reads as "done" — the user
        // shouldn't have to manually deselect after dropping into the Library.
        selectionRef.current = new Set();
        activeEdgeRef.current = null;
        overLibrary = false;
        onLibraryHover?.(false);
        // Settle the shrink animation instantly — the selection is gone, stored.
        libraryShrinkRef.current.scale = 1;
        libraryShrinkRef.current.target = 1;
        mode = 'none';
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      if (mode === 'marquee') {
        const m = marqueeRef.current;
        // Only a real sweep selects. A click with no drag leaves a zero-area marquee, and
        // sweeping with it would bbox-hit whatever the click just missed (the corner of a
        // rotated room) instead of reading as the deselect the user meant.
        if (m && draggedSinceDown) selectFromMarquee(m, cameraRef.current);
        else if (m && e.button === 0 && e.shiftKey) {
          // A SHIFT-click that never travelled is not a sweep at all — it is the additive pick, and the
          // only way to build the multi-selection every boolean needs ("click one room, Shift-click the
          // other, then click their overlap"). It has to be a point hit-test, not a zero-area marquee:
          // the marquee compares bounding boxes, so on a rotated or L-shaped room it would take one the
          // click visibly missed. Clicking a room already in the selection drops it back out.
          const { sx, sy } = localPoint(e);
          const picked = hitTopShape(shapesRef.current, screenToWorld(sx, sy, cameraRef.current));
          if (picked) {
            const next = new Set(selectionRef.current);
            if (!next.delete(picked.id)) next.add(picked.id);
            selectionRef.current = next;
          }
        }
        marqueeRef.current = null;
        activeEdgeRef.current = null; // a marquee selects infills (move target)
        requestDraw('scene');
      }
      // Record one undo step per shape-changing gesture: a real drag in a
      // mutating mode, or an Alt-duplicate (which changes state even without a
      // drag). New gesture types only need to be added to this condition.
      const mutated =
        gestureDuplicated ||
        (draggedSinceDown &&
          (mode === 'move' ||
            mode === 'resize' ||
            mode === 'thickness' ||
            mode === 'rotate' ||
            mode === 'vertex'));
      // A reshape just ended: re-centre each quad on its bounding box (once), so
      // it now rotates about its visual centre like a rectangle. Visually a no-op
      // (the geometry stays put) — only the pivot/extents are normalised.
      if (draggedSinceDown && (mode === 'vertex' || mode === 'resize')) {
        for (const item of dragItems) {
          if (!item.shape.corners) continue;
          const r = recenterCorners(item.shape);
          item.shape.x = r.x;
          item.shape.y = r.y;
          item.shape.width = r.width;
          item.shape.height = r.height;
          item.shape.corners = r.corners;
        }
      }
      if (mutated) commitHistory();

      // A plain click (no drag) dismisses the vertex dots of any shape it landed
      // outside of; a click-and-drag (pan/marquee/move/resize/…) leaves them.
      if (!draggedSinceDown) {
        const { sx, sy } = localPoint(e);
        const clicked = hitTopShape(shapesRef.current, screenToWorld(sx, sy, cameraRef.current));
        let cleared = false;
        for (const s of shapesRef.current) {
          if (s.dots && s !== clicked) {
            s.dots = false;
            cleared = true;
          }
        }
        if (cleared) {
          commitHistory();
          requestDraw('scene');
        }
      }

      // Arm the magenta edge faces on a clean edge click (press + release, no
      // drag), and keep them armed after a thickness drag so the faces stay
      // available for continued adjustment.
      edgeClickArmed = (mode === 'resize' && !draggedSinceDown) || mode === 'thickness';
      // The per-edge wall dimensions follow the same arming: a clean edge click (or a
      // thickness adjustment of an already-armed edge) shows them; any other gesture
      // — a pure resize drag, move, etc. — leaves them off.
      wallDimsArmedRef.current = edgeClickArmed;
      resizingRef.current = false;
      if (rotatingRef.current) {
        rotatingRef.current = null;
        requestDraw('scene'); // clear the angle readout
      }
      mode = 'none';
      handle = null;
      thicknessFace = null;
      thicknessAll = false;
      rotateTarget = null;
      dragItems = [];
      // Drop any wall-alignment guides from the move that just ended.
      if (alignGuidesRef.current) {
        alignGuidesRef.current = null;
        requestDraw('scene');
      }
      snapState = emptySnapState();
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // pointer may already be released; ignore.
      }
      updateHoverCursor(e);
    };

    // Double-click on a shape's white infill toggles its inner-vertex dots. Disabled
    // while a multi-selection is active — vertex editing is a single-shape gesture, so
    // a double-click on a group of selected rooms shouldn't arm it.
    const onDoubleClick = (e: MouseEvent) => {
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy, cameraRef.current);
      // Layers tool: double-click STEPS INTO a shape. Until then a border is an object you select and drag
      // around; from here on the pointer edits its contents — mullions, splits, and paint-selecting panels —
      // and the floating panel bar opens on the panel that was double-clicked. This is the boundary that
      // keeps "move the shape" and "select its cells" from competing for the same plain drag.
      if (layersActiveRef?.current && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        if (!partitionHasBoundary(layer)) return;
        const bi = partitionBorderIndexAt(layer, world);
        if (bi == null) return;
        if (partitionEnteredRef) partitionEnteredRef.current = bi;
        if (partitionBorderSelRef) partitionBorderSelRef.current = new Set([bi]);
        // Land on the ONE panel under the cursor, so the bar opens on exactly what was double-clicked
        // rather than lighting up every panel that shares its shape.
        const cellKey = partitionCellKeyAt(layer, world);
        if (partitionCellSelRef) {
          partitionCellSelRef.current = cellKey ? new Set([cellKey]) : new Set();
        }
        openCellMenu(layer, world);
        requestDraw('scene');
        return;
      }
      if (selectionRef.current.size > 1) return;
      const hit = hitTopShape(shapesRef.current, world);
      if (hit) {
        hit.dots = !hit.dots;
        commitHistory();
        requestDraw('scene');
      }
    };

    // Escape cancels an armed placement or the armed/in-progress footprint tool.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Step back out to shape level: the border stays selected (and draggable), its panels do not.
      if (partitionEnteredRef?.current != null) {
        partitionEnteredRef.current = null;
        if (partitionCellSelRef) partitionCellSelRef.current = new Set();
        onCellMenu?.(null);
        requestDraw('scene');
      }
      if (placementRef.current) {
        placementRef.current = null;
        alignGuidesRef.current = null; // drop placement snap guides
        setCursor('default');
        requestDraw('scene');
      }
      if (footprintArmRef.current || footprintDraftRef.current) {
        footprintArmRef.current = false;
        footprintDraftRef.current = null;
        mode = 'none';
        setCursor('default');
        requestDraw('scene');
      }
    };

    // Hold Space to pan: while it's down the pointer drags the camera and nothing
    // else, and releasing it hands the canvas straight back to selection/editing.
    // Ignored while a field (or a focusable control) has focus so typing a space —
    // or activating a button with it — still works.
    const onSpaceDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isKeyboardTarget(e.target)) return;
      e.preventDefault(); // Space would otherwise scroll the page
      if (spaceHeld) return;
      spaceHeld = true;
      if (mode === 'none') setCursor('grab');
    };
    const onSpaceUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeld = false;
      // A pan in flight keeps 'grabbing' until pointer-up; otherwise the next
      // pointer-move restores the hover cursor from here.
      if (mode !== 'pan') setCursor('default');
    };
    // Alt-tabbing away eats the keyup, which would otherwise leave Space "stuck" down.
    const onBlurClearSpace = () => {
      spaceHeld = false;
    };

    // Shift pressed/released while hovering an armed edge face toggles the
    // all-faces highlight even when the cursor is stationary.
    const onShiftToggle = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      const next = e.shiftKey && edgeHoverRef.current !== null;
      if (next !== edgeFaceAllRef.current) {
        edgeFaceAllRef.current = next;
        requestDraw('scene');
      }
    };

    setCursor('default');
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('dblclick', onDoubleClick);
    window.addEventListener('resize', refreshRect);
    window.addEventListener('scroll', refreshRect, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onSpaceDown);
    window.addEventListener('keyup', onSpaceUp);
    window.addEventListener('blur', onBlurClearSpace);
    window.addEventListener('keydown', onShiftToggle);
    window.addEventListener('keyup', onShiftToggle);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('dblclick', onDoubleClick);
      window.removeEventListener('resize', refreshRect);
      window.removeEventListener('scroll', refreshRect, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onSpaceDown);
      window.removeEventListener('keyup', onSpaceUp);
      window.removeEventListener('blur', onBlurClearSpace);
      window.removeEventListener('keydown', onShiftToggle);
      window.removeEventListener('keyup', onShiftToggle);
    };
  }, [
    canvasRef,
    cameraRef,
    shapesRef,
    selectionRef,
    marqueeRef,
    placementRef,
    predictionDragRef,
    footprintsRef,
    footprintArmRef,
    footprintDraftRef,
    libraryShrinkRef,
    commitPlacement,
    beginDimensionEdit,
    commitHistory,
    requestDraw,
    constraintsRef,
    libraryDropRef,
    libraryPopupDropRef,
    onLibraryHover,
    onLibraryDrop,
    onHoverRoomKey,
    clearFindHighlight,
    alignGuidesRef,
    onCellMenu,
    onExitFrameEdit,
  ]);
}
