import type { Vec2 } from '../canvas/coords';
import { polygonUnion, polygonDifference } from '../canvas/shapes';

/**
 * ============================================================================
 *  FACADE PARTITION — fixed-pitch sticky-cell layers, revealed through a trim border
 * ============================================================================
 *
 * A facade is authored as a STACK OF LAYERS. Each layer is a regular grid of FIXED-SIZE cells (a lattice
 * at a fixed world pitch, anchored at the drawn rectangle's origin) plus a deformable TRIM BORDER that acts
 * as a CLIPPING MASK. The cells themselves never deform: stretching the border just reveals more of the
 * repeating pattern continuing past the clip plane, and angling a border corner neatly SLICES the cells
 * crossing it. A base cell can be subdivided (recursively) into a finer fixed grid via right-click.
 *
 * Everything is axis-aligned except the border, which is a free quad used only to clip.
 */

/** An axis-aligned rectangle in world units (top-left origin, width/height ≥ 0). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A subdivision node inside a single base cell. A LEAF has no `grid`; a GRID node is split into
 * `cols × rows` children (row-major, even splits — so every sub-cell is a fixed fraction of its fixed-size
 * parent and never deforms). Children may themselves be grids (recursion).
 */
export interface Cell {
  id: string;
  grid?: { cols: number; rows: number; children: Cell[] };
}

/**
 * The fixed-pitch base lattice of a layer. Lines default to `origin + index*pitch`, but each can be moved
 * Excel-style: `colX`/`rowY` override a WHOLE line's position (its columns/rows reflow parametrically), and
 * `segX`/`segY` pin a single SEGMENT (one piece of a line between two intersections) to an ABSOLUTE world
 * position — decoupled from its parent line, so once jogged it stays put even when that line is moved.
 * Stretching the border still reveals more cells at the default pitch.
 */
export interface BaseGrid {
  originX: number;
  originY: number;
  pitchX: number;
  pitchY: number;
  /** Whole-line position overrides: vertical line index → world X; horizontal line index → world Y. */
  colX: Record<number, number>;
  rowY: Record<number, number>;
  /** Per-segment ABSOLUTE overrides: "i,j" → world X of vertical line i within row j / world Y of horizontal
   *  line j within col i. Present ⇒ that one segment is pinned independently of its parent line. */
  segX: Record<string, number>;
  segY: Record<string, number>;
  /** Extra (alt-duplicated) full divider lines at arbitrary world positions: X for vertical, Y for horizontal. */
  extraX: number[];
  extraY: number[];
  /** Extra PARTIAL dividers — a copied single segment, confined to one base cell "i,j" (world X / Y cuts). */
  extraSegX: Record<string, number[]>;
  extraSegY: Record<string, number[]>;
  /** Subdivision trees keyed by base-cell index "i,j"; absent ⇒ that base cell is a single leaf. */
  subdiv: Record<string, Cell>;
}

/** A draggable extra (copied) PARTIAL segment, confined to base cell (i, j) of border `border`'s lattice. */
export interface ExtraSegHandle {
  /** Index of the owning border (into `borders`/`grids`). */
  border: number;
  axis: 'v' | 'h';
  i: number;
  j: number;
  index: number;
}

/** A draggable inner grid line of one border's lattice: a lattice column/row line, or an extra divider. */
export type LineHandle =
  | { border: number; axis: 'v' | 'h'; kind: 'lattice'; index: number }
  | { border: number; axis: 'v' | 'h'; kind: 'extra'; index: number };

/** A single line segment (between two intersections) of one border's lattice. */
export interface SegmentRef {
  /** Index of the owning border (into `borders`/`grids`). */
  border: number;
  axis: 'v' | 'h';
  /** The line index (vertical line for 'v', horizontal line for 'h'). */
  line: number;
  /** The perpendicular cell index (row for a 'v' segment, column for an 'h' segment). */
  cell: number;
}

/** One facade layer: a set of independent trim borders, each with its own lattice anchor + fixed-pitch grid. */
export interface FacadeLayer {
  id: string;
  /**
   * The TRIM/CLIP quads, each corners [NW, NE, SE, SW] (world). Clips the cells; corners deform, edges reveal.
   * Each border is INDEPENDENT: it owns its own lattice anchor (`roots[i]`) and grid (`grids[i]`), so its panel
   * pattern stays fixed within it and travels rigidly when that border is moved — moving one border never
   * disturbs another's pattern. Empty until the first border is placed.
   */
  borders: Vec2[][];
  /**
   * Per-border lattice ANCHOR rect (parallel to `borders`): the drawn rectangle that seeds that border's grid
   * origin/pitch. May be null for a border seeded without an explicit rect (e.g. a boolean result) — callers
   * fall back to the border's bounding box.
   */
  roots: (Rect | null)[];
  /**
   * Per-border fixed-pitch base lattice (parallel to `borders`); an entry is null until that border's first
   * split — the whole border is a single panel until then.
   */
  grids: (BaseGrid | null)[];
  /**
   * PER-BORDER rationalization mode, indexed alongside `borders`. Each shape carries its own — one facade
   * can have a stair-stepped tower beside a trim-banded podium — and the modes are mutually exclusive by
   * construction, where three independent booleans could contradict each other. Null/absent ⇒ the normal
   * clip-to-border behaviour (panels sliced by the boundary).
   *
   *  - `edge-profile`:    only whole cells count as panels; the leftover perimeter becomes one trim band.
   *  - `stepped-edge`:    only whole cells, packed toward the boundary — a stair-step silhouette.
   *  - `modular-cluster`: panels group into fabrication FAMILIES by cut ANGLE rather than exact shape.
   */
  borderModes?: (PanelMode | null)[];
  /**
   * Per-group frame overrides (Edit-a-panel). Maps a panel GROUP key (the `cellGroups` shape key) to its
   * per-edge inset frame widths in WORLD units (n=top, e=right, s=bottom, w=left). Drawn as an inset band inside
   * every cell of that group, so editing one panel's frame mirrors to the whole group. Absent ⇒ no frame.
   */
  frames?: Record<string, GroupFrame>;
  /**
   * Per-group assigned panel MATERIAL kind (keyed by the `cellGroups` shape key, like `frames`). Drives the
   * cell's fill pattern in the editor (e.g. vision glass = diagonal lines, louver = parallel lines). Absent ⇒
   * the plain white panel. Assigned via the right-click menu's "Assign".
   */
  panelKinds?: Record<string, PanelKind>;
}

/**
 * Assignable panel material kinds (separate from the 14 shape-level facade assemblies). Each renders as a
 * distinct fill pattern on the panel:
 *  - `vision1`/`vision2`/`vision3`: clear vision glass, 1/2/3 subtle diagonal lines (single/double/triple glazing).
 *  - `spandrel`: opaque spandrel glass — a light-grey tint plus diagonal lines.
 *  - `solid`: solid metal/composite panel — blank fill with a thin inset joint/flange line.
 *  - `cladding`: heavy cladding (precast/brick/stone) — dot stippling.
 *  - `louver`: ventilated louver/screen — dense parallel lines.
 */
export type PanelKind =
  | 'vision1'
  | 'vision2'
  | 'vision3'
  | 'spandrel'
  | 'solid'
  | 'cladding'
  | 'louver';

/**
 * Per-edge inset frame widths (world units): n=top, e=right, s=bottom, w=left. `b` is the mullion width along
 * the trim BORDER cut (the diagonal edge of a border-sliced panel); when absent it falls back to the average of
 * the four sides, so it only matters once the user drags the border frame edge individually.
 */
export interface GroupFrame {
  n: number;
  e: number;
  s: number;
  w: number;
  b?: number;
}

/** The whole facade document: a stack of layers (index 0 = bottom) plus the active layer index. */
export interface FacadeDoc {
  layers: FacadeLayer[];
  activeIndex: number;
}

/** A reference to a cell for splitting within border `border`: either its un-gridded root, or a base cell. */
export type CellRef =
  | { border: number; kind: 'root' }
  | { border: number; kind: 'base'; i: number; j: number; path: number[] };

/**
 * Rationalization strategies for the Optimize tool — each reduces the number of UNIQUE panel shapes (distinct
 * `clipShapeKey`s) along diagonal borders in a different way:
 *  - `edge-normalize`: snap the border to a rational grid-aligned slope so the perimeter cut pattern repeats.
 *  - `edge-profile`:   keep every panel a full rectangle and absorb the diagonal into a single perimeter trim.
 *  - `modular-cluster`: merge near-identical perimeter cuts into a small family of reusable edge types.
 *  - `stepped-edge`:    quantize the diagonal to a stair-step of identical whole panels (pixelated edge).
 * Algorithms are implemented one at a time; see `panelStats` for the metric they minimize.
 */
export type OptimizeStrategy = 'edge-normalize' | 'edge-profile' | 'modular-cluster' | 'stepped-edge';

/**
 * The subset of {@link OptimizeStrategy} that is a persistent per-border MODE rather than a one-shot edit.
 * `edge-normalize` is excluded: it snaps the outline onto the grid once and leaves no state behind, so it
 * is an action, not something a border can "be in".
 */
export type PanelMode = 'edge-profile' | 'modular-cluster' | 'stepped-edge';

/** The rationalization mode a border is in, or null for the default sliced-panel behaviour. */
export function borderMode(layer: FacadeLayer, border: number): PanelMode | null {
  return layer.borderModes?.[border] ?? null;
}

/** Put a border into a mode (null clears it). Returns whether anything changed. */
export function setBorderMode(layer: FacadeLayer, border: number, mode: PanelMode | null): boolean {
  if (border < 0 || border >= layer.borders.length) return false;
  if (borderMode(layer, border) === mode) return false;
  if (!layer.borderModes) layer.borderModes = [];
  while (layer.borderModes.length < layer.borders.length) layer.borderModes.push(null);
  layer.borderModes[border] = mode;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Construction                                                               */
/* -------------------------------------------------------------------------- */

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${idSeq}`;
}

/** A fresh leaf cell. */
export function newCell(): Cell {
  return { id: nextId('cell') };
}

/** A fresh blank layer (no boundary drawn yet). */
export function newLayer(): FacadeLayer {
  return { id: nextId('layer'), borders: [], roots: [], grids: [] };
}

/** A fresh document with a single blank layer, ready to draw on. */
export function newDoc(): FacadeDoc {
  return { layers: [newLayer()], activeIndex: 0 };
}

/** A deep clone of the document — for immutable undo/redo snapshots (doc is plain serialisable data). */
export function cloneDoc(doc: FacadeDoc): FacadeDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as FacadeDoc;
  for (const layer of copy.layers) {
    // Migrate legacy single-`border` (pre multi-border) and single shared `root`/`grid` (pre per-border)
    // layers onto the parallel `borders`/`roots`/`grids` arrays. Idempotent: fresh layers already conform.
    const legacy = layer as FacadeLayer & {
      border?: Vec2[] | null;
      root?: Rect | null;
      grid?: BaseGrid | null;
    };
    if (!Array.isArray(layer.borders)) layer.borders = legacy.border ? [legacy.border] : [];
    if (!Array.isArray(layer.roots))
      layer.roots = layer.borders.map((_, i) => (i === 0 ? legacy.root ?? null : null));
    if (!Array.isArray(layer.grids))
      layer.grids = layer.borders.map((_, i) => (i === 0 ? legacy.grid ?? null : null));
    delete legacy.border;
    delete legacy.root;
    delete legacy.grid;
  }
  return copy;
}

/** The active layer of a document. */
export function activeLayer(doc: FacadeDoc): FacadeLayer {
  return doc.layers[doc.activeIndex] ?? doc.layers[0];
}

/** Append a blank layer on top and make it active (the user draws a fresh boundary on it). */
export function addLayer(doc: FacadeDoc): void {
  doc.layers.push(newLayer());
  doc.activeIndex = doc.layers.length - 1;
}

/** Select a layer by index (clamped). */
export function selectLayer(doc: FacadeDoc, i: number): void {
  if (i >= 0 && i < doc.layers.length) doc.activeIndex = i;
}

/** The four corners of a rect, ordered [NW, NE, SE, SW]. */
export function rectCorners(r: Rect): Vec2[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** Every trim quad of a layer. */
export function borderPolygons(layer: FacadeLayer): Vec2[][] {
  return layer.borders;
}

/** The layer's PRIMARY (first) trim polygon, or [] before any border is placed. */
export function borderPolygon(layer: FacadeLayer): Vec2[] {
  return layer.borders[0] ?? [];
}

/** True once at least one trim border has been placed (the canvas leaves draw mode). */
export function hasBoundary(layer: FacadeLayer): boolean {
  return layer.borders.length > 0;
}

/**
 * The trim border whose interior contains a (cell) rect's centre — used by per-panel consumers (frame band,
 * border-cut edges) to clip a panel against the border it actually belongs to. Falls back to the primary.
 */
export function borderContaining(layer: FacadeLayer, rect: Rect): Vec2[] {
  const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  for (let b = layer.borders.length - 1; b >= 0; b--) {
    if (pointInPolygon(c, layer.borders[b])) return layer.borders[b];
  }
  return layer.borders[0] ?? [];
}

/** Axis-aligned bounding box of a polygon (world units). Empty polys give a zero-size box at the origin. */
export function polyBBox(poly: Vec2[]): Rect {
  if (poly.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Scale a border polygon about its bounding-box centre so its bbox WIDTH (`axis='x'`) or HEIGHT (`axis='y'`)
 * becomes `targetWorld`. For an axis-aligned border this is a plain resize; a deformed quad scales along that
 * axis. Mutates the polygon in place. No-op if the current extent is degenerate.
 */
export function resizeBorderExtent(poly: Vec2[], axis: 'x' | 'y', targetWorld: number): void {
  const bb = polyBBox(poly);
  const cur = axis === 'x' ? bb.w : bb.h;
  if (cur <= 1e-6 || targetWorld <= 0) return;
  const f = targetWorld / cur;
  const cx = bb.x + bb.w / 2;
  const cy = bb.y + bb.h / 2;
  for (const p of poly) {
    if (axis === 'x') p.x = cx + (p.x - cx) * f;
    else p.y = cy + (p.y - cy) * f;
  }
}

/** Commit the FIRST drawn rectangle as the active layer's boundary (its own anchor; one cell to start). */
export function setLayerBoundary(layer: FacadeLayer, rect: Rect): void {
  layer.borders = [rectCorners(rect)];
  layer.roots = [{ ...rect }];
  layer.grids = [null];
}

/** Append an additional INDEPENDENT trim border rectangle with its own anchor + (empty) lattice. */
export function addBorder(layer: FacadeLayer, rect: Rect): void {
  layer.borders.push(rectCorners(rect));
  layer.roots.push({ ...rect });
  layer.grids.push(null);
}

/** Place a border rectangle: the first one seeds the layer (`setLayerBoundary`), the rest are appended. */
export function placeBorder(layer: FacadeLayer, rect: Rect): void {
  if (!hasBoundary(layer)) setLayerBoundary(layer, rect);
  else addBorder(layer, rect);
}

function clampCount(n: number): number {
  return Math.max(1, Math.min(20, Math.round(n)));
}

/** Stable key for a base-cell index. */
function baseKey(i: number, j: number): string {
  return `${i},${j}`;
}

/* -------------------------------------------------------------------------- */
/*  Subdivision tree (within a single fixed-size base cell)                    */
/* -------------------------------------------------------------------------- */

/** The child rects of a grid node laid out evenly within `rect` (row-major). */
function childRects(rect: Rect, grid: NonNullable<Cell['grid']>): Rect[] {
  const out: Rect[] = [];
  const cw = rect.w / grid.cols;
  const ch = rect.h / grid.rows;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      out.push({ x: rect.x + c * cw, y: rect.y + r * ch, w: cw, h: ch });
    }
  }
  return out;
}

/** Resolve the sub-cell at `path` within a tree, or null if the path is invalid. */
function cellAt(cell: Cell, path: number[]): Cell | null {
  let cur = cell;
  for (const idx of path) {
    if (!cur.grid || idx < 0 || idx >= cur.grid.children.length) return null;
    cur = cur.grid.children[idx];
  }
  return cur;
}

/** Split the sub-cell at `path` into `cols × rows` even children (1×1 collapses it back to a leaf). */
function splitCellAt(cell: Cell, path: number[], cols: number, rows: number): void {
  const target = cellAt(cell, path);
  if (!target) return;
  const c = clampCount(cols);
  const r = clampCount(rows);
  if (c === 1 && r === 1) {
    delete target.grid;
    return;
  }
  const children: Cell[] = [];
  for (let i = 0; i < c * r; i++) children.push(newCell());
  target.grid = { cols: c, rows: r, children };
}

/** Every leaf rect of a subdivision tree, given the base cell's fixed rect. */
function leafRectsOf(cell: Cell, rect: Rect): Rect[] {
  if (!cell.grid) return [rect];
  const out: Rect[] = [];
  const rects = childRects(rect, cell.grid);
  cell.grid.children.forEach((child, i) => out.push(...leafRectsOf(child, rects[i])));
  return out;
}

/** Descend a subdivision tree to the deepest leaf containing `pt`, returning its child-index path. */
function descendTree(cell: Cell, rect: Rect, pt: Vec2): number[] {
  const path: number[] = [];
  let cur = cell;
  let curRect = rect;
  while (cur.grid) {
    const rects = childRects(curRect, cur.grid);
    let next = -1;
    for (let i = 0; i < rects.length; i++) {
      if (inRect(pt, rects[i])) {
        next = i;
        break;
      }
    }
    if (next < 0) break;
    path.push(next);
    curRect = rects[next];
    cur = cur.grid.children[next];
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/*  Fixed-pitch base lattice                                                   */
/* -------------------------------------------------------------------------- */

/** World X of vertical line `i` (whole-line override, else default pitch). */
function lineX(g: BaseGrid, i: number): number {
  return g.colX[i] ?? g.originX + i * g.pitchX;
}
/** World Y of horizontal line `j` (whole-line override, else default pitch). */
function lineY(g: BaseGrid, j: number): number {
  return g.rowY[j] ?? g.originY + j * g.pitchY;
}
/** World X of vertical line `i` within row `j` — an absolute per-segment override if pinned, else the line. */
function edgeX(g: BaseGrid, i: number, j: number): number {
  const o = g.segX[`${i},${j}`];
  return o !== undefined ? o : lineX(g, i);
}
/** World Y of horizontal line `j` within column `i` — an absolute per-segment override if pinned, else the line. */
function edgeY(g: BaseGrid, i: number, j: number): number {
  const o = g.segY[`${i},${j}`];
  return o !== undefined ? o : lineY(g, j);
}

/** The world rect of base cell (i, j) — its four edges respect whole-line and per-segment overrides. */
function baseCellRect(g: BaseGrid, i: number, j: number): Rect {
  const x0 = edgeX(g, i, j);
  const y0 = edgeY(g, i, j);
  return { x: x0, y: y0, w: edgeX(g, i + 1, j) - x0, h: edgeY(g, i, j + 1) - y0 };
}

/** Most base cells revealed along one axis (guards against a tiny pitch under a huge border). */
const MAX_CELLS_PER_AXIS = 300;

/** The inclusive base-cell index range of border `b` overlapping ITS OWN bounding box (capped). */
function baseCellRange(
  layer: FacadeLayer,
  b: number,
): { iMin: number; iMax: number; jMin: number; jMax: number } | null {
  const g = layer.grids[b];
  const poly = layer.borders[b];
  if (!g || !poly || poly.length < 1) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  // Far edge is exclusive: a border landing exactly on a cell boundary must not reveal an empty next cell.
  const iMin = Math.floor((minX - g.originX) / g.pitchX);
  let iMax = Math.ceil((maxX - g.originX) / g.pitchX) - 1;
  const jMin = Math.floor((minY - g.originY) / g.pitchY);
  let jMax = Math.ceil((maxY - g.originY) / g.pitchY) - 1;
  iMax = Math.min(iMax, iMin + MAX_CELLS_PER_AXIS - 1);
  jMax = Math.min(jMax, jMin + MAX_CELLS_PER_AXIS - 1);
  return { iMin, iMax, jMin, jMax };
}

/** Split a rect by any extra divider lines crossing its interior (global cuts → consistent across cells). */
function splitRectByExtras(rect: Rect, extraX: number[], extraY: number[]): Rect[] {
  const EPS = 1e-6;
  const xs = [rect.x, rect.x + rect.w];
  for (const x of extraX) if (x > rect.x + EPS && x < rect.x + rect.w - EPS) xs.push(x);
  const ys = [rect.y, rect.y + rect.h];
  for (const y of extraY) if (y > rect.y + EPS && y < rect.y + rect.h - EPS) ys.push(y);
  if (xs.length === 2 && ys.length === 2) return [rect]; // nothing crosses it
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      out.push({ x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r] });
    }
  }
  return out;
}

/** Every leaf cell rect of ONE border's own lattice (its fixed-size pattern over the revealed region). */
function borderCellRects(layer: FacadeLayer, b: number): Rect[] {
  const poly = layer.borders[b];
  if (!poly) return [];
  const g = layer.grids[b];
  // Before the first split the whole border is one cell — span its full extent (handles a deformed/stretched
  // border) so the single panel always fills the boundary after the clip.
  if (!g) return [polyBBox(poly)];
  const range = baseCellRange(layer, b);
  if (!range) return [];
  const out: Rect[] = [];
  for (let j = range.jMin; j <= range.jMax; j++) {
    for (let i = range.iMin; i <= range.iMax; i++) {
      const key = baseKey(i, j);
      // Global extra lines plus this cell's own copied partial segments are all cuts for this cell.
      const cutsX = g.extraX.concat(g.extraSegX[key] ?? []);
      const cutsY = g.extraY.concat(g.extraSegY[key] ?? []);
      const baseRect = baseCellRect(g, i, j);
      const sub = g.subdiv[key];
      const leaves = sub ? leafRectsOf(sub, baseRect) : [baseRect];
      for (const leaf of leaves) for (const piece of splitRectByExtras(leaf, cutsX, cutsY)) out.push(piece);
    }
  }
  if (poly.length >= 3) {
    // Both modes keep only panels lying WHOLLY inside the border — every one a full rectangle that fits
    // within the boundary, never spilling past the outline the user drew.
    //
    // Stepped Edge then PACKS the leftover: a cell the border cuts is quartered and retried, so smaller
    // whole panels step in toward the diagonal instead of the gap being abandoned. Edge Profile keeps the
    // gap deliberately and fills it with one continuous trim band instead.
    const mode = borderMode(layer, b);
    if (mode === 'stepped-edge') {
      const packed: Rect[] = [];
      for (const r of out) packSteppedCell(r, poly, 0, packed);
      return packed;
    }
    if (mode === 'edge-profile') return out.filter((r) => rectInsideRatio(r, poly) >= 1 - 1e-3);
  }
  return out;
}

/**
 * How many times a Stepped-Edge boundary cell may be split to chase the border. Each level halves both
 * sides, so this caps the facade at TWO panel sizes: the base module and one half-module infill. Going
 * deeper closes the last slivers but adds a third and fourth size — the shop tools every one of them, so
 * the boundary fidelity is not worth the fabrication.
 */
const STEP_PACK_MAX_DEPTH = 1;

/**
 * Pack one Stepped-Edge cell against the border, quadtree style. A cell that fits whole is kept; one that
 * straddles the boundary is quartered and each piece retried, down to {@link STEP_PACK_MAX_DEPTH}. The
 * result is a two-size stair-step — full panels across the field, half-modules stepping in along the
 * diagonal — where every panel is still an orthogonal rectangle lying entirely inside the shape.
 */
function packSteppedCell(rect: Rect, border: Vec2[], depth: number, out: Rect[]): void {
  const ratio = rectInsideRatio(rect, border);
  if (ratio >= 1 - 1e-3) {
    out.push(rect); // fits whole
    return;
  }
  if (ratio <= 1e-6) return; // nothing of it is inside
  if (depth >= STEP_PACK_MAX_DEPTH) return; // any smaller stops being a buildable panel
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const next = depth + 1;
  packSteppedCell({ x: rect.x, y: rect.y, w: hw, h: hh }, border, next, out);
  packSteppedCell({ x: rect.x + hw, y: rect.y, w: hw, h: hh }, border, next, out);
  packSteppedCell({ x: rect.x + hw, y: rect.y + hh, w: hw, h: hh }, border, next, out);
  packSteppedCell({ x: rect.x, y: rect.y + hh, w: hw, h: hh }, border, next, out);
}

/** Every leaf cell rect to draw across ALL borders (each border contributes its own independent lattice). */
export function cellRects(layer: FacadeLayer): Rect[] {
  const out: Rect[] = [];
  for (let b = 0; b < layer.borders.length; b++) out.push(...borderCellRects(layer, b));
  return out;
}

/** Fraction (0..1) of a cell rect's area that lies inside the trim border — 1 ⇒ wholly inside. */
function rectInsideRatio(rect: Rect, border: Vec2[]): number {
  const clipped = clipCellToBorder(rect, border);
  const full = rect.w * rect.h;
  if (clipped.length < 3 || full <= 0) return 0;
  return polyArea(clipped) / full;
}

/* -------------------------------------------------------------------------- */
/*  Hit-testing & editing                                                      */
/* -------------------------------------------------------------------------- */

function inRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Convert HSL (h∈[0,360), s,l∈[0,1]) to a #rrggbb hex string. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Intersection of segment p1→p2 with the INFINITE line through a→b, or null when parallel. */
function segLineIntersect(p1: Vec2, p2: Vec2, a: Vec2, b: Vec2): Vec2 | null {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((a.x - p1.x) * ey - (a.y - p1.y) * ex) / denom;
  return { x: p1.x + dx * t, y: p1.y + dy * t };
}

/** Sutherland–Hodgman: clip a subject polygon to a convex clip polygon (the trim border). */
function clipToConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  if (clip.length < 3) return subject;
  const cx = clip.reduce((s, p) => s + p.x, 0) / clip.length;
  const cy = clip.reduce((s, p) => s + p.y, 0) / clip.length;
  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  let output = subject.slice();
  for (let e = 0; e < clip.length && output.length > 0; e++) {
    const a = clip[e];
    const b = clip[(e + 1) % clip.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    // "Inside" is the side the clip centroid sits on (handles either winding).
    const insidePos = cross(ex, ey, cx - a.x, cy - a.y) >= 0;
    const inside = (p: Vec2) => {
      const s = cross(ex, ey, p.x - a.x, p.y - a.y);
      return insidePos ? s >= -1e-9 : s <= 1e-9;
    };
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) {
          const ip = segLineIntersect(prev, cur, a, b);
          if (ip) output.push(ip);
        }
        output.push(cur);
      } else if (prevIn) {
        const ip = segLineIntersect(prev, cur, a, b);
        if (ip) output.push(ip);
      }
    }
  }
  return output;
}

/**
 * Intersection of a convex CELL rect with a (possibly concave) trim BORDER, as one polygon. We clip the BORDER
 * to the cell — Sutherland–Hodgman only needs the CLIP polygon (the cell) to be convex, so a concave border
 * (e.g. a boolean union/difference result) is handled correctly while a convex quad border behaves as before.
 */
function clipCellToBorder(rect: Rect, border: Vec2[]): Vec2[] {
  if (border.length < 3) return rectCorners(rect);
  return clipToConvex(border, rectCorners(rect));
}

/**
 * Inset (shrink) a convex polygon inward by distance `d`: every edge slides toward the interior by `d` and
 * adjacent offset edges are re-intersected. Returns the smaller polygon, or [] if it collapses. Used to set a
 * panel's frame in from the trim border so the mullion runs along the (possibly diagonal) border edge.
 */
function insetConvexPolygon(poly: Vec2[], d: number | ((edge: number) => number)): Vec2[] {
  const n = poly.length;
  if (n < 3) return poly.slice();
  const distAt = typeof d === 'function' ? d : () => d;
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  // Each edge becomes a line offset inward by its own distance (point + direction).
  const lines: { px: number; py: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    let nx = b.y - a.y;
    let ny = -(b.x - a.x);
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) continue;
    nx /= len;
    ny /= len;
    // Orient the normal toward the centroid so the offset is inward regardless of winding.
    if ((cx - (a.x + b.x) / 2) * nx + (cy - (a.y + b.y) / 2) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const di = Math.max(0, distAt(i));
    lines.push({ px: a.x + nx * di, py: a.y + ny * di, dx: b.x - a.x, dy: b.y - a.y });
  }
  const m = lines.length;
  if (m < 3) return [];
  const out: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const L1 = lines[(i - 1 + m) % m];
    const L2 = lines[i];
    const denom = L1.dx * L2.dy - L1.dy * L2.dx;
    if (Math.abs(denom) < 1e-9) continue; // parallel adjacent edges
    const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / denom;
    out.push({ x: L1.px + L1.dx * t, y: L1.py + L1.dy * t });
  }
  return out.length >= 3 ? out : [];
}

/** Shoelace area of a polygon (world units²). */
function polyArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * Translation-invariant shape key for a (clipped) cell polygon: vertices relative to the shape's bounding
 * min, quantised. A full rectangle and a border-sliced trapezoid/triangle therefore key differently.
 */
function clipShapeKey(poly: Vec2[]): string {
  // Normalise before hashing, because the SAME panel can come out of the clipper in different guises:
  // Sutherland-Hodgman may start the ring at a different vertex, and a border edge grazing a cell leaves
  // collinear points behind. Keying the raw vertex list made 30 identical rectangles report as 3 distinct
  // panel types — inflating the very "unique panels" figure the Optimize strategies exist to minimise.
  //
  // Two passes: drop vertices that bend nothing, then rotate the ring to start at its lowest vertex.
  // Winding is preserved, so a mirrored panel stays a different part (it is, to a fabricator).
  const pts: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const prev = poly[(i + poly.length - 1) % poly.length];
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    const dup = Math.abs(cur.x - prev.x) < 1e-6 && Math.abs(cur.y - prev.y) < 1e-6;
    if (!dup && Math.abs(cross) > 1e-6) pts.push(cur);
  }
  const ring = pts.length >= 3 ? pts : poly;

  let minX = Infinity;
  let minY = Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  const q = ring.map((p) => ({ x: Math.round((p.x - minX) * 10), y: Math.round((p.y - minY) * 10) }));
  let start = 0;
  for (let i = 1; i < q.length; i++) {
    if (q[i].x < q[start].x || (q[i].x === q[start].x && q[i].y < q[start].y)) start = i;
  }
  return q
    .map((_, i) => q[(start + i) % q.length])
    .map((p) => `${p.x},${p.y}`)
    .join(';');
}

/** Angle tolerance (degrees) for clustering cut edges into one fabrication family / CNC setup. */
const CLUSTER_ANGLE_STEP = 15;

/**
 * Modular-clustering FAMILY key for a clipped cell polygon. A cut panel's identity is the (quantised) set of
 * its non-axis-aligned cut ANGLES — so every perimeter cut of the same angle is one reusable type no matter
 * its length (only the cut length varies within a family). Panels with no cut edge are standard rectangles,
 * keyed by their dimensions. This collapses a straight diagonal's many trapezoids into a single edge family.
 */
function clusterFamilyKey(poly: Vec2[]): string {
  const cuts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 1e-6) continue; // degenerate edge
    const ang = (((Math.atan2(dy, dx) * 180) / Math.PI) % 180 + 180) % 180; // [0, 180)
    const axisDist = Math.min(ang, Math.abs(ang - 90), Math.abs(ang - 180));
    if (axisDist < 1) continue; // an axis-aligned cell edge — part of the standard panel, not a cut
    cuts.push((Math.round(ang / CLUSTER_ANGLE_STEP) * CLUSTER_ANGLE_STEP) % 180);
  }
  if (cuts.length === 0) {
    // No diagonal cut → a standard (possibly edge-trimmed) rectangle; family by its dimensions.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return `rect:${Math.round((maxX - minX) * 10)}x${Math.round((maxY - minY) * 10)}`;
  }
  return `cut:${[...new Set(cuts)].sort((m, n) => m - n).join(',')}`;
}

/**
 * Assign each computed cell a flat Material-ID colour for the Lumion-style segmentation map. The trim
 * border acts as a real CLIPPING PLANE: each cell is clipped to the border, and its identity is the
 * resulting SHAPE — so a cell the border slices on a diagonal becomes a different shape and a different
 * material. Cells of IDENTICAL shape share one HUE (only truly unique shapes get a unique hue); within a
 * shared-hue group every instance gets a distinct SATURATION so duplicates stay distinguishable for
 * masking. Deterministic (groups by shape key, instances by position).
 */
/**
 * Each VISIBLE cell (clipped area > 0) with its rect and material GROUP KEY — the clipped-shape identity
 * also used by the Material-ID colours. Cells with the same key are "the same panel" (group-selectable).
 */
export function cellGroups(
  layer: FacadeLayer,
): { rect: Rect; key: string; cx: number; cy: number; border: number }[] {
  const out: { rect: Rect; key: string; cx: number; cy: number; border: number }[] = [];
  // Each border's cells are clipped to THAT border only — so its pattern is independent of the others. Keys
  // are translation-invariant, so identical panel shapes still share a material/frame across every border.
  for (let b = 0; b < layer.borders.length; b++) {
    const border = layer.borders[b];
    for (const r of borderCellRects(layer, b)) {
      // Stepped-Edge and Edge-Profile both keep only cells that fit the border, so a kept panel IS its full
      // rectangle: identity is its size. Keying off the CLIPPED polygon instead would split one panel type
      // into several, because a cell sitting a hair inside the tolerance comes back with a shaved corner —
      // which is exactly the unique-panel count these two strategies exist to collapse.
      const bmode = borderMode(layer, b);
      if (bmode === 'stepped-edge' || bmode === 'edge-profile') {
        out.push({
          rect: r,
          key: clipShapeKey(rectCorners(r)),
          cx: r.x + r.w / 2,
          cy: r.y + r.h / 2,
          border: b,
        });
        continue;
      }
      const clipped = clipCellToBorder(r, border);
      if (clipped.length < 3 || polyArea(clipped) < 1e-6) continue; // outside this border / a sliver
      // Centroid of the clipped polygon anchors a centred panel label.
      let cx = 0;
      let cy = 0;
      for (const p of clipped) {
        cx += p.x;
        cy += p.y;
      }
      const key = bmode === 'modular-cluster' ? clusterFamilyKey(clipped) : clipShapeKey(clipped);
      out.push({ rect: r, key, cx: cx / clipped.length, cy: cy / clipped.length, border: b });
    }
  }
  return out;
}

/**
 * Paint-by-number labels for the Optimize overlay: every visible panel gets the 1-based number of its shape
 * GROUP, so identical panels share a number. Groups are numbered in the SAME sorted-key order `cellIdColors`
 * uses for hues, so the numbers line up with the Material-ID colours. Returns each panel's label position
 * (clipped-polygon centroid, world units) and its group number.
 */
export function cellNumbers(layer: FacadeLayer): { cx: number; cy: number; num: number }[] {
  const groups = cellGroups(layer);
  const keys = [...new Set(groups.map((g) => g.key))].sort();
  const numByKey = new Map(keys.map((k, i) => [k, i + 1]));
  return groups.map((g) => ({ cx: g.cx, cy: g.cy, num: numByKey.get(g.key)! }));
}

/* -------------------------------------------------------------------------- */
/*  Per-panel frames (Edit-a-panel)                                            */
/* -------------------------------------------------------------------------- */

/** The frame override for a CELL, or null. */
export function panelFrameAt(layer: FacadeLayer, key: string): GroupFrame | null {
  return layer.frames?.[key] ?? null;
}

/** The inset "glass" rect of a cell once its per-edge frame widths are removed (n=top … w=left). */
export function frameInnerRect(rect: Rect, f: GroupFrame): Rect {
  return {
    x: rect.x + f.w,
    y: rect.y + f.n,
    w: Math.max(0, rect.w - f.w - f.e),
    h: Math.max(0, rect.h - f.n - f.s),
  };
}

/**
 * The frame band geometry for one panel cell: its visible (border-clipped) OUTER outline and the inner GLASS
 * polygon. The glass is the cell inset by the per-edge frame widths AND inset from the trim border by the frame
 * width — so a panel the border slices gets a mullion that runs ALONG the (possibly diagonal) border edge, and
 * the whole band re-fits live whenever the border is moved. The band itself is `outer` minus `glass`
 * (even-odd). Returns null when the panel isn't visible.
 */
export function panelFrameBand(
  layer: FacadeLayer,
  rect: Rect,
  frame: GroupFrame,
): { outer: Vec2[]; glass: Vec2[] } | null {
  const border = borderContaining(layer, rect);
  const clip = border.length >= 3;
  const outer = clip ? clipCellToBorder(rect, border) : rectCorners(rect);
  if (outer.length < 3) return null;
  // Inset the ACTUAL panel outline edge-by-edge: an edge lying on a cell side uses that side's width; any other
  // edge (the diagonal / border cut) uses `b`. This keeps the mullion a single clean inset of the visible shape
  // — no reference to the full rectangle's edges past the border, so orthogonal and border frames miter cleanly.
  const bWidth = frame.b ?? (frame.n + frame.e + frame.s + frame.w) / 4;
  const edgeWidth = (i: number): number => {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    if (Math.abs(a.x - b.x) < 1e-6) {
      // vertical edge → a left/right cell side, if it sits on the cell boundary
      if (Math.abs(a.x - rect.x) < 1e-6) return frame.w;
      if (Math.abs(a.x - (rect.x + rect.w)) < 1e-6) return frame.e;
    } else if (Math.abs(a.y - b.y) < 1e-6) {
      // horizontal edge → a top/bottom cell side
      if (Math.abs(a.y - rect.y) < 1e-6) return frame.n;
      if (Math.abs(a.y - (rect.y + rect.h)) < 1e-6) return frame.s;
    }
    return bWidth; // diagonal or any non-cell-boundary border edge
  };
  const glass = insetConvexPolygon(outer, edgeWidth);
  return { outer, glass: glass.length >= 3 ? glass : [] };
}

/**
 * Every DIAGONAL border-cut edge of a panel's clipped outline (segments lying along a non-axis-aligned trim
 * border edge). These are the grab targets for dragging the frame that runs along the border; a corner panel
 * cut by two border edges returns both. Straight border edges are excluded — they're covered by n/e/s/w.
 */
export function panelBorderEdges(layer: FacadeLayer, rect: Rect): [Vec2, Vec2][] {
  const border = borderContaining(layer, rect);
  if (border.length < 3) return [];
  const poly = clipCellToBorder(rect, border);
  if (poly.length < 3) return [];
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (Math.abs(b.x - a.x) < 1e-6 || Math.abs(b.y - a.y) < 1e-6) continue; // axis-aligned → an n/e/s/w edge
    for (let k = 0; k < border.length; k++) {
      const c = border[k];
      const d = border[(k + 1) % border.length];
      if (distToSegment(a, c, d) < 1e-6 && distToSegment(b, c, d) < 1e-6) {
        out.push([a, b]);
        break;
      }
    }
  }
  return out;
}

/** The rect of a specific CELL (representative panel for the camera focus + edge hit-testing). */
export function representativeCell(layer: FacadeLayer, cell: string): Rect | null {
  for (const g of cellGroups(layer)) if (cellKey(g.rect) === cell) return g.rect;
  return null;
}

/**
 * Seed a uniform frame (all four sides = `widthWorld`) on every given CELL that has no override yet.
 * Returns true if anything was added. Used when an Edit session first opens on a selection.
 */
export function seedPanelFrames(layer: FacadeLayer, keys: Iterable<string>, widthWorld: number): boolean {
  if (!layer.frames) layer.frames = {};
  let added = false;
  for (const key of keys) {
    if (!layer.frames[key]) {
      layer.frames[key] = { n: widthWorld, e: widthWorld, s: widthWorld, w: widthWorld, b: widthWorld };
      added = true;
    }
  }
  return added;
}

/** Write the full per-edge frame to every given CELL — exactly the panels selected, no others. */
export function setPanelFrame(layer: FacadeLayer, keys: Iterable<string>, frame: GroupFrame): void {
  if (!layer.frames) layer.frames = {};
  for (const key of keys) layer.frames[key] = { ...frame };
}

/** The assigned panel material kind for a CELL, or null. */
export function panelKindAt(layer: FacadeLayer, key: string): PanelKind | null {
  return layer.panelKinds?.[key] ?? null;
}

/**
 * Assign a panel material kind to every given CELL, or clear it with null.
 *
 * Keyed per CELL, not per shape. Keying by clipped-shape meant assigning a material to one panel silently
 * repainted every identical panel on the elevation — which is not a choice a facade designer can express
 * ("this bay is spandrel, the one beside it is vision" is the normal case). Selecting several panels and
 * assigning once still covers the batch; that is what the selection is for.
 */
export function setPanelKind(layer: FacadeLayer, keys: Iterable<string>, kind: PanelKind | null): void {
  if (!layer.panelKinds) layer.panelKinds = {};
  for (const key of keys) {
    if (kind) layer.panelKinds[key] = kind;
    else delete layer.panelKinds[key];
  }
}

/**
 * Run a geometry mutation (move/reshape a border, slide a line or segment) while keeping every panel's
 * frame and assigned material attached to the SAME panel. Both are keyed by cell POSITION, so anything
 * that shifts a cell would otherwise orphan its properties.
 *
 * Two rules, in order — matching purely by list position is NOT enough:
 *
 *  1. A panel whose cell key is unchanged keeps its properties outright. Growing a border only reveals
 *     more of the fixed lattice; the panels already there do not move. Re-keying them by list index is
 *     what used to corrupt this — stretching WEST or NORTH prepends the new cells, shifting every
 *     existing panel one slot down the list and dragging its material onto its neighbour.
 *  2. Whatever is left over genuinely moved (a translate, a line slide, a rescale). Those match in list
 *     order, which the shared iteration order keeps consistent across the mutation.
 *
 * No-op overhead when the layer has neither frames nor materials.
 */
export function moveLatticePreservingFrames(layer: FacadeLayer, mutate: () => void): void {
  const hasFrames = !!layer.frames && Object.keys(layer.frames).length > 0;
  const hasKinds = !!layer.panelKinds && Object.keys(layer.panelKinds).length > 0;
  if (!hasFrames && !hasKinds) {
    mutate();
    return;
  }
  const before = cellGroups(layer).map((g) => cellKey(g.rect));
  const perFrame = before.map((k) => (hasFrames ? layer.frames![k] ?? null : null));
  const perKind = before.map((k) => (hasKinds ? layer.panelKinds![k] ?? null : null));
  mutate();
  const after = cellGroups(layer).map((g) => cellKey(g.rect));

  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const nextFrames: Record<string, GroupFrame> = {};
  const nextKinds: Record<string, PanelKind> = {};
  const put = (key: string, i: number) => {
    const f = perFrame[i];
    if (f) nextFrames[key] = { ...f };
    const kind = perKind[i];
    if (kind) nextKinds[key] = kind;
  };

  // 1. Panels that stayed exactly where they were.
  const moved: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (afterSet.has(before[i])) put(before[i], i);
    else moved.push(i);
  }
  // 2. Panels that shifted, paired with the new positions nothing else claimed.
  const vacated = after.filter((k) => !beforeSet.has(k));
  const n = Math.min(moved.length, vacated.length);
  for (let k = 0; k < n; k++) put(vacated[k], moved[k]);

  if (hasFrames) layer.frames = nextFrames;
  if (hasKinds) layer.panelKinds = nextKinds;
}

/**
 * Panel rationalization metric: how many VISIBLE panels there are and how many are UNIQUE shapes. "Unique"
 * counts distinct clipped-shape keys — exactly the number of distinct hues in the Material-ID view — so it is
 * the quantity the Optimize strategies aim to minimize. Computed from the same `cellGroups`/`clipShapeKey`
 * path that drives the segmentation colours.
 */
export function panelStats(layer: FacadeLayer): { total: number; unique: number } {
  if (!hasBoundary(layer)) return { total: 0, unique: 0 };
  const groups = cellGroups(layer);
  return { total: groups.length, unique: new Set(groups.map((g) => g.key)).size };
}

/** Per-material figures behind the live facade readouts. See {@link PANEL_PERFORMANCE}. */
interface PanelPerformance {
  /** Assembly U-factor, Btu/h·ft²·°F (lower = better insulated). */
  uValue: number;
  /** Supply + install, US$ per ft² of facade — the all-in rate a cost plan carries, not material only. */
  costPerSqft: number;
  /** Share of the panel's area that is vision glass, 0–1 — what the window-to-wall ratio counts. */
  visionFraction: number;
}

/**
 * Nominal performance + cost per panel material.
 *
 * PLACEHOLDER DATA — mid-market US rates for a unitised curtain wall, right to an order of magnitude but
 * not a specification. Real numbers come from the assembly's tested NFRC/ASHRAE data and a live cost book;
 * wire those in here and every readout that reads from this table follows.
 */
const PANEL_PERFORMANCE: Record<PanelKind, PanelPerformance> = {
  vision1: { uValue: 1.04, costPerSqft: 58, visionFraction: 1 },
  vision2: { uValue: 0.48, costPerSqft: 82, visionFraction: 1 },
  vision3: { uValue: 0.28, costPerSqft: 118, visionFraction: 1 },
  spandrel: { uValue: 0.32, costPerSqft: 64, visionFraction: 0 },
  solid: { uValue: 0.09, costPerSqft: 52, visionFraction: 0 },
  cladding: { uValue: 0.07, costPerSqft: 95, visionFraction: 0 },
  louver: { uValue: 1.2, costPerSqft: 105, visionFraction: 0 },
};

/**
 * What a panel counts as before the user assigns it a material: a generic unitised bay, part vision and
 * part spandrel, at a blended rate. Treating unassigned panels as full vision units (the obvious shortcut)
 * both reads WWR 100% — which is not a real facade — and prices the whole elevation at the glass rate.
 */
const UNASSIGNED_PANEL: PanelPerformance = { uValue: 0.42, costPerSqft: 68, visionFraction: 0.55 };

/** Live facade readouts for the active layer — see {@link facadeMetrics}. */
export interface FacadeMetrics {
  /** Visible panels across every border. */
  panels: number;
  /** Distinct panel SHAPES — the fabrication types to be tooled and tracked. */
  types: number;
  /** Repetition: share of panels that reuse an existing type, 0–100. Higher ⇒ cheaper to fabricate. */
  standardizationPct: number;
  /** Total clipped facade area, ft². */
  areaSqft: number;
  /** Window-to-wall ratio: vision-glass area ÷ facade area, 0–100. */
  wwrPct: number;
  /** Area-weighted assembly U-factor, Btu/h·ft²·°F. */
  uValue: number;
  /** Supply + install estimate, US$. */
  cost: number;
}

/**
 * Live facade engineering readouts for the active layer, computed from the real partition: panel and type
 * counts, clipped areas (so a border-sliced panel contributes only the glass that survives the cut), and
 * area-weighted performance rolled up from {@link PANEL_PERFORMANCE}. `worldPerFoot` converts world units
 * to feet so the caller owns the unit scale.
 *
 * The geometry is real; the per-material performance and cost constants are placeholders (see that table).
 */
export function facadeMetrics(layer: FacadeLayer, worldPerFoot: number): FacadeMetrics {
  const empty: FacadeMetrics = {
    panels: 0,
    types: 0,
    standardizationPct: 0,
    areaSqft: 0,
    wwrPct: 0,
    uValue: 0,
    cost: 0,
  };
  if (!hasBoundary(layer)) return empty;

  const sqftPerWorld = 1 / (worldPerFoot * worldPerFoot);
  const keys = new Set<string>();
  let panels = 0;
  let areaSqft = 0;
  let visionSqft = 0;
  let uArea = 0; // Σ (U × area) — divided by total area for the area-weighted U-factor
  let cost = 0;

  for (let b = 0; b < layer.borders.length; b++) {
    const border = layer.borders[b];
    for (const rect of borderCellRects(layer, b)) {
      // Stepped-Edge keeps whole rectangles; every other mode bills only the area inside the trim.
      const bmode = borderMode(layer, b);
      const poly =
        bmode === 'stepped-edge' ? rectCorners(rect) : clipCellToBorder(rect, border);
      if (poly.length < 3) continue;
      const areaWorld = polyArea(poly);
      if (areaWorld < 1e-6) continue;
      const key = bmode === 'modular-cluster' ? clusterFamilyKey(poly) : clipShapeKey(poly);
      keys.add(key);
      panels += 1;
      const sqft = areaWorld * sqftPerWorld;
      areaSqft += sqft;
      const kind = panelKindAt(layer, cellKey(rect));
      const perf = kind ? PANEL_PERFORMANCE[kind] : UNASSIGNED_PANEL;
      visionSqft += perf.visionFraction * sqft;
      uArea += perf.uValue * sqft;
      cost += perf.costPerSqft * sqft;
    }
  }

  if (panels === 0) return empty;
  return {
    panels,
    types: keys.size,
    standardizationPct: Math.round((1 - keys.size / panels) * 100),
    areaSqft: Math.round(areaSqft),
    wwrPct: areaSqft > 0 ? Math.round((visionSqft / areaSqft) * 100) : 0,
    uValue: areaSqft > 0 ? uArea / areaSqft : 0,
    cost: Math.round(cost),
  };
}

/** Is a world point inside ANY of the layer's trim borders? (False before a boundary is drawn.) */
export function pointInBorder(layer: FacadeLayer, pt: Vec2): boolean {
  return hasBoundary(layer) && borderPolygons(layer).some((b) => pointInPolygon(pt, b));
}

/**
 * Positional identity of ONE panel — its cell rect, quantised. A material GROUP key is shared by every
 * identical panel on the facade, so it can't name a single one; this can. Selection is stored as cell keys so
 * a rubber-band sweep selects only the panels it actually covered, the way a Plan-mode marquee does.
 *
 * The lattice is recomputed each frame at the same coordinates, so a key stays valid until the grid or border
 * genuinely moves — after which stale keys simply stop matching and the selection lapses (the callers that
 * reshape a border clear it outright).
 */
export function cellKey(rect: Rect): string {
  const q = (v: number) => Math.round(v * 1000);
  return `${q(rect.x)}:${q(rect.y)}:${q(rect.w)}:${q(rect.h)}`;
}

/** Every visible panel's cell key whose rect overlaps the given world rect (for rubber-band multi-select). */
export function cellKeysInRect(layer: FacadeLayer, rect: Rect): string[] {
  const keys = new Set<string>();
  for (const { rect: r } of cellGroups(layer)) {
    // Axis-aligned overlap: the marquee selects any panel it touches — and ONLY those.
    if (r.x < rect.x + rect.w && r.x + r.w > rect.x && r.y < rect.y + rect.h && r.y + r.h > rect.y) {
      keys.add(cellKey(r));
    }
  }
  return [...keys];
}

/** Every cell key in the material group `groupKey` — a click selects a panel's whole group. */
export function groupCellKeys(layer: FacadeLayer, groupKey: string): string[] {
  const keys: string[] = [];
  for (const g of cellGroups(layer)) if (g.key === groupKey) keys.push(cellKey(g.rect));
  return keys;
}

/**
 * Has this border actually been split into panels yet?
 *
 * Until the first split a border has no grid, and {@link cellRects} reports its whole extent as ONE cell so
 * the boundary still paints as a solid surface. That pseudo-panel is a drawing convenience, not a panel: it
 * is the raw elevation the user has yet to subdivide. Anything that reasons about panels as fabricated units
 * — above all the facade constraints — has to ask this first, or it will measure the entire facade as a
 * single enormous sheet of glass.
 */
export function isSubdivided(layer: FacadeLayer, border: number): boolean {
  return layer.grids[border] != null;
}

/** True once ANY border on the layer has been split — i.e. the facade has real panels to reason about. */
export function hasPanels(layer: FacadeLayer): boolean {
  return layer.borders.some((_, b) => isSubdivided(layer, b));
}

/** The live panel rects behind a set of selected cell keys (keys are positional, so stale ones drop out). */
export function cellRectsOf(layer: FacadeLayer, cells: Set<string>): Rect[] {
  const out: Rect[] = [];
  for (const g of cellGroups(layer)) if (cells.has(cellKey(g.rect))) out.push(g.rect);
  return out;
}

/**
 * The world extent of the current panel selection: one panel's own rect, or the box enclosing several.
 * The floating panel menu hangs off the BOTTOM CENTRE of this rect and reads its width/height, so the bar
 * follows whatever is selected — no right-click, and no re-anchoring when the selection grows.
 */
export function selectedCellsExtent(layer: FacadeLayer, cells: Set<string>): Rect | null {
  const rects = cellRectsOf(layer, cells);
  if (!rects.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The world extent of the selected BORDERS — Border mode's equivalent of {@link selectedCellsExtent}, so the
 * floating menu can hang under a freshly placed boundary before it has any panels to select.
 */
export function selectedBordersExtent(layer: FacadeLayer, indices: Set<number>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const i of indices) {
    const poly = layer.borders[i];
    if (!poly) continue;
    const b = polyBBox(poly);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
    count++;
  }
  if (!count) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The distinct material GROUP keys behind a set of selected cells — the bridge back to the group-level
 * operations (assign material, Edit-a-panel frames) that still act on a whole panel type at once.
 */
export function groupKeysOfCells(layer: FacadeLayer, cells: Set<string>): string[] {
  const keys = new Set<string>();
  for (const g of cellGroups(layer)) if (cells.has(cellKey(g.rect))) keys.add(g.key);
  return [...keys];
}

/**
 * The CELL key of the panel under a world point — the individual unit, not its material group. This is
 * what a paint stroke collects: dragging across the elevation adds exactly the panels the cursor touched,
 * leaving their identical twins elsewhere alone.
 */
export function cellKeyAt(layer: FacadeLayer, pt: Vec2): string | null {
  if (!pointInBorder(layer, pt)) return null;
  for (const { rect: r } of cellGroups(layer)) {
    if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return cellKey(r);
  }
  return null;
}

/** The material group key of the cell under a world point (for group-select), or null. */
export function cellGroupAt(layer: FacadeLayer, pt: Vec2): string | null {
  if (!pointInBorder(layer, pt)) return null;
  for (const { rect: r, key } of cellGroups(layer)) {
    if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return key;
  }
  return null;
}

export function cellIdColors(layer: FacadeLayer): { rect: Rect; color: string; key: string }[] {
  const groups = cellGroups(layer);
  const byKey = new Map<string, number[]>();
  groups.forEach((g, i) => {
    const arr = byKey.get(g.key);
    if (arr) arr.push(i);
    else byKey.set(g.key, [i]);
  });
  // Deterministic group order → stable hues; golden-angle spacing keeps distinct materials contrasting.
  const keys = [...byKey.keys()].sort();
  const colors = new Array<string>(groups.length);
  keys.forEach((key, gi) => {
    const idxs = byKey.get(key)!;
    idxs.sort((a, b) => groups[a].rect.y - groups[b].rect.y || groups[a].rect.x - groups[b].rect.x);
    const hue = (gi * 137.508) % 360;
    const n = idxs.length;
    idxs.forEach((ci, k) => {
      const frac = n === 1 ? 0 : k / (n - 1);
      colors[ci] = hslToHex(hue, 1 - 0.5 * frac, 0.5); // 100% → 50% saturation across the group
    });
  });
  return groups.map((g, i) => ({ rect: g.rect, color: colors[i], key: g.key }));
}

/** Distance from point p to segment a–b (world units). */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Even-odd ray cast: is the world point inside the (possibly angled) polygon? */
function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** The world rect a `CellRef` refers to (what a split applies to) — for the split-preview overlay. */
export function cellRefRect(layer: FacadeLayer, ref: CellRef): Rect | null {
  const poly = layer.borders[ref.border];
  if (!poly) return null;
  const anchor = layer.roots[ref.border] ?? polyBBox(poly);
  if (ref.kind === 'root') return anchor;
  const g = layer.grids[ref.border];
  if (!g) return null;
  let rect = baseCellRect(g, ref.i, ref.j);
  let cell: Cell | undefined = g.subdiv[baseKey(ref.i, ref.j)];
  for (const idx of ref.path) {
    if (!cell?.grid) break;
    const rects = childRects(rect, cell.grid);
    if (idx < 0 || idx >= rects.length) break;
    rect = rects[idx];
    cell = cell.grid.children[idx];
  }
  return rect;
}

/** The cell under a world point (for right-click split), clipped to the trim border. Null when outside. */
export function hitCell(layer: FacadeLayer, pt: Vec2): CellRef | null {
  const b = borderIndexAt(layer, pt);
  if (b == null) return null;
  const g = layer.grids[b];
  if (!g) return { border: b, kind: 'root' };
  const i = Math.floor((pt.x - g.originX) / g.pitchX);
  const j = Math.floor((pt.y - g.originY) / g.pitchY);
  const sub = g.subdiv[baseKey(i, j)];
  const path = sub ? descendTree(sub, baseCellRect(g, i, j), pt) : [];
  return { border: b, kind: 'base', i, j, path };
}

/**
 * Split a cell into `cols × rows`. Splitting the un-gridded root establishes the fixed-pitch base lattice
 * (pitch = root size / counts); splitting a base cell subdivides just that fixed-size cell (recursively).
 */
export function splitCell(layer: FacadeLayer, ref: CellRef, cols: number, rows: number): void {
  const poly = layer.borders[ref.border];
  if (!poly) return;
  if (ref.kind === 'root') {
    const c = clampCount(cols);
    const r = clampCount(rows);
    if (c === 1 && r === 1) return;
    const anchor = layer.roots[ref.border] ?? polyBBox(poly);
    layer.grids[ref.border] = {
      originX: anchor.x,
      originY: anchor.y,
      pitchX: anchor.w / c,
      pitchY: anchor.h / r,
      colX: {},
      rowY: {},
      segX: {},
      segY: {},
      extraX: [],
      extraY: [],
      extraSegX: {},
      extraSegY: {},
      subdiv: {},
    };
    return;
  }
  const g = layer.grids[ref.border];
  if (!g) return;
  const key = baseKey(ref.i, ref.j);
  let sub = g.subdiv[key];
  if (!sub) sub = g.subdiv[key] = newCell();
  splitCellAt(sub, ref.path, cols, rows);
  // A base cell flattened back to a single leaf needs no entry — keep the map clean.
  if (ref.path.length === 0 && !sub.grid) delete g.subdiv[key];
}

export type BoundaryEdge = 'n' | 'e' | 's' | 'w';

/** The topmost border (last-placed wins) whose interior contains the world point, or null. */
export function borderIndexAt(layer: FacadeLayer, pt: Vec2): number | null {
  const polys = layer.borders;
  for (let i = polys.length - 1; i >= 0; i--) {
    if (pointInPolygon(pt, polys[i])) return i;
  }
  return null;
}

/** Remove border `index` and its parallel anchor/grid entries together (keeps the arrays in lock-step). */
function removeBorderAt(layer: FacadeLayer, index: number): void {
  layer.borders.splice(index, 1);
  layer.roots.splice(index, 1);
  layer.grids.splice(index, 1);
}

/** Do two segments p1→p2 and p3→p4 properly cross (transversal; collinear touches ignored)? */
function segmentsCross(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const side = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = side(p3, p4, p1);
  const d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3);
  const d4 = side(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Do two polygons overlap (share interior area)? Vertex-in-polygon plus an edge-crossing test (catches the
 *  plus/cross case where neither polygon has a vertex inside the other). */
export function polygonsOverlap(a: Vec2[], b: Vec2[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (const p of a) if (pointInPolygon(p, b)) return true;
  for (const p of b) if (pointInPolygon(p, a)) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/**
 * UNITE two overlapping borders into one (boolean union). Border `a` absorbs `b`: its polygon becomes the
 * merged (possibly concave) outline and it keeps its OWN anchor/grid, so its pattern fills across the larger
 * region; border `b` is dropped. No-op (returns false) when the union is empty/disjoint.
 */
export function uniteBorders(layer: FacadeLayer, a: number, b: number): boolean {
  const pa = layer.borders[a];
  const pb = layer.borders[b];
  if (!pa || !pb) return false;
  const merged = polygonUnion(pa, pb);
  if (!merged || merged.length < 3) return false;
  layer.borders[a] = merged.map((p) => ({ x: p.x, y: p.y }));
  removeBorderAt(layer, b);
  return true;
}

/**
 * DIFFERENCE: subtract border `other` from `target` (boolean difference). `target` becomes the (possibly
 * concave) remainder and KEEPS its own anchor/grid — its pattern is unchanged, just clipped to the smaller
 * region; `other` is left untouched. If `target` is fully consumed it is removed. Returns whether it changed.
 */
export function differenceBorders(layer: FacadeLayer, target: number, other: number): boolean {
  const pt = layer.borders[target];
  const po = layer.borders[other];
  if (!pt || !po) return false;
  const result = polygonDifference(pt, po);
  if (result && result.length >= 3) {
    layer.borders[target] = result.map((p) => ({ x: p.x, y: p.y }));
  } else {
    removeBorderAt(layer, target); // wholly subtracted away
  }
  return true;
}

/** Shortest distance from `p` to any edge of polygon `poly`. */
function distToPolygonBoundary(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, distToSegment(p, poly[j], poly[i]));
  }
  return best;
}

/**
 * Classify a world hover point over two picked, OVERLAPPING borders — the in-canvas boolean trigger that
 * replaces the old Combine buttons (and mirrors the Plan-mode room booleans). Returns:
 *   • `union`      — the cursor is in the shared interior (the cyan region); a click UNITES the two.
 *   • `difference` — the cursor is on/near an EDGE that bounds the shared interior; a click SUBTRACTS that
 *                    edge's border from the other (clicking border X's edge trims X, like the Plan-mode wall
 *                    click). `tol` is the world-space pick radius for the edge test.
 * Null when fewer/more than two are picked, they don't overlap, or the cursor is elsewhere.
 */
export type BorderBooleanHover =
  | { kind: 'union'; a: number; b: number }
  | { kind: 'difference'; target: number; other: number };

export function borderBooleanHoverAt(
  layer: FacadeLayer,
  selected: Set<number>,
  pt: Vec2,
  tol: number,
): BorderBooleanHover | null {
  const idx = [...selected].filter((i) => i >= 0 && i < layer.borders.length);
  if (idx.length !== 2) return null;
  const [i, j] = idx;
  const polys = borderPolygons(layer);
  const A = polys[i];
  const B = polys[j];
  if (!A || !B || !polygonsOverlap(A, B)) return null;
  const inA = pointInPolygon(pt, A);
  const inB = pointInPolygon(pt, B);
  // Near an edge running through the shared interior → subtract that edge's border from the other.
  // (A's boundary inside B, or B's boundary inside A; whichever edge is closer wins on a lens corner.)
  const dA = inB ? distToPolygonBoundary(pt, A) : Infinity;
  const dB = inA ? distToPolygonBoundary(pt, B) : Infinity;
  if (dA <= tol || dB <= tol) {
    return dA <= dB
      ? { kind: 'difference', target: i, other: j }
      : { kind: 'difference', target: j, other: i };
  }
  // Strictly inside both, clear of either edge → the shared interior: a click UNITES.
  if (inA && inB) return { kind: 'union', a: i, b: j };
  return null;
}

/** Rigidly translate the fixed-pitch lattice (origin + every absolute override/extra) by (dx, dy). Cell
 *  indices and subdivision keys are relative to the origin, so they need no change. */
function translateGrid(g: BaseGrid, dx: number, dy: number): void {
  g.originX += dx;
  g.originY += dy;
  for (const k in g.colX) g.colX[k] += dx;
  for (const k in g.rowY) g.rowY[k] += dy;
  for (const k in g.segX) g.segX[k] += dx;
  for (const k in g.segY) g.segY[k] += dy;
  g.extraX = g.extraX.map((v) => v + dx);
  g.extraY = g.extraY.map((v) => v + dy);
  for (const k in g.extraSegX) g.extraSegX[k] = g.extraSegX[k].map((v) => v + dx);
  for (const k in g.extraSegY) g.extraSegY[k] = g.extraSegY[k].map((v) => v + dy);
}

/**
 * Translate a border by (dx, dy). Each border carries its OWN anchor + lattice, so its panels travel rigidly
 * with it like a room — and moving one border never disturbs another's pattern.
 */
export function moveBorder(layer: FacadeLayer, index: number, dx: number, dy: number): void {
  const poly = layer.borders[index];
  if (!poly) return;
  for (const p of poly) {
    p.x += dx;
    p.y += dy;
  }
  const root = layer.roots[index];
  if (root) {
    root.x += dx;
    root.y += dy;
  }
  const grid = layer.grids[index];
  if (grid) translateGrid(grid, dx, dy);
}

/**
 * Deep-copy border `index` — its outline, anchor rect, and whole lattice — offset by (dx, dy) and appended
 * on top. The copy is fully independent, so editing either one's panels leaves the other alone. Returns the
 * new border's index, or null when `index` names no border. This is the Layers-tool answer to Alt-dragging
 * a room in Plan mode.
 */
/** The cell keys of ONE border's visible panels, in the order `cellGroups` walks them. */
function borderCellKeys(layer: FacadeLayer, border: number): string[] {
  const out: string[] = [];
  for (const g of cellGroups(layer)) if (g.border === border) out.push(cellKey(g.rect));
  return out;
}

/**
 * Copy every per-panel frame and material from one border's cells onto another's, matched in positional
 * order. Panel properties are keyed by cell POSITION, so a copy of a shape starts blank unless its panels
 * are re-keyed onto the new positions — which is what makes a duplicated facade arrive fully clad rather
 * than stripped back to bare glass.
 */
function copyPanelProps(layer: FacadeLayer, from: number, to: number): void {
  const src = borderCellKeys(layer, from);
  const dst = borderCellKeys(layer, to);
  const n = Math.min(src.length, dst.length);
  for (let k = 0; k < n; k++) {
    const f = layer.frames?.[src[k]];
    if (f) {
      if (!layer.frames) layer.frames = {};
      layer.frames[dst[k]] = { ...f };
    }
    const kind = layer.panelKinds?.[src[k]];
    if (kind) {
      if (!layer.panelKinds) layer.panelKinds = {};
      layer.panelKinds[dst[k]] = kind;
    }
  }
}

export function duplicateBorder(layer: FacadeLayer, index: number, dx = 0, dy = 0): number | null {
  const poly = layer.borders[index];
  if (!poly) return null;
  layer.borders.push(poly.map((p) => ({ x: p.x, y: p.y })));
  const root = layer.roots[index];
  layer.roots.push(root ? { ...root } : { x: 0, y: 0, w: 0, h: 0 });
  const grid = layer.grids[index];
  layer.grids.push(grid ? (JSON.parse(JSON.stringify(grid)) as typeof grid) : null);
  const next = layer.borders.length - 1;
  if (dx || dy) moveBorder(layer, next, dx, dy);
  copyPanelProps(layer, index, next); // the copy arrives with the original's frames + materials
  return next;
}

/** One border lifted out of a layer — outline, lattice anchor, and grid — for the copy/paste clipboard. */
export interface BorderSnapshot {
  border: Vec2[];
  root: Rect | null;
  grid: BaseGrid | null;
}

/** Detached deep copies of the given borders, in index order (the Layers-tool answer to Ctrl+C). */
export function copyBorders(layer: FacadeLayer, indices: Iterable<number>): BorderSnapshot[] {
  const out: BorderSnapshot[] = [];
  for (const i of [...new Set(indices)].sort((a, b) => a - b)) {
    const poly = layer.borders[i];
    if (!poly) continue;
    const root = layer.roots[i];
    const grid = layer.grids[i];
    out.push({
      border: poly.map((p) => ({ x: p.x, y: p.y })),
      root: root ? { ...root } : null,
      grid: grid ? (JSON.parse(JSON.stringify(grid)) as BaseGrid) : null,
    });
  }
  return out;
}

/**
 * Append clipboard borders to the layer, offset by (dx, dy) so a paste lands clear of its source. Copies the
 * snapshots again on the way in, so pasting twice can't alias one clipboard entry into two live borders.
 * Returns the new borders' indices.
 */
export function pasteBorders(
  layer: FacadeLayer,
  snapshots: BorderSnapshot[],
  dx = 0,
  dy = 0,
): number[] {
  const added: number[] = [];
  for (const snap of snapshots) {
    layer.borders.push(snap.border.map((p) => ({ x: p.x, y: p.y })));
    layer.roots.push(snap.root ? { ...snap.root } : null);
    layer.grids.push(snap.grid ? (JSON.parse(JSON.stringify(snap.grid)) as BaseGrid) : null);
    const i = layer.borders.length - 1;
    if (dx || dy) moveBorder(layer, i, dx, dy);
    added.push(i);
  }
  return added;
}

/**
 * Delete the given borders (and their anchors + lattices). Removes highest-index first so the earlier
 * indices stay valid mid-loop. Returns true when anything was removed.
 */
export function removeBorders(layer: FacadeLayer, indices: Iterable<number>): boolean {
  const sorted = [...new Set(indices)]
    .filter((i) => i >= 0 && i < layer.borders.length)
    .sort((a, b) => b - a);
  for (const i of sorted) removeBorderAt(layer, i);
  return sorted.length > 0;
}

/** A border corner hit: which border (index into `borders`) and which corner (0..3, [NW,NE,SE,SW]). */
export interface BorderCornerHit {
  border: number;
  corner: number;
}

/** Which border corner a world point is near (within `tol`), across all borders, or null. */
export function hitBorderCorner(layer: FacadeLayer, pt: Vec2, tol: number): BorderCornerHit | null {
  const polys = borderPolygons(layer);
  let best: BorderCornerHit | null = null;
  let bestDist = tol;
  polys.forEach((poly, b) => {
    poly.forEach((c, i) => {
      const d = Math.hypot(pt.x - c.x, pt.y - c.y);
      if (d < bestDist) {
        bestDist = d;
        best = { border: b, corner: i };
      }
    });
  });
  return best;
}

/**
 * EDGE NORMALIZATION rationalization (Optimize → "Edge Normalization"). Snap every trim-border corner onto
 * the nearest MASTER-GRID intersection (the default lattice node `origin + index·pitch`). Clamping the border
 * to the modular grid makes each border edge run node-to-node, so its slope becomes a rational number of grid
 * pitches and the sequence of perimeter cuts REPEATS periodically — collapsing many unique edge panels into a
 * few (a ~45° edge, slope 1:1, collapses to a single repeating cut). The sub-cell deviation the user drew is
 * absorbed into the snap. No-op when there is no lattice yet, or if nothing moved. Returns whether it changed.
 */
export function normalizeBorderToGrid(layer: FacadeLayer, border: number): boolean {
  const g = layer.grids[border];
  const poly = layer.borders[border];
  if (!g || !poly) return false; // un-split border — a single panel, nothing to rationalize
  const snapped = poly.map((p) => ({
    x: g.originX + Math.round((p.x - g.originX) / g.pitchX) * g.pitchX,
    y: g.originY + Math.round((p.y - g.originY) / g.pitchY) * g.pitchY,
  }));
  if (!snapped.some((p, i) => Math.abs(p.x - poly[i].x) > 1e-6 || Math.abs(p.y - poly[i].y) > 1e-6)) {
    return false;
  }
  layer.borders[border] = snapped;
  return true;
}

/**
 * Apply a rationalization to ONE border — the single entry point behind the Optimize menu.
 *
 * Scoped per border, not per layer: a facade routinely wants a stair-stepped tower next to a trim-banded
 * podium, and the old layer-wide switches made that impossible to express. `edge-normalize` is a one-shot
 * edit (snap the outline to the lattice); the other three are modes, so re-picking the active one clears it
 * and `null` clears it outright. Returns whether anything actually changed, so callers can skip the undo step.
 */
export function optimizeBorder(
  layer: FacadeLayer,
  border: number,
  strategy: OptimizeStrategy | null,
): boolean {
  if (!hasBoundary(layer) || border < 0 || border >= layer.borders.length) return false;
  if (!layer.grids[border]) return false; // nothing to rationalize until the shape is split
  if (strategy === 'edge-normalize') return normalizeBorderToGrid(layer, border);
  const next = strategy === borderMode(layer, border) ? null : strategy;
  return setBorderMode(layer, border, next);
}

/** Move a border corner to a world point — deforms that trim quad (the fixed cells clip, never stretch). */
/**
 * Rotate a border's outline by `deg` about the centre of `orig`'s bounding box, writing the result over
 * `layer.borders[border]`. Takes the ORIGINAL polygon rather than reading the live one so a drag applies an
 * absolute angle each frame — rotating the live outline would compound rounding error over the gesture.
 *
 * Only the outline turns. The cell lattice stays axis-aligned by design (the border is a clipping mask, not
 * a frame), so a rotated boundary re-slices the panels underneath it exactly as a dragged corner does.
 */
export function rotateBorder(layer: FacadeLayer, border: number, orig: Vec2[], deg: number): void {
  if (!layer.borders[border] || orig.length < 3) return;
  const bb = polyBBox(orig);
  const cx = bb.x + bb.w / 2;
  const cy = bb.y + bb.h / 2;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  layer.borders[border] = orig.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

export function moveBorderCorner(layer: FacadeLayer, border: number, corner: number, pt: Vec2): void {
  const poly = layer.borders[border];
  if (!poly) return;
  // Bound by the polygon's OWN length, not a quad's. A border is a quad only until it is united or
  // subtracted; after a boolean it has as many vertices as the result left it, and every one of them is
  // drawn as a grab handle — so every one has to move.
  if (corner < 0 || corner >= poly.length) return;
  poly[corner] = { x: pt.x, y: pt.y };
}

/**
 * A border edge hit: which border (index into `borders`), and the INDEX of the edge that runs from
 * `poly[edge]` to `poly[edge + 1]`. An index rather than a compass face because a border is only a quad
 * until it is united or subtracted — after a boolean the outline is an N-gon, and every one of its edges
 * has to stay grabbable. `a`/`b` are that edge's endpoints, so callers can derive its direction.
 */
export interface BorderEdgeHit {
  border: number;
  edge: number;
  a: Vec2;
  b: Vec2;
}

/** Which outer border edge a world point is near (within `tol`), across all borders, or null. */
export function hitBoundaryEdge(layer: FacadeLayer, pt: Vec2, tol: number): BorderEdgeHit | null {
  if (!hasBoundary(layer)) return null;
  let best: BorderEdgeHit | null = null;
  let bestDist = tol;
  borderPolygons(layer).forEach((poly, b) => {
    if (poly.length < 3) return;
    // Walk EVERY edge, not just the first four: a boolean result has as many as the union/difference left.
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const bp = poly[(i + 1) % poly.length];
      const d = distToSegment(pt, a, bp);
      if (d < bestDist) {
        bestDist = d;
        best = { border: b, edge: i, a, b: bp };
      }
    }
  });
  return best;
}

// The border edge stretch reuses the room/shape `stretchEdge` (see useCanvasInteractions): the grabbed
// edge offsets along its outward normal and its endpoints slide along the adjacent edges, so an angled
// edge behaves exactly like a default shape's edge.

/* -------------------------------------------------------------------------- */
/*  Inner grid lines — Excel-style whole-line drag + per-segment jog           */
/* -------------------------------------------------------------------------- */

/** Smallest gap (as a fraction of the pitch) a line/segment keeps from its neighbour. */
const MIN_LINE_GAP_FRAC = 0.15;

/**
 * Every lattice line of a split border, in world coordinates — the column x's and the row y's, OUTER edges
 * included, so consecutive entries bracket one cell.
 *
 * Exists for the guided tour, which has to aim a real drag AT a mullion: the lattice is a fixed pitch plus
 * per-line overrides, so its live positions can only be read back, never predicted from the cols × rows the
 * split was asked for. Null until the border has been split.
 */
export function gridLinePositions(
  layer: FacadeLayer,
  border: number,
): { x: number[]; y: number[] } | null {
  const g = layer.grids[border];
  if (!g) return null;
  const range = baseCellRange(layer, border);
  if (!range) return null;
  const x: number[] = [];
  const y: number[] = [];
  for (let i = range.iMin; i <= range.iMax + 1; i++) x.push(lineX(g, i));
  for (let j = range.jMin; j <= range.jMax + 1; j++) y.push(lineY(g, j));
  return { x, y };
}

/** The nearest inner grid line — a lattice column/row divider OR an extra (duplicated) line — within `tol`. */
export function hitAnyLine(layer: FacadeLayer, pt: Vec2, tol: number): LineHandle | null {
  const b = borderIndexAt(layer, pt);
  if (b == null) return null;
  const g = layer.grids[b];
  const range = g ? baseCellRange(layer, b) : null;
  if (!g || !range) return null;
  const topY = lineY(g, range.jMin);
  const botY = lineY(g, range.jMax + 1);
  const leftX = lineX(g, range.iMin);
  const rightX = lineX(g, range.iMax + 1);
  let best: LineHandle | null = null;
  let bestDist = tol;
  for (let i = range.iMin + 1; i <= range.iMax; i++) {
    const d = distToSegment(pt, { x: lineX(g, i), y: topY }, { x: lineX(g, i), y: botY });
    if (d < bestDist) {
      bestDist = d;
      best = { border: b, axis: 'v', kind: 'lattice', index: i };
    }
  }
  for (let j = range.jMin + 1; j <= range.jMax; j++) {
    const d = distToSegment(pt, { x: leftX, y: lineY(g, j) }, { x: rightX, y: lineY(g, j) });
    if (d < bestDist) {
      bestDist = d;
      best = { border: b, axis: 'h', kind: 'lattice', index: j };
    }
  }
  g.extraX.forEach((x, k) => {
    const d = distToSegment(pt, { x, y: topY }, { x, y: botY });
    if (d < bestDist) {
      bestDist = d;
      best = { border: b, axis: 'v', kind: 'extra', index: k };
    }
  });
  g.extraY.forEach((y, k) => {
    const d = distToSegment(pt, { x: leftX, y }, { x: rightX, y });
    if (d < bestDist) {
      bestDist = d;
      best = { border: b, axis: 'h', kind: 'extra', index: k };
    }
  });
  return best;
}

/** Move a grid line to a world point. Lattice lines reflow their two neighbours (sticky clamp); extra
 *  (duplicated) lines slide freely within the revealed extent. */
export function moveLine(layer: FacadeLayer, h: LineHandle, pt: Vec2): void {
  const g = layer.grids[h.border];
  if (!g) return;
  if (h.kind === 'lattice') {
    if (h.axis === 'v') {
      const gap = g.pitchX * MIN_LINE_GAP_FRAC;
      g.colX[h.index] = Math.max(lineX(g, h.index - 1) + gap, Math.min(lineX(g, h.index + 1) - gap, pt.x));
    } else {
      const gap = g.pitchY * MIN_LINE_GAP_FRAC;
      g.rowY[h.index] = Math.max(lineY(g, h.index - 1) + gap, Math.min(lineY(g, h.index + 1) - gap, pt.y));
    }
    return;
  }
  const range = baseCellRange(layer, h.border);
  if (!range) return;
  if (h.axis === 'v') {
    g.extraX[h.index] = Math.max(lineX(g, range.iMin), Math.min(lineX(g, range.iMax + 1), pt.x));
  } else {
    g.extraY[h.index] = Math.max(lineY(g, range.jMin), Math.min(lineY(g, range.jMax + 1), pt.y));
  }
}

/** Duplicate a line: add an extra divider at a world position in border `border`'s lattice; return a handle. */
export function duplicateLine(
  layer: FacadeLayer,
  border: number,
  axis: 'v' | 'h',
  pos: number,
): LineHandle | null {
  const g = layer.grids[border];
  if (!g) return null;
  if (axis === 'v') {
    g.extraX.push(pos);
    return { border, axis: 'v', kind: 'extra', index: g.extraX.length - 1 };
  }
  g.extraY.push(pos);
  return { border, axis: 'h', kind: 'extra', index: g.extraY.length - 1 };
}

/** Candidate snap positions for an axis within border `border` — its parallel lines (lattice + extras). */
export function lineCandidates(
  layer: FacadeLayer,
  border: number,
  axis: 'v' | 'h',
  exclude?: LineHandle,
): number[] {
  const g = layer.grids[border];
  const range = g ? baseCellRange(layer, border) : null;
  if (!g || !range) return [];
  const out: number[] = [];
  const skipLattice = (i: number) =>
    exclude?.kind === 'lattice' && exclude.axis === axis && exclude.index === i;
  const skipExtra = (k: number) =>
    exclude?.kind === 'extra' && exclude.axis === axis && exclude.index === k;
  if (axis === 'v') {
    for (let i = range.iMin; i <= range.iMax + 1; i++) if (!skipLattice(i)) out.push(lineX(g, i));
    g.extraX.forEach((x, k) => {
      if (!skipExtra(k)) out.push(x);
    });
  } else {
    for (let j = range.jMin; j <= range.jMax + 1; j++) if (!skipLattice(j)) out.push(lineY(g, j));
    g.extraY.forEach((y, k) => {
      if (!skipExtra(k)) out.push(y);
    });
  }
  return out;
}

/**
 * Whether a segment has been SPLIT off — pinned to an absolute position, independent of its parent line.
 * A split segment moves on a plain drag (no Shift); an un-split lattice segment only jogs with Shift.
 */
export function isSplitSegment(layer: FacadeLayer, sel: SegmentRef): boolean {
  const g = layer.grids[sel.border];
  if (!g) return false;
  // 'v': key is "line,cell" = "i,j" in segX; 'h': key is "cell,line" = "i,j" in segY.
  return sel.axis === 'v'
    ? g.segX[`${sel.line},${sel.cell}`] !== undefined
    : g.segY[`${sel.cell},${sel.line}`] !== undefined;
}

/** The single line SEGMENT (between two intersections) nearest a world point within `tol`, or null. */
export function hitGridSegment(layer: FacadeLayer, pt: Vec2, tol: number): SegmentRef | null {
  const b = borderIndexAt(layer, pt);
  if (b == null) return null;
  const g = layer.grids[b];
  if (!g) return null;
  const i = Math.floor((pt.x - g.originX) / g.pitchX);
  const j = Math.floor((pt.y - g.originY) / g.pitchY);
  const x0 = edgeX(g, i, j);
  const x1 = edgeX(g, i + 1, j);
  const y0 = edgeY(g, i, j);
  const y1 = edgeY(g, i, j + 1);
  const cand: { sel: SegmentRef; a: Vec2; b: Vec2 }[] = [
    { sel: { border: b, axis: 'v', line: i, cell: j }, a: { x: x0, y: y0 }, b: { x: x0, y: y1 } },
    { sel: { border: b, axis: 'v', line: i + 1, cell: j }, a: { x: x1, y: y0 }, b: { x: x1, y: y1 } },
    { sel: { border: b, axis: 'h', line: j, cell: i }, a: { x: x0, y: y0 }, b: { x: x1, y: y0 } },
    { sel: { border: b, axis: 'h', line: j + 1, cell: i }, a: { x: x0, y: y1 }, b: { x: x1, y: y1 } },
  ];
  let best: SegmentRef | null = null;
  let bestDist = tol;
  for (const c of cand) {
    const d = distToSegment(pt, c.a, c.b);
    if (d < bestDist) {
      bestDist = d;
      best = c.sel;
    }
  }
  return best;
}

/**
 * Move a single line segment to a world point — pins just that piece to an ABSOLUTE position (clamped between
 * its row/col edges). Because it stores an absolute world coordinate (not a delta from the parent line), the
 * segment is decoupled: it stays put when its parent line is later moved, and stays selectable to move again.
 */
export function moveGridSegment(layer: FacadeLayer, sel: SegmentRef, pt: Vec2): void {
  const g = layer.grids[sel.border];
  if (!g) return;
  if (sel.axis === 'v') {
    const { line: i, cell: j } = sel;
    const gap = g.pitchX * MIN_LINE_GAP_FRAC;
    const lo = edgeX(g, i - 1, j) + gap;
    const hi = edgeX(g, i + 1, j) - gap;
    g.segX[`${i},${j}`] = Math.max(lo, Math.min(hi, pt.x));
  } else {
    const { line: j, cell: i } = sel;
    const gap = g.pitchY * MIN_LINE_GAP_FRAC;
    const lo = edgeY(g, i, j - 1) + gap;
    const hi = edgeY(g, i, j + 1) - gap;
    g.segY[`${i},${j}`] = Math.max(lo, Math.min(hi, pt.y));
  }
}

/** The world endpoints of a selected segment (for the highlight), or null. */
export function segmentEndpoints(layer: FacadeLayer, sel: SegmentRef): [Vec2, Vec2] | null {
  const g = layer.grids[sel.border];
  if (!g) return null;
  if (sel.axis === 'v') {
    const { line: i, cell: j } = sel;
    const x = edgeX(g, i, j);
    return [
      { x, y: edgeY(g, i, j) },
      { x, y: edgeY(g, i, j + 1) },
    ];
  }
  const { line: j, cell: i } = sel;
  const y = edgeY(g, i, j);
  return [
    { x: edgeX(g, i, j), y },
    { x: edgeX(g, i + 1, j), y },
  ];
}

/**
 * Duplicate just the selected SEGMENT (not the whole line): add an extra PARTIAL divider confined to the
 * one base cell next to it, seeded at the segment's position, and return a handle to drag the copy.
 */
export function duplicateSegment(layer: FacadeLayer, sel: SegmentRef): ExtraSegHandle | null {
  const g = layer.grids[sel.border];
  if (!g) return null;
  if (sel.axis === 'v') {
    const i = sel.line;
    const j = sel.cell;
    const key = baseKey(i, j);
    if (!g.extraSegX[key]) g.extraSegX[key] = [];
    g.extraSegX[key].push(edgeX(g, i, j));
    return { border: sel.border, axis: 'v', i, j, index: g.extraSegX[key].length - 1 };
  }
  const j = sel.line;
  const i = sel.cell;
  const key = baseKey(i, j);
  if (!g.extraSegY[key]) g.extraSegY[key] = [];
  g.extraSegY[key].push(edgeY(g, i, j));
  return { border: sel.border, axis: 'h', i, j, index: g.extraSegY[key].length - 1 };
}

/** Move a copied partial segment within its base cell (clamped between the cell's edges). */
export function moveSegmentExtra(layer: FacadeLayer, h: ExtraSegHandle, pt: Vec2): void {
  const g = layer.grids[h.border];
  if (!g) return;
  const key = baseKey(h.i, h.j);
  if (h.axis === 'v') {
    const arr = g.extraSegX[key];
    if (!arr || h.index < 0 || h.index >= arr.length) return;
    const gap = g.pitchX * MIN_LINE_GAP_FRAC;
    arr[h.index] = Math.max(edgeX(g, h.i, h.j) + gap, Math.min(edgeX(g, h.i + 1, h.j) - gap, pt.x));
  } else {
    const arr = g.extraSegY[key];
    if (!arr || h.index < 0 || h.index >= arr.length) return;
    const gap = g.pitchY * MIN_LINE_GAP_FRAC;
    arr[h.index] = Math.max(edgeY(g, h.i, h.j) + gap, Math.min(edgeY(g, h.i, h.j + 1) - gap, pt.y));
  }
}

/* -------------------------------------------------------------------------- */
/*  Summary                                                                    */
/* -------------------------------------------------------------------------- */

export interface FacadeSummary {
  layerCount: number;
  activeIndex: number;
  /** True when the active layer has no boundary yet (the canvas is in draw mode). */
  drawing: boolean;
  /** Visible (revealed) leaf-cell count of the active layer. */
  cellCount: number;
  /** # borders currently picked (shift-click) for a boolean op on the active layer. */
  borderSelCount: number;
  /** True when exactly two picked borders overlap → unite/difference is available. */
  borderSelCanBoolean: boolean;
}

export function summarizeDoc(doc: FacadeDoc, borderSel?: Set<number>): FacadeSummary {
  const layer = activeLayer(doc);
  const sel = borderSel ? [...borderSel].filter((i) => i >= 0 && i < layer.borders.length) : [];
  const canBoolean =
    sel.length === 2 && polygonsOverlap(layer.borders[sel[0]], layer.borders[sel[1]]);
  return {
    layerCount: doc.layers.length,
    activeIndex: doc.activeIndex,
    drawing: !hasBoundary(layer),
    cellCount: hasBoundary(layer) ? cellRects(layer).length : 0,
    borderSelCount: sel.length,
    borderSelCanBoolean: canBoolean,
  };
}
