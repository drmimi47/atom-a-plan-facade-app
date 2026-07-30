import type { Camera, LengthUnit, Marquee, ShapeTheme, Square, Walls } from '../types';
// Type-only: erased at build, so this creates no runtime cycle with violations.ts
// (which imports real helpers from this file).
import type { ShapeViolations } from '../../backend/violations';
import type { PredictionOption } from '../rooms/roomAdjacency';
import { fullAssemblyName } from '../facade/assemblies';
import { worldToScreen, type Vec2 } from './coords';
import {
  AREA_LABEL_FADE_END,
  AREA_LABEL_FADE_START,
  AREA_LABEL_FONT_PX,
  DEFAULT_WALL_WORLD,
  EDGE_HIT_TOLERANCE,
  OVERLAP_WALL_LIGHTEN,
  ROTATION_CORNER_OFFSET,
  ROTATION_CORNER_RADIUS,
  WORLD_UNITS_PER_FOOT,
  worldUnitsPerUnit,
} from '../constants';

/** A fresh per-side wall set, every side at the 6" default thickness. */
export function defaultWalls(): Walls {
  return { n: DEFAULT_WALL_WORLD, e: DEFAULT_WALL_WORLD, s: DEFAULT_WALL_WORLD, w: DEFAULT_WALL_WORLD };
}

/** IBM Plex Mono-first stack, mirroring the app's global font. */
const LABEL_FONT_STACK = "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', 'Courier New', monospace";

/** Dimension labels match the square-footage readout's on-screen size. */
const DIMENSION_FONT_PX = AREA_LABEL_FONT_PX;

/**
 * Half the vertical gap (px) between the room title and the area readout, so the
 * pair sits centred on the shape: title one half above the centre, area one half
 * below.
 */
const ROOM_LABEL_HALF_GAP = 10;

/** Warning yellow used to flag anything that violates a global constraint. */
const VIOLATION_YELLOW = '#facc15';

/** How far the outside dimension brackets + labels reach beyond a wall, px. */
const DIMENSION_REACH = 80;

/** Distance from the outer wall to a dimension bracket line, px. */
const DIMENSION_GAP = 36;

/** Text offset outside the bracket line, px. */
const DIMENSION_LABEL_GAP = 11;

/** Gap (px) from a clicked wall's faces to its own length/thickness dimension lines.
 *  The witness lines extend across this whole gap, so the bracket stays visibly
 *  connected to the edge as it sits further out (clear of the other UI). */
const WALL_DIM_GAP = 48;
/** Witness-line overshoot (px) past the wall dimension line. */
const WALL_DIM_EXT = 5;

/** Half-extent of the oblique architect's tick, px (also its bounding-box reach). */
const TICK_HALF = 4;

/**
 * Optional AutoCAD-style oblique "/" tick where each dimension line meets its
 * extension lines. Off by default; flip to `true` to show the ticks.
 */
const SHOW_DIMENSION_TICKS = false;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Decimal places shown per unit (metres need more, being a larger unit). */
function unitDecimals(unit: LengthUnit): number {
  return unit === 'meters' ? 2 : 1; // feet & centimetres → 1
}

/** The unit glyph appended to a length: prime for feet, else "m"/"cm". */
function unitSymbol(unit: LengthUnit): string {
  if (unit === 'meters') return 'm';
  if (unit === 'centimeters') return 'cm';
  return '′';
}

/** The area glyph for a unit, e.g. "ft²", "m²", "cm²". */
function areaSymbol(unit: LengthUnit): string {
  if (unit === 'meters') return 'm²';
  if (unit === 'centimeters') return 'cm²';
  return 'ft²';
}

/**
 * Live area readout in the active unit, e.g. "144 ft²", "13.4 m²", "133780 cm²".
 * A decimal is shown only when the value isn't whole.
 */
function formatArea(shape: Square, unit: LengthUnit): string {
  // True polygon area (shoelace), so a reshaped quad reads its actual footage.
  const per = worldUnitsPerUnit(unit);
  const sq = polygonAreaWorld(localCorners(shape)) / (per * per);
  const dec = unitDecimals(unit);
  const f = 10 ** dec;
  const area = Math.round(sq * f) / f;
  const value = Number.isInteger(area) ? `${area}` : area.toFixed(dec);
  return `${value} ${areaSymbol(unit)}`;
}

/** A shape's interior area in the active unit (e.g. ft²), unformatted. */
export function shapeAreaInUnit(shape: Square, unit: LengthUnit): number {
  const per = worldUnitsPerUnit(unit);
  return polygonAreaWorld(localCorners(shape)) / (per * per);
}

/**
 * A shape's gross area in the active unit — the outer footprint (interior + the
 * wall band around it), i.e. the polygon of its outer wall corners.
 */
export function shapeGrossAreaInUnit(shape: Square, unit: LengthUnit): number {
  const per = worldUnitsPerUnit(unit);
  const outer = outerCorners(localCorners(shape), wallThicknesses(shape));
  return polygonAreaWorld(outer) / (per * per);
}

/** The numeric part of a length in the active unit, e.g. 120 world → "12" (feet). */
function lengthValue(worldLen: number, unit: LengthUnit): string {
  const dec = unitDecimals(unit);
  const f = 10 ** dec;
  const v = Math.round((worldLen / worldUnitsPerUnit(unit)) * f) / f;
  return Number.isInteger(v) ? `${v}` : v.toFixed(dec);
}

/** A length with its unit mark, e.g. "12′", "3.66 m", "111.5 cm". */
function formatLength(worldLen: number, unit: LengthUnit): string {
  const sep = unit === 'feet' ? '' : ' ';
  return `${lengthValue(worldLen, unit)}${sep}${unitSymbol(unit)}`;
}

/** Fixed gap (px) drawn between the number and the unit mark. */
const DIMENSION_PRIME_GAP = 2;
/** A slightly wider gap before the "m" mark so it reads as a word, not a suffix. */
const DIMENSION_METER_GAP = 4;

/**
 * Draws a length measurement centred at the current origin, with the number and
 * the unit mark placed by hand with a fixed gap. Drawing the two glyphs
 * explicitly — rather than relying on the font's tight spacing — keeps the mark
 * from looking cramped and renders identically whatever the rotation. Assumes
 * the dimension font and `textBaseline = 'middle'` are already set.
 */
function drawNumberWithUnit(
  ctx: CanvasRenderingContext2D,
  num: string,
  sym: string,
  gap: number,
): void {
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  const numW = ctx.measureText(num).width;
  const symW = ctx.measureText(sym).width;
  const total = numW + gap + symW;
  const startX = -total / 2; // centre the number + gap + mark on the origin
  ctx.fillText(num, startX, 0);
  ctx.fillText(sym, startX + numW + gap, 0);
  ctx.textAlign = prevAlign;
}

function drawLengthLabel(
  ctx: CanvasRenderingContext2D,
  worldLen: number,
  unit: LengthUnit,
): void {
  drawNumberWithUnit(
    ctx,
    lengthValue(worldLen, unit),
    unitSymbol(unit),
    unit === 'feet' ? DIMENSION_PRIME_GAP : DIMENSION_METER_GAP,
  );
}

/**
 * Wall-thickness label text. In feet mode this is inches (e.g. "4″") — walls are an
 * inches-scale quantity and the min/max wall constraints are specified in inches — so
 * the coarse 0.1-ft feet readout (which rounds a 4″ wall to a misleading "0.3′") isn't
 * used. Other units keep their normal length formatting. Shared by the drawer and the
 * label hit-test so they always agree.
 */
function thicknessLabelText(worldLen: number, unit: LengthUnit): string {
  if (unit !== 'feet') return formatLength(worldLen, unit);
  const inches = (worldLen / WORLD_UNITS_PER_FOOT) * 12;
  const v = Math.round(inches * 10) / 10; // 0.1″ precision
  return (Number.isInteger(v) ? `${v}` : v.toFixed(1)) + '″';
}

/**
 * Draws a WALL-THICKNESS measurement — see {@link thicknessLabelText} for the value
 * rules. The number and unit mark are placed by hand (like {@link drawLengthLabel}).
 */
function drawThicknessLabel(
  ctx: CanvasRenderingContext2D,
  worldLen: number,
  unit: LengthUnit,
): void {
  if (unit !== 'feet') {
    drawLengthLabel(ctx, worldLen, unit);
    return;
  }
  const inches = (worldLen / WORLD_UNITS_PER_FOOT) * 12;
  const v = Math.round(inches * 10) / 10; // 0.1″ precision
  const num = Number.isInteger(v) ? `${v}` : v.toFixed(1);
  drawNumberWithUnit(ctx, num, '″', DIMENSION_PRIME_GAP);
}

/**
 * Resize handles: the four corners (nw/ne/se/sw) and the wall edges. A rectangle
 * or quad names its four edges n/e/s/w; an N-gon (boolean-difference result) uses
 * the numeric edge index for every edge so all of them stay grabbable.
 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | number;

/** A wall's two faces: the interior-facing line vs. the outer boundary line. */
export type EdgeFace = 'inner' | 'outer';

/** A region of a shape the pointer can be over: a wall edge, or the infill. */
export type HoverRegion = HandleId | 'infill';

const DEG2RAD = Math.PI / 180;

/**
 * Extra rotation (0 or π) to add to a label so it never renders upside-down:
 * flips 180° once its on-screen angle passes beyond ±90°. `deg` is the text's
 * net on-screen angle (shape rotation plus the label's own base angle).
 */
function uprightFlip(deg: number): number {
  let d = ((deg % 360) + 360) % 360; // 0..360
  if (d > 180) d -= 360; // (-180, 180]
  return Math.abs(d) > 90 ? Math.PI : 0;
}

/** Snap to a half-pixel so a 1px stroke stays crisp. */
const snap = (v: number): number => Math.round(v) + 0.5;

/** Half-size of the lock's clickable target (screen px). */
const LOCK_HIT_HALF = 9;
/** Colour of the lock when engaged (the constraints-accent blue). */
const LOCK_LOCKED_COLOR = '#6ea8fe';

/** Accent blue used to wash smart-find matches (rooms + matched wall bands). */
const FIND_HIGHLIGHT = '#6ea8fe';
/** Opacity of the translucent blue wash over a matched room's interior. */
const FIND_ROOM_ALPHA = 0.22;

/** Dev mode or the Analyze view renders every committed shape at this opacity (ghosted). */
const DEBUG_GHOST_ALPHA = 0.4;

/** Radius (screen px) of the edge-midpoint plus buttons. Shared with the facade border's copy. */
export const EDGE_PLUS_RADIUS = 7;
/** How far (screen px) each plus button's centre sits beyond the shape's outline. */
const EDGE_PLUS_OFFSET = 16;

/** Next-room prediction fan (shown while dragging an armed edge arrow). */
const PREDICTION_ARC_RADIUS = 96; // arrow button → each option centre
const PREDICTION_OPTION_RADIUS = 26;
const PREDICTION_OPTION_HOVER_RADIUS = 29;
const PREDICTION_SPREAD = 0.96; // ~55° between adjacent options
/** Ring + room-glyph colour shared by all three options. */
const PREDICTION_RING_COLOR = '#8a8f98';

/**
 * Draws a small circle with a centred plus, at (cx, cy) in screen space — an "add"
 * affordance sitting just off an edge midpoint. White fill so it reads over a wall.
 */
export function drawPlusCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  stroke: string,
  fill: string,
): void {
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
  // Plus.
  const a = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(cx - a, cy);
  ctx.lineTo(cx + a, cy);
  ctx.moveTo(cx, cy - a);
  ctx.lineTo(cx, cy + a);
  ctx.stroke();
  ctx.restore();
}

/**
 * Same little circle as {@link drawPlusCircle}, but with an outward chevron instead
 * of a plus — the "predict next room" affordance an edge button shows once the shape
 * is opened (double-clicked). `angle` is the outward direction (radians, screen y-down).
 */
function drawArrowCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  angle: number,
  stroke: string,
  fill: string,
): void {
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
  // Outward chevron ">" pointing along `angle`.
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const px = -uy; // perpendicular
  const py = ux;
  const tip = r * 0.55;
  const back = r * 0.12;
  const half = r * 0.42;
  ctx.beginPath();
  ctx.moveTo(cx - ux * back + px * half, cy - uy * back + py * half);
  ctx.lineTo(cx + ux * tip, cy + uy * tip);
  ctx.lineTo(cx - ux * back - px * half, cy - uy * back - py * half);
  ctx.stroke();
  ctx.restore();
}

/** Outward direction (radians, screen y-down) of a shape's edge `dir` (0=n,1=e,2=s,3=w). */
function edgeOutwardAngle(shape: Square, dir: number): number {
  const n = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ][dir];
  const a = shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return Math.atan2(n.x * sin + n.y * cos, n.x * cos - n.y * sin);
}

/**
 * Screen centres of the three next-room prediction options fanned in a semicircle
 * arc outward from edge `dir`'s arrow button. Ordered along the arc (one side →
 * middle → other side).
 */
export function predictionOptionAnchors(shape: Square, camera: Camera, dir: number): Vec2[] {
  const anchor = edgePlusAnchorsScreen(shape, camera)[dir];
  const base = edgeOutwardAngle(shape, dir);
  return [-PREDICTION_SPREAD, 0, PREDICTION_SPREAD].map((d) => ({
    x: anchor.x + Math.cos(base + d) * PREDICTION_ARC_RADIUS,
    y: anchor.y + Math.sin(base + d) * PREDICTION_ARC_RADIUS,
  }));
}

/** Which prediction option (0..2) a screen point is over, or null. */
export function hitPredictionOption(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
  dir: number,
): number | null {
  const centers = predictionOptionAnchors(shape, camera, dir);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const dx = screenX - centers[i].x;
    const dy = screenY - centers[i].y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const reach = (PREDICTION_OPTION_HOVER_RADIUS + 4) ** 2;
  return bestD <= reach ? best : null;
}

/**
 * Draws the three prediction options for edge `dir`: white circles with a coloured
 * ring and a small rounded square inside (a room glyph). The hovered one grows and
 * its ring thickens, signalling it as the pick.
 */
export function drawPredictionOptions(
  ctx: CanvasRenderingContext2D,
  shape: Square,
  camera: Camera,
  dir: number,
  hovered: number | null,
  options: (PredictionOption | null)[],
  debug: boolean,
): void {
  const centers = predictionOptionAnchors(shape, camera, dir);
  const anchor = edgePlusAnchorsScreen(shape, camera)[dir];
  ctx.save();
  for (let i = 0; i < centers.length; i++) {
    const opt = options[i];
    if (!opt) continue; // empty slot (fewer than 3 predictions)
    const c = centers[i];
    const isHover = hovered === i;
    const r = isHover ? PREDICTION_OPTION_HOVER_RADIUS : PREDICTION_OPTION_RADIUS;

    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    // Translucent fill so the ghost room (and the number) stay readable behind the
    // dot; the opaque ring + number below keep it legible.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.66)';
    ctx.fill();
    ctx.lineWidth = isHover ? 4 : 3;
    ctx.strokeStyle = PREDICTION_RING_COLOR;
    ctx.stroke();

    // Inner number = confidence rank (1 = most confident).
    ctx.fillStyle = PREDICTION_RING_COLOR;
    ctx.font = `600 ${Math.round(r * 0.8)}px ${LABEL_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(opt.rank + 1), c.x, c.y);

    // Debug: room label + confidence %, placed radially outward beyond the dot.
    if (debug) {
      let ox = c.x - anchor.x;
      let oy = c.y - anchor.y;
      const len = Math.hypot(ox, oy) || 1;
      ox /= len;
      oy /= len;
      const tx = c.x + ox * (r + 8);
      const ty = c.y + oy * (r + 8);
      ctx.font = `600 12px ${LABEL_FONT_STACK}`;
      ctx.textAlign = ox > 0.25 ? 'left' : ox < -0.25 ? 'right' : 'center';
      ctx.textBaseline = oy > 0.25 ? 'top' : oy < -0.25 ? 'bottom' : 'middle';
      ctx.fillText(`${opt.label} ${Math.round(opt.confidence * 100)}%`, tx, ty);
    }
  }
  ctx.restore();
}

/**
 * Draws a tiny padlock centred at (cx, cy) in screen space — closed + filled when
 * `locked`, open + hollow otherwise. Sized to sit under the ft² readout.
 */
function drawLockIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  locked: boolean,
  color: string,
): void {
  const bodyW = 9;
  const bodyH = 7;
  const bodyX = cx - bodyW / 2;
  const bodyY = cy - bodyH / 2 + 1.5; // body sits low; shackle rides above
  const shR = 2.6; // shackle radius
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  // Shackle: a closed arc with both legs down to the body when locked; lifted and
  // with the right leg detached (open) when unlocked.
  ctx.beginPath();
  if (locked) {
    const shCy = bodyY - 0.5;
    ctx.arc(cx, shCy, shR, Math.PI, 2 * Math.PI); // top half-circle
    ctx.lineTo(cx + shR, bodyY); // right leg down to the body
    ctx.moveTo(cx - shR, shCy);
    ctx.lineTo(cx - shR, bodyY); // left leg down to the body
  } else {
    const shCy = bodyY - 2; // lifted
    ctx.arc(cx, shCy, shR, Math.PI, 2 * Math.PI);
    ctx.lineTo(cx + shR, shCy + 1.5); // short right stub — not reaching the body
    ctx.moveTo(cx - shR, shCy);
    ctx.lineTo(cx - shR, bodyY); // left leg still anchored
  }
  ctx.stroke();

  // Body: filled when locked, outlined when open.
  ctx.beginPath();
  ctx.roundRect(bodyX, bodyY, bodyW, bodyH, 1.6);
  if (locked) ctx.fill();
  else ctx.stroke();
  ctx.restore();
}

/** Corner order shared everywhere: top-left, top-right, bottom-right, bottom-left. */
const CORNER_HANDLES = ['nw', 'ne', 'se', 'sw'] as const;
/** Which polygon edge (corner i → i+1) each wall side runs along. */
const SIDE_EDGE: Record<'n' | 'e' | 's' | 'w', number> = { n: 0, e: 1, s: 2, w: 3 };

/** The interior-edge index a handle refers to (numeric handle, or n/e/s/w), or -1 for a corner. */
function edgeIndexOf(handle: HandleId): number {
  if (typeof handle === 'number') return handle;
  return handle in SIDE_EDGE ? SIDE_EDGE[handle as 'n' | 'e' | 's' | 'w'] : -1;
}

/**
 * The room's four interior corners in the LOCAL frame (centre-origin,
 * pre-rotation, world units), ordered [nw, ne, se, sw]. A free-form shape stores
 * these directly; a plain rectangle derives them from width/height.
 */
function localCorners(shape: Square): Vec2[] {
  if (shape.corners && shape.corners.length >= 3) {
    return shape.corners.map((p) => ({ x: p.x, y: p.y }));
  }
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

/**
 * Per-edge wall thickness (world units), one per interior edge. A rectangle or a
 * 4-corner quad maps the named walls n/e/s/w to edges [0,1,2,3]; a free polygon
 * with any other vertex count (e.g. a boolean-difference result) uses a uniform
 * thickness so every new edge still reads as a wall.
 */
export function wallThicknesses(shape: Square): number[] {
  const pts = localCorners(shape);
  // Explicit per-edge thicknesses (free polygons / boolean N-gons) win when set.
  if (shape.wallEdges && shape.wallEdges.length === pts.length) {
    return shape.wallEdges;
  }
  if (pts.length === 4) {
    return [shape.walls.n, shape.walls.e, shape.walls.s, shape.walls.w];
  }
  return pts.map(() => shape.walls.n);
}

/**
 * Returns `shape` with edge `e`'s wall thickness set to `value`, writing to the
 * representation the shape uses: a per-edge `wallEdges` array when present, else the
 * named n/e/s/w walls (rect / 4-corner quad). Lets a single edge change thickness
 * without disturbing the others.
 */
export function withEdgeThickness(shape: Square, e: number, value: number): Square {
  const pts = localCorners(shape);
  if (shape.wallEdges && shape.wallEdges.length === pts.length) {
    const wallEdges = shape.wallEdges.slice();
    wallEdges[e] = value;
    return { ...shape, wallEdges };
  }
  const side = (['n', 'e', 's', 'w'] as const)[e] ?? 'n';
  return { ...shape, walls: { ...shape.walls, [side]: value } };
}

/** Returns `shape` with every edge's wall thickness mapped through `fn`. */
export function mapEdgeThickness(shape: Square, fn: (t: number) => number): Square {
  const thicks = wallThicknesses(shape).map(fn);
  const pts = localCorners(shape);
  if (shape.wallEdges && shape.wallEdges.length === pts.length) {
    return { ...shape, wallEdges: thicks };
  }
  if (pts.length === 4) {
    return { ...shape, walls: { n: thicks[0], e: thicks[1], s: thicks[2], w: thicks[3] } };
  }
  return { ...shape, walls: { ...shape.walls, n: thicks[0] } };
}

/**
 * Length (world units) of each interior side, one per edge — edge `i` runs from
 * corner `i` to corner `i+1`, the same indexing as {@link wallThicknesses}. Used
 * to flag room sides that fall below a minimum-side-length constraint.
 */
export function edgeLengthsWorld(shape: Square): number[] {
  const pts = localCorners(shape);
  const out: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  return out;
}

/** Intersection of line (p + t·r) and line (q + u·s), or null if parallel. */
function lineIntersect(p: Vec2, r: Vec2, q: Vec2, s: Vec2): Vec2 | null {
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / denom;
  return { x: p.x + t * r.x, y: p.y + t * r.y };
}

/**
 * The outer (wall) corners for an interior polygon, each edge pushed outward
 * along its normal by that side's thickness and adjacent offset edges mitered at
 * their intersection. `thick` is indexed by edge (n, e, s, w). Reduces exactly to
 * the offset rectangle when the interior is a rect.
 */
function outerCorners(iPts: Vec2[], thick: number[]): Vec2[] {
  const n = iPts.length;
  // Outward normal of each edge i (iPts[i] → iPts[i+1]); the corner winding is
  // clockwise in screen space (y down), so the outward normal is (dy, -dx).
  const normals = iPts.map((a, i) => {
    const b = iPts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dy / len, y: -dx / len };
  });
  return iPts.map((corner, i) => {
    const prev = (i + n - 1) % n; // edge ending at this corner
    const next = i; // edge leaving this corner
    const pPoint = {
      x: corner.x + thick[prev] * normals[prev].x,
      y: corner.y + thick[prev] * normals[prev].y,
    };
    const pDir = { x: corner.x - iPts[prev].x, y: corner.y - iPts[prev].y };
    const nPoint = {
      x: corner.x + thick[next] * normals[next].x,
      y: corner.y + thick[next] * normals[next].y,
    };
    const nDir = { x: iPts[(i + 1) % n].x - corner.x, y: iPts[(i + 1) % n].y - corner.y };
    return lineIntersect(pPoint, pDir, nPoint, nDir) ?? pPoint;
  });
}

/**
 * Mix a #rrggbb colour toward white (amt > 0) or black (amt < 0) by |amt| in
 * 0..1, returning a new #rrggbb. Used for the slight lighten/darken of the
 * overlap cues — output stays fully opaque (no alpha), so it adds no blending.
 */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const target = amt >= 0 ? 255 : 0;
  const t = Math.abs(amt);
  const mix = (ch: number): string =>
    Math.round(ch + (target - ch) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

/**
 * A shape's interior and outer (wall) footprints as closed polygons in ABSOLUTE
 * screen pixels — the same corners the body is drawn from, but expressed in
 * screen space so two shapes' footprints can be intersected for the overlap cues
 * regardless of each one's rotation.
 */
export function footprintScreen(shape: Square, camera: Camera): { inner: Vec2[]; outer: Vec2[] } {
  const iLocal = localCorners(shape).map((p) => ({
    x: p.x * camera.scale,
    y: p.y * camera.scale,
  }));
  const thick = wallThicknesses(shape).map((w) => w * camera.scale);
  const oLocal = outerCorners(iLocal, thick);
  const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
  const a = shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const toScreen = (p: Vec2): Vec2 => ({
    x: c.x + p.x * cos - p.y * sin,
    y: c.y + p.x * sin + p.y * cos,
  });
  return { inner: iLocal.map(toScreen), outer: oLocal.map(toScreen) };
}

/**
 * A shape's interior and outer (wall) footprints as closed polygons in WORLD
 * coordinates, plus the per-edge wall thickness. The world-space twin of
 * {@link footprintScreen} (no camera) — used by alignment snapping to derive wall
 * lines for ANY shape, including rotated rooms, edited quads, and irregular boolean
 * N-gons, not just axis-aligned rectangles. Corners are ordered the same as
 * {@link wallThicknesses}: edge `i` runs from corner `i` to corner `i+1`.
 */
export function footprintWorld(
  shape: Square,
): { inner: Vec2[]; outer: Vec2[]; thickness: number[] } {
  const iLocal = localCorners(shape);
  const thick = wallThicknesses(shape);
  const oLocal = outerCorners(iLocal, thick);
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const a = shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const toWorld = (p: Vec2): Vec2 => ({
    x: cx + p.x * cos - p.y * sin,
    y: cy + p.x * sin + p.y * cos,
  });
  return { inner: iLocal.map(toWorld), outer: oLocal.map(toWorld), thickness: thick };
}

/**
 * Rotation affordance: a short arc hugging each polygon corner, offset outward
 * by `radius`, centred on that corner's exterior bisector and spanning the
 * corner's own angle — so on a rectangle the four read as the rounded corners of
 * a rounded rectangle, and on an irregular quad each tilts to match its corner.
 * `pts` are the corner points in the CURRENT canvas frame; assumes strokeStyle /
 * lineWidth are already set.
 */
export function drawCornerRotationArcs(
  ctx: CanvasRenderingContext2D,
  pts: Vec2[],
  radius: number,
): void {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const c = pts[i];
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
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
    const bx = -(d1x + d2x); // exterior bisector (away from the interior)
    const by = -(d1y + d2y);
    if (Math.hypot(bx, by) < 1e-3) continue; // near-straight corner → no arc
    const aOut = Math.atan2(by, bx);
    const dot = Math.max(-1, Math.min(1, d1x * d2x + d1y * d2y));
    const half = Math.acos(dot) / 2; // half the corner's interior angle
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, aOut - half, aOut + half);
    ctx.stroke();
  }
}

/**
 * Draws a rectangle's two dimension brackets — width along the TOP, height along
 * the RIGHT — with their length labels, each flipped so it never reads
 * upside-down. `inner` are the [TL, TR, BR, BL] corners the bracket feet reach
 * in to; `outer` is the box the spines sit `DIMENSION_GAP` beyond (the wall band
 * for a plain rect, or the same bounding box for a reshaped quad). With
 * `outlineBox` the bounding box itself is stroked too. The caller sets globalAlpha
 * and the rotated frame; colours/font are configured here.
 */
export function drawBoxDimensions(
  ctx: CanvasRenderingContext2D,
  inner: Vec2[],
  outer: Vec2[],
  widthWorld: number,
  heightWorld: number,
  rotationDeg: number,
  unit: LengthUnit,
  theme: ShapeTheme,
  outlineBox = false,
  // Offset (screen px) of the dimension line from the box edge. Defaults to the room/wall-band clearance; a
  // wall-less feature (e.g. a facade border) passes a smaller gap so the dimensions hug the actual edges.
  dimGap = DIMENSION_GAP,
): void {
  const gap = dimGap;
  const labelGap = DIMENSION_LABEL_GAP;
  const ext = TICK_HALF * 2.5; // equal-length crossing stubs at each corner
  // Nudge every edge to a pixel centre (+0.5) so axis-aligned 1px lines are crisp.
  // When the shape is ROTATED the points are already whole-pixel snapped by stab()
  // in absolute screen space; adding the half-pixel in this rotated frame would
  // instead knock them OFF that grid, so the diagonal lines drift across pixel
  // boundaries and shimmer/fade. So only nudge when the shape is axis-aligned —
  // when rotated, draw straight from the snapped points (like the shape's edges).
  const aligned = ((Math.round(rotationDeg) % 90) + 90) % 90 === 0;
  const h = aligned ? 0.5 : 0;
  const left = inner[0].x + h;
  const top = inner[0].y + h;
  const iRight = inner[2].x + h;
  const iBottom = inner[2].y + h;
  const oTop = outer[0].y + h;
  const oRight = outer[2].x + h;
  const cx2 = (left + iRight) / 2;
  const cy2 = (top + iBottom) / 2;

  ctx.strokeStyle = theme.label;
  ctx.fillStyle = theme.label;
  ctx.lineWidth = 1;
  ctx.font = `${DIMENSION_FONT_PX}px ${LABEL_FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Bounding-box outline (when asked), in the exact same snapped coordinates as
  // the bracket feet so the corners coincide perfectly.
  if (outlineBox) {
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(iRight, top);
    ctx.lineTo(iRight, iBottom);
    ctx.lineTo(left, iBottom);
    ctx.closePath();
    ctx.stroke();
  }

  // Vertical bracket on the RIGHT — measures height; feet reach in to the right edge.
  const vx = oRight + gap;
  ctx.beginPath();
  ctx.moveTo(vx, top - ext);
  ctx.lineTo(vx, iBottom + ext);
  ctx.moveTo(iRight, top);
  ctx.lineTo(vx + ext, top);
  ctx.moveTo(iRight, iBottom);
  ctx.lineTo(vx + ext, iBottom);
  ctx.stroke();

  // Horizontal bracket on the TOP — measures width; feet reach down to the top edge.
  const hy = oTop - gap;
  ctx.beginPath();
  ctx.moveTo(left - ext, hy);
  ctx.lineTo(iRight + ext, hy);
  ctx.moveTo(left, hy - ext);
  ctx.lineTo(left, top);
  ctx.moveTo(iRight, hy - ext);
  ctx.lineTo(iRight, top);
  ctx.stroke();

  if (SHOW_DIMENSION_TICKS) {
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [tx, ty] of [
      [vx, top],
      [vx, iBottom],
      [left, hy],
      [iRight, hy],
    ] as const) {
      ctx.moveTo(tx - TICK_HALF, ty + TICK_HALF);
      ctx.lineTo(tx + TICK_HALF, ty - TICK_HALF);
    }
    ctx.stroke();
    ctx.strokeStyle = theme.label;
    ctx.lineWidth = 1;
  }

  // Width label above the top bracket; height label right of the right bracket.
  // Each flips on its own on-screen angle so neither ever reads inverted.
  ctx.save();
  ctx.translate(Math.round(cx2), Math.round(hy - labelGap));
  ctx.rotate(uprightFlip(rotationDeg));
  drawLengthLabel(ctx, widthWorld, unit);
  ctx.restore();

  ctx.save();
  ctx.translate(Math.round(vx + labelGap), Math.round(cy2));
  ctx.rotate(-Math.PI / 2 + uprightFlip(rotationDeg - 90));
  drawLengthLabel(ctx, heightWorld, unit);
  ctx.restore();
}

/**
 * Draws a clicked wall's own two dimensions — its LENGTH (along the edge) and its
 * WIDTH/thickness (across the band) — as small CAD-style brackets hugging the active
 * wall, so a stretch reads its live size right where the magenta stretch lines are.
 * `A`,`B` are the wall's interior-edge endpoints and `D`,`C` the matching outer-edge
 * endpoints (quad A-B-C-D), all in the shape's rotated local frame (px).
 * `lengthWorld`/`thicknessWorld` are the measured values; each label sits parallel to
 * what it measures and flips so it never reads upside-down. Colours/font set here.
 */
function drawWallDimensions(
  ctx: CanvasRenderingContext2D,
  A: Vec2,
  B: Vec2,
  C: Vec2,
  D: Vec2,
  lengthWorld: number,
  thicknessWorld: number,
  rotationDeg: number,
  unit: LengthUnit,
  theme: ShapeTheme,
): void {
  // Edge direction (A→B), a unit vector.
  let ex = B.x - A.x;
  let ey = B.y - A.y;
  const eLen = Math.hypot(ex, ey) || 1;
  ex /= eLen;
  ey /= eLen;
  // Outward normal as the TRUE perpendicular of the edge (rotate the edge dir 90°),
  // sign-flipped to point from the interior toward the outer face. Deriving it from
  // the edge itself — rather than the inner→outer midpoint vector, which a mitered or
  // slanted wall skews — keeps every bracket square: the dimension lines stay parallel
  // to what they measure and the witness legs stay at right angles to them.
  let nx = ey;
  let ny = -ex;
  const outX = (C.x + D.x) / 2 - (A.x + B.x) / 2;
  const outY = (C.y + D.y) / 2 - (A.y + B.y) / 2;
  if (nx * outX + ny * outY < 0) {
    nx = -nx;
    ny = -ny;
  }

  const gap = WALL_DIM_GAP;
  const ext = WALL_DIM_EXT;
  const labelGap = DIMENSION_LABEL_GAP;

  // 25% lighter than the room's own dimension grey, so it's easy to tell the per-edge
  // wall dimensions apart from the shape's overall width/height dimensions.
  const wallDimColor = shade(theme.label, 0.25);
  ctx.strokeStyle = wallDimColor;
  ctx.fillStyle = wallDimColor;
  ctx.lineWidth = 1;
  ctx.font = `${DIMENSION_FONT_PX}px ${LABEL_FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Local text angles (the ctx is already rotated by the shape) and their NET
  // on-screen angles, used to decide each label's upright flip.
  const locEdge = Math.atan2(ey, ex);
  const locNorm = Math.atan2(ny, nx);
  const netEdgeDeg = (locEdge * 180) / Math.PI + rotationDeg;
  const netNormDeg = (locNorm * 180) / Math.PI + rotationDeg;

  // Perpendicular wall thickness in px (project a mitered outer corner onto the normal).
  const thickPx = (D.x - A.x) * nx + (D.y - A.y) * ny;

  // ---- LENGTH: a bracket parallel to the edge, beyond the OUTER face. ----
  // The witness lines start at the INTERIOR edge endpoints (A, B) — the edge being
  // manipulated — and run perpendicular all the way across the wall band, past the
  // outer face, out to the dimension line, so the bracket visibly connects to it.
  {
    const span = thickPx + gap; // inner edge → dimension line
    const p1 = { x: A.x + nx * span, y: A.y + ny * span };
    const p2 = { x: B.x + nx * span, y: B.y + ny * span };
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(A.x + nx * (span + ext), A.y + ny * (span + ext));
    ctx.moveTo(B.x, B.y);
    ctx.lineTo(B.x + nx * (span + ext), B.y + ny * (span + ext));
    ctx.stroke();
    const mx = (p1.x + p2.x) / 2 + nx * labelGap;
    const my = (p1.y + p2.y) / 2 + ny * labelGap;
    ctx.save();
    ctx.translate(Math.round(mx), Math.round(my));
    ctx.rotate(locEdge + uprightFlip(netEdgeDeg));
    drawLengthLabel(ctx, lengthWorld, unit);
    ctx.restore();
  }

  // ---- WIDTH (thickness): a bracket across the band, just beyond the B/C end. ----
  // Witness lines run parallel to the edge from the inner corner B and the outer face,
  // so the bracket connects to both faces of the manipulated wall.
  {
    const off = gap;
    const oAnchor = { x: B.x + nx * thickPx, y: B.y + ny * thickPx }; // on the outer face, normal-aligned
    const p1 = { x: B.x + ex * off, y: B.y + ey * off }; // inner-face level
    const p2 = { x: oAnchor.x + ex * off, y: oAnchor.y + ey * off }; // outer-face level
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.moveTo(B.x, B.y);
    ctx.lineTo(B.x + ex * (off + ext), B.y + ey * (off + ext));
    ctx.moveTo(oAnchor.x, oAnchor.y);
    ctx.lineTo(oAnchor.x + ex * (off + ext), oAnchor.y + ey * (off + ext));
    ctx.stroke();
    const mx = (p1.x + p2.x) / 2 + ex * labelGap;
    const my = (p1.y + p2.y) / 2 + ey * labelGap;
    ctx.save();
    ctx.translate(Math.round(mx), Math.round(my));
    ctx.rotate(locNorm + uprightFlip(netNormDeg));
    drawThicknessLabel(ctx, thicknessWorld, unit);
    ctx.restore();
  }
}

/** Signed-area (shoelace) magnitude of a local polygon, in world units². */
function polygonAreaWorld(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Area centroid of a shape's interior, in its LOCAL frame (relative to the
 * centre). For a rectangle this is (0,0); for a reshaped quad it's the true
 * polygon centroid, so the area readout sits at the visual middle of the room.
 */
function shapeCentroidLocal(shape: Square): Vec2 {
  const pts = localCorners(shape);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-6) return { x: 0, y: 0 }; // degenerate → fall back to centre
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/**
 * Tight axis-aligned bounding box of a shape's interior corners, in its LOCAL
 * (pre-rotation, centre-origin) frame, world units. Every side touches an
 * extreme corner — for a reshaped quad this is the true best-fit box; for a
 * plain rectangle it reduces to the symmetric ±half-extents.
 */
export function boundingBoxLocal(shape: Square): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const pts = localCorners(shape);
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
  return { minX, minY, maxX, maxY };
}

/**
 * Re-centres a reshaped quad so its tight bounding box sits on the local origin,
 * WITHOUT moving the shape on screen: the stored corners are shifted and the
 * world position is compensated. Run once when a reshape gesture ends (never
 * per-frame — that would jitter). Afterwards the shape rotates about its visual
 * centre like a plain rectangle, and its box, dimension brackets, and rotation
 * handles sit symmetrically about that centre.
 */
export function recenterCorners(shape: Square): Square {
  if (!shape.corners) return shape;
  const bb = boundingBoxLocal(shape);
  const cxL = (bb.minX + bb.maxX) / 2;
  const cyL = (bb.minY + bb.maxY) / 2;
  if (Math.abs(cxL) < 1e-6 && Math.abs(cyL) < 1e-6) return shape; // already centred
  // Move the local origin by (cxL, cyL); shift world position the same amount
  // (rotated) so the geometry stays put on screen.
  const a = shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const wcx = shape.x + shape.width / 2 + (cxL * cos - cyL * sin);
  const wcy = shape.y + shape.height / 2 + (cxL * sin + cyL * cos);
  const corners = shape.corners.map((p) => ({ x: p.x - cxL, y: p.y - cyL }));
  const newW = bb.maxX - bb.minX;
  const newH = bb.maxY - bb.minY;
  return {
    ...shape,
    corners,
    width: newW,
    height: newH,
    x: wcx - newW / 2,
    y: wcy - newH / 2,
  };
}

/**
 * The fixed WORLD point the area lock scales about while `handle` is dragged: the
 * midpoint of the edge OPPOSITE the grabbed edge, or the corner opposite a grabbed
 * vertex. (Those points don't move during the resize itself, so anchoring there
 * keeps the room pinned rather than floating.) Because uniform scaling leaves every
 * line through its centre invariant, scaling about the opposite edge's midpoint
 * keeps that edge on its line. For an N-gon the "opposite" edge is the one whose
 * midpoint is farthest from the grabbed edge's midpoint.
 */
export function areaLockAnchorWorld(shape: Square, handle: HandleId, vertex: boolean): Vec2 {
  const pts = localCorners(shape);
  const n = pts.length;
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let local: Vec2;
  if (vertex) {
    const ci = cornerIndexForHandle(handle);
    local = pts[(ci + Math.floor(n / 2)) % n]; // opposite corner
  } else {
    const e = edgeIndexOf(handle);
    if (e < 0) {
      local = { x: 0, y: 0 };
    } else {
      const eMid = mid(pts[e], pts[(e + 1) % n]);
      let best = (e + Math.floor(n / 2)) % n;
      let bestD = -1;
      for (let k = 0; k < n; k++) {
        const mk = mid(pts[k], pts[(k + 1) % n]);
        const d = (mk.x - eMid.x) ** 2 + (mk.y - eMid.y) ** 2;
        if (d > bestD) {
          bestD = d;
          best = k;
        }
      }
      local = mid(pts[best], pts[(best + 1) % n]);
    }
  }
  const rot = shape.rotation * DEG2RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const wcx = shape.x + shape.width / 2;
  const wcy = shape.y + shape.height / 2;
  return { x: wcx + local.x * cos - local.y * sin, y: wcy + local.x * sin + local.y * cos };
}

/**
 * Returns `candidate` uniformly scaled so its interior area equals `reference`'s —
 * the "area lock". Edge/vertex edits build a candidate that changed the area; this
 * scales the whole room back to the locked footage about `anchorWorld` (the world
 * point that should stay put — see {@link areaLockAnchorWorld}), holding it pinned
 * so the opposite edge stays anchored and the room never drifts freely. Works for
 * rectangles (scales width/height) and free quads/N-gons (scales the local corners).
 */
export function scaledToArea(candidate: Square, reference: Square, anchorWorld: Vec2): Square {
  const refA = shapeAreaInUnit(reference, 'feet');
  const candA = shapeAreaInUnit(candidate, 'feet');
  if (!(refA > 1e-9) || !(candA > 1e-9)) return candidate;
  const f = Math.sqrt(refA / candA);
  if (!isFinite(f) || Math.abs(f - 1) < 1e-9) return candidate;

  const rot = candidate.rotation * DEG2RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const wcx0 = candidate.x + candidate.width / 2;
  const wcy0 = candidate.y + candidate.height / 2;
  // The anchor expressed in the CANDIDATE's local frame (centre-origin, pre-rotation).
  const adx = anchorWorld.x - wcx0;
  const ady = anchorWorld.y - wcy0;
  const aLx = adx * cos + ady * sin;
  const aLy = -adx * sin + ady * cos;
  const aWx = anchorWorld.x;
  const aWy = anchorWorld.y;

  if (!candidate.corners) {
    // Rectangle: stays a rectangle under uniform scaling; only the centre shifts so
    // the anchor (opposite edge's midpoint) holds its world position.
    const w = candidate.width * f;
    const h = candidate.height * f;
    const ncLx = aLx * (1 - f); // old centre maps here (local frame)
    const ncLy = aLy * (1 - f);
    const ncWx = wcx0 + ncLx * cos - ncLy * sin;
    const ncWy = wcy0 + ncLx * sin + ncLy * cos;
    return { ...candidate, width: w, height: h, x: ncWx - w / 2, y: ncWy - h / 2 };
  }

  // Polygon: scale the local corners about the anchor, then re-centre on the new
  // bounding box and pin the anchor back to its world position.
  const pts = localCorners(candidate).map((p) => ({
    x: aLx + (p.x - aLx) * f,
    y: aLy + (p.y - aLy) * f,
  }));
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
  const bcx = (minX + maxX) / 2;
  const bcy = (minY + maxY) / 2;
  const newW = maxX - minX;
  const newH = maxY - minY;
  const corners = pts.map((p) => ({ x: p.x - bcx, y: p.y - bcy }));
  // Anchor in the new (bbox-centred) local frame; choose the world centre so it
  // lands back on (aWx, aWy). (Scaling about the anchor leaves its local coords
  // unchanged, so it's still at (aLx, aLy) before the bbox re-centre.)
  const aLx2 = aLx - bcx;
  const aLy2 = aLy - bcy;
  const wcx = aWx - (aLx2 * cos - aLy2 * sin);
  const wcy = aWy - (aLx2 * sin + aLy2 * cos);
  return { ...candidate, corners, width: newW, height: newH, x: wcx - newW / 2, y: wcy - newH / 2 };
}

/** Ray-cast point-in-polygon test (point and polygon in the same frame). */
function pointInPolygon(pt: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    const straddles = a.y > pt.y !== b.y > pt.y;
    if (straddles && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * True when `point` (canvas-local screen px) lies in a shared-overlap "yellow
 * band" — the lighter-grey wall-over-infill strip between two SELECTED,
 * overlapping rooms (the same region that highlights yellow on hover). Used to
 * disable edge-stretching there while 2+ shapes are selected. False unless at
 * least two shapes are selected.
 */
export function pointInSelectedOverlapBand(
  point: Vec2,
  shapes: Square[],
  selectedIds: Set<string>,
  camera: Camera,
): boolean {
  if (selectedIds.size < 2) return false;
  const fps = shapes.filter((s) => selectedIds.has(s.id)).map((s) => footprintScreen(s, camera));
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const A = fps[i];
      const B = fps[j];
      const inAi = pointInPolygon(point, A.inner);
      const inBi = pointInPolygon(point, B.inner);
      const inAo = pointInPolygon(point, A.outer);
      const inBo = pointInPolygon(point, B.outer);
      if ((inAo && inBi && !inAi) || (inBo && inAi && !inBi)) return true;
    }
  }
  return false;
}

/**
 * The shared-overlap band under `point` (screen px), or null. Returns which
 * SELECTED room's wall is clicked (`target`, to be trimmed) and the other room
 * whose footprint is subtracted from it (`other`, whose wall the target then
 * inherits). Mirrors the yellow-hover / merge-preview geometry.
 */
export function overlapBandAt(
  point: Vec2,
  shapes: Square[],
  selectedIds: Set<string>,
  camera: Camera,
): { target: Square; other: Square } | null {
  if (selectedIds.size < 2) return null;
  const sel = shapes.filter((s) => selectedIds.has(s.id));
  const fps = sel.map((s) => footprintScreen(s, camera));
  for (let i = 0; i < sel.length; i++) {
    for (let j = i + 1; j < sel.length; j++) {
      const A = fps[i];
      const B = fps[j];
      const inAi = pointInPolygon(point, A.inner);
      const inBi = pointInPolygon(point, B.inner);
      const inAo = pointInPolygon(point, A.outer);
      const inBo = pointInPolygon(point, B.outer);
      // Clicking A's wall over B's infill trims A (and vice-versa).
      if (inAo && inBi && !inAi) return { target: sel[i], other: sel[j] };
      if (inBo && inAi && !inBi) return { target: sel[j], other: sel[i] };
    }
  }
  return null;
}

/**
 * The interior-overlap region under `point` (screen px), or null — where TWO selected
 * rooms' INTERIORS overlap (the infill∩infill region shown cyan in Debug). Returns the
 * two rooms to merge; a clean click there runs the boolean UNION. Distinct from
 * {@link overlapBandAt} (the wall band, which runs the difference).
 */
export function overlapInteriorAt(
  point: Vec2,
  shapes: Square[],
  selectedIds: Set<string>,
  camera: Camera,
): { a: Square; b: Square } | null {
  if (selectedIds.size < 2) return null;
  const sel = shapes.filter((s) => selectedIds.has(s.id));
  const fps = sel.map((s) => footprintScreen(s, camera));
  for (let i = 0; i < sel.length; i++) {
    for (let j = i + 1; j < sel.length; j++) {
      if (pointInPolygon(point, fps[i].inner) && pointInPolygon(point, fps[j].inner)) {
        return { a: sel[i], b: sel[j] };
      }
    }
  }
  return null;
}

/** Strict interior intersection of segments a→b and c→d, with the param on a→b. */
function segInt(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { p: Vec2; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null; // parallel / collinear
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  const E = 1e-9;
  if (t <= E || t >= 1 - E || u <= E || u >= 1 - E) return null; // endpoints excluded
  return { p: { x: a.x + t * rx, y: a.y + t * ry }, t, u };
}

/** Signed area (shoelace) of a polygon ring. */
function ringArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return s / 2;
}

/* ---- Degenerate-overlap tolerances (world units; a foot is WORLD_UNITS_PER_FOOT of these) ----
 * Ordered TOUCH ≪ NUDGE ≪ SNAP, which is what makes the retry below reversible: the nudge is far
 * bigger than the error that decides whether two edges touch, and far smaller than the snap that puts
 * the answer back on the coordinates the inputs were built from. All three are invisible on screen. */
const TOUCH_TOL = 1e-4;
const NUDGE = 1e-3;
const SNAP_TOL = 1e-2;

/** Every vertex of `inner` inside `outer`, at least one of them strictly (not just lying on an edge). */
function polygonContains(outer: Vec2[], inner: Vec2[]): boolean {
  let strict = false;
  for (const p of inner) {
    const on = polygonBoundaryDist(p, outer) <= TOUCH_TOL;
    if (!on && !pointInPolygon(p, outer)) return false;
    if (!on) strict = true;
  }
  return strict;
}

/** Distance from a point to a polygon's outline. */
function polygonBoundaryDist(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, distPointToSegment(p, poly[j], poly[i]));
  }
  return best;
}

/** Do the two outlines meet without crossing — a shared corner or a run of collinear edge? */
function polygonsTouch(a: Vec2[], b: Vec2[]): boolean {
  return (
    a.some((p) => polygonBoundaryDist(p, b) <= TOUCH_TOL) ||
    b.some((p) => polygonBoundaryDist(p, a) <= TOUCH_TOL)
  );
}

/** Push every vertex `by` away from the centroid — just enough to lift shared edges off each other. */
function inflatePolygon(poly: Vec2[], by: number): Vec2[] {
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  return poly.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy);
    return len > 0 ? { x: p.x + (dx / len) * by, y: p.y + (dy / len) * by } : { x: p.x, y: p.y };
  });
}

/**
 * Put a ring computed against a NUDGED clip back onto the geometry the user actually drew: pull each
 * coordinate onto the input coordinate it is within {@link SNAP_TOL} of, drop the duplicate vertices that
 * collapses, then drop the vertices left sitting on a straight run. What comes back out is the exact
 * rectangle (or L) the two rooms describe, with no trace of the nudge.
 */
function cleanRing(ring: Vec2[], subject: Vec2[], clip: Vec2[]): Vec2[] {
  const xs = [...subject, ...clip].map((p) => p.x);
  const ys = [...subject, ...clip].map((p) => p.y);
  const snap = (v: number, axis: number[]) => {
    let best = v;
    let bestD = SNAP_TOL;
    for (const c of axis) {
      const d = Math.abs(c - v);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };
  const snapped = ring.map((p) => ({ x: snap(p.x, xs), y: snap(p.y, ys) }));

  const dedup: Vec2[] = [];
  for (const p of snapped) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > SNAP_TOL) dedup.push(p);
  }
  while (
    dedup.length > 1 &&
    Math.hypot(dedup[0].x - dedup[dedup.length - 1].x, dedup[0].y - dedup[dedup.length - 1].y) <=
      SNAP_TOL
  ) {
    dedup.pop();
  }

  const out: Vec2[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const prev = dedup[(i + dedup.length - 1) % dedup.length];
    const cur = dedup[i];
    const next = dedup[(i + 1) % dedup.length];
    // Perpendicular distance from the straight run through its neighbours: a corner survives, a point
    // that only marks where the nudge stepped does not.
    if (distPointToSegment(cur, prev, next) > SNAP_TOL) out.push(cur);
  }
  return out.length >= 3 ? out : dedup;
}

/**
 * Polygon boolean of two simple polygons via the Greiner–Hormann algorithm, returning the largest
 * resulting ring. `union=false` computes `subject \ clip` (difference); `union=true` computes
 * `subject ∪ clip`.
 *
 * Greiner–Hormann sees TRANSVERSAL crossings only, and two rooms of the same height standing side by side
 * have none: every meeting point is a shared corner or a collinear run, which {@link segInt} rejects. That
 * is not an exotic case — it is what "drop two rooms and overlap them" produces — and left alone it took
 * the containment fallback below and answered "one swallowed the other", silently deleting a room on
 * union. So that case is detected and retried against a hair-nudged clip, which turns every degenerate
 * touch into a real crossing, and {@link cleanRing} then takes the nudge back out of the answer.
 */
function polygonBoolean(subject: Vec2[], clip: Vec2[], union: boolean): Vec2[] | null {
  const direct = polygonBooleanCore(subject, clip, union);
  if (direct !== DEGENERATE) return direct;
  const nudged = polygonBooleanCore(subject, inflatePolygon(clip, NUDGE), union);
  if (nudged === DEGENERATE || !nudged) return null;
  const cleaned = cleanRing(nudged, subject, clip);
  return cleaned.length >= 3 ? cleaned : null;
}

/** Returned by the core when the two outlines only touch, so the caller knows to retry on a nudged clip. */
const DEGENERATE: Vec2[] = [];

function polygonBooleanCore(subject: Vec2[], clip: Vec2[], union: boolean): Vec2[] | null {
  interface N {
    x: number;
    y: number;
    next: N;
    prev: N;
    inter: boolean;
    neighbor: N | null;
    alpha: number;
    entry: boolean;
    visited: boolean;
  }
  const ring = (pts: Vec2[]): N[] => {
    const ns = pts.map(
      (p) =>
        ({
          x: p.x,
          y: p.y,
          inter: false,
          neighbor: null,
          alpha: 0,
          entry: false,
          visited: false,
        }) as N,
    );
    const k = ns.length;
    for (let i = 0; i < k; i++) {
      ns[i].next = ns[(i + 1) % k];
      ns[i].prev = ns[(i + k - 1) % k];
    }
    return ns;
  };
  const sNodes = ring(subject);
  const cNodes = ring(clip);

  // Insert an intersection node along the edge leaving original vertex `from`,
  // keeping intersections on that edge ordered by alpha.
  const insert = (node: N, from: N) => {
    let curr = from.next;
    while (curr.inter && curr.alpha < node.alpha) curr = curr.next;
    node.next = curr;
    node.prev = curr.prev;
    curr.prev.next = node;
    curr.prev = node;
  };

  const allInts: N[] = [];
  for (let i = 0; i < sNodes.length; i++) {
    const a = sNodes[i];
    const b = sNodes[(i + 1) % sNodes.length];
    for (let j = 0; j < cNodes.length; j++) {
      const c = cNodes[j];
      const d = cNodes[(j + 1) % cNodes.length];
      const r = segInt(a, b, c, d);
      if (!r) continue;
      const si = { x: r.p.x, y: r.p.y, inter: true, neighbor: null, alpha: r.t, entry: false, visited: false } as N;
      const ci = { x: r.p.x, y: r.p.y, inter: true, neighbor: null, alpha: r.u, entry: false, visited: false } as N;
      si.neighbor = ci;
      ci.neighbor = si;
      insert(si, a);
      insert(ci, c);
      allInts.push(si);
    }
  }

  if (allInts.length === 0) {
    // No crossings: one polygon wholly inside the other, disjoint — or only TOUCHING, which is the
    // degenerate case this cannot answer and hands back for a retry. Containment is tested over every
    // vertex rather than the first one alone, because a first vertex sitting exactly ON the other outline
    // (two rooms of the same height) is precisely where `pointInPolygon` cannot be trusted.
    const subjInClip = polygonContains(clip, subject);
    const clipInSubj = polygonContains(subject, clip);
    if (!subjInClip && !clipInSubj && polygonsTouch(subject, clip)) return DEGENERATE;
    if (union) {
      if (subjInClip) return clip.map((p) => ({ x: p.x, y: p.y })); // subject swallowed
      if (clipInSubj) return subject.map((p) => ({ x: p.x, y: p.y }));
      return null; // disjoint — no single union ring
    }
    return subjInClip ? null : subject.map((p) => ({ x: p.x, y: p.y })); // difference
  }

  // Mark entry/exit. Both ops walk the subject's portion OUTSIDE the clip; they
  // differ only on the clip: difference keeps the clip INSIDE the subject (reversed,
  // a hole boundary), union keeps the clip OUTSIDE it. So only the clip's `flip` flips.
  const mark = (start: N, other: Vec2[], flip: boolean) => {
    let inside = pointInPolygon(start, other);
    let node = start;
    do {
      if (node.inter) {
        node.entry = flip ? inside : !inside;
        inside = !inside;
      }
      node = node.next;
    } while (node !== start);
  };
  mark(sNodes[0], clip, true);
  mark(cNodes[0], subject, union);

  const rings: Vec2[][] = [];
  for (const start of allInts) {
    if (start.visited) continue;
    const out: Vec2[] = [];
    let current: N = start;
    do {
      current.visited = true;
      if (current.neighbor) current.neighbor.visited = true;
      if (current.entry) {
        do {
          current = current.next;
          out.push({ x: current.x, y: current.y });
        } while (!current.inter);
      } else {
        do {
          current = current.prev;
          out.push({ x: current.x, y: current.y });
        } while (!current.inter);
      }
      current = current.neighbor as N;
    } while (current !== start && out.length < 1000);
    if (out.length >= 3) rings.push(out);
  }
  if (rings.length === 0) return null;
  return rings.reduce((best, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(best)) ? r : best));
}

/** Polygon difference `subject \ clip` (largest ring), or null when consumed. */
export function polygonDifference(subject: Vec2[], clip: Vec2[]): Vec2[] | null {
  return polygonBoolean(subject, clip, false);
}

/** Polygon union `subject ∪ clip` (largest ring), or null when disjoint. */
export function polygonUnion(subject: Vec2[], clip: Vec2[]): Vec2[] | null {
  return polygonBoolean(subject, clip, true);
}

/**
 * New LOCAL interior corners for `target` after subtracting `other`'s outer
 * footprint — the boolean difference behind the overlap click. The result keeps
 * `target`'s old local frame; the caller re-centres it. Null when the subtraction
 * leaves nothing or doesn't change the shape.
 */
export function differenceCorners(target: Square, other: Square): Vec2[] | null {
  const subject = localCorners(target);
  // other's outer footprint → world → target's local frame.
  const otherOuter = outerCorners(localCorners(other), wallThicknesses(other));
  const oa = other.rotation * DEG2RAD;
  const ocos = Math.cos(oa);
  const osin = Math.sin(oa);
  const ocx = other.x + other.width / 2;
  const ocy = other.y + other.height / 2;
  const ta = target.rotation * DEG2RAD;
  const tcos = Math.cos(ta);
  const tsin = Math.sin(ta);
  const tcx = target.x + target.width / 2;
  const tcy = target.y + target.height / 2;
  const clip = otherOuter.map((p) => {
    const wx = ocx + p.x * ocos - p.y * osin;
    const wy = ocy + p.x * osin + p.y * ocos;
    const dx = wx - tcx;
    const dy = wy - tcy;
    return { x: dx * tcos + dy * tsin, y: -dx * tsin + dy * tcos };
  });
  const diff = polygonDifference(subject, clip);
  if (!diff || diff.length < 3) return null;
  // Unchanged (disjoint) ⇒ no-op.
  if (diff.length === subject.length && Math.abs(ringArea(diff) - ringArea(subject)) < 1e-6) {
    return null;
  }
  // Keep the original winding so outerCorners offsets the walls outward.
  if (Math.sign(ringArea(diff)) !== Math.sign(ringArea(subject))) diff.reverse();
  return diff;
}

/** Maps `b`'s LOCAL points into `a`'s local frame (via world). Shared by union ops. */
function localToOtherLocal(b: Square, pts: Vec2[], a: Square): Vec2[] {
  const ba = b.rotation * DEG2RAD;
  const bcos = Math.cos(ba);
  const bsin = Math.sin(ba);
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  const aa = a.rotation * DEG2RAD;
  const acos = Math.cos(aa);
  const asin = Math.sin(aa);
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  return pts.map((p) => {
    const wx = bcx + p.x * bcos - p.y * bsin;
    const wy = bcy + p.x * bsin + p.y * bcos;
    const dx = wx - acx;
    const dy = wy - acy;
    return { x: dx * acos + dy * asin, y: -dx * asin + dy * acos };
  });
}

/**
 * New LOCAL interior corners for the boolean UNION of rooms `a` and `b` — the merged
 * room behind the interior-overlap click. The two INTERIORS are unioned (so the
 * walls between them dissolve into one space); the result keeps `a`'s local frame for
 * the caller to re-centre. Null when the interiors don't actually overlap.
 */
export function unionCorners(a: Square, b: Square): Vec2[] | null {
  const subject = localCorners(a);
  const clip = localToOtherLocal(b, localCorners(b), a); // b's interior in a's frame
  const u = polygonUnion(subject, clip);
  if (!u || u.length < 3) return null;
  if (Math.sign(ringArea(u)) !== Math.sign(ringArea(subject))) u.reverse();
  return u;
}

/**
 * Per-edge wall thicknesses for the union result (corners from {@link unionCorners},
 * in `a`'s local frame). Each merged edge came from one of the two rooms' interior
 * boundaries, so it keeps THAT room's wall thickness — preserving each room's unique
 * edge thicknesses across the join. Falls back to `a`'s first wall if unmatched.
 */
export function unionWallEdges(a: Square, b: Square, resultCorners: Vec2[]): number[] {
  const aPts = localCorners(a);
  const aThick = wallThicknesses(a);
  const bPts = localToOtherLocal(b, localCorners(b), a);
  const bThick = wallThicknesses(b);
  const TOL = 0.5;
  const nearestThick = (m: Vec2, pts: Vec2[], thick: number[]): number | null => {
    let best = -1;
    let bestD = TOL;
    for (let k = 0; k < pts.length; k++) {
      const d = distPointToSegment(m, pts[k], pts[(k + 1) % pts.length]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best >= 0 ? thick[best] : null;
  };
  const fallback = aThick[0] ?? a.walls.n;
  const out: number[] = [];
  const n = resultCorners.length;
  for (let i = 0; i < n; i++) {
    const p = resultCorners[i];
    const q = resultCorners[(i + 1) % n];
    const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    out.push(nearestThick(m, aPts, aThick) ?? nearestThick(m, bPts, bThick) ?? fallback);
  }
  return out;
}

/** Shortest distance from point `m` to segment `a`–`b`. */
function distPointToSegment(m: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(m.x - a.x, m.y - a.y);
  let t = ((m.x - a.x) * dx + (m.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(m.x - (a.x + t * dx), m.y - (a.y + t * dy));
}

/**
 * Per-edge wall thicknesses for the boolean-difference result of `target \ other`
 * (the corners from {@link differenceCorners}, in target's local frame). Each result
 * edge either lies along a TARGET interior edge (keeps that edge's thickness) or
 * along the OTHER room's outer wall — the cut — and inherits the other's wall
 * thickness there. So the trim preserves existing wall thicknesses instead of
 * resetting every wall to a default. Falls back to the target's first wall if an
 * edge can't be matched.
 */
export function differenceWallEdges(target: Square, other: Square, resultCorners: Vec2[]): number[] {
  const tPts = localCorners(target);
  const tThick = wallThicknesses(target);
  // Other's outer footprint mapped into target's local frame (same transform as
  // differenceCorners), with the other's per-edge thickness (one per outer edge).
  const otherOuter = outerCorners(localCorners(other), wallThicknesses(other));
  const oThick = wallThicknesses(other);
  const oa = other.rotation * DEG2RAD;
  const ocos = Math.cos(oa);
  const osin = Math.sin(oa);
  const ocx = other.x + other.width / 2;
  const ocy = other.y + other.height / 2;
  const ta = target.rotation * DEG2RAD;
  const tcos = Math.cos(ta);
  const tsin = Math.sin(ta);
  const tcx = target.x + target.width / 2;
  const tcy = target.y + target.height / 2;
  const clip = otherOuter.map((p) => {
    const wx = ocx + p.x * ocos - p.y * osin;
    const wy = ocy + p.x * osin + p.y * ocos;
    const dx = wx - tcx;
    const dy = wy - tcy;
    return { x: dx * tcos + dy * tsin, y: -dx * tsin + dy * tcos };
  });

  const TOL = 0.5; // world units; result vertices land exactly on a source edge
  const nearestThick = (m: Vec2, pts: Vec2[], thick: number[]): number | null => {
    let best = -1;
    let bestD = TOL;
    for (let k = 0; k < pts.length; k++) {
      const d = distPointToSegment(m, pts[k], pts[(k + 1) % pts.length]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best >= 0 ? thick[best] : null;
  };

  const fallback = tThick[0] ?? target.walls.n;
  const n = resultCorners.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = resultCorners[i];
    const b = resultCorners[(i + 1) % n];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Target edges win (a kept wall keeps its thickness); else it's a cut edge that
    // follows the other room's wall.
    out.push(nearestThick(m, tPts, tThick) ?? nearestThick(m, clip, oThick) ?? fallback);
  }
  return out;
}

/** Corner handle (nw/ne/se/sw) → its index in the [nw,ne,se,sw] corner order. */
export function cornerIndexForHandle(handle: HandleId): number {
  const i = (CORNER_HANDLES as readonly string[]).indexOf(String(handle));
  return i < 0 ? 0 : i;
}

/** World-space outward unit normal of interior edge `e` (corner e → e+1). */
function edgeNormalWorld(shape: Square, e: number): Vec2 {
  const pts = localCorners(shape);
  const a = pts[e];
  const b = pts[(e + 1) % pts.length];
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.hypot(ex, ey) || 1;
  const lnx = ey / len; // local outward normal (clockwise winding, y-down)
  const lny = -ex / len;
  const t = shape.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { x: lnx * cos - lny * sin, y: lnx * sin + lny * cos };
}

/**
 * Moves a set of interior corners by the same world-space delta, so the room
 * becomes a free quadrilateral. The drag is mapped into the local frame and the
 * corners are stored relative to the UNCHANGED centre. Keeping the centre fixed
 * is what stops the shape jittering: the render rounds the centre and each corner
 * separately, so a centre that shifted every frame would make the anchored
 * corners wobble ±1px under the double-rounding. width/height bound the corners
 * symmetrically about the centre, which keeps culling/marquee correct.
 */
function moveCorners(
  original: Square,
  indices: number[],
  worldDx: number,
  worldDy: number,
): Square {
  const t = original.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;

  const pts = localCorners(original);
  for (const index of indices) {
    pts[index] = { x: pts[index].x + ldx, y: pts[index].y + ldy };
  }
  return finalizeCorners(original, pts);
}

/**
 * Rebuilds a Square from a new set of LOCAL corners while holding the centre
 * fixed (so anchored corners stay pixel-stable — see moveCorners). width/height
 * are symmetric half-extents about the centre, keeping the AABB a valid bound.
 */
function finalizeCorners(original: Square, pts: Vec2[]): Square {
  let maxX = 0;
  let maxY = 0;
  for (const p of pts) {
    maxX = Math.max(maxX, Math.abs(p.x));
    maxY = Math.max(maxY, Math.abs(p.y));
  }
  const newW = maxX * 2;
  const newH = maxY * 2;
  const cx = original.x + original.width / 2;
  const cy = original.y + original.height / 2;
  return {
    ...original,
    x: cx - newW / 2,
    y: cy - newH / 2,
    width: newW,
    height: newH,
    corners: pts,
  };
}

/** Moves a single interior corner by a world delta (free-form vertex drag). */
export function moveVertex(
  original: Square,
  index: number,
  worldDx: number,
  worldDy: number,
): Square {
  return moveCorners(original, [index], worldDx, worldDy);
}

/**
 * New positions for edge `e`'s two endpoints when that edge is offset along its
 * outward normal by `perp` (local units): the endpoints slide along the two
 * adjacent edge lines (kept on their original directions), so the neighbouring
 * edges only lengthen/shorten. Falls back to a plain perpendicular move if an
 * adjacent edge is parallel to this one.
 */
function offsetEdgeEndpoints(pts: Vec2[], e: number, perp: number): { p0: Vec2; p1: Vec2 } {
  const n = pts.length;
  const i0 = e;
  const i1 = (e + 1) % n;
  const iPrev = (e + n - 1) % n;
  const iNext = (e + 2) % n;
  const dEx = pts[i1].x - pts[i0].x;
  const dEy = pts[i1].y - pts[i0].y;
  const len = Math.hypot(dEx, dEy) || 1;
  const nEx = dEy / len; // outward (clockwise winding, y-down)
  const nEy = -dEx / len;
  const off = { x: pts[i0].x + nEx * perp, y: pts[i0].y + nEy * perp };
  const dE = { x: dEx, y: dEy };
  const dPrev = { x: pts[i0].x - pts[iPrev].x, y: pts[i0].y - pts[iPrev].y };
  const dNext = { x: pts[i1].x - pts[iNext].x, y: pts[i1].y - pts[iNext].y };
  const p0 = lineIntersect(pts[iPrev], dPrev, off, dE) ?? off;
  const p1 =
    lineIntersect(pts[iNext], dNext, off, dE) ?? { x: pts[i1].x + nEx * perp, y: pts[i1].y + nEy * perp };
  return { p0, p1 };
}

/**
 * Stretches one side of a free-form quad. The edge is offset along its own
 * outward normal by the perpendicular drag, then its two endpoints slide ALONG
 * the two adjacent edges' lines (kept on their original directions). So the
 * neighbouring edges only grow or shrink — they don't change angle — and the two
 * far corners stay anchored. (Rectangles use `resizeShape`, staying rectangular.)
 */
export function stretchEdge(
  original: Square,
  handle: HandleId,
  worldDx: number,
  worldDy: number,
): Square {
  const e = edgeIndexOf(handle);
  const pts = localCorners(original);
  const i0 = e;
  const i1 = (e + 1) % pts.length;

  // Edge outward normal (local), and the drag projected onto it.
  const dEx = pts[i1].x - pts[i0].x;
  const dEy = pts[i1].y - pts[i0].y;
  const len = Math.hypot(dEx, dEy) || 1;
  const nEx = dEy / len;
  const nEy = -dEx / len;
  const t = original.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;
  const perp = ldx * nEx + ldy * nEy;

  const { p0, p1 } = offsetEdgeEndpoints(pts, e, perp);
  const next = pts.slice();
  next[i0] = p0;
  next[i1] = p1;
  return finalizeCorners(original, next);
}

/** Pointer expressed in a shape's local (un-rotated, centre-origin) screen frame. */
interface LocalFrame {
  lx: number;
  ly: number;
  /** Half-extents of the shape in screen pixels. */
  hw: number;
  hh: number;
}

function localScreenFrame(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): LocalFrame {
  const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
  const dx = screenX - c.x;
  const dy = screenY - c.y;
  const a = -shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    lx: dx * cos - dy * sin,
    ly: dx * sin + dy * cos,
    hw: (shape.width * camera.scale) / 2,
    hh: (shape.height * camera.scale) / 2,
  };
}

export interface DrawShapesParams {
  ctx: CanvasRenderingContext2D;
  shapes: Square[];
  camera: Camera;
  selectedIds: Set<string>;
  /**
   * The selection's active region. A handle id darkens just that one wall edge;
   * `null` (with a non-empty selection) darkens the white infill instead.
   */
  activeHandle: HandleId | null;
  /**
   * Which face of the active edge to pick out in magenta — `'inner'` or
   * `'outer'`, whichever the pointer is nearer — or `null` when not hovering it.
   * Only one face lights at a time, and only for a single selected edge.
   */
  activeEdgeFace: EdgeFace | null;
  /**
   * Shift-held variant: light up EVERY edge's `activeEdgeFace` (all inner faces or
   * all outer faces) in magenta, so a drag stretches the whole interior/outer
   * boundary at once. Only meaningful alongside a non-null `activeEdgeFace`.
   */
  activeEdgeFaceAll?: boolean;
  /**
   * True once the active edge was armed by a clean click (no drag) — gates the
   * per-edge wall length/thickness dimensions, so a fresh stretch never summons them.
   */
  wallDimsArmed?: boolean;
  /**
   * The shape the pointer is currently over, and which region of it. Mirrors the
   * selected-state darkening as a hover preview — the infill or the hovered edge
   * darkens — so a shape reads as ready to move/stretch before any click.
   */
  hoverId: string | null;
  hoverRegion: HoverRegion | null;
  /**
   * True while an edge stretch is in progress AND dimensions were already
   * showing (the shape was infill-selected) when it began. Keeps the dimension
   * lines visible and live-updating through the drag; a stretch started on the
   * edge of a non-dim shape leaves this false, so no dimensions appear.
   */
  resizing: boolean;
  /**
   * While a shape is being rotated, the shape id and the corner the rotation was
   * grabbed from — drives the live angle readout drawn next to that corner.
   */
  rotating: { id: string; corner: HandleId } | null;
  /** Active measurement unit for all dimension labels and the area readout. */
  unit: LengthUnit;
  width: number;
  height: number;
  theme: ShapeTheme;
  /**
   * Shape ids in the order they were selected (oldest first). Drives the TEMP
   * green selection-order debug numbers; will feed boolean ops (e.g. difference
   * = first selected minus the rest).
   */
  selectionOrder?: string[];
  /**
   * Cursor position in canvas-local screen px (or null when off-canvas / mid-
   * drag). Lets a shared overlap edge highlight yellow when hovered, once two
   * overlapping shapes are both selected.
   */
  hoverPoint?: { x: number; y: number } | null;
  /** Shape whose centre readouts (name/area) are hovered — draws the edit box. */
  centerHoverId?: string | null;
  /**
   * Per-shape constraint violations (by shape id). When a shape breaks a rule its
   * offending wall(s) / over-area outline are flagged bright green. Absent/empty
   * when no constraints are set — the common, zero-cost case.
   */
  violations?: Map<string, ShapeViolations>;
  /**
   * When true (the Debug toggle is on), dev overlays are drawn: the green
   * selection-order centre numbers and the cyan infill-overlap region. Off by
   * default, so these are hidden during normal use.
   */
  debug?: boolean;
  /**
   * When true, every committed shape is drawn ghosted (translucent). Driven by Dev mode OR
   * the Analyze view — separate from `debug` so Analyze fades the rooms without the dev
   * overlays (green numbers / red-cyan overlap).
   */
  ghosted?: boolean;
  /**
   * Facade mode: render committed shapes as a white-on-black wireframe (white infill + white wall
   * band, black inner/outer edge lines) so a panel reads as glass-with-a-frame, not a grey material.
   * Placement previews are unaffected.
   */
  facade?: boolean;
  /**
   * Translucent ghost(s) of the shape(s) an edge-plus button would drop — one while
   * hovered, several (sequential) while dragged — drawn on top of everything. Absent
   * when no button is hovered/dragged.
   */
  duplicatePreviews?: Square[] | null;
  /**
   * Active next-room prediction fan: the opened shape, which edge's arrow is being
   * dragged, and which of the three options (0..2) is hovered. Absent unless an arrow
   * is being dragged; drawn above everything as a semicircle of option circles.
   */
  predictionDrag?: {
    shapeId: string;
    dir: number;
    hovered: number | null;
    options: (PredictionOption | null)[];
  } | null;
  /**
   * Smart-find result: rooms matched by a search ("show me all kitchens") get a
   * translucent accent-blue wash over their interior. Absent/empty when no find
   * is active. Coexists with selection — a shape can be both selected and matched.
   */
  highlightIds?: Set<string>;
  /**
   * Smart-find wall matches ("highlight all 6\" walls"): per-shape list of the wall
   * sides to wash accent-blue. Keys are `HandleId`s — named sides ('n'|'e'|'s'|'w')
   * for rectangles, numeric edge indices for free polygons.
   */
  highlightWalls?: Map<string, HandleId[]>;
  /**
   * Facade standardization (Analyze popup) — shape id → its panel-type colour. When present, each
   * panel's infill is painted its type colour (so duplicates share a colour and an adjusted panel
   * stands out); a selected panel is filled more strongly so the active type group reads clearly.
   */
  panelColors?: Map<string, string>;
}

/**
 * Draws every square (z-order = array order), each rotated about its centre.
 * Selected squares get the emphasised outline. No visible resize/rotate
 * handles are drawn — stretching (edges) and rotating (corners) are discovered
 * via the cursor alone.
 */
export function drawShapes({
  ctx,
  shapes,
  camera,
  selectedIds,
  activeHandle,
  activeEdgeFace,
  activeEdgeFaceAll,
  wallDimsArmed,
  hoverId,
  hoverRegion,
  resizing,
  rotating,
  unit,
  width,
  height,
  theme,
  selectionOrder,
  hoverPoint,
  centerHoverId,
  violations,
  debug,
  ghosted,
  facade,
  duplicatePreviews,
  predictionDrag,
  highlightIds,
  highlightWalls,
  panelColors,
}: DrawShapesParams): void {
  // Overlap cues (pre-boolean groundwork): inside any region two rooms share the
  // wall lightens a touch (the shared-infill + wall-in-both regions use debug
  // colours for now).
  const overlapStroke = shade(theme.stroke, OVERLAP_WALL_LIGHTEN);
  // Facade wireframe palette: white wall band + black edge face-lines (vs the normal dark-grey wall
  // and white face-lines). White infill is unchanged. Overlap regions also go white so touching
  // panels stay clean. `faceLine` drives both the always-on edge lines and the overlap interior edges.
  const wallFill = facade ? '#ffffff' : theme.stroke;
  const edgeLineColor = facade ? '#000000' : '#ffffff';
  const overlapBase = facade ? '#ffffff' : overlapStroke;
  // Each shape's interior + outer footprint in absolute screen px, plus the
  // outer AABB, computed once per frame so the overlap pass is a cheap O(n²) of
  // bounding-box tests plus a clip only for pairs that actually touch.
  const footprints = shapes.map((s) => {
    const { inner, outer } = footprintScreen(s, camera);
    let minX = Infinity;
    const id = s.id;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { id, inner, outer, minX, minY, maxX, maxY };
  });

  // Trace a closed polygon (current user space) — used by the overlap pass.
  const tracePoly = (pts: Vec2[]): void => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();
  };

  // Intersect the clip with the region OUTSIDE `poly`: a canvas-covering rect
  // with the polygon punched out via the even-odd rule. One polygon per call, so
  // stacking calls excludes several polygons without the "inside two at once gets
  // re-included" pitfall of punching them all into a single even-odd path.
  const clipOutside = (poly: Vec2[]): void => {
    ctx.beginPath();
    ctx.rect(-1e6, -1e6, 2e6, 2e6);
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x, poly[k].y);
    ctx.closePath();
    ctx.clip('evenodd');
  };

  // Dimension brackets + labels are collected here during the body loop and
  // replayed after the overlap pass, so a selected shape's dimensions always sit
  // above every body and overlap cue (never hidden by an overlapping neighbour).
  const deferredDims: Array<() => void> = [];

  // Ghosted view (Dev mode or Analyze): render every committed shape translucent so the canvas
  // reads as a working/under-construction layer. Set once here; the body loop and overlap pass
  // below each use per-shape / per-pair save+restore, so this base opacity carries through both
  // passes and is reset to 1 before the deferred labels (so dimensions/readouts stay fully legible).
  const baseAlpha = ghosted ? DEBUG_GHOST_ALPHA : 1;
  ctx.globalAlpha = baseAlpha;

  for (let si = 0; si < shapes.length; si++) {
    const shape = shapes[si];
    const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
    const wS = shape.width * camera.scale;
    const hS = shape.height * camera.scale;
    // Thickest wall in screen px (per-edge aware) — only used to pad the cull reach.
    const maxWallPx = Math.max(...wallThicknesses(shape)) * camera.scale;

    // Fade shared by the area readout and the dimension lines: both ease out
    // together as the shape gets too small on screen to read.
    const shortSide = Math.min(wS, hS);
    const labelAlpha = clamp01(
      (shortSide - AREA_LABEL_FADE_START) / (AREA_LABEL_FADE_END - AREA_LABEL_FADE_START),
    );

    const selected = selectedIds.has(shape.id);
    const isRect = !shape.corners;
    const singleSel = selected && selectedIds.size === 1;
    // Width/height dimension brackets for a lone infill-selected shape: a
    // rectangle's hang off its walls (live during a stretch); a reshaped quad's
    // hang off its bounding box.
    const dimsRect = isRect && singleSel && (!activeHandle || resizing);
    const dimsPoly = !isRect && singleSel;
    const showDims = dimsRect || dimsPoly;
    // The clicked wall's own length + thickness dimensions: shown only once the edge
    // has been ARMED by a clean click (wallDimsArmed) — so a fresh stretch never
    // summons them — and then persistently while that edge stays active (the labels
    // stay put and clickable even when the cursor leaves the band to reach them). The
    // magenta stretch line is still gated separately on hovering the face.
    const showWallDims =
      singleSel && !!wallDimsArmed && activeHandle != null && edgeIndexOf(activeHandle) >= 0;

    // Cull, with a margin for the outward wall band and the stroke — plus extra
    // reach for the dimension brackets that sit outside the shape, when shown.
    const reach =
      Math.hypot(wS, hS) / 2 + maxWallPx + 2 + (showDims || showWallDims ? DIMENSION_REACH : 0);
    if (c.x + reach < 0 || c.y + reach < 0 || c.x - reach > width || c.y - reach > height) {
      continue;
    }

    const rot = shape.rotation * DEG2RAD;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const rcx = Math.round(c.x);
    const rcy = Math.round(c.y);

    ctx.save();
    ctx.translate(rcx, rcy);
    ctx.rotate(rot);

    // Snap a scaled-local point to a whole pixel in ABSOLUTE screen space, then
    // express it back in this translated+rotated frame. Snapping the absolute
    // position (rather than rounding the centre and the local offset separately)
    // keeps anchored corners pixel-stable while the centre slides during a
    // stretch — and is computed from the EXACT (unrounded) geometry so a moving
    // neighbour can't make an anchored corner's wall miter flicker.
    const stab = (lsx: number, lsy: number): Vec2 => {
      const ax = c.x + lsx * cosR - lsy * sinR;
      const ay = c.y + lsx * sinR + lsy * cosR;
      const dx = Math.round(ax) - rcx;
      const dy = Math.round(ay) - rcy;
      return { x: dx * cosR + dy * sinR, y: -dx * sinR + dy * cosR };
    };

    // Interior corners (exact, then stabilised). For a rect these are the
    // familiar axis-aligned points; for a reshaped quad, the four free vertices.
    const iExact = localCorners(shape).map((p) => ({
      x: p.x * camera.scale,
      y: p.y * camera.scale,
    }));
    const iPts: Vec2[] = iExact.map((p) => stab(p.x, p.y));
    // Outer (wall) corners: each interior edge offset outward by its side's
    // thickness, mitered at the corners (n, e, s, w) — built from the exact inner
    // points so the miters stay steady, then stabilised the same way.
    const oPts = outerCorners(
      iExact,
      wallThicknesses(shape).map((w) => w * camera.scale),
    ).map((p) => stab(p.x, p.y));
    // Edge polylines for the thin face-lines, generalised to any vertex count:
    // each interior/outer edge k runs from point k to k+1.
    const edgeLines = (pts: Vec2[]): void => {
      ctx.beginPath();
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    };

    // Best-fit bounding box (tight interior AABB) corners [TL, TR, BR, BL] — every
    // side touches an extreme corner. For a reshaped quad it's the box dimensions
    // + rotation controls hang off; for a plain rect it's just the interior rect.
    const bb = boundingBoxLocal(shape);
    const bboxPts = [
      stab(bb.minX * camera.scale, bb.minY * camera.scale),
      stab(bb.maxX * camera.scale, bb.minY * camera.scale),
      stab(bb.maxX * camera.scale, bb.maxY * camera.scale),
      stab(bb.minX * camera.scale, bb.maxY * camera.scale),
    ];
    const bbW = bb.maxX - bb.minX;
    const bbH = bb.maxY - bb.minY;

    const polyPath = (pts: Vec2[]) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.closePath();
    };

    // [x0,y0,x1,y1] of one side's inner (interior-facing) or outer face line.
    // Shared by the always-on white border and the magenta hover highlight.
    const faceLine = (hdl: HandleId, face: EdgeFace): [number, number, number, number] => {
      const e = edgeIndexOf(hdl);
      const pts = face === 'inner' ? iPts : oPts;
      const a = pts[e];
      const b = pts[(e + 1) % pts.length];
      return [a.x, a.y, b.x, b.y];
    };

    // An edge reads darker when it's the selected region OR is being hovered;
    // the infill darkens when it's the selected region OR is being hovered.
    const hovered = shape.id === hoverId;
    const hoverEdge: HandleId | null =
      hovered && hoverRegion && hoverRegion !== 'infill' ? hoverRegion : null;
    const darkEdges: HandleId[] = [];
    if (selected && activeHandle) darkEdges.push(activeHandle);
    if (hoverEdge && hoverEdge !== activeHandle) darkEdges.push(hoverEdge);

    // Standardization view: paint the panel its type colour. A selected panel fills its
    // wall band with the colour too (and a darker infill below), so the active type group
    // reads as solid while the rest show a white band with a colour-filled interior.
    const typeColor = panelColors?.get(shape.id);

    // Walls in the base shade (whole band), then overdraw each darkened side's
    // strip (the quad between that side's inner and outer edges).
    ctx.fillStyle = typeColor && selected ? shade(typeColor, -0.2) : wallFill;
    polyPath(oPts);
    ctx.fill();
    if (darkEdges.length > 0) {
      ctx.fillStyle = theme.selectedStroke;
      for (const hdl of darkEdges) {
        const e = edgeIndexOf(hdl);
        const j = (e + 1) % iPts.length;
        polyPath([iPts[e], iPts[j], oPts[j], oPts[e]]);
        ctx.fill();
      }
    }

    // Smart-find wall matches: wash just the matched wall bands in accent blue
    // (same band quad as the darkened-edge strip). Numeric handles index a free
    // polygon's edge directly; named sides go through edgeIndexOf.
    const matchedWalls = highlightWalls?.get(shape.id);
    if (matchedWalls && matchedWalls.length > 0) {
      ctx.fillStyle = FIND_HIGHLIGHT;
      for (const hdl of matchedWalls) {
        const e = typeof hdl === 'number' ? hdl : edgeIndexOf(hdl);
        if (e < 0 || e >= iPts.length) continue;
        const j = (e + 1) % iPts.length;
        polyPath([iPts[e], iPts[j], oPts[j], oPts[e]]);
        ctx.fill();
      }
    }

    // Interior darkened when the infill is the selected region (move) or hovered.
    const infillDark = (selected && !activeHandle) || (hovered && hoverRegion === 'infill');
    ctx.fillStyle = typeColor
      ? selected
        ? shade(typeColor, -0.35)
        : typeColor
      : infillDark
        ? theme.selectedFill
        : theme.fill;
    polyPath(iPts);
    ctx.fill();

    // Smart-find room match: a translucent accent-blue wash over the interior so
    // the room reads as "found" without hiding its contents (sits above the infill).
    if (highlightIds?.has(shape.id)) {
      ctx.save();
      ctx.globalAlpha = FIND_ROOM_ALPHA;
      ctx.fillStyle = FIND_HIGHLIGHT;
      polyPath(iPts);
      ctx.fill();
      ctx.restore();
    }

    // Thin border on every side's inner and outer face — together the inner
    // faces read as a frame inside the grey band, the outer faces as one outside
    // it. White; only the enlarged edge-stretch highlight (below) is magenta.
    ctx.strokeStyle = edgeLineColor; // thin edge face-lines (white normally, black in Facade wireframe)
    ctx.lineWidth = 1;

    // Interior face-lines — always shown (one per interior edge).
    edgeLines(iPts);

    // Exterior face-lines — shown everywhere EXCEPT inside another shape's
    // footprint, so within an overlap only the interior lines remain. Each
    // overlapping neighbour's footprint (mapped into this shape's rotated frame)
    // is excluded from the clip before the lines are stroked.
    const self = footprints[si];
    const neighbours = footprints.filter((o, oi) => {
      if (oi === si) return false;
      return !(self.maxX < o.minX || o.maxX < self.minX || self.maxY < o.minY || o.maxY < self.minY);
    });
    ctx.save();
    for (const o of neighbours) {
      clipOutside(
        o.outer.map((p) => {
          const dx = p.x - rcx;
          const dy = p.y - rcy;
          return { x: dx * cosR + dy * sinR, y: -dx * sinR + dy * cosR };
        }),
      );
    }
    edgeLines(oPts);
    ctx.restore();

    // Hovering a single selected edge picks out just ONE of that wall's faces —
    // whichever (inner or outer) the cursor is nearer — in magenta. With Shift held
    // (activeEdgeFaceAll), EVERY edge's face of that kind lights instead, so a drag
    // stretches the whole interior or outer boundary at once.
    if (selected && activeHandle && activeEdgeFace && selectedIds.size === 1) {
      ctx.strokeStyle = theme.edgeHover;
      ctx.lineWidth = 3;
      if (activeEdgeFaceAll) {
        edgeLines(activeEdgeFace === 'inner' ? iPts : oPts);
      } else {
        const line = faceLine(activeHandle, activeEdgeFace);
        ctx.beginPath();
        ctx.moveTo(line[0], line[1]);
        ctx.lineTo(line[2], line[3]);
        ctx.stroke();
      }
    }

    // The clicked wall's own length + thickness dimensions, hugging the active edge.
    // They appear with the magenta stretch lines and update live as the wall is
    // dragged (both values are read fresh from the shape each frame). Deferred so
    // they sit above the bodies and overlap cues, like the box dimensions.
    if (showWallDims && labelAlpha > 0) {
      const e = edgeIndexOf(activeHandle);
      if (e >= 0) {
        const j = (e + 1) % iPts.length;
        const A = iPts[e];
        const B = iPts[j];
        const D = oPts[e];
        const C = oPts[j];
        const lenW = edgeLengthsWorld(shape)[e];
        const thickW = wallThicknesses(shape)[e];
        deferredDims.push(() => {
          ctx.save();
          ctx.translate(rcx, rcy);
          ctx.rotate(rot);
          ctx.globalAlpha = labelAlpha;
          drawWallDimensions(ctx, A, B, C, D, lenW, thickW, shape.rotation, unit, theme);
          ctx.globalAlpha = 1;
          ctx.restore();
        });
      }
    }

    // Dimension brackets — width along the top, height along the right, beyond
    // the wall band — plus the corner rotation arcs. Deferred so they sit above
    // everything; skipped when too small to read.
    if (dimsRect && labelAlpha > 0) {
      deferredDims.push(() => {
        ctx.save();
        ctx.translate(rcx, rcy);
        ctx.rotate(rot);
        ctx.globalAlpha = labelAlpha; // fade out with the area readout when small
        drawBoxDimensions(ctx, iPts, oPts, shape.width, shape.height, shape.rotation, unit, theme);
        if (!shape.dots) {
          ctx.strokeStyle = theme.label;
          ctx.lineWidth = 1;
          drawCornerRotationArcs(ctx, oPts, DIMENSION_GAP / 2);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      });
    }

    // A reshaped (irregular) quad is dimensioned and rotated about its best-fit
    // bounding box: the box is outlined, then the SAME width/height brackets and
    // corner rotation arcs as a rectangle hang off it — so however jagged the
    // outline, the controls read as a clean rectangle. (inner === outer === box,
    // since there is no separate wall band to offset from.)
    if (dimsPoly && labelAlpha > 0) {
      deferredDims.push(() => {
        ctx.save();
        ctx.translate(rcx, rcy);
        ctx.rotate(rot);
        ctx.globalAlpha = labelAlpha;
        // Bounding-box outline + dimensions, all drawn together so the box edges
        // and the bracket feet share the exact same snapped coordinates.
        drawBoxDimensions(ctx, bboxPts, bboxPts, bbW, bbH, shape.rotation, unit, theme, true);
        if (!shape.dots) {
          ctx.strokeStyle = theme.label;
          ctx.lineWidth = 1;
          drawCornerRotationArcs(ctx, bboxPts, DIMENSION_GAP / 2);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      });
    }

    // Constraint violations — flag, don't change. Paint each offending wall strip
    // (the quad between that edge's inner and outer faces) and, when the room is
    // over the max area, outline its outer footprint — all bright green. Drawn on
    // top of this shape's own body; geometry is never modified.
    const v = violations?.get(shape.id);
    if (v?.any) {
      ctx.save();
      // Bad sides (wall thickness out of bounds, or side too short) → yellow strip.
      ctx.fillStyle = VIOLATION_YELLOW;
      ctx.globalAlpha = 0.55;
      for (const e of v.flaggedEdges) {
        const j = (e + 1) % iPts.length;
        polyPath([iPts[e], iPts[j], oPts[j], oPts[e]]);
        ctx.fill();
      }
      // Room below the minimum area → yellow wash over the white infill.
      if (v.areaUnder) {
        ctx.fillStyle = VIOLATION_YELLOW;
        ctx.globalAlpha = 0.5;
        polyPath(iPts);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Room above the maximum area → yellow outline of the outer footprint.
      if (v.areaOver) {
        ctx.strokeStyle = VIOLATION_YELLOW;
        ctx.lineWidth = 2.5;
        polyPath(oPts);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  // ── Overlap cues (groundwork for boolean ops) ───────────────────────────────
  // A final pass, drawn over every body, so the look of a shared region does NOT
  // depend on which shape sits on top — there is no z-order here. For each pair
  // of shapes whose wall footprints intersect, the overlap is restyled
  // symmetrically (exterior edges are already withheld here by the body pass):
  //   • wall ∩ infill   → mid-grey (lighter than the default dark wall)
  //   • wall ∩ wall      → red  (debug)
  //   • infill ∩ infill  → cyan (debug)
  //   • both rooms' interior edges → magenta (debug)
  // Clipped to the exact intersection — which canvas handles even for a concave
  // reshaped quad — so it live-updates as shapes are dragged. No alpha.
  for (let i = 0; i < footprints.length; i++) {
    const A = footprints[i];
    for (let j = i + 1; j < footprints.length; j++) {
      const B = footprints[j];
      // Broad-phase: ignore pairs whose screen bounding boxes don't touch.
      if (A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY) {
        continue;
      }
      ctx.save();
      // Clip to the overlap region = A's footprint ∩ B's footprint.
      tracePoly(A.outer);
      ctx.clip();
      tracePoly(B.outer);
      ctx.clip();
      // Base coat: mid-grey across the whole overlap — lighter than the default
      // dark wall, darker than the infill. The red/cyan steps below repaint the
      // wall-in-both and infill-in-both sub-regions; what's left mid-grey is the
      // wall-over-the-other-room band.
      ctx.fillStyle = overlapBase;
      tracePoly(A.outer);
      ctx.fill();
      // Which shared-overlap grey band the cursor is over — only when BOTH rooms
      // are selected (≥2 selected). 'AB' = A's wall over B's infill, 'BA' = the
      // reverse. Drives the merge preview drawn after the magenta edges below.
      let hoverBand: 'AB' | 'BA' | null = null;
      // Hovering the infill∩infill region (cyan in Debug) with both rooms selected
      // cues a boolean UNION — drawn as a "+" grid over that shared interior below.
      let hoverUnion = false;
      if (hoverPoint && selectedIds.size >= 2 && selectedIds.has(A.id) && selectedIds.has(B.id)) {
        const inAi = pointInPolygon(hoverPoint, A.inner);
        const inBi = pointInPolygon(hoverPoint, B.inner);
        const inAo = pointInPolygon(hoverPoint, A.outer);
        const inBo = pointInPolygon(hoverPoint, B.outer);
        if (inAo && inBi && !inAi) hoverBand = 'AB';
        else if (inBo && inAi && !inBi) hoverBand = 'BA';
        else if (inAi && inBi) hoverUnion = true;
      }
      // The wall-in-BOTH pieces — the thick-edge bits that sit OUTSIDE the
      // enclosed (inner ∩ inner) magenta region, reading as two little squares in
      // a diagonal overlap — are painted RED in Debug, else repainted the default
      // dark wall grey so they read as a solid thick edge (not the lighter mid-grey
      // base coat). Region = the overlap minus each room's interior. The mid-grey
      // wall-over-infill pieces are untouched.
      {
        ctx.save();
        clipOutside(A.inner);
        clipOutside(B.inner);
        ctx.fillStyle = debug ? '#ff0000' : wallFill; // debug red, else wall (white in Facade)
        tracePoly(A.outer);
        ctx.fill();
        ctx.restore();
      }
      // Infill where BOTH rooms' interiors meet — painted CYAN in Debug, else the
      // default white infill so the shared interior reads as plain room space (not
      // the mid-grey base coat). Restricted to the interior intersection so either
      // room's wall still reads as a wall where it crosses the other's room.
      {
        ctx.save();
        tracePoly(A.inner);
        ctx.clip();
        tracePoly(B.inner);
        ctx.clip();
        ctx.fillStyle = debug ? '#00ffff' : theme.fill; // debug cyan, else white infill
        tracePoly(A.inner);
        ctx.fill();
        ctx.restore();
      }
      // Both rooms' interior edges restored, matching the edge face-lines.
      ctx.strokeStyle = edgeLineColor;
      ctx.lineWidth = 1;
      tracePoly(A.inner);
      ctx.stroke();
      tracePoly(B.inner);
      ctx.stroke();

      // Trim preview: hovering a grey wall-over-infill band hatches that region
      // (the band + its cyan infill∩infill) with diagonal lines, signifying it
      // will be erased when the boolean runs. Region = the other room's interior
      // ∩ this band's wall footprint, which lies within `fp`'s screen bounds.
      if (hoverBand) {
        const keepInner = hoverBand === 'AB' ? B.inner : A.inner;
        const fp = hoverBand === 'AB' ? A : B;
        ctx.save();
        tracePoly(keepInner);
        ctx.clip(); // = overlap ∩ keepInner = the region to be trimmed
        ctx.strokeStyle = '#6ea8fe'; // blue diagonal hatch = "to be erased" (accent blue)
        ctx.lineWidth = 1;
        ctx.beginPath();
        const HATCH_GAP = 8; // spacing along the x+y axis (≈5.7px perpendicular)
        for (let c = fp.minX + fp.minY; c <= fp.maxX + fp.maxY; c += HATCH_GAP) {
          ctx.moveTo(c - fp.minY, fp.minY);
          ctx.lineTo(c - fp.maxY, fp.maxY);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Union preview: hovering the shared interior (the cyan infill∩infill region)
      // tiles a "+" grid over it — the visual cue that a click there merges the two
      // rooms into one. Clipped to A.inner ∩ B.inner so it fills exactly the mergeable
      // area; marks are anchored to a screen-space lattice so they stay put as shapes
      // move and only the clip changes.
      if (hoverUnion) {
        ctx.save();
        tracePoly(A.inner);
        ctx.clip();
        tracePoly(B.inner);
        ctx.clip();
        ctx.strokeStyle = '#6ea8fe'; // accent blue, matching the trim hatch
        ctx.lineWidth = 1; // same weight as the diagonal trim hatch
        ctx.lineCap = 'round';
        const GRID = 12; // spacing between plus marks
        const ARM = 4; // half-length of each plus arm
        const minX = Math.max(A.minX, B.minX);
        const minY = Math.max(A.minY, B.minY);
        const maxX = Math.min(A.maxX, B.maxX);
        const maxY = Math.min(A.maxY, B.maxY);
        ctx.beginPath();
        for (let x = Math.ceil(minX / GRID) * GRID; x <= maxX; x += GRID) {
          for (let y = Math.ceil(minY / GRID) * GRID; y <= maxY; y += GRID) {
            ctx.moveTo(x - ARM, y);
            ctx.lineTo(x + ARM, y);
            ctx.moveTo(x, y - ARM);
            ctx.lineTo(x, y + ARM);
          }
        }
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // End of the ghosted body + overlap layer — labels, selection chrome, previews and the
  // debug overlays below all draw at full opacity.
  ctx.globalAlpha = 1;

  // Dimension brackets + labels, lifted above all bodies and overlap cues.
  for (const fn of deferredDims) fn();

  // Text readouts last, so the overlap fills never cover them.
  for (const shape of shapes) {
    const wS = shape.width * camera.scale;
    const hS = shape.height * camera.scale;
    const labelAlpha = clamp01(
      (Math.min(wS, hS) - AREA_LABEL_FADE_START) / (AREA_LABEL_FADE_END - AREA_LABEL_FADE_START),
    );

    // Area readout — drawn in screen space so it stays upright regardless of the
    // shape's rotation. Constant on-screen size; it fades out (with the dimension
    // lines) as the shape gets too small on screen to read. Positioned at the
    // polygon centroid so it sits at the visual middle even for a reshaped room.
    // Hidden on rooms in a multi-selection so the edges + boolean cues read clearly.
    const inMultiSelect = selectedIds.size >= 2 && selectedIds.has(shape.id);
    if (labelAlpha > 0 && !inMultiSelect) {
      const cen = shapeCentroidLocal(shape);
      const cenScreen = localToScreen(shape, camera, cen.x * camera.scale, cen.y * camera.scale);
      const cx = Math.round(cenScreen.x);
      const cy = Math.round(cenScreen.y);
      // In Facade mode a panel carries a short assembly name ("UCWP"); when it's the lone
      // selection, expand it to the full title ("Unitized Curtain Wall Panel"). Other shapes
      // (and unselected panels) keep their stored name as-is.
      const singleSelected = selectedIds.has(shape.id) && selectedIds.size === 1;
      const nameText =
        facade && singleSelected ? fullAssemblyName(shape.name) : shape.name ?? 'Room';
      const areaText = formatArea(shape, unit);
      ctx.save();
      ctx.globalAlpha = labelAlpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Hover affordance: a thin rounded box around BOTH readouts shows they're
      // editable (click the title to rename, the area to set square footage).
      if (centerHoverId === shape.id) {
        const nameW = measureLabelWidth(nameText, `600 ${AREA_LABEL_FONT_PX}px ${LABEL_FONT_STACK}`);
        const areaW = measureLabelWidth(areaText, `${AREA_LABEL_FONT_PX}px ${LABEL_FONT_STACK}`);
        const halfW = Math.max(nameW, areaW) / 2 + 9;
        const halfH = ROOM_LABEL_HALF_GAP + AREA_LABEL_FONT_PX / 2 + 5;
        ctx.beginPath();
        ctx.roundRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2, 5);
        ctx.fillStyle = theme.fill;
        ctx.fill();
        ctx.strokeStyle = theme.stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Room title (semibold) above, area readout below — centred as a pair on
      // the shape's centre so both stay horizontally and vertically aligned. The
      // area turns bright green when the room exceeds the max-area constraint.
      const areaOver = violations?.get(shape.id)?.areaOver ?? false;
      ctx.fillStyle = theme.label;
      ctx.font = `600 ${AREA_LABEL_FONT_PX}px ${LABEL_FONT_STACK}`;
      ctx.fillText(nameText, cx, cy - ROOM_LABEL_HALF_GAP);
      ctx.font = `${AREA_LABEL_FONT_PX}px ${LABEL_FONT_STACK}`;
      ctx.fillStyle = areaOver ? VIOLATION_YELLOW : theme.label;
      ctx.fillText(areaText, cx, cy + ROOM_LABEL_HALF_GAP);

      // Area-lock toggle — a little padlock at the dimension corner (where the
      // width + height brackets meet, like an x/y graph's origin), shown only when
      // this room's dimension lines are (a lone selection; for a rectangle, while
      // its infill is the active region or it's being resized). Engaged = blue.
      const singleSel = selectedIds.has(shape.id) && selectedIds.size === 1;
      const dimsShown = singleSel && (shape.corners ? true : !activeHandle || resizing);
      if (dimsShown) {
        const a = lockAnchorScreen(shape, camera);
        drawLockIcon(
          ctx,
          Math.round(a.x),
          Math.round(a.y),
          !!shape.areaLocked,
          shape.areaLocked ? LOCK_LOCKED_COLOR : theme.label,
        );
        // Four edge-midpoint buttons. Normally an "add" plus (duplicate); once the
        // shape is opened (double-clicked → dots), they become outward arrows that
        // arm the next-room prediction fan instead.
        const anchors = edgePlusAnchorsScreen(shape, camera);
        for (let bi = 0; bi < anchors.length; bi++) {
          const p = anchors[bi];
          if (shape.dots) {
            drawArrowCircle(
              ctx,
              Math.round(p.x),
              Math.round(p.y),
              EDGE_PLUS_RADIUS,
              edgeOutwardAngle(shape, bi),
              theme.label,
              theme.fill,
            );
          } else {
            drawPlusCircle(ctx, Math.round(p.x), Math.round(p.y), EDGE_PLUS_RADIUS, theme.label, theme.fill);
          }
        }
      }
      ctx.restore();
    }

    // Rotation readout — while this shape is rotating, show its angle next to the
    // grabbed corner, upright and the size of the dimension text.
    if (rotating && rotating.id === shape.id) {
      const grips = outerCornerGrips(shape, camera);
      const idx = CORNER_HANDLES.indexOf(rotating.corner as (typeof CORNER_HANDLES)[number]);
      const grip = grips[idx >= 0 ? idx : 0];
      // Push the label out along the corner's outward bisector, past its rotation
      // arc (which sits at DIMENSION_GAP/2) plus clearance so the text never
      // collides with the arc symbol.
      const reach = DIMENSION_GAP / 2 + 18;
      const ox = grip.p.x + grip.dir.x * reach;
      const oy = grip.p.y + grip.dir.y * reach;
      const p = localToScreen(shape, camera, ox, oy);
      // Show the angle signed in (-180, 180] so a turn the short way past 0 reads
      // as e.g. -15° rather than 345°.
      const deg = Math.round(shape.rotation);
      const signed = deg > 180 ? deg - 360 : deg;
      ctx.save();
      ctx.fillStyle = theme.label;
      ctx.font = `${DIMENSION_FONT_PX}px ${LABEL_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${signed}°`, Math.round(p.x), Math.round(p.y));
      ctx.restore();
    }
  }

  // Vertex dots last of all, so the four draggable handles sit above every body
  // AND the overlap cues even where shapes intersect. Drawn in screen space from
  // each shape's interior corners. Toggled by double-click.
  ctx.fillStyle = theme.label;
  ctx.strokeStyle = '#ffffff'; // matches the white edge face-lines
  ctx.lineWidth = 1;
  for (let i = 0; i < shapes.length; i++) {
    if (!shapes[i].dots) continue;
    for (const p of footprints[i].inner) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, VERTEX_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Selection-order debug numbers — a big green 1-based index at the centre of
  // each selected shape, above everything, so the pick order (which feeds boolean
  // difference) is visible. Shown only when the Debug toggle is on.
  if (debug && selectionOrder && selectionOrder.length > 0) {
    ctx.save();
    ctx.fillStyle = '#16a34a';
    ctx.font = `bold 56px ${LABEL_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let n = 0; n < selectionOrder.length; n++) {
      const shape = shapes.find((s) => s.id === selectionOrder[n]);
      if (!shape) continue;
      const cen = shapeCentroidLocal(shape);
      const c = localToScreen(shape, camera, cen.x * camera.scale, cen.y * camera.scale);
      ctx.fillText(String(n + 1), Math.round(c.x), Math.round(c.y));
    }
    ctx.restore();
  }

  // Duplicate preview — translucent ghost(s) of the shape(s) an edge-plus button
  // would drop (one hovered, several when dragged out), above everything. Walls
  // (dark band) + white infill, matching the real shape's outline at any rotation.
  if (duplicatePreviews && duplicatePreviews.length > 0) {
    ctx.save();
    for (const preview of duplicatePreviews) {
      const { inner, outer } = footprintScreen(preview, camera);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = theme.stroke;
      tracePoly(outer);
      ctx.fill();
      ctx.fillStyle = theme.fill;
      tracePoly(inner);
      ctx.fill();
      ctx.globalAlpha = 0.65;
      ctx.strokeStyle = theme.stroke;
      ctx.lineWidth = 1;
      tracePoly(outer);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Next-room prediction fan — the three option circles arced outward from the
  // dragged edge arrow, above everything so they read over neighbouring rooms.
  if (predictionDrag) {
    const shp = shapes.find((s) => s.id === predictionDrag.shapeId);
    if (shp) {
      // Ghost of the hovered option's room — translucent walls + infill, flush to the
      // edge, with the room's NAME ghosted across it so the suggestion reads at a glance.
      const hi = predictionDrag.hovered;
      const opt = hi != null ? predictionDrag.options[hi] : null;
      if (opt) {
        const wWorld = opt.widthFt * WORLD_UNITS_PER_FOOT;
        const hWorld = opt.heightFt * WORLD_UNITS_PER_FOOT;
        const place = adjacentRoomPlacement(shp, predictionDrag.dir, wWorld, hWorld, DEFAULT_WALL_WORLD);
        const ghost: Square = {
          id: '',
          x: place.x,
          y: place.y,
          width: wWorld,
          height: hWorld,
          rotation: place.rotation,
          walls: defaultWalls(),
          dots: false,
          name: opt.label,
        };
        const { inner, outer } = footprintScreen(ghost, camera);
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = theme.stroke;
        tracePoly(outer);
        ctx.fill();
        ctx.fillStyle = theme.fill;
        tracePoly(inner);
        ctx.fill();
        ctx.globalAlpha = 0.65;
        ctx.strokeStyle = theme.stroke;
        ctx.lineWidth = 1;
        tracePoly(outer);
        ctx.stroke();
        // Ghosted room name, centred and rotated with the room.
        const ctr = worldToScreen(ghost.x + ghost.width / 2, ghost.y + ghost.height / 2, camera);
        const shortPx = Math.min(wWorld, hWorld) * camera.scale;
        if (shortPx > 26) {
          ctx.globalAlpha = 0.6;
          ctx.translate(ctr.x, ctr.y);
          ctx.rotate(ghost.rotation * DEG2RAD);
          ctx.fillStyle = theme.label;
          ctx.font = `600 13px ${LABEL_FONT_STACK}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(opt.label, 0, 0);
        }
        ctx.restore();
      }
      drawPredictionOptions(
        ctx,
        shp,
        camera,
        predictionDrag.dir,
        predictionDrag.hovered,
        predictionDrag.options,
        !!debug,
      );
    }
  }
}

/** Draws the rubber-band selection rectangle (canvas-local screen coords). */
export function drawMarquee(
  ctx: CanvasRenderingContext2D,
  m: Marquee,
  fill: string,
  stroke: string,
): void {
  const x = Math.min(m.x0, m.x1);
  const y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0);
  const h = Math.abs(m.y1 - m.y0);

  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.strokeRect(snap(x), snap(y), Math.round(w), Math.round(h));
}

/**
 * Returns the edge of `shape` under the screen point, or null. Edges are
 * grabbable anywhere along their length (within a small perpendicular
 * tolerance), excluding the corner zones — those rotate (see hitCorner). Tested
 * in the shape's local frame so it works at any rotation.
 */
export function hitShapeEdge(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): HandleId | null {
  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const t = EDGE_HIT_TOLERANCE;
  const pts = localCorners(shape).map((p) => ({ x: p.x * camera.scale, y: p.y * camera.scale }));
  const thick = wallThicknesses(shape).map((w) => w * camera.scale);
  const sides = ['n', 'e', 's', 'w'] as const;

  // For EVERY interior edge, grab anywhere from just inside the boundary (t) out
  // across that side's wall band (thickness + t), excluding a small zone at each
  // end so the corners stay unambiguous (they belong to rotation / vertex drag).
  // The first four edges keep their n/e/s/w names; extra edges (an N-gon) use the
  // numeric edge index so all of them remain grabbable.
  //
  // Where two walls overlap — e.g. the two edges meeting at a concave corner, or
  // any pair after a thickness change — several bands can contain the point. Pick
  // the edge whose INTERIOR face the point is nearest (smallest outward distance),
  // so an individual edge always resolves to the one the cursor is actually on,
  // rather than whichever happens to come first in the list.
  let best = -1;
  let bestPerp = Infinity;
  for (let e = 0; e < pts.length; e++) {
    const a = pts[e];
    const b = pts[(e + 1) % pts.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1) continue;
    const ux = ex / len;
    const uy = ey / len;
    const nx = uy; // outward normal (clockwise winding, y-down)
    const ny = -ux;
    const rx = lx - a.x;
    const ry = ly - a.y;
    const along = rx * ux + ry * uy;
    const perp = rx * nx + ry * ny;
    const cz = Math.min(t, len / 2); // corner exclusion along the edge
    if (perp >= -t && perp <= thick[e] + t && along >= cz && along <= len - cz) {
      const score = Math.abs(perp); // distance from this edge's interior face line
      if (score < bestPerp) {
        bestPerp = score;
        best = e;
      }
    }
  }
  if (best < 0) return null;
  return best < 4 ? sides[best] : best;
}

/**
 * For `handle`'s wall, which face the screen point is nearer: the inner
 * (interior-facing) line or the outer boundary line. Split at the band midline.
 */
export function edgeFace(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
  handle: HandleId,
): EdgeFace {
  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const e = edgeIndexOf(handle);
  const pts = localCorners(shape).map((p) => ({ x: p.x * camera.scale, y: p.y * camera.scale }));
  const a = pts[e];
  const b = pts[(e + 1) % pts.length];
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.hypot(ex, ey) || 1;
  const nx = ey / len; // outward normal
  const ny = -ex / len;
  const perp = (lx - a.x) * nx + (ly - a.y) * ny; // distance outward from the inner edge
  const wall = wallThicknesses(shape)[e] * camera.scale;
  return perp < wall / 2 ? 'inner' : 'outer';
}

/** Which corner grip (rotation zone) the screen point is within, or null. */
export function hitCornerHandle(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): HandleId | null {
  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const r = ROTATION_CORNER_RADIUS;
  const off = ROTATION_CORNER_OFFSET; // nudge each zone outward along the corner's bisector, onto its arc
  const grips = outerCornerGrips(shape, camera);
  for (let i = 0; i < grips.length; i++) {
    const cx = grips[i].p.x + grips[i].dir.x * off;
    const cy = grips[i].p.y + grips[i].dir.y * off;
    if (Math.abs(lx - cx) <= r && Math.abs(ly - cy) <= r) return CORNER_HANDLES[i];
  }
  return null;
}

/** Whether the screen point is within a corner grip of `shape` (rotation zone). */
export function hitCorner(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): boolean {
  return hitCornerHandle(screenX, screenY, shape, camera) !== null;
}

/** Each corner of `pts` paired with its outward (exterior-bisector) unit dir. */
function gripsFromCorners(pts: Vec2[]): { p: Vec2; dir: Vec2 }[] {
  const n = pts.length;
  return pts.map((c, i) => {
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
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
    let bx = -(d1x + d2x);
    let by = -(d1y + d2y);
    const bl = Math.hypot(bx, by);
    if (bl < 1e-3) {
      bx = -d1y; // near-straight corner → fall back to an edge's outward normal
      by = d1x;
    } else {
      bx /= bl;
      by /= bl;
    }
    return { p: { x: c.x, y: c.y }, dir: { x: bx, y: by } };
  });
}

/**
 * Each rotation-grip corner and its outward unit direction, in this shape's
 * local (un-rotated, centre-origin) screen frame, ordered [nw, ne, se, sw].
 * Drives both the rotation grab zones and the angle-readout placement. A plain
 * rectangle uses its outer wall corners; a reshaped quad uses its tight best-fit
 * BOUNDING BOX corners, so rotation happens about the clean box rather than the
 * jagged outline.
 */
function outerCornerGrips(shape: Square, camera: Camera): { p: Vec2; dir: Vec2 }[] {
  if (shape.corners) {
    const bb = boundingBoxLocal(shape);
    const sc = camera.scale;
    return gripsFromCorners([
      { x: bb.minX * sc, y: bb.minY * sc },
      { x: bb.maxX * sc, y: bb.minY * sc },
      { x: bb.maxX * sc, y: bb.maxY * sc },
      { x: bb.minX * sc, y: bb.maxY * sc },
    ]);
  }
  const iLocal = localCorners(shape).map((p) => ({ x: p.x * camera.scale, y: p.y * camera.scale }));
  const thick = wallThicknesses(shape).map((w) => w * camera.scale);
  return gripsFromCorners(outerCorners(iLocal, thick));
}

/** Radius (px) the drawn vertex dots occupy; grab tolerance is a touch larger. */
const VERTEX_DOT_RADIUS = 6;

/**
 * Which interior-vertex dot the screen point is on (or null). Only meaningful
 * when `shape.dots` is showing. The returned corner handle (`'nw'|'ne'|'se'|'sw'`)
 * drives a corner resize that pulls the two adjacent edges, anchoring the
 * opposite corner — so dragging a dot reshapes the room parametrically.
 */
export function hitCornerDot(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): HandleId | null {
  if (!shape.dots) return null;
  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const r = VERTEX_DOT_RADIUS + 4; // a little forgiving around the dot
  const pts = localCorners(shape);
  for (let i = 0; i < pts.length; i++) {
    const cx = pts[i].x * camera.scale;
    const cy = pts[i].y * camera.scale;
    if (Math.abs(lx - cx) <= r && Math.abs(ly - cy) <= r) return CORNER_HANDLES[i];
  }
  return null;
}

/** A dimension label clicked for editing: which measure, where, and its value. */
export interface DimensionLabelHit {
  /** The shape's bounding-box width or height label. */
  which: 'width' | 'height';
  /** Label centre in canvas-local screen px (for positioning an editor). */
  sx: number;
  sy: number;
  /** Editor rotation in degrees, matching the on-canvas label. */
  angleDeg: number;
  /** Current measurement text, e.g. "12'". */
  text: string;
}

// Cached offscreen context purely for measuring label widths off the hot path.
let measureCtx: CanvasRenderingContext2D | null = null;
function measureLabelWidth(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 8;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
function dimensionTextWidth(text: string): number {
  return measureLabelWidth(text, `${DIMENSION_FONT_PX}px ${LABEL_FONT_STACK}`);
}

/** A clickable centre readout: the room title or the square-footage value. */
export interface CenterLabelHit {
  which: 'name' | 'area';
  /** Label centre in canvas-local screen px (for positioning the editor). */
  sx: number;
  sy: number;
  /** Current text, e.g. "Bedroom" or "196 ft²". */
  text: string;
}

/**
 * The centre readout under the screen point (or null): the room title (above) or
 * the area value (below), matching where `drawShapes` draws them at the centroid.
 * Both are upright, so the test is plain screen-space.
 */
export function hitCenterLabel(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
  unit: LengthUnit,
): CenterLabelHit | null {
  const wS = shape.width * camera.scale;
  const hS = shape.height * camera.scale;
  if (Math.min(wS, hS) <= AREA_LABEL_FADE_START) return null; // too small / faded
  const cen = shapeCentroidLocal(shape);
  const c = localToScreen(shape, camera, cen.x * camera.scale, cen.y * camera.scale);
  const cx = Math.round(c.x);
  const cy = Math.round(c.y);
  const halfFont = AREA_LABEL_FONT_PX / 2 + 4;

  const nameText = shape.name ?? 'Room';
  const nameHalf =
    measureLabelWidth(nameText, `600 ${AREA_LABEL_FONT_PX}px ${LABEL_FONT_STACK}`) / 2 + 4;
  const nameY = cy - ROOM_LABEL_HALF_GAP;
  if (Math.abs(screenX - cx) <= nameHalf && Math.abs(screenY - nameY) <= halfFont) {
    return { which: 'name', sx: cx, sy: nameY, text: nameText };
  }

  const areaText = formatArea(shape, unit);
  const areaHalf =
    measureLabelWidth(areaText, `${AREA_LABEL_FONT_PX}px ${LABEL_FONT_STACK}`) / 2 + 4;
  const areaY = cy + ROOM_LABEL_HALF_GAP;
  if (Math.abs(screenX - cx) <= areaHalf && Math.abs(screenY - areaY) <= halfFont) {
    return { which: 'area', sx: cx, sy: areaY, text: areaText };
  }
  return null;
}

/**
 * Screen position of the area-lock padlock: the top-right corner where the width
 * (top) and height (right) dimension brackets meet — the "origin" of the two
 * measurement axes. Built from the same outer-right / outer-top + gap the brackets
 * use, then rotated into screen space about the shape's centre.
 */
export function lockAnchorScreen(shape: Square, camera: Camera): Vec2 {
  const scale = camera.scale;
  let oRight: number;
  let oTop: number;
  if (shape.corners) {
    // Reshaped quad: dimensions hang off the bounding box (no separate wall band).
    const bb = boundingBoxLocal(shape);
    oRight = bb.maxX * scale;
    oTop = bb.minY * scale;
  } else {
    // Rectangle: dimensions hang off the outer wall corners.
    const outer = outerCorners(
      localCorners(shape).map((p) => ({ x: p.x * scale, y: p.y * scale })),
      wallThicknesses(shape).map((w) => w * scale),
    );
    oRight = outer[2].x; // se corner → max x
    oTop = outer[0].y; // nw corner → min y (top)
  }
  const vx = oRight + DIMENSION_GAP; // vertical (height) bracket line
  const hy = oTop - DIMENSION_GAP; // horizontal (width) bracket line
  const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
  const a = shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: c.x + vx * cos - hy * sin, y: c.y + vx * sin + hy * cos };
}

/**
 * Wrap a bare polygon (a facade trim border) as a zero-wall `Square`, so it can feed the room machinery
 * that operates on shapes: the edge stretch, the wall snapper, and the edge-plus button geometry. With zero
 * walls inner == outer == centreline, and because {@link worldToScreen} is affine with a uniform scale, a
 * shape whose origin is (0,0) has its "local" frame coincide with world space — so the corners can be
 * passed through as-is.
 */
export function polygonShape(corners: { x: number; y: number }[]): Square {
  return {
    id: 'facade-border',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    walls: { n: 0, e: 0, s: 0, w: 0 },
    dots: false,
    corners: corners.map((p) => ({ x: p.x, y: p.y })),
  };
}

/**
 * Screen positions of the four edge-midpoint plus buttons, ordered [n, e, s, w].
 *
 * Each button is **side-dependent** and laid out so the four stay independent:
 *  - Its position ALONG its edge is the midpoint of the tight INTERIOR bounding box
 *    (the same `boundingBoxLocal` the dimension brackets use) — stable against wall
 *    thickness and any non-extreme vertex tweak.
 *  - Its OUTWARD distance is that side's wall thickness + a constant `EDGE_PLUS_OFFSET`
 *    gap, where the side's thickness is the thickest wall facing that cardinal
 *    direction (n/e/s/w). So thickening one wall pushes only that side's button out;
 *    the other three don't budge. Buttons move only when the bounding box changes or
 *    that side's own wall does. Then rotated into screen space.
 */
export function edgePlusAnchorsScreen(shape: Square, camera: Camera): Vec2[] {
  const scale = camera.scale;
  const bb = boundingBoxLocal(shape); // interior bbox, world units
  const pts = localCorners(shape);
  const thick = wallThicknesses(shape);

  // Thickest wall facing each cardinal direction (world units). An edge contributes
  // to a direction when its outward normal points that way; a diagonal edge counts
  // for both of its directions, so the buttons always clear the visible wall.
  let wN = 0;
  let wE = 0;
  let wS = 0;
  let wW = 0;
  const eps = 1e-6;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len; // outward normal (clockwise winding, y-down)
    const ny = -dx / len;
    const t = thick[i];
    if (nx > eps) wE = Math.max(wE, t);
    if (nx < -eps) wW = Math.max(wW, t);
    if (ny > eps) wS = Math.max(wS, t);
    if (ny < -eps) wN = Math.max(wN, t);
  }

  const off = EDGE_PLUS_OFFSET;
  const cx = ((bb.minX + bb.maxX) / 2) * scale; // interior bbox centre (stable)
  const cy = ((bb.minY + bb.maxY) / 2) * scale;
  // Local (pre-rotation) screen positions: along-edge from the interior bbox centre,
  // outward by that side's wall (scaled) + the constant gap.
  const local: Vec2[] = [
    { x: cx, y: bb.minY * scale - wN * scale - off }, // n (top)
    { x: bb.maxX * scale + wE * scale + off, y: cy }, // e (right)
    { x: cx, y: bb.maxY * scale + wS * scale + off }, // s (bottom)
    { x: bb.minX * scale - wW * scale - off, y: cy }, // w (left)
  ];
  const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
  const ang = shape.rotation * DEG2RAD;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  return local.map((p) => ({ x: c.x + p.x * cos - p.y * sin, y: c.y + p.x * sin + p.y * cos }));
}

/**
 * Which edge-midpoint plus button (0=n, 1=e, 2=s, 3=w) the screen point is over, or
 * null. Mirrors {@link edgePlusAnchorsScreen}; callers gate it to the lone shape
 * whose buttons are shown.
 */
export function hitEdgePlus(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): number | null {
  const anchors = edgePlusAnchorsScreen(shape, camera);
  const r = EDGE_PLUS_RADIUS + 3; // a little slop
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if ((screenX - a.x) ** 2 + (screenY - a.y) ** 2 <= r * r) return i;
  }
  return null;
}

/**
 * World-space offset to drop a duplicate beside `shape` in direction `dir`
 * (0=n, 1=e, 2=s, 3=w), aligned to the shared wall's CENTERLINE — mirroring the
 * move/placement snapping rules. A copy has the source's exact wall thickness, so the
 * touching walls (source's far wall + copy's near wall) merge into one seamless band:
 * the step is the outer footprint extent pulled back by half of each touching wall.
 * For equal-thickness walls this reduces to "extent − one wall", overlapping the shared
 * wall exactly; chained drag-copies therefore share walls all the way down the row.
 */
export function adjacentCopyOffset(shape: Square, dir: number): { dx: number; dy: number } {
  // Spacing box = bounding box of the OUTER wall footprint (local, pre-rotation units).
  const thick = wallThicknesses(shape);
  const outer = outerCorners(localCorners(shape), thick);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const ex = maxX - minX;
  const ey = maxY - minY;

  // Centerline overlap: pull back by the mean of the two touching walls so their
  // centerlines coincide (= the shared wall). Along x the touching walls are E/W
  // (edges 1 & 3); along y they're N/S (edges 0 & 2). Polygons without the 4 named
  // edges (boolean N-gons) fall back to the mean wall thickness.
  const meanT = thick.reduce((a, b) => a + b, 0) / (thick.length || 1);
  const overlapX = thick.length === 4 ? (thick[1] + thick[3]) / 2 : meanT;
  const overlapY = thick.length === 4 ? (thick[0] + thick[2]) / 2 : meanT;
  const stepX = Math.max(0, ex - overlapX);
  const stepY = Math.max(0, ey - overlapY);

  let lx = 0;
  let ly = 0;
  if (dir === 0) ly = -stepY;
  else if (dir === 1) lx = stepX;
  else if (dir === 2) ly = stepY;
  else lx = -stepX;
  const rot = shape.rotation * DEG2RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { dx: lx * cos - ly * sin, dy: lx * sin + ly * cos };
}

/**
 * Where to drop a NEW room of interior size `newWWorld`×`newHWorld` (plain rect,
 * `wall` on every side) beside `source` on side `dir` (0=n,1=e,2=s,3=w), aligned to the
 * shared wall's CENTERLINE — the same rule the duplicate ({@link adjacentCopyOffset}) and
 * the move/placement snapping follow. The touching walls (source's far wall + the new
 * room's near wall) merge into one band: the new room starts flush against the source's
 * outer face, then is pulled back by half of each touching wall. Equal-thickness walls
 * overlap into a single shared wall; the perpendicular axis aligns the outer corner (top
 * edges for E/W, left edges for N/S). Returns the new room's top-left `x/y` (world) and
 * `rotation` (= source's), ready to build a {@link Square}.
 */
export function adjacentRoomPlacement(
  source: Square,
  dir: number,
  newWWorld: number,
  newHWorld: number,
  wall: number,
): { x: number; y: number; rotation: number } {
  // Source outer footprint bbox, in its LOCAL (centre-origin, pre-rotation) frame.
  const thick = wallThicknesses(source);
  const outer = outerCorners(localCorners(source), thick);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // New room's outer half-extents (interior half + its wall band).
  const halfW = newWWorld / 2 + wall;
  const halfH = newHWorld / 2 + wall;

  // Centerline overlap: pull the new room back toward the source by the mean of the two
  // touching walls (source's `dir` wall + the new room's wall) so their centerlines align.
  // Edge `dir` maps to thickness index dir on a rect/quad; other polygons use the mean.
  const sourceWall = thick.length === 4 ? thick[dir] : thick.reduce((a, b) => a + b, 0) / (thick.length || 1);
  const overlap = (wall + sourceWall) / 2;

  // New room centre in the source's local frame: centerline-aligned on `dir`, corner-aligned
  // on the perpendicular axis.
  let cxL: number;
  let cyL: number;
  if (dir === 1) {
    cxL = maxX + halfW - overlap; // east
    cyL = minY + halfH; // align top edges
  } else if (dir === 3) {
    cxL = minX - halfW + overlap; // west
    cyL = minY + halfH;
  } else if (dir === 0) {
    cyL = minY - halfH + overlap; // north
    cxL = minX + halfW; // align left edges
  } else {
    cyL = maxY + halfH - overlap; // south
    cxL = minX + halfW;
  }

  // Rotate the local offset about the source's world centre.
  const rot = source.rotation * DEG2RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const ccx = source.x + source.width / 2;
  const ccy = source.y + source.height / 2;
  const wx = ccx + cxL * cos - cyL * sin;
  const wy = ccy + cxL * sin + cyL * cos;
  return { x: wx - newWWorld / 2, y: wy - newHWorld / 2, rotation: source.rotation };
}

/**
 * True when the screen point is over the area-lock padlock at the dimension corner.
 * Mirrors where `drawShapes` places it. Callers should only test the lone
 * infill-selected shape (the only one whose lock is shown).
 */
export function hitCenterLock(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): boolean {
  const wS = shape.width * camera.scale;
  const hS = shape.height * camera.scale;
  if (Math.min(wS, hS) <= AREA_LABEL_FADE_START) return false; // faded out with the readout
  const a = lockAnchorScreen(shape, camera);
  return Math.abs(screenX - a.x) <= LOCK_HIT_HALF && Math.abs(screenY - a.y) <= LOCK_HIT_HALF;
}

/** Local (shape-frame) point → canvas-local screen px. */
function localToScreen(shape: Square, camera: Camera, lcx: number, lcy: number): Vec2 {
  const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
  const a = shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: c.x + lcx * cos - lcy * sin, y: c.y + lcx * sin + lcy * cos };
}

/**
 * The dimension label under the screen point (or null). Mirrors the geometry
 * `drawShapes` uses for the outside brackets, so the clickable target sits right
 * on the drawn text at any rotation. Callers should only test the single
 * infill-selected shape (the only one that shows dimensions).
 */
export function hitDimensionLabel(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
  unit: LengthUnit,
  // Must match the `dimGap` the labels were drawn with (defaults to the room gap; borders pass a smaller one).
  dimGap = DIMENSION_GAP,
): DimensionLabelHit | null {
  const wS = shape.width * camera.scale;
  const hS = shape.height * camera.scale;
  // Matches where the dimension lines fully fade out (so faint labels at the
  // edge of visibility aren't clickable).
  if (Math.min(wS, hS) <= AREA_LABEL_FADE_START) return null;

  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  // Labels hang off the tight bounding box. A rectangle's brackets clear its wall
  // band; a reshaped quad's hang off the box directly (no wall to clear).
  const sc = camera.scale;
  const bb = boundingBoxLocal(shape);
  const boxL = bb.minX * sc;
  const boxR = bb.maxX * sc;
  const boxT = bb.minY * sc;
  const boxB = bb.maxY * sc;
  const boxCx = (boxL + boxR) / 2;
  const boxCy = (boxT + boxB) / 2;
  const wallN = shape.corners ? 0 : shape.walls.n * sc;
  const wallE = shape.corners ? 0 : shape.walls.e * sc;
  const pad = 4;
  const halfFont = DIMENSION_FONT_PX / 2 + pad;

  // Width label: centred over the top bracket. Flip matches the draw side (keyed
  // off each label's own on-screen angle) so the editor agrees.
  const wText = formatLength(bb.maxX - bb.minX, unit);
  const wcy = boxT - wallN - dimGap - DIMENSION_LABEL_GAP;
  const wHalf = dimensionTextWidth(wText) / 2 + pad;
  if (Math.abs(lx - boxCx) <= wHalf && Math.abs(ly - wcy) <= halfFont) {
    const p = localToScreen(shape, camera, boxCx, wcy);
    const angleDeg = shape.rotation + (uprightFlip(shape.rotation) * 180) / Math.PI;
    return { which: 'width', sx: p.x, sy: p.y, angleDeg, text: wText };
  }

  // Height label: centred right of the right bracket, rotated −90°.
  const hText = formatLength(bb.maxY - bb.minY, unit);
  const hcx = boxR + wallE + dimGap + DIMENSION_LABEL_GAP;
  const hHalf = dimensionTextWidth(hText) / 2 + pad;
  if (Math.abs(lx - hcx) <= halfFont && Math.abs(ly - boxCy) <= hHalf) {
    const p = localToScreen(shape, camera, hcx, boxCy);
    const angleDeg = shape.rotation - 90 + (uprightFlip(shape.rotation - 90) * 180) / Math.PI;
    return { which: 'height', sx: p.x, sy: p.y, angleDeg, text: hText };
  }
  return null;
}

/** A clickable wall (edge) dimension label: the edge's length or its thickness. */
export interface WallDimensionLabelHit {
  which: 'wallLength' | 'wallThickness';
  /** Which interior edge it measures. */
  edge: number;
  /** Label centre in canvas-local screen px (for positioning the editor). */
  sx: number;
  sy: number;
  /** Editor rotation in degrees, matching the on-canvas label. */
  angleDeg: number;
  /** Current measurement text, e.g. "12′" or "4″". */
  text: string;
}

/**
 * The active edge's length or thickness dimension label under the screen point (or
 * null). Mirrors the exact geometry {@link drawWallDimensions} draws from, so the
 * clickable target sits right on the rendered text at any rotation or edge angle.
 * `handle` is the shape's active wall edge; only that edge's two labels are tested.
 */
export function hitWallDimensionLabel(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
  handle: HandleId,
  unit: LengthUnit,
): WallDimensionLabelHit | null {
  const e = edgeIndexOf(handle);
  if (e < 0) return null;
  const sc = camera.scale;
  const iPts = localCorners(shape).map((p) => ({ x: p.x * sc, y: p.y * sc }));
  const oPts = outerCorners(iPts, wallThicknesses(shape).map((w) => w * sc));
  const n = iPts.length;
  const j = (e + 1) % n;
  const A = iPts[e];
  const B = iPts[j];
  const D = oPts[e];
  const C = oPts[j];

  // Edge direction + outward normal (true perpendicular), as in drawWallDimensions.
  let ex = B.x - A.x;
  let ey = B.y - A.y;
  const eLen = Math.hypot(ex, ey) || 1;
  ex /= eLen;
  ey /= eLen;
  let nx = ey;
  let ny = -ex;
  const outX = (C.x + D.x) / 2 - (A.x + B.x) / 2;
  const outY = (C.y + D.y) / 2 - (A.y + B.y) / 2;
  if (nx * outX + ny * outY < 0) {
    nx = -nx;
    ny = -ny;
  }
  const thickPx = (D.x - A.x) * nx + (D.y - A.y) * ny;
  const gap = WALL_DIM_GAP;
  const labelGap = DIMENSION_LABEL_GAP;

  // Label centres, matching the drawn positions (local, scaled, centre-origin px).
  const span = thickPx + gap;
  const lenCx = (A.x + B.x) / 2 + nx * (span + labelGap);
  const lenCy = (A.y + B.y) / 2 + ny * (span + labelGap);
  const thCx = (B.x + (B.x + nx * thickPx)) / 2 + ex * (gap + labelGap);
  const thCy = (B.y + (B.y + ny * thickPx)) / 2 + ey * (gap + labelGap);

  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const halfFont = DIMENSION_FONT_PX / 2 + 4;
  const locEdge = Math.atan2(ey, ex);
  const locNorm = Math.atan2(ny, nx);

  // Hit-test in each label's own (rotated) frame, since wall labels tilt with the edge.
  const hits = (cx: number, cy: number, angle: number, text: string): boolean => {
    const dx = lx - cx;
    const dy = ly - cy;
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return Math.abs(rx) <= dimensionTextWidth(text) / 2 + 4 && Math.abs(ry) <= halfFont;
  };
  const angleDegOf = (locDeg: number): number =>
    shape.rotation + locDeg + (uprightFlip(shape.rotation + locDeg) * 180) / Math.PI;

  const lenText = formatLength(edgeLengthsWorld(shape)[e], unit);
  if (hits(lenCx, lenCy, locEdge, lenText)) {
    const p = localToScreen(shape, camera, lenCx, lenCy);
    return {
      which: 'wallLength',
      edge: e,
      sx: p.x,
      sy: p.y,
      angleDeg: angleDegOf((locEdge * 180) / Math.PI),
      text: lenText,
    };
  }

  const thText = thicknessLabelText(wallThicknesses(shape)[e], unit);
  if (hits(thCx, thCy, locNorm, thText)) {
    const p = localToScreen(shape, camera, thCx, thCy);
    return {
      which: 'wallThickness',
      edge: e,
      sx: p.x,
      sy: p.y,
      angleDeg: angleDegOf((locNorm * 180) / Math.PI),
      text: thText,
    };
  }
  return null;
}

/** Whether the world point lies inside `s`'s interior (rotation- & shape-aware). */
export function containsPoint(s: Square, world: Vec2): boolean {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const a = -s.rotation * DEG2RAD;
  const dx = world.x - cx;
  const dy = world.y - cy;
  const local = { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
  return pointInPolygon(local, localCorners(s));
}

/** Top-most square containing the given world point (rotation-aware), or null. */
export function hitTopShape(shapes: Square[], world: Vec2): Square | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (containsPoint(shapes[i], world)) return shapes[i];
  }
  return null;
}

/**
 * Resizes `original` by moving the edge(s) named by `handle` by a world-space
 * delta (worldDx, worldDy). The drag is mapped into the shape's local frame so
 * it works at any rotation; the opposite edge stays anchored in world space and
 * the shape cannot collapse below `minWorld`. Delta-based, so the same drag can
 * be applied uniformly across a multi-shape selection.
 */
export function resizeShape(
  original: Square,
  handle: HandleId,
  worldDx: number,
  worldDy: number,
  minWorld: number,
): Square {
  const t = original.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);

  // World delta → local delta (rotate by -θ).
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;

  let left = -original.width / 2;
  let right = original.width / 2;
  let top = -original.height / 2;
  let bottom = original.height / 2;

  // resizeShape is only ever used for rectangles, so `handle` is a named side.
  const h = String(handle);
  if (h.includes('w')) left = Math.min(left + ldx, right - minWorld);
  if (h.includes('e')) right = Math.max(right + ldx, left + minWorld);
  if (h.includes('n')) top = Math.min(top + ldy, bottom - minWorld);
  if (h.includes('s')) bottom = Math.max(bottom + ldy, top + minWorld);

  const newW = right - left;
  const newH = bottom - top;

  // The new local centre (offset from the old centre) → world (rotate by +θ),
  // so the anchored edge keeps its world position.
  const lcx = (left + right) / 2;
  const lcy = (top + bottom) / 2;
  const cx = original.x + original.width / 2 + (lcx * cos - lcy * sin);
  const cy = original.y + original.height / 2 + (lcx * sin + lcy * cos);

  return { ...original, x: cx - newW / 2, y: cy - newH / 2, width: newW, height: newH };
}

/**
 * Changes the thickness of `handle`'s wall by dragging one of its faces:
 *  - `'outer'`: the outer face follows the cursor; the room (interior) is fixed,
 *    so the wall grows outward.
 *  - `'inner'`: the inner face (the interior boundary) follows the cursor while
 *    the outer face is held fixed, so pulling inward thickens the wall and
 *    shrinks the room.
 * Walls never go below `minWall`; the room never below `minInterior`.
 */
export function resizeWall(
  original: Square,
  handle: HandleId,
  face: EdgeFace,
  worldDx: number,
  worldDy: number,
  minWall: number,
  minInterior: number,
): Square {
  // For a plain rectangle the named n/e/s/w wall is used; a free polygon (incl.
  // boolean N-gons) keys its thickness per edge via withEdgeThickness.
  const side = (typeof handle === 'string' && handle in SIDE_EDGE
    ? handle
    : 'n') as keyof Walls;

  // Free-form polygon: act along the actual edge's outward normal, changing ONLY
  // the grabbed edge's wall. The outer face adds to that wall (interior corners
  // fixed); the inner face translates just that edge (its two corners) and
  // compensates its wall so the outer face stays put.
  if (original.corners) {
    const e = edgeIndexOf(handle);
    const nrm = edgeNormalWorld(original, e);
    const perp = worldDx * nrm.x + worldDy * nrm.y; // + = outward
    const cur = wallThicknesses(original)[e]; // this edge's current thickness
    if (face === 'outer') {
      return withEdgeThickness(original, e, Math.max(minWall, cur + perp));
    }
    // Inner face: clamp so the wall can't drop below minWall (outer face fixed).
    const delta = Math.max(perp, minWall - cur);
    const moved = moveCorners(
      original,
      [e, (e + 1) % original.corners.length],
      nrm.x * delta,
      nrm.y * delta,
    );
    return withEdgeThickness(moved, e, Math.max(minWall, cur - delta));
  }

  if (face === 'inner') {
    // Move the interior boundary, then hold the outer face by compensating the
    // wall: the boundary's outward gain is the wall's loss (and vice versa).
    const next = resizeShape(original, handle, worldDx, worldDy, minInterior);
    const grew =
      handle === 'e' || handle === 'w'
        ? next.width - original.width
        : next.height - original.height;
    const walls = { ...original.walls };
    walls[side] = Math.max(minWall, original.walls[side] - grew);
    return { ...next, walls };
  }

  // Outer face: project the drag onto the side's outward normal and add it to
  // the wall thickness. Interior unchanged.
  const tr = original.rotation * DEG2RAD;
  const cos = Math.cos(tr);
  const sin = Math.sin(tr);
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;
  const outDelta = handle === 'e' ? ldx : handle === 'w' ? -ldx : handle === 'n' ? -ldy : ldy;

  const walls = { ...original.walls };
  walls[side] = Math.max(minWall, original.walls[side] + outDelta);
  return { ...original, walls };
}

/**
 * Stretch EVERY wall's inner (or outer) face by the same amount at once — the
 * Shift-held variant of {@link resizeWall}. The offset distance is the drag
 * projected onto the GRABBED edge's outward normal, then applied uniformly to all
 * sides so the whole interior (inner) or whole outer footprint (outer) insets/
 * outsets together. Works for rectangles and free polygons.
 *
 * - `outer`: every wall thickens/thins by the offset (interior fixed).
 * - `inner`: the interior boundary insets/outsets by the offset and each wall
 *   compensates so the outer footprint stays put.
 */
export function resizeAllWalls(
  original: Square,
  activeHandle: HandleId,
  face: EdgeFace,
  worldDx: number,
  worldDy: number,
  minWall: number,
  minInterior: number,
): Square {
  const e = Math.max(0, edgeIndexOf(activeHandle));
  const nrm = edgeNormalWorld(original, e);
  let perp = worldDx * nrm.x + worldDy * nrm.y; // + = outward (grow)

  // Every wall is offset by the same `perp`, whichever representation the shape
  // uses (named n/e/s/w, or a per-edge wallEdges array) — see mapEdgeThickness.
  const thicks = wallThicknesses(original);
  const minThick = Math.min(...thicks);
  const shiftWalls = (d: number) => (t: number) => Math.max(minWall, t + d);

  if (face === 'outer') {
    // Every wall grows/shrinks by `perp` uniformly (interior fixed); the thinnest
    // may not drop below minWall.
    perp = Math.max(perp, minWall - minThick);
    return mapEdgeThickness(original, shiftWalls(perp));
  }

  // Inner face: the interior boundary insets/outsets by `perp` and every wall
  // compensates by the same amount so the outer footprint stays put. The walls can
  // shrink at most to minWall.
  perp = Math.min(perp, minThick - minWall);

  if (!original.corners) {
    // Rectangle: grow the interior symmetrically about the centre; keep ≥ minInterior.
    const lo = Math.max((minInterior - original.width) / 2, (minInterior - original.height) / 2);
    if (minThick - minWall < lo) return original; // no legal move
    perp = Math.max(perp, lo);
    const cx = original.x + original.width / 2;
    const cy = original.y + original.height / 2;
    const width = original.width + 2 * perp;
    const height = original.height + 2 * perp;
    const grown = { ...original, x: cx - width / 2, y: cy - height / 2, width, height };
    return mapEdgeThickness(grown, shiftWalls(-perp));
  }

  // Polygon (4-corner quad or N-gon): offset every interior edge outward by `perp`
  // (mitered). Bail if the inset would self-collapse/invert.
  const iPts = localCorners(original);
  const offset = outerCorners(
    iPts,
    iPts.map(() => perp),
  );
  if (
    Math.sign(ringArea(offset)) !== Math.sign(ringArea(iPts)) ||
    Math.abs(ringArea(offset)) < 1
  ) {
    return original;
  }
  const moved = finalizeCorners(original, offset);
  return mapEdgeThickness(moved, shiftWalls(-perp));
}

/** A double-headed arrow cursor pointing along `angleDeg` in screen space. */
export function resizeCursor(angleDeg: number): string {
  const a = (((angleDeg % 180) + 180) % 180).toFixed(1);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    `<g transform="rotate(${a} 16 16)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M6 16H26M10 11 5 16l5 5M22 11l5 5-5 5" stroke="white" stroke-width="5"/>' +
    '<path d="M6 16H26M10 11 5 16l5 5M22 11l5 5-5 5" stroke="black" stroke-width="2.2"/>' +
    '</g></svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, auto`;
}

/**
 * Resize cursor for an edge handle, kept perpendicular to that edge at any shape
 * rotation. The arrow points along the edge's outward normal — computed straight
 * from the edge geometry so it's correct for every edge of an N-gon, not just
 * n/e/s/w — then offset by the shape's rotation so it follows the edge as it
 * turns. (Only ever called for wall edges.)
 */
export function cursorForHandle(handle: HandleId, shape: Square): string {
  const e = edgeIndexOf(handle);
  if (e < 0) return resizeCursor(shape.rotation);
  const pts = localCorners(shape);
  const a = pts[e];
  const b = pts[(e + 1) % pts.length];
  const base = (Math.atan2(-(b.x - a.x), b.y - a.y) * 180) / Math.PI;
  return resizeCursor(base + shape.rotation);
}
