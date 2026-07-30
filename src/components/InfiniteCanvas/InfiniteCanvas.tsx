import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react';
import type {
  CanvasStats,
  DrawLayer,
  Footprint,
  LengthUnit,
  Marquee,
  PendingPlacement,
  Square,
} from '../../types';
import {
  GRID_THEME,
  SHAPE_THEME,
  DEFAULT_SQUARE_SCREEN_SIZE,
  DEFAULT_WALL_WORLD,
  WORLD_UNITS_PER_FOOT,
  MIN_WALL_WORLD,
  MAX_DEVICE_PIXEL_RATIO,
  MAX_SCALE,
  MARQUEE_FILL,
  MARQUEE_STROKE,
  worldUnitsPerUnit,
  computeGridExtentCells,
} from '../../constants';
import { drawGrid } from '../../canvas/grid';
import {
  drawShapes,
  drawMarquee,
  defaultWalls,
  boundingBoxLocal,
  adjacentCopyOffset,
  footprintWorld,
  shapeAreaInUnit,
  shapeGrossAreaInUnit,
  withEdgeThickness,
  recenterCorners,
  type HandleId,
  type EdgeFace,
  type HoverRegion,
  type DimensionLabelHit,
  type CenterLabelHit,
  type WallDimensionLabelHit,
} from '../../canvas/shapes';
import { drawClusterPreview } from '../../canvas/thumbnail';
import { DEFAULT_FACADE_ASSEMBLY } from '../../facade/assemblies';
import {
  facadeType,
  inchesToWorld,
  worldToInches,
  feetToWorld,
  bandInchesFor,
} from '../../facade/catalog';
import { computePanelTypes, type PanelType } from '../../facade/standardize';
import { drawPartition } from '../../canvas/partitionDraw';
import {
  newDoc,
  cellKeysInRect,
  cloneDoc as clonePartitionDoc,
  activeLayer as partitionActiveLayer,
  hasBoundary as partitionHasBoundary,
  addLayer as addPartitionLayer,
  selectLayer as selectPartitionLayer,
  splitCell as splitPartitionCell,
  placeBorder as placePartitionBorder,
  polyBBox as partitionPolyBBox,
  gridLinePositions as partitionGridLines,
  resizeBorderExtent,
  moveLatticePreservingFrames,
  summarizeDoc,
  panelStats as partitionPanelStatsOf,
  optimizeBorder,
  borderBooleanHoverAt,
  representativeCell,
  cellKeyAt,
  cellRectsOf,
  cellRefRect as partitionCellRefRect,
  selectedCellsExtent,
  selectedBordersExtent,
  seedPanelFrames,
  panelFrameAt,
  copyBorders,
  pasteBorders,
  removeBorders,
  setPanelKind,
  facadeMetrics as facadeMetricsOf,
  type BorderSnapshot,
  type FacadeMetrics,
  type CellRef,
  type PanelKind,
  type FacadeDoc,
  type FacadeSummary,
  type OptimizeStrategy,
  type PanelMode,
  type Rect,
  type SegmentRef,
} from '../../facade/partition';
import { drawFootprints } from '../../canvas/footprint';
import { findMatches } from '../../search/findQuery';
import {
  drawAlignmentGuides,
  resolveWallSnap,
  emptySnapState,
  type AlignGuide,
} from '../../canvas/snapping';
import { isUsableFloorArea } from '../../rooms/roomCatalog';
import {
  enumerateViolations,
  proposeFix,
  globalNotes,
  violationKey,
  type Violation,
  type Proposal,
  type FixResult,
} from '../../constraints/autofix';
import type { PredictionOption } from '../../rooms/roomAdjacency';
import type { ProjectSnapshot, WorkspaceState } from '../../projects';
import { screenToWorld, worldToScreen } from '../../canvas/coords';
import type { Constraints, FacadeConstraints } from '../../../backend/types';
import {
  EMPTY_CONSTRAINTS,
  EMPTY_FACADE_CONSTRAINTS,
  hasAnyConstraint,
  hasAnyFacadeConstraint,
} from '../../../backend/types';
import { findViolations, type ShapeViolations } from '../../../backend/violations';
import { findFacadeViolations, NO_FACADE_VIOLATIONS } from '../../../backend/facadeViolations';
import { worsensConstraints } from '../../../backend/clamp';
import { useCamera } from '../../hooks/useCamera';
import { useCanvasInteractions } from '../../hooks/useCanvasInteractions';
import { useWindowSize } from '../../hooks/useWindowSize';
import { perfMonitor } from '../../perf/perfMonitor';
import styles from './InfiniteCanvas.module.css';

/** Imperative placement API the action button drives. */
/** Live read-out of the single selected facade panel, reported to App for the assembly inspector. */
export interface SelectedPanelInfo {
  /** The selected shape's id. */
  id: string;
  /** Its assembly type key (e.g. "UCWP"). */
  assembly: string;
  /** Interior width / height in feet. */
  widthFt: number;
  heightFt: number;
  /** The visible mullion/joint band width in inches (its uniform wall thickness). */
  bandIn: number;
}

/**
 * A restorable copy of the canvas, for the guided tour's Back button. Opaque to its callers — they hold one
 * and hand it back; only {@link CanvasHandle.demoRestore} knows what is in it.
 */
export interface DemoSnapshot {
  shapes: Square[];
  footprints: Footprint[];
  partition: FacadeDoc;
  selection: string[];
  cellSel: string[];
  borderSel: number[];
  entered: number | null;
  frameEdit: { keys: string[]; rect: Rect; hoverSide: 'n' | 'e' | 's' | 'w' | 'b' | null; allSides: boolean } | null;
  camera: { x: number; y: number; scale: number };
}

export interface CanvasHandle {
  /**
   * Arm placement: a preview square appears centred on the given client point
   * and follows the cursor until the user clicks the canvas to commit it.
   */
  startPlacement(clientX: number, clientY: number): void;
  /** Reposition the armed preview (used while dragging from the button). */
  updatePlacement(clientX: number, clientY: number): void;
  /** Commit the armed preview at a client point (used on drag release). */
  commitPlacementAtClient(clientX: number, clientY: number): void;
  /** Cancel an armed placement without committing. */
  cancelPlacement(): void;
  /**
   * Create the given rooms (each its own interior size in feet + display name),
   * laid out left→right in a flush horizontal line (outer walls touching, no
   * overlap) centred in the current view. One undo step; the new rooms become the
   * selection. Drives the Prompt — sizes/names come from the room catalog resolver.
   */
  createRoomsFromList(rooms: { name: string; widthFt: number; heightFt: number }[]): void;
  /**
   * Arm placement of a saved Library cluster: a ghost of the whole arrangement
   * follows the cursor from the given client point and commits where released (drag)
   * or on the next canvas click. `shapes` must be origin-centred (as stored).
   */
  startClusterPlacement(shapes: Square[], clientX: number, clientY: number): void;
  /**
   * Arm the building-footprint tool: the next click-drag on the canvas draws a
   * white-slab, black-outlined footprint behind every room. Single-shot — it
   * disarms once one footprint is drawn (or the drag is cancelled).
   */
  armFootprintDraw(): void;
  /**
   * Serialise the whole drawing — BOTH mode workspaces (the live one plus the stashed
   * other), the facade partition, and the active unit — as plain data for the Saved list.
   */
  snapshotProject(): ProjectSnapshot;
  /**
   * Replace the whole drawing with a saved snapshot. The current mode decides which
   * workspace goes live; the other is stashed. History restarts from the loaded state, so
   * undo can't reach back past the load.
   */
  loadProject(snapshot: ProjectSnapshot): void;
  /**
   * Run a smart-find search over the current shapes and highlight the matches in
   * accent blue (rooms washed, matched wall bands filled). Returns the match count.
   */
  runFind(query: string): number;
  /** Clear any active smart-find highlight. */
  clearFind(): void;
  /**
   * Facade mode: capture the current selection for an AI render — the selected shapes (clones) and the
   * count. The multi-pass renderer builds its own per-material reference images from these. Returns null
   * when nothing is selected.
   */
  captureSelectionShapes(): { shapes: Square[]; count: number } | null;
  /**
   * Replace the current selection with the given shape ids (Facade standardization: select every
   * panel of a type from the Analyze popup). Unknown ids are ignored; an empty list clears selection.
   */
  selectShapeIds(ids: string[]): void;
  /**
   * Facade mode: set the selected panel's assembly type — updates its `name` and its band (wall)
   * thickness from the type's default band, keeping its size. One undo step.
   */
  setSelectionAssembly(key: string): void;
  /** Facade mode: resize one panel's interior to the given feet, about its centre. One undo step. */
  setShapeSize(id: string, widthFt: number, heightFt: number): void;
  /**
   * Facade mode: set the uniform band (wall) thickness, in inches, on every panel of the given
   * assembly type — propagates a type-level mullion/joint change to all its panels. One undo step.
   */
  applyAssemblyBand(key: string, inches: number): void;
  /** Layers tool: add a fresh blank layer on top and make it active (the user draws its boundary). */
  addLayer(): void;
  /** Layers tool: select a layer by index. */
  selectLayer(index: number): void;
  /** Layers tool: split the referenced cell (in the active layer) into `cols × rows`. */
  splitCell(ref: CellRef, cols: number, rows: number): void;
  /** Layers tool: total visible panels + how many are UNIQUE shapes in the active layer (the Optimize metric). */
  partitionPanelStats(): { total: number; unique: number };
  /** Facade mode: the live engineering readouts for the active layer (drives the bottom statistics). */
  facadeMetrics(): FacadeMetrics;
  /** Layers tool: rationalize the active layer with the chosen strategy to reduce unique panels (one undo step). */
  optimizePartition(border: number, strategy: OptimizeStrategy): void;
  /**
   * Layers tool: begin an Edit-a-panel session on the currently selected panel group(s) — zoom to a
   * representative panel and auto-seed a uniform frame on the group. Returns the edited group keys, or null
   * when nothing is selected. The user then drags panel edges to set per-edge frame widths (mirrored to the
   * group); `endPanelFrameEdit` eases the camera back.
   */
  startPanelFrameEdit(clickRect?: Rect | null): { keys: string[] } | null;
  /** Layers tool: end the Edit-a-panel session and restore the prior camera. */
  endPanelFrameEdit(): void;
  /** Layers tool: assign a panel MATERIAL kind to the selected panel group(s) (null clears it). One undo step. */
  assignPanelKind(kind: PanelKind | null): void;
  /**
   * Begin a guided constraint-fix session: enumerate every violation, zoom to the
   * first offending room, and preview its proposed fix. Returns the first step (or a
   * done-summary if nothing is violated). Subsequent steps come from fixApprove/fixSkip.
   */
  fixStart(): FixResult;
  /** Apply the current step's proposed fix (one undo step), then advance. */
  fixApprove(): FixResult;
  /** Leave the current violation as-is and advance to the next. */
  fixSkip(): FixResult;
  /** End the session: clear the preview and ease the camera back to where it started. */
  fixCancel(): void;
  /* ---- Scripted-walkthrough primitives (the guided Demo) ---------------------------------------- */
  /**
   * Bounding box of the first trim border, or null when there is none.
   *
   * The tour needs this because a dropped border is sized in SCREEN pixels — its world extent depends on
   * the camera at the moment of the drop, so the script cannot know it in advance and has to read it back
   * before it can aim a drag at an edge or a corner.
   */
  demoBorderRect(): Rect | null;
  /**
   * World positions of the first border's lattice lines (outer edges included), or null before it is split.
   *
   * The tour drags REAL mullions, and a lattice carries per-line overrides the moment one is moved — so
   * every grab point after the first has to be read back rather than derived from the cols × rows.
   */
  demoGridLines(): { x: number[]; y: number[] } | null;
  /**
   * The rects of the panels currently selected — the live ones, not the lattice cells they came from.
   *
   * The lattice is a bounding box: on a cut elevation whole rows and columns of it exist only where the
   * boundary has not eaten them, so a point derived from the lattice can easily land where there is no
   * panel at all. Anything the tour has to AIM at (a mullion face, say) has to come from here instead.
   */
  demoSelectedPanelRects(): Rect[];
  /**
   * Every Plan-mode room as the tour needs to aim at one: its id, whether it is selected, whether it is
   * currently flagged for a constraint violation, and its interior and outer (wall) world bounds.
   *
   * The two rects are what make a Plan gesture aimable at all, because in Plan mode WHERE you click is
   * the whole operation: a press inside both rooms' interiors unites them, a press on one room's wall
   * band over the other's interior subtracts. Those two regions are one wall thickness apart, so the
   * tour has to measure the real geometry rather than predict it — a dropped room can be nudged off its
   * drop point by wall snapping on the way down, and every click after that would then miss.
   *
   * `corners` and `thickness` are what let it keep aiming after a room has been RESHAPED. A bounding box
   * describes a rectangle and nothing else: move one vertex and two of the walls run at an angle, so the
   * midpoint of a wall — and the band a thickness drag has to be inside — can only be found from the
   * polygon itself.
   */
  demoRoomRects(): {
    id: string;
    selected: boolean;
    flagged: boolean;
    inner: Rect;
    outer: Rect;
    /** Interior corners in world space; edge `i` runs from corner `i` to corner `i + 1`. */
    corners: { x: number; y: number }[];
    /** Each edge's wall thickness in world units, indexed like {@link corners}. */
    thickness: number[];
  }[];
  /** Select every panel overlapping a world rect (what a marquee sweep does). Returns how many. */
  selectPanelsInWorldRect(rect: Rect): number;
  /**
   * Ease the camera to frame a world rect. `padPx` is the screen margin; `fill` (0–1) then backs the zoom
   * off that best fit, so the subject sits in its surroundings instead of filling the viewport edge to
   * edge — which reads as being shoved into the shape rather than shown it.
   *
   * `insets` overrides that margin per side, and the rect is centred in what's LEFT — which is the only way
   * to frame around the fixed furniture. The floating panel bar hangs under the selection and the nav pill
   * owns the bottom of the screen, so a subject centred on the raw viewport pushes its own toolbar off it.
   */
  focusWorldRect(
    rect: Rect,
    opts?: {
      padPx?: number;
      fill?: number;
      insets?: { top?: number; right?: number; bottom?: number; left?: number };
      /** Land the camera THIS frame instead of easing. Used when a tour step is being skipped to its end. */
      instant?: boolean;
    },
  ): void;
  /**
   * Everything the canvas holds that a tour step can change, deep-copied.
   *
   * This is what makes stepping BACKWARDS in the tour instant: the walkthrough is cumulative, so returning
   * to an earlier step used to mean replaying every gesture from an empty canvas. Keeping the end state of
   * each step lets it be put back exactly, in one frame, with nothing re-enacted.
   */
  demoSnapshot(): DemoSnapshot;
  /** Put a {@link demoSnapshot} back, camera included, and repaint. */
  demoRestore(snap: DemoSnapshot): void;
  /**
   * Drop every selection — panels, borders, shapes — and close any panel-Edit session, leaving the drawing
   * itself untouched. What the tour ends on, so the last thing shown is the elevation rather than the
   * highlight of whatever the last gesture happened to sweep up.
   */
  demoDeselect(): void;
  /**
   * Clear the canvas (both workspaces' shapes and the facade partition) AND recentre the camera — the demo
   * starts from empty, at 100%, with the world origin in the middle of the viewport.
   *
   * The camera reset is not cosmetic. The cube drops a fixed SCREEN square, so the world size of everything
   * the tour builds is decided by the zoom at the moment of the drop; without this, replaying the tour from
   * a zoomed-in step would build a shape smaller each time and eventually need a zoom past MAX_SCALE to
   * frame it.
   */
  resetForDemo(): void;
  /** A world point in VIEWPORT coordinates, so an overlay can point at something on the canvas. */
  worldToClient(world: { x: number; y: number }): { x: number; y: number };
}

/** Screen-px gap between a panel's bottom edge and the floating menu hanging under it. */
const CELL_MENU_GAP = 8;

/** Default mullion width (inches) auto-seeded onto a group's frame when an Edit-a-panel session starts. */
const DEFAULT_PANEL_FRAME_IN = 2;

interface InfiniteCanvasProps {
  gridSize: number;
  /**
   * Plan-mode room constraints; rooms breaking a rule are flagged yellow. MODE-SCOPED: these are ignored
   * entirely in Facade mode — a curtain wall isn't judged on room areas — so they neither flag a facade
   * assembly nor clamp a drag there. {@link facadeConstraints} takes over instead.
   */
  constraints: Constraints;
  /**
   * Facade-mode constraints (panel sizes, WWR, U-value, standardization, cost). Active ONLY in Facade
   * mode, and only against the Layers-tool partition — the two rule sets are never both in force.
   */
  facadeConstraints?: FacadeConstraints;
  /** When on, draws dev overlays (green centre numbers, cyan overlap region). */
  debug?: boolean;
  /** When on (the Analyze view), every shape is ghosted — the dev overlays stay off. */
  analyze?: boolean;
  /**
   * When false, the yellow constraint-violation highlights are hidden on the canvas
   * (per-room flags + the global budget wash). Violations are still computed, so the
   * Constraints button's superscript count is unaffected. Defaults to true.
   */
  showConstraintHighlights?: boolean;
  /** Reports live canvas stats (count + areas) whenever they change. */
  onStatsChange?: (stats: CanvasStats) => void;
  /** Reports the selected-shape count whenever it changes (drives the Render button gate). */
  onSelectionChange?: (count: number) => void;
  /**
   * Facade mode: reports the single selected panel's live geometry + assembly (or null when zero /
   * several panels are selected, or in Plan mode) — drives the left assembly inspector and the
   * bidirectional size/band sync. Deduped on change, so it updates live during canvas drags.
   */
  onSelectedPanelChange?: (panel: SelectedPanelInfo | null) => void;
  /**
   * Client rect of the Library nav button (or null). While the selection is being
   * dragged over it, the drop is treated as "save to Library" rather than a move.
   */
  libraryDropRef?: MutableRefObject<DOMRect | null>;
  /** Client rect of the open Library popup (or null) — also a save drop-target. */
  libraryPopupDropRef?: MutableRefObject<DOMRect | null>;
  /** Fires true/false as a selection drag enters/leaves the Library button. */
  onLibraryHover?: (over: boolean) => void;
  /** Fires with the dragged shapes when they're dropped onto the Library button. */
  onLibraryDrop?: (shapes: Square[]) => void;
  /**
   * Fires when the smart-find highlight changes: a match count after a search, or
   * `null` when a canvas edit clears the highlight (so the App can drop its chip).
   */
  onFindChange?: (count: number | null) => void;
  /** Fires with the hovered room's catalog key (or null) — drives the dev matrix highlight. */
  onHoverRoomKey?: (key: string | null) => void;
  /**
   * Facade mode: a separate workspace. Switching it on/off swaps the canvas to that mode's own
   * shapes (so Facade starts empty / "cleared"), and a dropped default shape is named the default
   * facade assembly instead of "Room".
   */
  facade?: boolean;
  /**
   * Facade standardization view (the Analyze popup is open): panels are coloured by type, clicking a
   * panel selects every panel of that type, and {@link onPanelTypesChange} reports the live type list.
   */
  standardize?: boolean;
  /** Reports the standardized panel types whenever they change (drives the Analyze popup list). */
  onPanelTypesChange?: (types: PanelType[]) => void;
  /**
   * Facade Layers tool (uniform sticky-cell partition). When active, the canvas edits the layer stack and
   * HIDES the rooms. `onPartitionChange` reports the live layer/cell summary for the top-center navigator;
   * `onCellMenu` fires when a click over a cell should open (or close) that panel's floating menu.
   */
  layersActive?: boolean;
  /**
   * Live Assign-menu preview: while an option is hovered, the SELECTED panels render with that material
   * instead of their own. Render-only — nothing is committed until the option is clicked.
   */
  kindPreview?: { kind: PanelKind | null } | null;
  /**
   * Live Optimize-menu preview: render `border` as `strategy` would leave it. Render-only — the strategy is
   * committed only when the option is clicked.
   */
  optimizePreview?: { border: number; strategy: OptimizeStrategy } | null;
  /** Material-ID (segmentation) view: paint each cell a flat contrasting colour. */
  idView?: boolean;
  /** Purely-visual drop shadow under the per-group frame bands (depth only). */
  frameShadow?: boolean;
  /** Optimize overlay: paint each panel its shape-group number, centred (identical panels share a number). */
  panelNumbers?: boolean;
  /** Live split-menu preview: the cell `ref` being split into `cols × rows`, or null. The preview is computed
   *  from the actual resulting partition (lattice tiled + clipped to the boundary). */
  splitPreview?: { ref: CellRef; cols: number; rows: number } | null;
  onPartitionChange?: (summary: FacadeSummary) => void;
  /** Open (null = close) the floating menu for a panel. The cell REF is reported, not a screen point. */
  onCellMenu?: (
    info: { ref: CellRef; rect: Rect | null; subdivided: boolean; mode: PanelMode | null } | null,
  ) => void;
  /** The cell whose floating menu is open, so the canvas can keep publishing its live screen anchor. */
  menuCell?: CellRef | null;
  /**
   * Live screen anchor (client px) for the open panel menu: the BOTTOM CENTRE of the current panel
   * SELECTION — one panel's own rect, or the box enclosing several — so the bar sits under whatever is
   * selected. Re-published on every scene draw, so the menu rides along as the panels are dragged, panned,
   * or zoomed. Null once the selection and cell are both gone.
   */
  onCellMenuAnchorChange?: (anchor: { x: number; y: number } | null) => void;
  /** End the active Edit-a-panel session (a clean click outside the border / on another group acts as Done). */
  onExitFrameEdit?: () => void;
}

/** State for the floating dimension-editing input. */
interface DimEditorState {
  shapeId: string;
  which: 'width' | 'height' | 'name' | 'area' | 'wallLength' | 'wallThickness';
  /** For wall edits, which interior edge the value applies to. */
  edge?: number;
  /** Canvas-local screen position of the label centre. */
  x: number;
  y: number;
  /** Rotation (deg) so the input sits over the angled label. */
  angle: number;
  value: string;
}

function createId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sq_${Math.random().toString(36).slice(2)}`;
}

/** Deep-enough clone of one shape (geometry + walls + corners + per-edge walls). */
function cloneShape(s: Square): Square {
  return {
    ...s,
    walls: { ...s.walls },
    corners: s.corners?.map((p) => ({ ...p })),
    wallEdges: s.wallEdges?.slice(),
  };
}

/** Axis-aligned world bounds of a polygon ring (a footprint from {@link footprintWorld}). */
function polyBounds(pts: { x: number; y: number }[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Deep-enough clone of the shapes for an immutable history snapshot. */
function cloneShapes(shapes: Square[]): Square[] {
  return shapes.map(cloneShape);
}

/** Snapshot clone of the footprints (flat rects, so a shallow copy each). */
function cloneFootprints(footprints: Footprint[]): Footprint[] {
  return footprints.map((f) => ({ ...f }));
}

/**
 * Render-only clone of `s` scaled by `f` (0..1) toward `pivot` (world centre of the
 * dragged group) — drives the shrink-into-Library animation. Geometry and walls all
 * scale together so the room collapses proportionally toward the button; never
 * committed (the real shape keeps its size).
 */
function shrinkShapeToward(s: Square, pivot: { x: number; y: number }, f: number): Square {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const ncx = pivot.x + (cx - pivot.x) * f;
  const ncy = pivot.y + (cy - pivot.y) * f;
  const w = s.width * f;
  const h = s.height * f;
  return {
    ...s,
    x: ncx - w / 2,
    y: ncy - h / 2,
    width: w,
    height: h,
    walls: { n: s.walls.n * f, e: s.walls.e * f, s: s.walls.s * f, w: s.walls.w * f },
    corners: s.corners?.map((p) => ({ x: p.x * f, y: p.y * f })),
    wallEdges: s.wallEdges?.map((t) => t * f),
  };
}

/** Copy a clone's geometry back onto a live shape — reverts a rejected edit. */
function restoreShape(target: Square, src: Square): void {
  target.x = src.x;
  target.y = src.y;
  target.width = src.width;
  target.height = src.height;
  target.walls = src.walls;
  target.corners = src.corners;
  target.wallEdges = src.wallEdges;
}

/** Cap on undo depth, to bound memory. */
const MAX_HISTORY = 200;

/** One undo/redo step: the shapes, building footprints, the active unit, and the facade partition doc. */
interface Snapshot {
  shapes: Square[];
  footprints: Footprint[];
  unit: LengthUnit;
  partition: FacadeDoc;
}

const LOW_LATENCY: CanvasRenderingContext2DSettings = { desynchronized: true };

/**
 * Full-viewport canvas that renders the CPlane grid and placed squares.
 *
 * Performance design:
 *  - Two stacked canvases: an opaque grid layer (static during shape edits) and
 *    a transparent scene layer for squares + handles. Per-layer dirty flags mean
 *    dragging/placing a square redraws ONLY the scene — the grid is untouched.
 *  - Low-latency, alpha-tuned contexts ({ desynchronized: true }; grid is also
 *    alpha:false) to cut input-to-photon latency and compositing cost.
 *  - All interaction mutates refs and coalesces to one draw per animation frame;
 *    React only re-renders on viewport resize — the one time backing stores are
 *    re-sized. Device pixel ratio is capped to bound fill cost on HiDPI screens.
 */
export const InfiniteCanvas = forwardRef<CanvasHandle, InfiniteCanvasProps>(
  function InfiniteCanvas(
    {
      gridSize,
      constraints,
      facadeConstraints,
      debug,
      analyze,
      facade,
      showConstraintHighlights = true,
      onStatsChange,
      onSelectionChange,
      onSelectedPanelChange,
      libraryDropRef,
      libraryPopupDropRef,
      onLibraryHover,
      onLibraryDrop,
      onFindChange,
      onHoverRoomKey,
      standardize,
      onPanelTypesChange,
      layersActive,
      idView,
      frameShadow,
      panelNumbers,
      splitPreview,
      kindPreview,
      optimizePreview,
      onPartitionChange,
      onCellMenu,
      menuCell,
      onCellMenuAnchorChange,
      onExitFrameEdit,
    },
    ref,
  ) {
    const gridCanvasRef = useRef<HTMLCanvasElement>(null);
    const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
    const gridCtxRef = useRef<CanvasRenderingContext2D | null>(null);
    const sceneCtxRef = useRef<CanvasRenderingContext2D | null>(null);
    // Cached scene-canvas rect; refreshed on resize so placement does no layout
    // reads on the hot path.
    const rectRef = useRef<DOMRect | null>(null);

    const { width, height } = useWindowSize();

    // Fix the CPlane's size once, from the viewport at mount, so the square
    // covers the screen on load yet stays a stable finite plane afterwards.
    const extentCells = useMemo(
      () => computeGridExtentCells(window.innerWidth, window.innerHeight, gridSize),
      [gridSize],
    );

    // Scene state — kept in refs so interaction never re-renders React.
    const shapesRef = useRef<Square[]>([]);
    // Building footprints (white slab + black outline) drawn BEHIND every room.
    // Drawn by the Generate tool menu's square tool; resizable via their own
    // Length/Width dimension labels.
    const footprintsRef = useRef<Footprint[]>([]);
    // True once the square footprint tool is armed (the next canvas drag draws one).
    const footprintArmRef = useRef(false);
    // The footprint currently being drag-drawn (live preview), or null.
    const footprintDraftRef = useRef<Footprint | null>(null);
    // Shrink-into-Library animation: while a selection drag hovers the Library
    // button the selected shapes ease from scale 1 down to `target` (and back to 1
    // on leave), signalling they're being stored. Render-only — never committed.
    const libraryShrinkRef = useRef({ scale: 1, target: 1, pivot: { x: 0, y: 0 } });
    // Smart-find highlight: rooms matched by a search (washed blue) and the matched
    // wall sides per shape (filled blue). Empty when no find is active. Render-only.
    const highlightRef = useRef<{ roomIds: Set<string>; wallMap: Map<string, HandleId[]> }>({
      roomIds: new Set(),
      wallMap: new Map(),
    });
    // Guided constraint-fix session state. `current` holds the violation under review
    // and its proposal; `skipped` excludes left-alone violations from re-enumeration.
    const fixSessionRef = useRef<{
      skipped: Set<string>;
      priorCamera: { x: number; y: number; scale: number };
      fixedCount: number;
      skippedCount: number;
      current: { violation: Violation; proposal: Proposal } | null;
    } | null>(null);
    // Translucent ghost of the proposed fix for the room under review (render-only).
    const fixPreviewRef = useRef<{ shapeId: string; ghost: Square } | null>(null);
    // Edit-a-panel session: the selected panel keys being framed, the representative cell rect (camera focus
    // + edge hit-testing), and the live hovered/dragged frame side. No camera is stored — Edit zooms IN and
    // leaves the view there; ending the session doesn't pull the camera back out from under the user.
    const frameEditRef = useRef<{
      keys: string[];
      rect: Rect;
      hoverSide: 'n' | 'e' | 's' | 'w' | 'b' | null;
      allSides: boolean;
    } | null>(null);
    // In-flight camera-ease rAF id (focus / restore), so a new focus cancels the old.
    const cameraTweenRef = useRef(0);
    // Active wall-alignment guide lines during a move drag (green); null when none.
    const alignGuidesRef = useRef<AlignGuide[] | null>(null);
    // Per-axis wall-snap lock for the in-progress single-room placement preview.
    const placeSnapStateRef = useRef(emptySnapState());
    // Last stats key reported to React, so the StatsBar signal fires only when a
    // displayed value actually changes (not every frame).
    const lastStatsKeyRef = useRef('');
    // Last reported selection count, so onSelectionChange only fires on an actual change.
    const lastSelCountRef = useRef(-1);
    // Last reported single-selected facade panel key, so onSelectedPanelChange only fires on a change.
    // Sentinel '\0' means "never reported"; '' means "null reported".
    const lastSelPanelKeyRef = useRef<string>('\0');
    const selectionRef = useRef<Set<string>>(new Set());
    // Order shapes were selected in (oldest first), kept in sync with the
    // selection each frame. Groundwork for boolean ops (e.g. difference = first
    // selected minus the rest); cleared automatically when selection empties.
    const selectionOrderRef = useRef<string[]>([]);
    // Active region of the selection: a handle id highlights just that wall
    // edge; null (with a selection) highlights the white infill instead.
    const activeEdgeRef = useRef<HandleId | null>(null);
    // Which face of the active edge the pointer is nearer (glows magenta), or
    // null when not hovering it.
    const edgeHoverRef = useRef<EdgeFace | null>(null);
    // Shift held over that face → light ALL inner/outer faces (stretch the whole
    // boundary at once).
    const edgeFaceAllRef = useRef(false);
    // True once an edge has been ARMED by a clean click (press + release, no drag),
    // gating the per-edge wall length/thickness dimensions. A fresh stretch that
    // begins on an un-armed edge never summons them; a clean click does, and they
    // persist (incl. through a subsequent stretch of that armed edge).
    const wallDimsArmedRef = useRef(false);
    // Shape + region the pointer is over, for the hover-preview darkening.
    const hoverRef = useRef<{ id: string; region: HoverRegion } | null>(null);
    // Cursor in canvas-local screen px (null off-canvas / mid-drag), so a shared
    // overlap edge can highlight yellow on hover when both rooms are selected.
    const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
    // Shape whose centre name/area readout is being hovered (single selection),
    // so the editable box can be drawn around it.
    const centerHoverRef = useRef<string | null>(null);
    // Edge-plus button hovered/dragged ({shape id, direction 0=n/1=e/2=s/3=w, copy
    // count}), so the scene can ghost the translucent duplicate(s) it would drop.
    const edgePlusHoverRef = useRef<{ id: string; dir: number; count: number } | null>(null);
    // Active next-room prediction fan: which opened shape + edge arrow is being
    // dragged, the hovered option (0..2), and whether the drag has begun (the fan
    // only appears once dragging, not on a bare press).
    const predictionDragRef = useRef<{
      shapeId: string;
      dir: number;
      hovered: number | null;
      dragging: boolean;
      options: (PredictionOption | null)[];
    } | null>(null);
    // True while an edge stretch is dragging, so dimensions stay live.
    const resizingRef = useRef(false);
    // While rotating: shape id + grabbed corner, for the live angle readout.
    const rotatingRef = useRef<{ id: string; corner: HandleId } | null>(null);
    // Website-wide measurement unit (default feet); switched by typing a unit
    // keyword into any dimension editor.
    const unitRef = useRef<LengthUnit>('feet');
    const marqueeRef = useRef<Marquee | null>(null);
    const placementRef = useRef<PendingPlacement | null>(null);

    // Undo/redo as snapshots of the shapes array AND the active unit. `baseline`
    // mirrors the current committed state; `commitHistory` (called after every
    // mutation) pushes the prior baseline onto `undo`. Adding a new undoable
    // action is just a matter of calling commitHistory() once the change applies.
    const historyRef = useRef<{ undo: Snapshot[]; redo: Snapshot[]; baseline: Snapshot }>({
      undo: [],
      redo: [],
      baseline: { shapes: [], footprints: [], unit: 'feet', partition: newDoc() },
    });

    // In-app clipboard for copy/cut/paste. `pasteSeq` cascades repeated pastes
    // so they don't stack exactly on top of each other.
    const clipboardRef = useRef<Square[]>([]);
    const pasteSeqRef = useRef(0);
    // The Layers tool's own clipboard: whole trim borders (outline + lattice + panels), so the same
    // copy/cut/paste keys work on facade borders the way they do on rooms. Kept separate from the room
    // clipboard so switching tools never pastes the wrong kind of thing.
    const borderClipboardRef = useRef<BorderSnapshot[]>([]);
    const borderPasteSeqRef = useRef(0);

    // ---- Frame scheduler (per-layer dirty flags, one rAF) ------------------
    // Latest constraints, read by the scene draw (a ref so the imperative render
    // loop sees updates without this component re-rendering on every frame).
    const constraintsRef = useRef<Constraints>(constraints);
    // The Facade-mode rule set, same deal. Only ever non-empty while Facade mode is active.
    const facadeConstraintsRef = useRef<FacadeConstraints>(EMPTY_FACADE_CONSTRAINTS);
    // Cell keys of the panels the facade rules currently flag — handed to drawPartition each frame.
    const facadeFlaggedCellsRef = useRef<Set<string>>(new Set());
    // Debug-overlay flag (green centre numbers + cyan overlap), read by the draw.
    const debugRef = useRef(debug);
    // Analyze view: ghost every shape (no dev overlays), read by the scene draw.
    const analyzeRef = useRef(analyze);
    // Facade mode flag, read by createSquareAtWorld + the right-click handler.
    const facadeRef = useRef(facade);
    // Facade Layers tool (uniform sticky-cell partition): active flag, the layer-stack document, the live
    // boundary-draw preview rect, and a key to dedupe summary reports.
    const layersActiveRef = useRef(layersActive);
    // The border the user has double-clicked INTO (null = shape level). Outside it a border is an object
    // to select and drag; inside it the pointer edits that border's panels.
    const partitionEnteredRef = useRef<number | null>(null);
    // Hovered Assign option (render-only material preview on the selection), read by the scene draw.
    const kindPreviewRef = useRef<{ kind: PanelKind | null } | null>(kindPreview ?? null);
    // Hovered Optimize option (render-only repanelization preview), read by the scene draw.
    const optimizePreviewRef = useRef<{ border: number; strategy: OptimizeStrategy } | null>(
      optimizePreview ?? null,
    );
    // Live edge-plus duplicate preview on a border (ghost copies under the cursor); null when idle.
    const partitionPlusRef = useRef<{
      border: number;
      dx: number;
      dy: number;
      count: number;
    } | null>(null);
    const partitionDocRef = useRef<FacadeDoc>(newDoc());
    const partitionSelSegRef = useRef<SegmentRef | null>(null);
    // Selected panels, as per-CELL keys (see `cellKey`). Clicking a panel expands its whole material group
    // into this set; a rubber-band sweep adds only the cells it covered. Group-level operations (assign
    // material, Edit-a-panel) map back with `groupKeysOfCells`.
    const partitionCellSelRef = useRef<Set<string>>(new Set());
    // Borders picked (shift-click, Border mode) for a boolean unite/difference op, in selection order.
    const partitionBorderSelRef = useRef<Set<number>>(new Set());
    const idViewRef = useRef(idView);
    const frameShadowRef = useRef(frameShadow);
    const panelNumbersRef = useRef(panelNumbers);
    const splitPreviewRef = useRef(splitPreview);
    // The cell whose floating menu is open, plus the last anchor published for it (rounded to whole px so
    // an idle frame never re-fires). Read by the scene draw, which is what keeps the menu glued to the panel.
    const menuCellRef = useRef<CellRef | null>(menuCell ?? null);
    const lastMenuAnchorRef = useRef<string>('\0');
    const lastPartitionKeyRef = useRef('');
    // Standardization view (Analyze popup open): colour panels by type + type-group click-select.
    const standardizeRef = useRef(standardize);
    // Live shape-id → type colour map for the standardization view (rebuilt each frame when active).
    const panelColorsRef = useRef<Map<string, string> | null>(null);
    // Change key for the reported panel-type list, so onPanelTypesChange only fires on a real change.
    const lastPanelTypesKeyRef = useRef('');
    // Plan and Facade are separate workspaces: each keeps its own shapes + footprints, stashed here
    // while the other mode is active (null = never visited → starts empty / "cleared"). prevFacadeRef
    // tracks the last mode so the swap effect knows which slot to stash into.
    const workspaceStashRef = useRef<{
      plan: { shapes: Square[]; footprints: Footprint[] } | null;
      facade: { shapes: Square[]; footprints: Footprint[] } | null;
    }>({ plan: null, facade: null });
    const prevFacadeRef = useRef(!!facade);
    // When false, the canvas skips drawing the yellow constraint-violation highlights
    // (the Constraints "Visibility" eye toggles this). Violations are still computed.
    const showViolationsRef = useRef(showConstraintHighlights);

    const frameRef = useRef(0);
    const dirtyGridRef = useRef(false);
    const dirtySceneRef = useRef(false);
    const drawGridRef = useRef<() => void>(() => {});
    const drawSceneRef = useRef<() => void>(() => {});

    const requestDraw = useCallback((layer: DrawLayer = 'all') => {
      if (layer !== 'scene') dirtyGridRef.current = true;
      if (layer !== 'grid') dirtySceneRef.current = true;
      if (frameRef.current) return; // a frame is already queued
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        const drawGridNow = dirtyGridRef.current;
        const drawSceneNow = dirtySceneRef.current;
        dirtyGridRef.current = false;
        dirtySceneRef.current = false;
        const start = import.meta.env.DEV ? performance.now() : 0;
        if (drawGridNow) drawGridRef.current();
        if (drawSceneNow) drawSceneRef.current();
        if (import.meta.env.DEV) perfMonitor.recordDraw(performance.now() - start);
      });
    }, []);

    const requestAll = useCallback(() => requestDraw('all'), [requestDraw]);

    // A new/changed constraint set re-flags every shape on the next frame.
    //
    // MODE SCOPING happens here, once, rather than at each of the half-dozen call sites downstream: in
    // Facade mode the room rules are swapped for an EMPTY set, so every consumer that reads this ref — the
    // per-room violation flags, the drag clamp in `worsensConstraints`, the global budget wash, the fix
    // wand — goes quiet together. There is no path by which a Plan rule can act on a facade.
    useEffect(() => {
      constraintsRef.current = facade ? EMPTY_CONSTRAINTS : constraints;
      requestDraw('scene');
    }, [constraints, facade, requestDraw]);

    // ...and the mirror image: the facade rules apply only in Facade mode.
    useEffect(() => {
      facadeConstraintsRef.current = facade
        ? facadeConstraints ?? EMPTY_FACADE_CONSTRAINTS
        : EMPTY_FACADE_CONSTRAINTS;
      requestDraw('scene');
    }, [facadeConstraints, facade, requestDraw]);

    // Toggling Debug shows/hides the dev overlays on the next frame.
    useEffect(() => {
      debugRef.current = debug;
      requestDraw('scene');
    }, [debug, requestDraw]);

    // Toggling Analyze ghosts/un-ghosts the shapes on the next frame.
    useEffect(() => {
      analyzeRef.current = analyze;
      requestDraw('scene');
    }, [analyze, requestDraw]);

    // Entering/leaving the standardization view recolours the panels on the next frame. Reset the
    // report key so the type list is (re)emitted on entry even if the grouping is unchanged.
    useEffect(() => {
      standardizeRef.current = standardize;
      lastPanelTypesKeyRef.current = '';
      if (!standardize) {
        panelColorsRef.current = null;
        onPanelTypesChange?.([]);
      }
      requestDraw('scene');
    }, [standardize, onPanelTypesChange, requestDraw]);

    // Switching Plan ⇄ Facade swaps to that mode's own workspace: stash the outgoing shapes,
    // restore the incoming ones (empty the first time, so Facade starts cleared). Undo history is
    // reset to the restored workspace (no cross-mode undo). Both layers repaint synchronously so
    // the swap is on screen the moment it happens, and the redraw re-emits stats.
    useEffect(() => {
      facadeRef.current = facade;
      const isFacade = !!facade;
      if (prevFacadeRef.current === isFacade) return; // not a mode change
      const stash = workspaceStashRef.current;
      const outgoing = {
        shapes: cloneShapes(shapesRef.current),
        footprints: cloneFootprints(footprintsRef.current),
      };
      if (prevFacadeRef.current) stash.facade = outgoing;
      else stash.plan = outgoing;
      const incoming = isFacade ? stash.facade : stash.plan;
      shapesRef.current = incoming ? cloneShapes(incoming.shapes) : [];
      footprintsRef.current = incoming ? cloneFootprints(incoming.footprints) : [];
      selectionRef.current = new Set();
      activeEdgeRef.current = null;
      placementRef.current = null;
      historyRef.current = {
        undo: [],
        redo: [],
        baseline: {
          shapes: cloneShapes(shapesRef.current),
          footprints: cloneFootprints(footprintsRef.current),
          unit: unitRef.current,
          partition: clonePartitionDoc(partitionDocRef.current),
        },
      };
      prevFacadeRef.current = isFacade;
      // These dedupe the React-side reports against the LAST workspace's values. The
      // incoming workspace can coincidentally match (both modes empty, both one shape
      // selected), which would swallow the report and leave the panels describing the
      // workspace we just left. Reset them so the redraw below re-emits unconditionally.
      lastStatsKeyRef.current = '';
      lastSelCountRef.current = -1;
      lastSelPanelKeyRef.current = '\0';
      lastPanelTypesKeyRef.current = '';
      lastPartitionKeyRef.current = '';
      // Repaint NOW, not on the next queued frame. requestDraw only sets dirty flags when a
      // frame is already in flight, and the swapped-in workspace has to be on screen the
      // instant the mode flips — otherwise the canvas keeps showing the mode we just left
      // (which reads as "Facade is empty") until some unrelated interaction forces a redraw.
      dirtyGridRef.current = false;
      dirtySceneRef.current = false;
      drawGridRef.current();
      drawSceneRef.current();
    }, [facade]);

    // Toggling the Constraints "Visibility" eye shows/hides the yellow violation
    // highlights on the next frame (the count/superscript is unaffected).
    useEffect(() => {
      showViolationsRef.current = showConstraintHighlights;
      requestDraw('scene');
    }, [showConstraintHighlights, requestDraw]);

    const { cameraRef, reset: resetCamera } = useCamera(sceneCanvasRef, requestAll);

    // Entering/leaving the Layers tool just toggles the flag and redraws — the user draws the boundary
    // (no auto-seed). 'all' so the grid layer redraws too: it hides while the tool is on, restores when off.
    useEffect(() => {
      layersActiveRef.current = layersActive;
      requestDraw('all');
    }, [layersActive, requestDraw]);

    // Toggling the Material-ID view just repaints the partition scene.
    useEffect(() => {
      idViewRef.current = idView;
      requestDraw('scene');
    }, [idView, requestDraw]);

    // Toggling the frame drop shadow just repaints the partition scene.
    useEffect(() => {
      frameShadowRef.current = frameShadow;
      requestDraw('scene');
    }, [frameShadow, requestDraw]);

    // Showing/hiding the Optimize paint-by-number overlay just repaints the partition scene.
    useEffect(() => {
      panelNumbersRef.current = panelNumbers;
      requestDraw('scene');
    }, [panelNumbers, requestDraw]);

    // Hovering an Assign option repaints the selection in that material (and un-hovering restores it).
    useEffect(() => {
      kindPreviewRef.current = kindPreview ?? null;
      requestDraw('scene');
    }, [kindPreview, requestDraw]);

    // Hovering an Optimize option repanelizes that border for the preview only.
    useEffect(() => {
      optimizePreviewRef.current = optimizePreview ?? null;
      requestDraw('scene');
    }, [optimizePreview, requestDraw]);

    // Opening/closing the panel menu: reset the dedupe key so the next draw publishes the anchor even if
    // it lands on the exact pixel the previous menu did, then draw to publish it right away.
    useEffect(() => {
      menuCellRef.current = menuCell ?? null;
      lastMenuAnchorRef.current = '\0';
      requestDraw('scene');
    }, [menuCell, requestDraw]);

    // Live split-menu preview: repaint whenever the previewed cell / counts change.
    useEffect(() => {
      splitPreviewRef.current = splitPreview;
      requestDraw('scene');
    }, [splitPreview, requestDraw]);

    // Snapshot the current shapes as one undo step (call after a mutation).
    const commitHistory = useCallback(() => {
      const h = historyRef.current;
      h.undo.push(h.baseline);
      if (h.undo.length > MAX_HISTORY) h.undo.shift();
      h.baseline = {
        shapes: cloneShapes(shapesRef.current),
        footprints: cloneFootprints(footprintsRef.current),
        unit: unitRef.current,
        partition: clonePartitionDoc(partitionDocRef.current),
      };
      h.redo.length = 0;
    }, []);

    // Commit a square centred on a world point, select it, and redraw the scene.
    const createSquareAtWorld = useCallback(
      (worldX: number, worldY: number, worldSize?: number, name?: string) => {
        const size = worldSize ?? DEFAULT_SQUARE_SCREEN_SIZE / cameraRef.current.scale;
        const finalName = name ?? (facadeRef.current ? DEFAULT_FACADE_ASSEMBLY : 'Room');
        // In Facade mode a dropped panel takes its assembly type's default proportions + band (mullion
        // / joint) thickness, so the default shape reflects the chosen facade classification.
        let width = size;
        let height = size;
        let walls = defaultWalls();
        if (facadeRef.current) {
          const def = facadeType(finalName);
          width = feetToWorld(def.defaultWidthFt);
          height = feetToWorld(def.defaultHeightFt);
          const bandWorld = inchesToWorld(bandInchesFor(def.defaultMeta, finalName));
          walls = { n: bandWorld, e: bandWorld, s: bandWorld, w: bandWorld };
        }
        const square: Square = {
          id: createId(),
          x: worldX - width / 2,
          y: worldY - height / 2,
          width,
          height,
          rotation: 0,
          walls,
          dots: false,
          name: finalName,
        };
        shapesRef.current.push(square);
        selectionRef.current = new Set([square.id]);
        activeEdgeRef.current = null;
        commitHistory();
        requestDraw('scene');
      },
      [cameraRef, commitHistory, requestDraw],
    );

    // Drop fresh, re-id'd copies of a (origin-centred) cluster's shapes with their
    // centre on a world point; select them as one undo step. Retains every shape's
    // orientation, size, walls and other properties.
    const createClusterAtWorld = useCallback(
      (shapes: Square[], worldX: number, worldY: number) => {
        const ids: string[] = [];
        for (const s of shapes) {
          const copy = cloneShape(s);
          copy.id = createId();
          copy.x += worldX;
          copy.y += worldY;
          shapesRef.current.push(copy);
          ids.push(copy.id);
        }
        if (ids.length === 0) return;
        selectionRef.current = new Set(ids);
        activeEdgeRef.current = null;
        commitHistory();
        requestDraw('scene');
      },
      [commitHistory, requestDraw],
    );

    // Place the armed preview at a canvas-local screen point: a saved cluster drops
    // its whole arrangement; otherwise a single default/room square.
    const commitPlacement = useCallback(
      (sx: number, sy: number) => {
        const pending = placementRef.current;
        placementRef.current = null;
        // Drop the placement's snap guides + lock state once it's committed.
        alignGuidesRef.current = null;
        placeSnapStateRef.current = emptySnapState();
        if (pending?.clusterShapes) {
          const world = screenToWorld(sx, sy, cameraRef.current);
          createClusterAtWorld(pending.clusterShapes, world.x, world.y);
          return;
        }
        // Facade Layers tool active → the cube places a TRIM BORDER (not a room): a default 12'×12' quad
        // centred on the cursor that the shared lattice clips against. The first border seeds the lattice;
        // later ones are appended.
        if (layersActiveRef.current) {
          const world = screenToWorld(sx, sy, cameraRef.current);
          const size = pending?.worldSize ?? DEFAULT_SQUARE_SCREEN_SIZE / cameraRef.current.scale;
          const rect: Rect = { x: world.x - size / 2, y: world.y - size / 2, w: size, h: size };
          const layer = partitionActiveLayer(partitionDocRef.current);
          placePartitionBorder(layer, rect);
          // Select what was just dropped, the way a placed room is. `placeBorder` seeds the first border
          // and appends the rest, so the new one is always last. Without this the shape lands with no
          // handles, dimensions, or + buttons until it is clicked a second time — the drop and the
          // selection were two steps for what reads as one action.
          partitionBorderSelRef.current = new Set([Math.max(0, layer.borders.length - 1)]);
          // A fresh border has no panels to be inside of, and nothing selected in it.
          partitionEnteredRef.current = null;
          partitionCellSelRef.current = new Set();
          onCellMenu?.(null);
          commitHistory();
          requestDraw('scene');
          return;
        }
        // Single rooms land on their wall-snapped centre (set by the draw layer) when
        // snapping was engaged; otherwise on the plain cursor world point.
        const world = pending?.snapCenter ?? screenToWorld(sx, sy, cameraRef.current);
        createSquareAtWorld(world.x, world.y, pending?.worldSize, pending?.name);
      },
      [cameraRef, createSquareAtWorld, createClusterAtWorld, commitHistory, requestDraw, onCellMenu],
    );

    // ---- Inline dimension editor -------------------------------------------
    // An <input> floats over a clicked dimension label; typing a value resizes
    // the shape's interior. `editorRef` mirrors the state so commit reads the
    // latest value without putting side effects in a state updater.
    const [editor, setEditor] = useState<DimEditorState | null>(null);
    const editorRef = useRef<DimEditorState | null>(null);
    const dimInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
      editorRef.current = editor;
    }, [editor]);
    // Focus + select when a NEW editor opens (keyed on shape/which so typing,
    // which only changes the value, doesn't re-select on every keystroke).
    useEffect(() => {
      if (editor && dimInputRef.current) {
        dimInputRef.current.focus();
        dimInputRef.current.select();
      }
    }, [editor?.shapeId, editor?.which]);

    const beginDimensionEdit = useCallback((shapeId: string, hit: DimensionLabelHit) => {
      setEditor({
        shapeId,
        which: hit.which,
        x: hit.sx,
        y: hit.sy,
        angle: hit.angleDeg,
        value: hit.text.match(/-?\d*\.?\d+/)?.[0] ?? hit.text, // the bare number
      });
    }, []);

    // Click a centre readout to edit it: the room title (free text) or the square
    // footage (a number that auto-resizes the shape). Always upright (angle 0).
    const beginCenterEdit = useCallback((shapeId: string, hit: CenterLabelHit) => {
      // Facade panels are typed from the inspector dropdown, not by free-typing the on-canvas title.
      if (facadeRef.current && hit.which === 'name') return;
      setEditor({
        shapeId,
        which: hit.which,
        x: hit.sx,
        y: hit.sy,
        angle: 0,
        value: hit.which === 'name' ? hit.text : hit.text.match(/-?\d*\.?\d+/)?.[0] ?? hit.text,
      });
    }, []);

    // Click a wall (edge) dimension label to edit it: the edge's length or its wall
    // thickness. Carries the edge index so commit knows which wall to change.
    const beginWallDimensionEdit = useCallback((shapeId: string, hit: WallDimensionLabelHit) => {
      setEditor({
        shapeId,
        which: hit.which,
        edge: hit.edge,
        x: hit.sx,
        y: hit.sy,
        angle: hit.angleDeg,
        value: hit.text.match(/-?\d*\.?\d+/)?.[0] ?? hit.text, // the bare number
      });
    }, []);

    const commitDimension = useCallback(() => {
      const ed = editorRef.current;
      setEditor(null);
      if (!ed) return;

      // Facade trim border width/height: scale the border about its centre to the typed value (in the active
      // unit). The shared lattice stays anchored, so resizing just reveals more/fewer cells — like an edge drag.
      if (ed.shapeId.startsWith('__border__')) {
        const idx = parseInt(ed.shapeId.slice('__border__'.length), 10);
        const layer = partitionActiveLayer(partitionDocRef.current);
        const poly = layer.borders[idx];
        if (poly && (ed.which === 'width' || ed.which === 'height')) {
          const want = parseFloat(ed.value);
          if (Number.isFinite(want) && want > 0) {
            const world = Math.max(1, want * worldUnitsPerUnit(unitRef.current));
            // Typing a size reshapes the border, which moves its cells — carry their frames and
            // materials across, exactly as the drag gestures do.
            moveLatticePreservingFrames(layer, () =>
              resizeBorderExtent(poly, ed.which === 'width' ? 'x' : 'y', world),
            );
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Building footprint width/height: resize about the centre to the typed value
      // (read in the active unit). No walls or constraints — it's just the slab.
      const fp = footprintsRef.current.find((f) => f.id === ed.shapeId);
      if (fp) {
        if (ed.which === 'width' || ed.which === 'height') {
          const want = parseFloat(ed.value);
          if (Number.isFinite(want) && want > 0) {
            const world = Math.max(1, want * worldUnitsPerUnit(unitRef.current));
            if (ed.which === 'width') {
              const cx = fp.x + fp.width / 2;
              fp.width = world;
              fp.x = cx - world / 2;
            } else {
              const cy = fp.y + fp.height / 2;
              fp.height = world;
              fp.y = cy - world / 2;
            }
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      const target = shapesRef.current.find((s) => s.id === ed.shapeId);

      // Wall thickness: set just this edge's wall to the typed value (inches in feet
      // mode, mirroring the label), floored at the hard minimum. A value that would
      // create/worsen a constraint violation is rejected (geometry reverts).
      if (ed.which === 'wallThickness') {
        const want = parseFloat(ed.value);
        if (target && ed.edge != null && Number.isFinite(want) && want > 0) {
          const world =
            unitRef.current === 'feet'
              ? (want / 12) * WORLD_UNITS_PER_FOOT // typed inches → world
              : want * worldUnitsPerUnit(unitRef.current);
          const orig = cloneShape(target);
          const next = withEdgeThickness(target, ed.edge, Math.max(MIN_WALL_WORLD, world));
          target.walls = next.walls;
          target.wallEdges = next.wallEdges;
          if (worsensConstraints(target, orig, constraintsRef.current)) {
            restoreShape(target, orig);
          } else {
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Wall length: set this edge's interior length to the typed value. For a
      // rectangle this maps to width (n/s edges) or height (e/w edges) about the
      // centre; for a reshaped quad/N-gon, the edge is scaled about its midpoint
      // (both endpoints move) and the shape re-centres. Violations revert.
      if (ed.which === 'wallLength') {
        const want = parseFloat(ed.value);
        if (target && ed.edge != null && Number.isFinite(want) && want > 0) {
          const world = Math.max(1, want * worldUnitsPerUnit(unitRef.current));
          const orig = cloneShape(target);
          let changed = false;
          if (!target.corners) {
            const horizontal = ed.edge % 2 === 0; // edges 0 (n) / 2 (s) run horizontally
            if (horizontal && world !== target.width) {
              const cx = target.x + target.width / 2;
              target.width = world;
              target.x = cx - world / 2;
              changed = true;
            } else if (!horizontal && world !== target.height) {
              const cy = target.y + target.height / 2;
              target.height = world;
              target.y = cy - world / 2;
              changed = true;
            }
          } else {
            const pts = target.corners;
            const nC = pts.length;
            const a = pts[ed.edge];
            const b = pts[(ed.edge + 1) % nC];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const cur = Math.hypot(dx, dy);
            if (cur > 1e-6 && Math.abs(world - cur) > 1e-6) {
              const ux = dx / cur;
              const uy = dy / cur;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              pts[ed.edge] = { x: mx - ux * (world / 2), y: my - uy * (world / 2) };
              pts[(ed.edge + 1) % nC] = { x: mx + ux * (world / 2), y: my + uy * (world / 2) };
              const r = recenterCorners(target);
              target.corners = r.corners;
              target.width = r.width;
              target.height = r.height;
              target.x = r.x;
              target.y = r.y;
              changed = true;
            }
          }
          if (changed && worsensConstraints(target, orig, constraintsRef.current)) {
            restoreShape(target, orig);
            changed = false;
          }
          if (changed) {
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Room title: free text (empty falls back to "Room").
      if (ed.which === 'name') {
        if (target) {
          const name = ed.value.trim() || 'Room';
          if (name !== (target.name ?? 'Room')) {
            target.name = name;
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Square footage: scale the whole shape about its centre so its area hits
      // the typed value (linear factor = √(target / current area)).
      if (ed.which === 'area') {
        const want = parseFloat(ed.value);
        if (target && Number.isFinite(want) && want > 0) {
          const current = shapeAreaInUnit(target, unitRef.current);
          if (current > 0 && Math.abs(want - current) > 1e-6) {
            const orig = cloneShape(target);
            const f = Math.sqrt(want / current);
            const wcx = target.x + target.width / 2;
            const wcy = target.y + target.height / 2;
            if (target.corners) {
              target.corners = target.corners.map((p) => ({ x: p.x * f, y: p.y * f }));
            }
            target.width *= f;
            target.height *= f;
            target.x = wcx - target.width / 2;
            target.y = wcy - target.height / 2;
            // Hard lock: a typed value that would create/worsen a violation is
            // rejected (geometry reverts); compliant values apply normally.
            if (worsensConstraints(target, orig, constraintsRef.current)) {
              restoreShape(target, orig);
            } else {
              commitHistory();
              requestDraw('scene');
            }
          }
        }
        return;
      }

      // A typed unit keyword switches the whole site's units. Letters only (digits
      // and punctuation stripped); a prime/apostrophe also means feet.
      const raw = ed.value.trim().toLowerCase();
      const word = raw.replace(/[\d.,\s'′"-]/g, '');
      const cmWords = ['cm', 'cms', 'centimeter', 'centimeters', 'centimetre', 'centimetres'];
      const meterWords = ['m', 'meter', 'meters', 'metre', 'metres', 'mtr', 'mtrs'];
      const feetWords = ['ft', 'feet', 'foot', 'f'];
      let unitChanged = false;
      let nextUnit: LengthUnit | null = null;
      if (raw.includes("'") || raw.includes('′') || feetWords.includes(word)) nextUnit = 'feet';
      else if (cmWords.includes(word)) nextUnit = 'centimeters';
      else if (meterWords.includes(word)) nextUnit = 'meters';
      if (nextUnit && nextUnit !== unitRef.current) {
        unitRef.current = nextUnit;
        unitChanged = true;
      }

      // Resize only when a positive number was typed; a bare keyword (e.g. "m")
      // just switches units. The number is read in the now-active unit.
      const value = parseFloat(raw);
      const shape = shapesRef.current.find((s) => s.id === ed.shapeId);
      let resized = false;
      if (shape && Number.isFinite(value) && value > 0) {
        const orig = cloneShape(shape);
        const world = Math.max(1, value * worldUnitsPerUnit(unitRef.current));
        if (shape.corners) {
          // Reshaped quad: edit its tight bounding-box dimension. Scale the
          // corners along that axis so the box hits the typed size, then rebuild
          // the symmetric extents (width/height) keeping the world centre fixed.
          const bb = boundingBoxLocal(shape);
          const before = ed.which === 'width' ? bb.maxX - bb.minX : bb.maxY - bb.minY;
          if (world !== before && before > 0) {
            const s = world / before;
            shape.corners = shape.corners.map((p) => ({
              x: ed.which === 'width' ? p.x * s : p.x,
              y: ed.which === 'height' ? p.y * s : p.y,
            }));
            let mx = 0;
            let my = 0;
            for (const p of shape.corners) {
              mx = Math.max(mx, Math.abs(p.x));
              my = Math.max(my, Math.abs(p.y));
            }
            const wcx = shape.x + shape.width / 2;
            const wcy = shape.y + shape.height / 2;
            shape.width = mx * 2;
            shape.height = my * 2;
            shape.x = wcx - shape.width / 2;
            shape.y = wcy - shape.height / 2;
            resized = true;
          }
        } else {
          // Rectangle: resize the interior about the centre (keeps rotation natural).
          const before = ed.which === 'width' ? shape.width : shape.height;
          if (world !== before) {
            if (ed.which === 'width') {
              const cx = shape.x + shape.width / 2;
              shape.width = world;
              shape.x = cx - world / 2;
            } else {
              const cy = shape.y + shape.height / 2;
              shape.height = world;
              shape.y = cy - world / 2;
            }
            resized = true;
          }
        }
        // Hard lock: revert a typed dimension that would create/worsen a violation.
        if (resized && worsensConstraints(shape, orig, constraintsRef.current)) {
          restoreShape(shape, orig);
          resized = false;
        }
      }

      // A unit switch is itself undoable, so commit when either the geometry or
      // the unit changed (a single step captures both at once).
      if (resized || unitChanged) {
        commitHistory();
        requestDraw('scene');
      }
    }, [commitHistory, requestDraw]);

    // ---- Undo / redo --------------------------------------------------------
    const applySnapshot = useCallback(
      (snapshot: Snapshot) => {
        shapesRef.current = cloneShapes(snapshot.shapes);
        footprintsRef.current = cloneFootprints(snapshot.footprints);
        footprintDraftRef.current = null;
        unitRef.current = snapshot.unit;
        // Restore the facade partition (deep clone so the stored snapshot stays immutable) and clear its
        // transient drag/selection state; reset the dedupe key so the layer navigator re-syncs.
        partitionDocRef.current = clonePartitionDoc(snapshot.partition);
        partitionSelSegRef.current = null;
        partitionCellSelRef.current = new Set();
        partitionEnteredRef.current = null; // border indices are snapshot-relative
        lastPartitionKeyRef.current = '';
        // Drop selection/transient highlights that may reference removed shapes.
        const ids = new Set(shapesRef.current.map((s) => s.id));
        selectionRef.current = new Set([...selectionRef.current].filter((id) => ids.has(id)));
        activeEdgeRef.current = null;
        edgeHoverRef.current = null;
        hoverRef.current = null;
        resizingRef.current = false;
        setEditor(null);
        requestDraw('scene');
      },
      [requestDraw],
    );

    const undo = useCallback(() => {
      const h = historyRef.current;
      if (h.undo.length === 0) return;
      h.redo.push(h.baseline);
      h.baseline = h.undo.pop() as Snapshot;
      applySnapshot(h.baseline);
    }, [applySnapshot]);

    const redo = useCallback(() => {
      const h = historyRef.current;
      if (h.redo.length === 0) return;
      h.undo.push(h.baseline);
      h.baseline = h.redo.pop() as Snapshot;
      applySnapshot(h.baseline);
    }, [applySnapshot]);

    // ---- Copy / cut / paste -------------------------------------------------
    // In the Layers tool the "shapes" are trim BORDERS, so the same four shortcuts act on the selected
    // border(s) — outline, lattice anchor, and panel grid travelling together — instead of on rooms.
    const copySelection = useCallback(() => {
      if (layersActiveRef.current) {
        const sel = partitionBorderSelRef.current;
        if (sel.size === 0) return;
        borderClipboardRef.current = copyBorders(partitionActiveLayer(partitionDocRef.current), sel);
        borderPasteSeqRef.current = 0;
        return;
      }
      const sel = selectionRef.current;
      if (sel.size === 0) return;
      clipboardRef.current = cloneShapes(shapesRef.current.filter((s) => sel.has(s.id)));
      pasteSeqRef.current = 0;
    }, []);

    const cutSelection = useCallback(() => {
      if (layersActiveRef.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        const sel = partitionBorderSelRef.current;
        if (sel.size === 0) return;
        borderClipboardRef.current = copyBorders(layer, sel);
        borderPasteSeqRef.current = 0;
        removeBorders(layer, sel);
        partitionBorderSelRef.current = new Set();
        partitionCellSelRef.current = new Set(); // cell keys are positional — the removed cells are gone
        partitionEnteredRef.current = null; // the shape that was entered is gone
        lastPartitionKeyRef.current = '';
        commitHistory();
        requestDraw('scene');
        return;
      }
      const sel = selectionRef.current;
      if (sel.size === 0) return;
      clipboardRef.current = cloneShapes(shapesRef.current.filter((s) => sel.has(s.id)));
      pasteSeqRef.current = 0;
      shapesRef.current = shapesRef.current.filter((s) => !sel.has(s.id));
      selectionRef.current = new Set();
      activeEdgeRef.current = null;
      commitHistory();
      requestDraw('scene');
    }, [commitHistory, requestDraw]);

    // Remove the selected shapes outright (no clipboard write), e.g. via Delete /
    // Backspace. A no-op when nothing is selected. In the Layers tool it deletes the
    // selected trim border(s) instead, panels and all.
    const deleteSelection = useCallback(() => {
      if (layersActiveRef.current) {
        const bsel = partitionBorderSelRef.current;
        if (bsel.size === 0) return;
        removeBorders(partitionActiveLayer(partitionDocRef.current), bsel);
        partitionBorderSelRef.current = new Set();
        partitionCellSelRef.current = new Set();
        partitionEnteredRef.current = null; // the shape that was entered is gone
        lastPartitionKeyRef.current = '';
        commitHistory();
        requestDraw('scene');
        return;
      }
      const sel = selectionRef.current;
      if (sel.size === 0) return;
      shapesRef.current = shapesRef.current.filter((s) => !sel.has(s.id));
      selectionRef.current = new Set();
      activeEdgeRef.current = null;
      commitHistory();
      requestDraw('scene');
    }, [commitHistory, requestDraw]);

    const pasteClipboard = useCallback(() => {
      if (layersActiveRef.current) {
        const clip = borderClipboardRef.current;
        if (clip.length === 0) return;
        const layer = partitionActiveLayer(partitionDocRef.current);
        // Cascade successive pastes by the same constant on-screen offset rooms use.
        const seq = (borderPasteSeqRef.current += 1);
        const offset = (16 / cameraRef.current.scale) * seq;
        const added = pasteBorders(layer, clip, offset, offset);
        partitionBorderSelRef.current = new Set(added);
        lastPartitionKeyRef.current = '';
        commitHistory();
        requestDraw('scene');
        return;
      }
      const clip = clipboardRef.current;
      if (clip.length === 0) return;
      // Cascade each successive paste by a constant on-screen offset.
      const seq = (pasteSeqRef.current += 1);
      const offset = (16 / cameraRef.current.scale) * seq;
      const copies = clip.map((s) => ({
        ...s,
        walls: { ...s.walls },
        corners: s.corners?.map((p) => ({ ...p })),
        id: createId(),
        x: s.x + offset,
        y: s.y + offset,
      }));
      for (const c of copies) shapesRef.current.push(c);
      selectionRef.current = new Set(copies.map((c) => c.id));
      activeEdgeRef.current = null;
      commitHistory();
      requestDraw('scene');
    }, [cameraRef, commitHistory, requestDraw]);

    // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo. Ignored while typing
    // in the dimension editor so its own text undo keeps working.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
          return;
        }
        // Delete / Backspace removes the current selection (no modifier needed).
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          deleteSelection();
          return;
        }
        if (!(e.ctrlKey || e.metaKey)) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          redo();
        } else if (key === 'c') {
          e.preventDefault();
          copySelection();
        } else if (key === 'x') {
          e.preventDefault();
          cutSelection();
        } else if (key === 'v') {
          e.preventDefault();
          pasteClipboard();
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo, copySelection, cutSelection, pasteClipboard, deleteSelection]);

    // Clear any active smart-find highlight — like pressing Esc. The interaction hook
    // calls this only when a room is actually EDITED (stretch, vertex move, wall
    // stretch, rotate); navigation (click, pan, zoom) and plain moves keep it.
    // Render-only + idempotent, so calling it per drag-frame is cheap.
    const clearFindHighlight = useCallback(() => {
      const h = highlightRef.current;
      if (h.roomIds.size === 0 && h.wallMap.size === 0) return;
      highlightRef.current = { roomIds: new Set(), wallMap: new Map() };
      requestDraw('scene');
      onFindChange?.(null);
    }, [requestDraw, onFindChange]);

    useCanvasInteractions({
      canvasRef: sceneCanvasRef,
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
    });

    // ---- Render layers -----------------------------------------------------
    const drawGridLayer = useCallback(() => {
      const ctx = gridCtxRef.current;
      if (!ctx) return;
      // One CPlane for both modes: the same faint scale/alignment reference on a white composing surface,
      // so switching Plan ⇄ Facade doesn't shift the canvas out from under the drawing.
      drawGrid({
        ctx,
        width,
        height,
        camera: cameraRef.current,
        gridSize,
        extentCells,
        theme: GRID_THEME,
      });
    }, [width, height, gridSize, extentCells, cameraRef]);

    const drawSceneLayer = useCallback(() => {
      const shapes = shapesRef.current;

      // Flag rooms that break a global constraint (yellow). Only computed when at
      // least one rule is set; otherwise skipped. The map has one entry per flagged
      // room, so its size is the StatsBar's "Constraint Flags" count.
      let violations: Map<string, ShapeViolations> | undefined;
      const activeConstraints = constraintsRef.current;
      // Union the per-room rules broken anywhere on the canvas (e.g. one room too
      // small, another with too-thin a wall) so the Constraints box can highlight
      // each offending line. Global budgets are added below from their breach flags.
      const violatedKeySet = new Set<string>();
      if (hasAnyConstraint(activeConstraints)) {
        violations = new Map<string, ShapeViolations>();
        for (const s of shapes) {
          const v = findViolations(s, activeConstraints);
          if (v.any) {
            violations.set(s.id, v);
            for (const k of v.flaggedKeys) violatedKeySet.add(k);
          }
        }
      }

      // Facade mode enforces its OWN vocabulary against the partition instead: panel sizes flag individual
      // panels, and the whole-elevation rules (WWR, U-value, standardization, counts, cost) breach globally.
      // `activeConstraints` is already empty here — the two sets never overlap — so this is the only rule
      // check running. The global figures come from the same `facadeMetrics` the StatsBar shows, so a flag
      // and its readout can never disagree.
      const facadeRules = facadeConstraintsRef.current;
      let facadeViolations = NO_FACADE_VIOLATIONS;
      // Gated on the Layers tool: panels only exist while it's on, so this skips the per-cell walk
      // entirely the rest of the time rather than measuring an empty partition every frame.
      if (layersActiveRef.current && hasAnyFacadeConstraint(facadeRules)) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        facadeViolations = findFacadeViolations(
          layer,
          facadeMetricsOf(layer, worldUnitsPerUnit('feet')),
          facadeRules,
        );
        for (const k of facadeViolations.flaggedKeys) violatedKeySet.add(k);
      }
      facadeFlaggedCellsRef.current = facadeViolations.flaggedCells;

      // Surface live stats to React (deduped on the displayed integers) — placement,
      // delete, paste, edits, and undo/redo all flow through a scene redraw, so this
      // catches them all. Areas are always in ft² regardless of the display unit.
      let total = 0; // GIA — Σ interior
      let gross = 0; // GFA — Σ interior + walls
      let usable = 0; // UFA — Σ interior of usable rooms only
      for (const s of shapes) {
        const interior = shapeAreaInUnit(s, 'feet');
        total += interior;
        gross += shapeGrossAreaInUnit(s, 'feet');
        if (isUsableFloorArea(s.name)) usable += interior;
      }
      const roomCount = shapes.length;
      // One counter, whichever mode is live: flagged rooms in Plan, flagged panels in Facade.
      const constraintFlags = (violations?.size ?? 0) + facadeViolations.flaggedCount;
      const totalAreaSqft = Math.round(total);
      const grossAreaSqft = Math.round(gross);
      const usableAreaSqft = Math.round(usable);
      // Global Max Total / Max Total Gross Area: compare the live sums (not the
      // rounded readouts) to each budget. Flag-only — never clamps a drag; deleting
      // rooms clears them.
      const maxTotal = activeConstraints.maxTotalAreaSqft;
      const maxGross = activeConstraints.maxTotalGrossAreaSqft;
      const maxRooms = activeConstraints.maxRoomCount;
      const totalAreaExceeded = maxTotal != null && total > maxTotal + 1e-6;
      const grossAreaExceeded = maxGross != null && gross > maxGross + 1e-6;
      const roomCountExceeded = maxRooms != null && roomCount > maxRooms;
      // Fold the breached global budgets into the violated-key set, then emit a
      // stable, sorted list so the Constraints box highlights every broken rule.
      if (totalAreaExceeded) violatedKeySet.add('maxTotalAreaSqft');
      if (grossAreaExceeded) violatedKeySet.add('maxTotalGrossAreaSqft');
      if (roomCountExceeded) violatedKeySet.add('maxRoomCount');
      const facadeGlobalExceeded = facadeViolations.globalBreached;
      const violatedKeys = [...violatedKeySet].sort();
      const key = `${roomCount}|${constraintFlags}|${totalAreaSqft}|${grossAreaSqft}|${usableAreaSqft}|${totalAreaExceeded}|${grossAreaExceeded}|${roomCountExceeded}|${facadeGlobalExceeded}|${violatedKeys.join(',')}`;
      if (key !== lastStatsKeyRef.current) {
        lastStatsKeyRef.current = key;
        onStatsChange?.({
          roomCount,
          constraintFlags,
          totalAreaSqft,
          grossAreaSqft,
          usableAreaSqft,
          facadeGlobalExceeded,
          totalAreaExceeded,
          grossAreaExceeded,
          roomCountExceeded,
          violatedKeys,
        });
      }

      // Report selection-count changes (drives the Render button's enabled state).
      const selCount = selectionRef.current.size;
      if (selCount !== lastSelCountRef.current) {
        lastSelCountRef.current = selCount;
        onSelectionChange?.(selCount);
      }

      // Report the single-selected facade panel's live geometry + assembly (drives the left inspector
      // and the bidirectional size/band sync). Null unless Facade mode with exactly one panel selected.
      // Deduped on a serialized key, so it fires live during drags but not every idle frame.
      const selPanelShape =
        facadeRef.current && selCount === 1
          ? shapes.find((s) => selectionRef.current.has(s.id))
          : undefined;
      let selPanel: SelectedPanelInfo | null = null;
      if (selPanelShape) {
        selPanel = {
          id: selPanelShape.id,
          assembly: selPanelShape.name ?? DEFAULT_FACADE_ASSEMBLY,
          widthFt: selPanelShape.width / WORLD_UNITS_PER_FOOT,
          heightFt: selPanelShape.height / WORLD_UNITS_PER_FOOT,
          bandIn: worldToInches(selPanelShape.walls.n),
        };
      }
      const selPanelKey = selPanel
        ? `${selPanel.id}|${selPanel.assembly}|${selPanel.widthFt.toFixed(3)}|${selPanel.heightFt.toFixed(3)}|${selPanel.bandIn.toFixed(3)}`
        : '';
      if (selPanelKey !== lastSelPanelKeyRef.current) {
        lastSelPanelKeyRef.current = selPanelKey;
        onSelectedPanelChange?.(selPanel);
      }

      // Standardization view (Analyze popup): bucket the panels into types, keep a colour map for
      // the draw below, and report the type summary to React (deduped on signatures + counts).
      if (standardizeRef.current) {
        const { types, colorByShapeId } = computePanelTypes(shapes);
        panelColorsRef.current = colorByShapeId;
        const typesKey = types.map((t) => `${t.signature}:${t.count}`).join('|');
        if (typesKey !== lastPanelTypesKeyRef.current) {
          lastPanelTypesKeyRef.current = typesKey;
          onPanelTypesChange?.(types);
        }
      }

      const ctx = sceneCtxRef.current;
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);

      // Layers tool: draw the sticky-cell layer stack and HIDE the rooms entirely. Report the summary
      // (deduped) so the top-center layer navigator shows live layer/cell counts.
      if (layersActiveRef.current) {
        // Edit-a-panel highlight: the representative cell outline + the hovered side's frame strip.
        const fe = frameEditRef.current;
        const feFrame = fe ? panelFrameAt(partitionActiveLayer(partitionDocRef.current), fe.keys[0]) : null;
        // Live boolean preview: classify the cursor over two picked, overlapping borders so the union "+" grid
        // / subtract hatch follows it (only meaningful in Border mode with exactly two borders picked).
        let boolHover = null as ReturnType<typeof borderBooleanHoverAt> | null;
        if (partitionBorderSelRef.current.size === 2 && hoverPointRef.current) {
          const cam = cameraRef.current;
          const w = screenToWorld(hoverPointRef.current.x, hoverPointRef.current.y, cam);
          boolHover = borderBooleanHoverAt(
            partitionActiveLayer(partitionDocRef.current),
            partitionBorderSelRef.current,
            w,
            8 / cam.scale,
          );
        }
        drawPartition(ctx, partitionDocRef.current, cameraRef.current, {
          selectedSegment: partitionSelSegRef.current,
          selectedCells: partitionCellSelRef.current,
          enteredBorder: partitionEnteredRef.current,
          plusPreview: partitionPlusRef.current,
          // The Constraints "Visibility" eye hides the yellow flags in Facade mode too.
          flaggedCells: showViolationsRef.current ? facadeFlaggedCellsRef.current : undefined,
          kindPreview: kindPreviewRef.current,
          optimizePreview: optimizePreviewRef.current,
          idView: idViewRef.current,
          frameShadow: frameShadowRef.current,
          selectedBorders: partitionBorderSelRef.current,
          boolHover,
          unit: unitRef.current,
          showPanelNumbers: panelNumbersRef.current,
          frameEdit:
            fe && feFrame
              ? {
                  // Every selected panel, so each reads as grabbable — any one drives the whole set.
                  rects: cellRectsOf(partitionActiveLayer(partitionDocRef.current), new Set(fe.keys)),
                  frame: feFrame,
                  hoverSide: fe.hoverSide,
                  all: fe.allSides,
                }
              : null,
          splitPreview: splitPreviewRef.current,
        });
        // Line-snap alignment guides (green), reusing the wall-snap guide renderer.
        if (alignGuidesRef.current) {
          drawAlignmentGuides(ctx, alignGuidesRef.current, cameraRef.current, width, height);
        }
        // Drag multi-select rectangle — shows the area whose panel groups the selection will hit.
        // (The Layers branch returns below, so this must be drawn here, not in the shared overlay pass.)
        const partitionMarquee = marqueeRef.current;
        if (partitionMarquee) {
          drawMarquee(ctx, partitionMarquee, MARQUEE_FILL, MARQUEE_STROKE);
        }
        // Border placement preview: a cursor-following ghost of the to-be-dropped trim quad, styled like the
        // committed border (blue edge + 4 white corner dots, no wall thickness).
        const borderPlace = placementRef.current;
        if (borderPlace && !borderPlace.clusterShapes) {
          const cam = cameraRef.current;
          const px = (borderPlace.worldSize ? borderPlace.worldSize * cam.scale : DEFAULT_SQUARE_SCREEN_SIZE);
          const cx = borderPlace.sx;
          const cy = borderPlace.sy;
          const left = cx - px / 2;
          const top = cy - px / 2;
          ctx.save();
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2;
          ctx.strokeRect(left, top, px, px);
          for (const [dx, dy] of [
            [left, top],
            [left + px, top],
            [left + px, top + px],
            [left, top + px],
          ]) {
            ctx.beginPath();
            ctx.arc(dx, dy, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#2563eb';
            ctx.stroke();
          }
          ctx.restore();
        }
        // Republish the open menu's anchor from its cell's CURRENT geometry. Doing it here — inside the
        // draw that already runs for every drag, pan, and zoom frame — is what makes the menu follow the
        // panel. Deduped on whole pixels, so an idle or unrelated frame costs one comparison.
        if (menuCellRef.current) {
          const menuLayer = partitionActiveLayer(partitionDocRef.current);
          // Anchor to the SELECTION, not the clicked cell: one panel gives its own rect, several give the
          // box enclosing them, so the bar hangs off the bottom centre of whatever is selected. Border mode
          // selects boundaries rather than panels, so it falls back to those; the clicked cell is the last
          // resort, covering the instant before a selection lands.
          const menuRect =
            selectedCellsExtent(menuLayer, partitionCellSelRef.current) ??
            selectedBordersExtent(menuLayer, partitionBorderSelRef.current) ??
            partitionCellRefRect(menuLayer, menuCellRef.current);
          const canvasRect = rectRef.current;
          let anchorKey = '';
          let anchor: { x: number; y: number } | null = null;
          if (menuRect && canvasRect) {
            const mid = worldToScreen(
              menuRect.x + menuRect.w / 2,
              menuRect.y + menuRect.h,
              cameraRef.current,
            );
            anchor = {
              x: Math.round(canvasRect.left + mid.x),
              y: Math.round(canvasRect.top + mid.y + CELL_MENU_GAP),
            };
            anchorKey = `${anchor.x},${anchor.y}`;
          }
          if (anchorKey !== lastMenuAnchorRef.current) {
            lastMenuAnchorRef.current = anchorKey;
            onCellMenuAnchorChange?.(anchor);
          }
        }
        const summary = summarizeDoc(partitionDocRef.current, partitionBorderSelRef.current);
        const key = `${summary.layerCount}|${summary.activeIndex}|${summary.drawing}|${summary.cellCount}|${summary.borderSelCount}|${summary.borderSelCanBoolean}`;
        if (key !== lastPartitionKeyRef.current) {
          lastPartitionKeyRef.current = key;
          onPartitionChange?.(summary);
        }
        return;
      }

      // Building footprints first, so rooms and their dimensions render on top. The
      // live drag-draft (if any) is drawn alongside the committed ones.
      if (footprintsRef.current.length > 0) {
        drawFootprints(ctx, footprintsRef.current, cameraRef.current, unitRef.current);
      }
      if (footprintDraftRef.current) {
        drawFootprints(ctx, [footprintDraftRef.current], cameraRef.current, unitRef.current);
      }

      // Keep the selection-order list in sync with the live selection: drop
      // deselected ids, append newly selected ones (Set preserves pick order),
      // and clear entirely once nothing is selected (no lingering memory).
      const sel = selectionRef.current;
      const order = selectionOrderRef.current;
      for (let i = order.length - 1; i >= 0; i--) {
        if (!sel.has(order[i])) order.splice(i, 1);
      }
      for (const id of sel) if (!order.includes(id)) order.push(id);

      // Translucent ghost(s) of the to-be-dropped duplicate(s) while an edge-plus is
      // hovered (one ghost) or dragged (one per copy, sequential in that direction).
      let duplicatePreviews: Square[] | undefined;
      const ph = edgePlusHoverRef.current;
      if (ph) {
        const src = shapesRef.current.find((s) => s.id === ph.id);
        if (src) {
          const { dx, dy } = adjacentCopyOffset(src, ph.dir);
          duplicatePreviews = [];
          for (let i = 1; i <= ph.count; i++) {
            duplicatePreviews.push({ ...cloneShape(src), x: src.x + dx * i, y: src.y + dy * i });
          }
        }
      }

      // Placement preview: the default/room square being dragged onto the canvas is
      // shown with the SAME translucent ghost styling as the edge-plus duplicate
      // previews (walls + white infill + outline), so the two read identically.
      const pendingPlace = placementRef.current;
      if (pendingPlace && !pendingPlace.clusterShapes) {
        const cam = cameraRef.current;
        const cursor = screenToWorld(pendingPlace.sx, pendingPlace.sy, cam);
        const size = pendingPlace.worldSize ?? DEFAULT_SQUARE_SCREEN_SIZE / cam.scale;
        // An origin-centred ghost gives the snap helper the room's wall lines; the
        // cursor world is the "free" centre. resolveWallSnap returns the (possibly
        // snapped) centre, with green guides + breakout, against all existing rooms.
        const ghostBase: Square = {
          id: '__placement__',
          x: -size / 2,
          y: -size / 2,
          width: size,
          height: size,
          rotation: 0,
          walls: defaultWalls(),
          dots: false,
          name: pendingPlace.name ?? (facadeRef.current ? DEFAULT_FACADE_ASSEMBLY : 'Room'),
        };
        const snapped = resolveWallSnap(
          [ghostBase],
          shapesRef.current,
          cursor.x,
          cursor.y,
          cam.scale,
          placeSnapStateRef.current,
        );
        alignGuidesRef.current = snapped.guides.length > 0 ? snapped.guides : null;
        pendingPlace.snapCenter = { x: snapped.dx, y: snapped.dy };
        const ghost: Square = {
          ...ghostBase,
          x: snapped.dx - size / 2,
          y: snapped.dy - size / 2,
        };
        duplicatePreviews = duplicatePreviews ? [...duplicatePreviews, ghost] : [ghost];
      }

      // Constraint-fix preview: the proposed corrected room, drawn as the same
      // translucent ghost over the (still yellow-flagged) original for a before/after read.
      const fixGhost = fixPreviewRef.current?.ghost;
      if (fixGhost) {
        duplicatePreviews = duplicatePreviews ? [...duplicatePreviews, fixGhost] : [fixGhost];
      }

      // Ease the Library shrink animation; while shrinking, render a copy where the
      // selected shapes collapse toward their group centre (real shapes untouched).
      const ls = libraryShrinkRef.current;
      if (Math.abs(ls.scale - ls.target) > 0.001) {
        ls.scale += (ls.target - ls.scale) * 0.25;
        if (Math.abs(ls.scale - ls.target) <= 0.001) ls.scale = ls.target;
        requestDraw('scene'); // keep the animation going until it settles
      }
      let renderShapes = shapesRef.current;
      if (ls.scale < 0.999 && selectionRef.current.size > 0) {
        // Collapse toward the mouse pointer (tracked during the drag), so the shapes
        // appear to be pulled into the cursor as it hovers the Library button.
        const pivot = ls.pivot;
        renderShapes = shapesRef.current.map((s) =>
          selectionRef.current.has(s.id) ? shrinkShapeToward(s, pivot, ls.scale) : s,
        );
      }

      drawShapes({
        ctx,
        shapes: renderShapes,
        camera: cameraRef.current,
        selectedIds: selectionRef.current,
        selectionOrder: selectionOrderRef.current,
        hoverPoint: hoverPointRef.current,
        centerHoverId: centerHoverRef.current,
        activeHandle: activeEdgeRef.current,
        activeEdgeFace: edgeHoverRef.current,
        activeEdgeFaceAll: edgeFaceAllRef.current,
        wallDimsArmed: wallDimsArmedRef.current,
        hoverId: hoverRef.current?.id ?? null,
        hoverRegion: hoverRef.current?.region ?? null,
        resizing: resizingRef.current,
        rotating: rotatingRef.current,
        unit: unitRef.current,
        width,
        height,
        theme: SHAPE_THEME,
        // Hidden when the Constraints "Visibility" eye is off — the violations are still
        // computed above (for the count/superscript), just not drawn yellow on the canvas.
        violations: showViolationsRef.current ? violations : undefined,
        debug: debugRef.current,
        ghosted: debugRef.current || analyzeRef.current,
        facade: facadeRef.current,
        duplicatePreviews,
        predictionDrag: predictionDragRef.current?.dragging ? predictionDragRef.current : undefined,
        highlightIds: highlightRef.current.roomIds,
        highlightWalls: highlightRef.current.wallMap,
        panelColors: standardizeRef.current ? panelColorsRef.current ?? undefined : undefined,
      });
      // A saved Library cluster still uses its own multi-shape preview; the single
      // square's ghost is drawn above via `duplicatePreviews`.
      const pending = placementRef.current;
      if (pending?.clusterShapes) {
        drawClusterPreview(
          ctx,
          pending.clusterShapes,
          pending.sx,
          pending.sy,
          cameraRef.current,
          SHAPE_THEME,
        );
      }
      const marquee = marqueeRef.current;
      if (marquee) {
        drawMarquee(ctx, marquee, MARQUEE_FILL, MARQUEE_STROKE);
      }

      // Wall-alignment guides (green) — shown while a move drag is snapped to an axis.
      if (alignGuidesRef.current) {
        drawAlignmentGuides(ctx, alignGuidesRef.current, cameraRef.current, width, height);
      }
    }, [
      width,
      height,
      cameraRef,
      onStatsChange,
      onSelectionChange,
      onSelectedPanelChange,
      onPanelTypesChange,
      onPartitionChange,
      onCellMenuAnchorChange,
      requestDraw,
    ]);

    useEffect(() => {
      drawGridRef.current = drawGridLayer;
    }, [drawGridLayer]);
    useEffect(() => {
      drawSceneRef.current = drawSceneLayer;
    }, [drawSceneLayer]);

    // ---- Backing-store sizing (the ONLY place canvases are resized) --------
    useEffect(() => {
      const gridCanvas = gridCanvasRef.current;
      const sceneCanvas = sceneCanvasRef.current;
      if (!gridCanvas || !sceneCanvas) return;

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      const pxWidth = Math.floor(width * dpr);
      const pxHeight = Math.floor(height * dpr);

      gridCanvas.width = pxWidth;
      gridCanvas.height = pxHeight;
      sceneCanvas.width = pxWidth;
      sceneCanvas.height = pxHeight;

      const gridCtx = gridCanvas.getContext('2d', { ...LOW_LATENCY, alpha: false });
      const sceneCtx = sceneCanvas.getContext('2d', LOW_LATENCY);
      if (!gridCtx || !sceneCtx) return;
      gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gridCtxRef.current = gridCtx;
      sceneCtxRef.current = sceneCtx;
      rectRef.current = sceneCanvas.getBoundingClientRect();

      drawGridLayer();
      drawSceneLayer();
    }, [width, height, drawGridLayer, drawSceneLayer]);

    useEffect(() => {
      return () => {
        if (frameRef.current) {
          cancelAnimationFrame(frameRef.current);
          // Reset the guard too: otherwise a cancelled frame leaves frameRef set,
          // and every later requestDraw bails at `if (frameRef.current) return`,
          // freezing the scene. (Surfaces under StrictMode's mount→cleanup→remount.)
          frameRef.current = 0;
        }
      };
    }, []);

    // ---- Constraint-fix helpers (camera focus + session stepping) ----------

    // Ease the camera {x, y, scale} to a target over ~250ms (easeInOutQuad),
    // cancelling any in-flight tween. Both focusing a room and restoring the view use it.
    const tweenCameraTo = useCallback(
      (target: { x: number; y: number; scale: number }) => {
        if (cameraTweenRef.current) cancelAnimationFrame(cameraTweenRef.current);
        const cam = cameraRef.current;
        const from = { x: cam.x, y: cam.y, scale: cam.scale };
        const t0 = performance.now();
        const DUR = 250;
        const tick = () => {
          const raw = Math.min(1, (performance.now() - t0) / DUR);
          const e = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2;
          cam.x = from.x + (target.x - from.x) * e;
          cam.y = from.y + (target.y - from.y) * e;
          cam.scale = from.scale + (target.scale - from.scale) * e;
          requestDraw('all');
          cameraTweenRef.current = raw < 1 ? requestAnimationFrame(tick) : 0;
        };
        cameraTweenRef.current = requestAnimationFrame(tick);
      },
      [cameraRef, requestDraw],
    );

    // Centre + zoom the camera so `shape` (its interior AABB, world space) fits the
    // viewport with `padPx` margin, capped so a tiny room doesn't zoom absurdly.
    const focusShape = useCallback(
      (shape: Square, padPx = 140) => {
        const rect = rectRef.current;
        if (!rect) return;
        const bb = boundingBoxLocal(shape); // centre-origin local frame
        const cx = shape.x + shape.width / 2;
        const cy = shape.y + shape.height / 2;
        const rad = (shape.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [lx, ly] of [
          [bb.minX, bb.minY],
          [bb.maxX, bb.minY],
          [bb.maxX, bb.maxY],
          [bb.minX, bb.maxY],
        ]) {
          const wx = cx + lx * cos - ly * sin;
          const wy = cy + lx * sin + ly * cos;
          minX = Math.min(minX, wx);
          minY = Math.min(minY, wy);
          maxX = Math.max(maxX, wx);
          maxY = Math.max(maxY, wy);
        }
        const aabbW = Math.max(maxX - minX, 1);
        const aabbH = Math.max(maxY - minY, 1);
        const scale = Math.min(
          (rect.width - 2 * padPx) / aabbW,
          (rect.height - 2 * padPx) / aabbH,
          4, // never zoom past 4 CSS px / world unit
        );
        const ccx = (minX + maxX) / 2;
        const ccy = (minY + maxY) / 2;
        tweenCameraTo({ x: rect.width / 2 - ccx * scale, y: rect.height / 2 - ccy * scale, scale });
      },
      [tweenCameraTo],
    );

    // Pick the next non-skipped violation, focus its room, preview its proposed fix,
    // and return the step descriptor (or a done-summary when none remain).
    const advanceFix = useCallback((): FixResult => {
      const session = fixSessionRef.current;
      if (!session) return { done: true, fixedCount: 0, unresolved: 0, globalNotes: [] };
      const c = constraintsRef.current;
      const next = enumerateViolations(shapesRef.current, c).find(
        (v) => !session.skipped.has(violationKey(v)),
      );
      if (!next) {
        // Nothing left to review — clear the ghost and report the summary. "unresolved"
        // is the genuine remaining violation count (skipped fixable + any still-broken).
        session.current = null;
        fixPreviewRef.current = null;
        requestDraw('scene');
        return {
          done: true,
          fixedCount: session.fixedCount,
          unresolved: enumerateViolations(shapesRef.current, c).length,
          globalNotes: globalNotes(shapesRef.current, c),
        };
      }
      const shape = shapesRef.current.find((s) => s.id === next.shapeId)!;
      const proposal = proposeFix(shape, next, c);
      session.current = { violation: next, proposal };
      fixPreviewRef.current = proposal.fixed
        ? { shapeId: next.shapeId, ghost: proposal.fixed }
        : null;
      // Select the room under review (infill, no active edge) so its L/W dimensions
      // appear — as if the user had clicked it — alongside the ghosted proposal.
      selectionRef.current = new Set([next.shapeId]);
      selectionOrderRef.current = [next.shapeId];
      activeEdgeRef.current = null;
      focusShape(shape);
      requestDraw('scene');
      const remaining = enumerateViolations(shapesRef.current, c).filter(
        (v) => !session.skipped.has(violationKey(v)),
      ).length;
      return {
        done: false,
        shapeId: next.shapeId,
        title: next.title,
        detail: next.detail,
        canAutoFix: proposal.fixed != null && proposal.resolves,
        worsensOthers: proposal.worsensOthers,
        fixedCount: session.fixedCount,
        remaining,
      };
    }, [constraintsRef, focusShape, requestDraw]);

    // Replace a shape in place with its corrected geometry (same id).
    const applyFixedShape = useCallback((fixed: Square) => {
      const arr = shapesRef.current;
      const idx = arr.findIndex((s) => s.id === fixed.id);
      if (idx >= 0) arr[idx] = fixed;
    }, []);

    // ---- Placement API (driven by the Space button) ------------------------
    useImperativeHandle(
      ref,
      (): CanvasHandle => ({
        startPlacement(clientX, clientY) {
          const rect = rectRef.current;
          if (!rect) return;
          placementRef.current = { sx: clientX - rect.left, sy: clientY - rect.top };
          placeSnapStateRef.current = emptySnapState(); // fresh snap session
          requestDraw('scene');
        },
        updatePlacement(clientX, clientY) {
          const rect = rectRef.current;
          const pending = placementRef.current;
          if (!rect || !pending) return;
          pending.sx = clientX - rect.left;
          pending.sy = clientY - rect.top;
          requestDraw('scene');
        },
        commitPlacementAtClient(clientX, clientY) {
          const rect = rectRef.current;
          if (!rect || !placementRef.current) return;
          commitPlacement(clientX - rect.left, clientY - rect.top);
        },
        cancelPlacement() {
          if (placementRef.current) {
            placementRef.current = null;
            alignGuidesRef.current = null;
            placeSnapStateRef.current = emptySnapState();
            requestDraw('scene');
          }
        },
        createRoomsFromList(rooms) {
          const valid = rooms.filter((r) => r.widthFt > 0 && r.heightFt > 0).slice(0, 50);
          if (valid.length === 0) return;
          const wall = DEFAULT_WALL_WORLD;
          // Each room's outer extent (interior + both side walls) along the row, so
          // adjacent rooms' outer walls touch with no overlap.
          const outerW = valid.map((r) => r.widthFt * WORLD_UNITS_PER_FOOT + 2 * wall);
          const totalW = outerW.reduce((a, b) => a + b, 0);
          // Deepest room in the row — the row's vertical extent, used to centre the
          // whole block on the view even though the rooms hang from a shared top edge.
          const maxH = Math.max(...valid.map((r) => r.heightFt * WORLD_UNITS_PER_FOOT));

          // Centre the whole row on the current view's centre in world space.
          const rect = rectRef.current;
          const cam = cameraRef.current;
          const centre = rect
            ? screenToWorld(rect.width / 2, rect.height / 2, cam)
            : screenToWorld(width / 2, height / 2, cam);

          let cursor = centre.x - totalW / 2; // left edge of the current room's outer box
          const top = centre.y - maxH / 2; // shared interior top edge for every room
          const ids: string[] = [];
          for (let i = 0; i < valid.length; i++) {
            const r = valid[i];
            const wWorld = r.widthFt * WORLD_UNITS_PER_FOOT;
            const hWorld = r.heightFt * WORLD_UNITS_PER_FOOT;
            const square: Square = {
              id: createId(),
              x: cursor + wall, // interior sits inside its wall band
              y: top, // top-aligned: every room in the row shares one top edge
              width: wWorld,
              height: hWorld,
              rotation: 0,
              walls: defaultWalls(),
              dots: false,
              name: r.name,
            };
            shapesRef.current.push(square);
            ids.push(square.id);
            cursor += outerW[i];
          }
          selectionRef.current = new Set(ids);
          activeEdgeRef.current = null;
          commitHistory();
          requestDraw('scene');
        },
        startClusterPlacement(shapes, clientX, clientY) {
          const rect = rectRef.current;
          if (!rect || shapes.length === 0) return;
          placementRef.current = {
            sx: clientX - rect.left,
            sy: clientY - rect.top,
            clusterShapes: shapes,
          };
          requestDraw('scene');
        },
        armFootprintDraw() {
          // Cancel any armed room placement so the two tools never fight.
          placementRef.current = null;
          footprintArmRef.current = true;
          requestDraw('scene');
        },
        snapshotProject() {
          // The live shapes belong to whichever mode is showing; the OTHER mode's work is
          // sitting in the stash. Read both so a save from Plan never drops the Facade.
          const stash = workspaceStashRef.current;
          const live: WorkspaceState = {
            shapes: cloneShapes(shapesRef.current),
            footprints: cloneFootprints(footprintsRef.current),
          };
          const stashed = (w: typeof stash.plan): WorkspaceState | null =>
            w ? { shapes: cloneShapes(w.shapes), footprints: cloneFootprints(w.footprints) } : null;
          return {
            plan: facadeRef.current ? stashed(stash.plan) : live,
            facade: facadeRef.current ? live : stashed(stash.facade),
            partition: clonePartitionDoc(partitionDocRef.current),
            unit: unitRef.current,
          };
        },
        loadProject(snapshot) {
          // Deep-clone in, so editing the loaded drawing never mutates the stored snapshot.
          const cloneWorkspace = (w: WorkspaceState | null) =>
            w ? { shapes: cloneShapes(w.shapes), footprints: cloneFootprints(w.footprints) } : null;
          const incoming = facadeRef.current ? snapshot.facade : snapshot.plan;
          const other = cloneWorkspace(facadeRef.current ? snapshot.plan : snapshot.facade);
          workspaceStashRef.current = facadeRef.current
            ? { plan: other, facade: null }
            : { plan: null, facade: other };
          shapesRef.current = incoming ? cloneShapes(incoming.shapes) : [];
          footprintsRef.current = incoming ? cloneFootprints(incoming.footprints) : [];
          footprintDraftRef.current = null;
          partitionDocRef.current = clonePartitionDoc(snapshot.partition);
          unitRef.current = snapshot.unit;
          // Every transient that could still point at the replaced document.
          selectionRef.current = new Set();
          activeEdgeRef.current = null;
          edgeHoverRef.current = null;
          hoverRef.current = null;
          placementRef.current = null;
          footprintArmRef.current = false;
          resizingRef.current = false;
          partitionSelSegRef.current = null;
          partitionCellSelRef.current = new Set();
          partitionBorderSelRef.current = new Set();
          partitionEnteredRef.current = null;
          frameEditRef.current = null;
          highlightRef.current = { roomIds: new Set(), wallMap: new Map() };
          lastPartitionKeyRef.current = '';
          setEditor(null);
          // A loaded drawing is its own starting point — undo must not reach back into
          // whatever was on the canvas before it.
          historyRef.current = {
            undo: [],
            redo: [],
            baseline: {
              shapes: cloneShapes(shapesRef.current),
              footprints: cloneFootprints(footprintsRef.current),
              unit: unitRef.current,
              partition: clonePartitionDoc(partitionDocRef.current),
            },
          };
          requestDraw('all');
        },
        runFind(query) {
          const r = findMatches(query, shapesRef.current);
          highlightRef.current = { roomIds: r.roomIds, wallMap: r.wallMap };
          requestDraw('scene');
          return r.count;
        },
        clearFind() {
          if (highlightRef.current.roomIds.size === 0 && highlightRef.current.wallMap.size === 0) {
            return;
          }
          highlightRef.current = { roomIds: new Set(), wallMap: new Map() };
          requestDraw('scene');
        },
        captureSelectionShapes() {
          const selected = shapesRef.current.filter((s) => selectionRef.current.has(s.id));
          if (selected.length === 0) return null;
          // Hand the shapes back; the multi-pass renderer builds the per-material references + prompts.
          return { shapes: selected.map(cloneShape), count: selected.length };
        },
        selectShapeIds(ids) {
          const present = new Set(shapesRef.current.map((s) => s.id));
          selectionRef.current = new Set(ids.filter((id) => present.has(id)));
          activeEdgeRef.current = null;
          requestDraw('scene');
        },
        setSelectionAssembly(key) {
          const id = [...selectionRef.current][0];
          const shape = shapesRef.current.find((s) => s.id === id);
          if (!shape) return;
          const def = facadeType(key);
          shape.name = key;
          // Switching type changes only the band (mullion/joint) thickness; size is kept.
          const bandWorld = inchesToWorld(bandInchesFor(def.defaultMeta, key));
          shape.walls = { n: bandWorld, e: bandWorld, s: bandWorld, w: bandWorld };
          commitHistory();
          requestDraw('scene');
        },
        setShapeSize(id, widthFt, heightFt) {
          const shape = shapesRef.current.find((s) => s.id === id);
          if (!shape) return;
          const w = Math.max(feetToWorld(0.5), feetToWorld(widthFt));
          const h = Math.max(feetToWorld(0.5), feetToWorld(heightFt));
          const cx = shape.x + shape.width / 2;
          const cy = shape.y + shape.height / 2;
          shape.width = w;
          shape.height = h;
          shape.x = cx - w / 2;
          shape.y = cy - h / 2;
          commitHistory();
          requestDraw('scene');
        },
        applyAssemblyBand(key, inches) {
          // No commitHistory: this is the continuous type-level band sync (fires per-frame during a
          // wall drag). The originating gesture commits its own undo step on release.
          const bandWorld = Math.max(inchesToWorld(0.25), inchesToWorld(inches));
          let changed = false;
          for (const s of shapesRef.current) {
            if ((s.name ?? '') === key && s.walls.n !== bandWorld) {
              s.walls = { n: bandWorld, e: bandWorld, s: bandWorld, w: bandWorld };
              changed = true;
            }
          }
          if (changed) requestDraw('scene');
        },
        addLayer() {
          addPartitionLayer(partitionDocRef.current);
          partitionBorderSelRef.current = new Set(); // border indices are per-layer — drop any pick
          commitHistory(); // creating a layer is one undo step
          requestDraw('scene');
        },
        selectLayer(index) {
          selectPartitionLayer(partitionDocRef.current, index);
          partitionBorderSelRef.current = new Set(); // border indices are per-layer — drop any pick
          partitionEnteredRef.current = null; // ...and so is the shape that was entered
          partitionCellSelRef.current = new Set();
          onCellMenu?.(null);
          requestDraw('scene'); // navigation only — not an undo step
        },
        splitCell(ref, cols, rows) {
          splitPartitionCell(partitionActiveLayer(partitionDocRef.current), ref, cols, rows);
          partitionCellSelRef.current = new Set(); // start the new grid with no panel selected
          commitHistory(); // splitting a cell is one undo step
          requestDraw('scene');
        },
        partitionPanelStats() {
          return partitionPanelStatsOf(partitionActiveLayer(partitionDocRef.current));
        },
        facadeMetrics() {
          return facadeMetricsOf(partitionActiveLayer(partitionDocRef.current), WORLD_UNITS_PER_FOOT);
        },
        optimizePartition(border, strategy) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          // Per BORDER, not per layer: one facade can carry a stair-stepped tower beside a trim-banded
          // podium. Re-picking the mode a border is already in clears it, so the menu doubles as the way out.
          if (!optimizeBorder(layer, border, strategy)) return; // nothing changed → no undo step, no repaint
          partitionCellSelRef.current = new Set(); // selection keys may be stale after reshaping the border
          partitionEnteredRef.current = null;
          onCellMenu?.(null);
          commitHistory(); // a rationalization pass is one undo step
          requestDraw('scene');
        },
        startPanelFrameEdit(clickRect?: Rect | null) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          // Edit acts on exactly the SELECTED panels — the ones washed grey on the canvas — and nothing
          // else. It used to map them back to their material groups, which silently pulled in every
          // identical panel on the elevation; select more panels (or Shift-click to take a whole type)
          // to widen the batch.
          const keys = [...partitionCellSelRef.current];
          if (!partitionHasBoundary(layer) || keys.length === 0) return null;
          // The representative panel: the one actually clicked when it's in the selection, else the first.
          // Used for the frame hit-testing and overlay only — Edit does not move the camera.
          let rect: Rect | null = null;
          if (clickRect) {
            const k = cellKeyAt(layer, {
              x: clickRect.x + clickRect.w / 2,
              y: clickRect.y + clickRect.h / 2,
            });
            if (k && keys.includes(k)) rect = clickRect;
          }
          if (!rect) rect = representativeCell(layer, keys[0]);
          if (!rect) return null;
          frameEditRef.current = { keys, rect, hoverSide: null, allSides: false };
          // Auto-generate a uniform frame on the group (default 2″ mullion width).
          const seeded = seedPanelFrames(layer, keys, inchesToWorld(DEFAULT_PANEL_FRAME_IN));
          // Edit does NOT touch the camera. Framing the panel (or its shape) yanked the view on every
          // click, and the user is already looking at what they selected — the session just makes the
          // mullions grabbable where they already are.
          if (seeded) commitHistory(); // seeding the frame is one undo step
          requestDraw('scene');
          return { keys };
        },
        endPanelFrameEdit() {
          // Ends the session only — Edit never moved the camera, so there is nothing to restore.
          frameEditRef.current = null;
          requestDraw('scene');
        },
        assignPanelKind(kind: PanelKind | null) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          // Assign paints exactly the SELECTED panels. Materials used to be keyed by panel TYPE, so one
          // assignment repainted every identical panel — which made "this bay is spandrel, the next is
          // vision" impossible to express. The selection is the batch now.
          const keys = [...partitionCellSelRef.current];
          if (!partitionHasBoundary(layer) || keys.length === 0) return;
          setPanelKind(layer, keys, kind);
          commitHistory();
          requestDraw('scene');
        },
        fixStart() {
          const cam = cameraRef.current;
          fixSessionRef.current = {
            skipped: new Set(),
            priorCamera: { x: cam.x, y: cam.y, scale: cam.scale },
            fixedCount: 0,
            skippedCount: 0,
            current: null,
          };
          return advanceFix();
        },
        fixApprove() {
          const session = fixSessionRef.current;
          const cur = session?.current;
          if (!session || !cur) return advanceFix();
          if (cur.proposal.fixed && cur.proposal.resolves) {
            applyFixedShape(cur.proposal.fixed);
            session.fixedCount += 1;
            commitHistory();
            requestDraw('scene');
          } else {
            // Not auto-fixable — treat Approve as leaving it (shouldn't happen; UI gates it).
            session.skipped.add(violationKey(cur.violation));
            session.skippedCount += 1;
          }
          return advanceFix();
        },
        fixSkip() {
          const session = fixSessionRef.current;
          const cur = session?.current;
          if (!session || !cur) return advanceFix();
          session.skipped.add(violationKey(cur.violation));
          session.skippedCount += 1;
          return advanceFix();
        },
        fixCancel() {
          const session = fixSessionRef.current;
          fixPreviewRef.current = null;
          if (session) tweenCameraTo(session.priorCamera);
          fixSessionRef.current = null;
          requestDraw('scene');
        },
        demoRoomRects() {
          const c = constraintsRef.current;
          return shapesRef.current.map((s) => {
            const fp = footprintWorld(s);
            return {
              id: s.id,
              selected: selectionRef.current.has(s.id),
              flagged: findViolations(s, c).any,
              inner: polyBounds(fp.inner),
              outer: polyBounds(fp.outer),
              corners: fp.inner.map((p) => ({ ...p })),
              thickness: fp.thickness.slice(),
            };
          });
        },
        demoBorderRect() {
          const poly = partitionActiveLayer(partitionDocRef.current).borders[0];
          return poly && poly.length ? partitionPolyBBox(poly) : null;
        },
        demoGridLines() {
          return partitionGridLines(partitionActiveLayer(partitionDocRef.current), 0);
        },
        demoSelectedPanelRects() {
          return cellRectsOf(partitionActiveLayer(partitionDocRef.current), partitionCellSelRef.current);
        },
        selectPanelsInWorldRect(rect) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          const keys = cellKeysInRect(layer, rect);
          partitionCellSelRef.current = new Set(keys);
          requestDraw('scene');
          return keys.length;
        },
        focusWorldRect(rect, opts) {
          const canvas = rectRef.current;
          if (!canvas) return;
          const padPx = opts?.padPx ?? 120;
          const fill = opts?.fill ?? 1;
          // Per-side margins default to the uniform pad, so the plain call still centres on the viewport.
          const top = opts?.insets?.top ?? padPx;
          const right = opts?.insets?.right ?? padPx;
          const bottom = opts?.insets?.bottom ?? padPx;
          const left = opts?.insets?.left ?? padPx;
          // The free box the subject is fitted into and centred on. Floored so absurd insets on a small
          // window degrade to a cramped frame rather than an inverted one.
          const boxW = Math.max(120, canvas.width - left - right);
          const boxH = Math.max(120, canvas.height - top - bottom);
          const scale = Math.min(
            (boxW / Math.max(rect.w, 1)) * fill,
            (boxH / Math.max(rect.h, 1)) * fill,
            MAX_SCALE,
          );
          const target = {
            x: left + boxW / 2 - (rect.x + rect.w / 2) * scale,
            y: top + boxH / 2 - (rect.y + rect.h / 2) * scale,
            scale,
          };
          // Skipping a step to its end must not have to sit through a 250ms ease per framing — and a tour
          // that is being fast-forwarded has no viewer watching the camera travel anyway.
          if (opts?.instant) {
            if (cameraTweenRef.current) {
              cancelAnimationFrame(cameraTweenRef.current);
              cameraTweenRef.current = 0;
            }
            Object.assign(cameraRef.current, target);
            requestDraw('all');
            return;
          }
          tweenCameraTo(target);
        },
        demoSnapshot() {
          const fe = frameEditRef.current;
          const cam = cameraRef.current;
          return {
            shapes: cloneShapes(shapesRef.current),
            footprints: cloneFootprints(footprintsRef.current),
            partition: clonePartitionDoc(partitionDocRef.current),
            selection: [...selectionRef.current],
            cellSel: [...partitionCellSelRef.current],
            borderSel: [...partitionBorderSelRef.current],
            entered: partitionEnteredRef.current,
            frameEdit: fe ? { ...fe, keys: [...fe.keys], rect: { ...fe.rect } } : null,
            camera: { x: cam.x, y: cam.y, scale: cam.scale },
          };
        },
        demoRestore(snap) {
          // A camera tween still in flight holds the object it started with and would keep writing to it
          // after the restore, dragging the view off the state being put back.
          if (cameraTweenRef.current) {
            cancelAnimationFrame(cameraTweenRef.current);
            cameraTweenRef.current = 0;
          }
          shapesRef.current = cloneShapes(snap.shapes);
          footprintsRef.current = cloneFootprints(snap.footprints);
          partitionDocRef.current = clonePartitionDoc(snap.partition);
          selectionRef.current = new Set(snap.selection);
          partitionCellSelRef.current = new Set(snap.cellSel);
          partitionBorderSelRef.current = new Set(snap.borderSel);
          partitionEnteredRef.current = snap.entered;
          frameEditRef.current = snap.frameEdit
            ? { ...snap.frameEdit, keys: [...snap.frameEdit.keys], rect: { ...snap.frameEdit.rect } }
            : null;
          Object.assign(cameraRef.current, snap.camera);
          activeEdgeRef.current = null;
          placementRef.current = null;
          // The React-side reports dedupe against their last published value, and the restore can easily
          // land back on one of them — reset the keys so the redraw below re-publishes unconditionally.
          lastStatsKeyRef.current = '';
          lastSelCountRef.current = -1;
          lastSelPanelKeyRef.current = '\0';
          lastPanelTypesKeyRef.current = '';
          lastPartitionKeyRef.current = '';
          // The floating panel bar is React state, not canvas state: its anchor is republished by the draw
          // below (hence the key reset), but a bar left hanging over a state that has no panel selected at
          // all would be pointing at nothing, so that one case is closed outright.
          lastMenuAnchorRef.current = '\0';
          if (!snap.cellSel.length && !snap.frameEdit) onCellMenu?.(null);
          commitHistory();
          requestDraw('all');
        },
        demoDeselect() {
          selectionRef.current = new Set();
          partitionCellSelRef.current = new Set();
          partitionBorderSelRef.current = new Set();
          partitionSelSegRef.current = null;
          frameEditRef.current = null;
          activeEdgeRef.current = null;
          // The floating bar is React state and hangs off the selection that just went away; the redraw
          // republishes from the canvas, but with nothing selected there is nothing to republish.
          lastSelCountRef.current = -1;
          lastSelPanelKeyRef.current = '\0';
          lastMenuAnchorRef.current = '\0';
          onCellMenu?.(null);
          requestDraw('all');
        },
        worldToClient(world) {
          const canvas = rectRef.current;
          const p = worldToScreen(world.x, world.y, cameraRef.current);
          return { x: (canvas?.left ?? 0) + p.x, y: (canvas?.top ?? 0) + p.y };
        },
        resetForDemo() {
          // Kill any framing tween first: it holds the camera object it started with and would keep
          // writing to it for the rest of its 250ms, dragging the view back off the reset.
          if (cameraTweenRef.current) {
            cancelAnimationFrame(cameraTweenRef.current);
            cameraTweenRef.current = 0;
          }
          resetCamera(); // world origin centred, 100% — the zoom every screen-px gesture below is sized in
          shapesRef.current = [];
          footprintsRef.current = [];
          selectionRef.current = new Set();
          activeEdgeRef.current = null;
          workspaceStashRef.current = { plan: null, facade: null };
          partitionDocRef.current = newDoc();
          partitionCellSelRef.current = new Set();
          partitionBorderSelRef.current = new Set();
          partitionEnteredRef.current = null;
          frameEditRef.current = null;
          lastPartitionKeyRef.current = '';
          commitHistory();
          requestDraw('all');
        },
      }),
      [
        requestDraw,
        commitPlacement,
        commitHistory,
        cameraRef,
        width,
        height,
        advanceFix,
        applyFixedShape,
        tweenCameraTo,
        resetCamera,
        constraintsRef,
        onCellMenu,
      ],
    );

    // Suppress the browser's right-click menu (the "Save image as…/Copy image"
    // menu, since the scene canvas is an image role) so right-click is ours.
    const suppressContextMenu = (e: ReactMouseEvent) => e.preventDefault();

    return (
      <>
        <canvas
          ref={gridCanvasRef}
          className={`${styles.canvas} ${styles.grid}`}
          style={{ width, height }}
          aria-hidden="true"
          onContextMenu={suppressContextMenu}
        />
        <canvas
          ref={sceneCanvasRef}
          className={`${styles.canvas} ${styles.scene}`}
          style={{ width, height }}
          aria-label="Infinite drawing canvas"
          role="img"
          onContextMenu={suppressContextMenu}
        />
        {editor && (
          <input
            ref={dimInputRef}
            key={`${editor.shapeId}:${editor.which}`}
            className={styles.dimInput}
            style={{
              left: editor.x,
              top: editor.y,
              transform: `translate(-50%, -50%) rotate(${editor.angle}deg)`,
              width: editor.which === 'name' ? 130 : undefined,
            }}
            value={editor.value}
            inputMode={editor.which === 'name' ? 'text' : 'decimal'}
            aria-label={
              editor.which === 'name'
                ? 'Room name'
                : editor.which === 'area'
                  ? 'Square footage'
                  : editor.which === 'wallThickness'
                    ? 'Wall thickness'
                    : editor.which === 'wallLength'
                      ? 'Wall length'
                      : `${editor.which} in feet`
            }
            onChange={(e) =>
              setEditor((ed) => (ed ? { ...ed, value: e.target.value } : ed))
            }
            onKeyDown={(e) => {
              // Enter always commits; Space commits a number (never needed in
              // one) but is a literal character in a room name.
              if (e.key === 'Enter' || (e.key === ' ' && editor.which !== 'name')) {
                e.preventDefault();
                commitDimension();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditor(null);
              }
            }}
            onBlur={commitDimension}
          />
        )}
      </>
    );
  },
);
