import type { Camera, LengthUnit } from '../types';
import { worldToScreen, type Vec2 } from './coords';
import {
  drawBoxDimensions,
  drawCornerRotationArcs,
  drawPlusCircle,
  edgePlusAnchorsScreen,
  polygonShape,
  EDGE_PLUS_RADIUS,
} from './shapes';
import { SHAPE_THEME, BORDER_DIM_GAP } from '../constants';
import {
  borderPolygons,
  borderContaining,
  hasBoundary,
  polyBBox,
  cellRects,
  cellGroups,
  cellIdColors,
  cellKey,
  borderMode,
  optimizeBorder,
  cellNumbers,
  panelFrameAt,
  panelKindAt,
  panelFrameBand,
  panelBorderEdges,
  segmentEndpoints,
  splitCell,
  type BorderBooleanHover,
  type CellRef,
  type FacadeDoc,
  type FacadeLayer,
  type GroupFrame,
  type PanelKind,
  type OptimizeStrategy,
  type Rect,
  type SegmentRef,
} from '../facade/partition';

/**
 * Convex hull (Andrew's monotone chain) of screen-space points. Used to sweep a frame band's
 * silhouette along the light offset so its cast shadow connects to the frame corners with real
 * diagonal miters — like an extruded 3D solid — rather than a 2D copy nudged sideways.
 */
function convexHull(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
      upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Signed area (shoelace). Sign encodes winding; we only ever compare two polygons' signs. */
function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Intersection of a subject polygon with a CONVEX clip polygon (Sutherland–Hodgman). Used to find
 * the part of a frame's glass opening that stays lit during the shadow sweep — `glass ∩ (glass+off)`.
 */
function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  const c = signedArea(clip) < 0 ? clip.slice().reverse() : clip; // force CCW for a consistent inside test
  let out = subject.slice();
  const isect = (p1: Vec2, p2: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const r = { x: p2.x - p1.x, y: p2.y - p1.y };
    const s = { x: b.x - a.x, y: b.y - a.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) < 1e-9) return p2;
    const t = ((a.x - p1.x) * s.y - (a.y - p1.y) * s.x) / denom;
    return { x: p1.x + t * r.x, y: p1.y + t * r.y };
  };
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const inside = (p: Vec2) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(isect(prev, cur, a, b));
        out.push(cur);
      } else if (prevIn) {
        out.push(isect(prev, cur, a, b));
      }
    }
  }
  return out;
}

const ACCENT = '#2563eb';
const CELL_STROKE = '#334155'; // dark slate — the active layer's cell outlines
const CELL_FILL = '#ffffff'; // plain white infill on the active layer (no tint)
const GHOST_STROKE = 'rgba(15, 23, 42, 0.22)'; // trace-paper outline for layers beneath the active one
const SEG_HIGHLIGHT = '#db2777'; // magenta — the shift-selected line segment
const BOOL_OVERLAP_FILL = 'rgba(0, 200, 220, 0.20)'; // cyan tint marking the shared interior of two picked borders
const BOOL_CUE_LINE = '#6ea8fe'; // accent blue for the union "+" grid / subtract hatch (matches the Plan-mode cues)
const BOOL_TRIM_EDGE = '#ef4444'; // red — the border that a subtract will trim (loses the overlap)
const TRIM_FILL = '#ffffff'; // white — the Edge-Profile perimeter trim reads as part of the frame assembly
const FRAME_FILL = '#ffffff'; // white infill (matches CELL_FILL) — the per-group (Edit-a-panel) inset frame band
const FRAME_STROKE = CELL_STROKE; // match the panel cell outlines (the lines shown before a frame) — elevation mullion
const FRAME_STROKE_WIDTH = 1; // match the vertical/horizontal grid-line weight
const FRAME_SHADOW = 'rgba(15, 23, 42, 0.35)'; // purely-visual drop shadow lifting the frame assembly off the wall
const SPLIT_PREVIEW = 'rgba(37, 99, 235, 0.55)'; // faint accent — live split-menu subdivision preview
// Border dimensions reuse the room bracket geometry, drawn in the trim accent blue.
const BORDER_DIM_THEME = { ...SHAPE_THEME, label: ACCENT };
// Below this on-screen short side (px) the border dimension labels are hidden (clutter), matching footprints.
const BORDER_DIM_MIN_PX = 24;
// One calibrated semi-transparent grey overlay marks a selected panel in BOTH modes: over white it reads
// as a light grey; over a Material-ID hue it greys the colour down while keeping it recognisable.
const SELECTED_OVERLAY = 'rgba(120, 120, 120, 0.5)';
// Material-ID view uses a much darker grey so the selection clearly stands out, while staying
// translucent enough that the underlying segmentation hue remains readable beneath it.
const SELECTED_OVERLAY_ID = 'rgba(30, 30, 30, 0.62)';
// Constraint-violation flag on a panel — the same warning yellow a flagged room wears in Plan mode
// (VIOLATION_YELLOW in shapes.ts), as a translucent wash plus a solid outline so it survives any fill
// beneath it (material pattern, Material-ID hue, selection grey).
const FLAG_OVERLAY = 'rgba(250, 204, 21, 0.42)';
const FLAG_STROKE = '#facc15';

// --- Assigned panel-material fill patterns (the right-click "Assign" kinds) ---
const VISION_LINE = '#7fa3d6'; // crisp blue 45° glass slashes for clear vision glass
const SPANDREL_FILL = '#d9dee6'; // opaque light-grey tint behind spandrel glass
const SPANDREL_LINE = '#9aa6b6'; // diagonals over the spandrel tint
const SOLID_SHEEN_HI = '#f1f4f8'; // smooth-panel gradient: light top-left highlight
const SOLID_SHEEN_MID = '#dde3ea'; // smooth-panel gradient: mid tone
const SOLID_SHEEN_LO = '#c6cdd7'; // smooth-panel gradient: bottom-right shade
const CLADDING_DOT = '#b3bac4'; // stipple dots for heavy cladding
const LOUVER_LINE = '#9fa8b4'; // dense parallel lines for a louver/screen

/**
 * Draw the facade layer stack. The regular axis-aligned cell grid is built on each layer's grid domain and
 * NEVER stretches; instead the deformable TRIM borders act as a clipping mask (the cell grid fills their
 * UNION), so cells crossing an angled border are neatly sliced off. Non-active layers render as faint "trace
 * paper" beneath the active one. Everything maps through the camera.
 */
export function drawPartition(
  ctx: CanvasRenderingContext2D,
  doc: FacadeDoc,
  camera: Camera,
  opts: {
    selectedSegment?: SegmentRef | null;
    /** Cell keys of the selected panels — drawn black (ID view) / white (normal view). Per-PANEL, not per
     *  material group, so a rubber-band sweep highlights only the panels it covered. */
    selectedCells?: Set<string>;
    /**
     * Cell keys of the panels breaking a Facade-mode constraint (too wide, too tall, too small…). Washed
     * and outlined in the same warning yellow a flagged room gets in Plan mode, so one visual language
     * covers both. Undefined (or empty) when no rule is broken or the Visibility eye is off.
     */
    flaggedCells?: Set<string>;
    /**
     * Live "what would this look like" preview while hovering an option in the Assign menu: the SELECTED
     * panels render with this material instead of their own. Render-only — nothing is written to the
     * document until the option is clicked, so moving off the menu simply restores what was there.
     * `{ kind: null }` previews clearing the assignment; the whole field is null when not previewing.
     */
    kindPreview?: { kind: PanelKind | null } | null;
    /** Material-ID view: paint each cell its flat segmentation colour and drop all chrome. */
    idView?: boolean;
    /**
     * Clicked border indices. Every selected border shows its draggable corner handles; exactly one also
     * shows its dimensions (like a single-selected room); two are armed for a boolean (unite/difference)
     * op. The outline colour never changes. This is what replaced the Border/Panels edit switch — border
     * geometry is editable whenever its border is selected, with no mode to toggle.
     */
    selectedBorders?: Set<number>;
    /**
     * The border the user has double-clicked INTO, or null. It gets a heavier outline so "I am editing this
     * shape's contents" is legible at a glance — outside it a border is an object you drag, inside it the
     * pointer paints panels, and the two are otherwise indistinguishable on screen.
     */
    enteredBorder?: number | null;
    /**
     * Live Optimize-menu preview: run `strategy` on `border` against a throwaway CLONE of the active layer
     * and draw that. Running the real `optimizeBorder` — rather than re-deriving what it would do — is what
     * lets the one-shot Snap to Grid preview too (the outline moves onto the lattice and the cells re-cut),
     * and guarantees the preview can never drift from what clicking actually commits, toggle-off included.
     */
    optimizePreview?: { border: number; strategy: OptimizeStrategy } | null;
    /**
     * Live edge-plus drag: how many adjacent copies of `border` to ghost, stepped by (dx, dy) each. Mirrors
     * the Plan-mode duplicate preview — drag outward from a plus button and the row grows under the cursor.
     */
    plusPreview?: { border: number; dx: number; dy: number; count: number } | null;
    /** Live Plan-style boolean classification of the cursor over two picked, overlapping borders: drives the
     *  union "+" grid (shared interior) / subtract hatch (bounding edge) preview. */
    boolHover?: BorderBooleanHover | null;
    /** Active length unit — when set (and in Border mode) the selected border shows live, editable dims. */
    unit?: LengthUnit;
    /** Optimize overlay: paint each panel its shape-GROUP number, centred (identical panels share a number). */
    showPanelNumbers?: boolean;
    /**
     * Edit-a-panel session: outline EVERY selected cell + magenta-highlight the draggable frame face(s) on
     * each — just `hoverSide`, or all four when `all` (editing every side at once).
     */
    frameEdit?: {
      /** EVERY selected panel — each one is a grabbable handle that drives the whole selection. */
      rects: Rect[];
      frame: GroupFrame;
      hoverSide: 'n' | 'e' | 's' | 'w' | 'b' | null;
      all: boolean;
    } | null;
    /** Live split-menu preview: the cell ref being split into cols × rows. The preview is computed from the
     *  ACTUAL resulting partition (lattice tiled + clipped to the boundary), not a naive even subdivision. */
    splitPreview?: { ref: CellRef; cols: number; rows: number } | null;
    /** Purely-visual drop shadow beneath the per-group frame bands (depth, no geometry change). */
    frameShadow?: boolean;
  } = {},
): void {
  // Map a world rect to its screen rectangle (x, y, w, h in device px).
  const screenRect = (r: Rect): [number, number, number, number] => {
    const tl = worldToScreen(r.x, r.y, camera);
    const br = worldToScreen(r.x + r.w, r.y + r.h, camera);
    return [tl.x, tl.y, br.x - tl.x, br.y - tl.y];
  };

  // Trace a world polygon as a screen path (caller decides clip/stroke/fill).
  const tracePoly = (poly: Vec2[]) => {
    if (poly.length < 2) return;
    ctx.beginPath();
    const p0 = worldToScreen(poly[0].x, poly[0].y, camera);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < poly.length; i++) {
      const p = worldToScreen(poly[i].x, poly[i].y, camera);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  };

  // Trace ALL of a layer's trim borders into ONE path (each quad a subpath). With the default nonzero rule a
  // following `ctx.clip()`/`ctx.fill()` covers the UNION of the borders — so the cell grid spans every border.
  const traceAllBorders = (layer: FacadeLayer) => {
    ctx.beginPath();
    for (const poly of borderPolygons(layer)) {
      if (poly.length < 2) continue;
      const p0 = worldToScreen(poly[0].x, poly[0].y, camera);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) {
        const p = worldToScreen(poly[i].x, poly[i].y, camera);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    }
  };

  // Stroke the clean sliced outline of every border, then (in Border mode) its draggable corner dots. Every
  // border keeps the one accent blue whether or not it's picked — like a Plan-mode room, selection reads from
  // the dimensions that appear, not from a colour change.
  /**
   * Outline every border, and put draggable corner dots on the ones in `handlesFor`. Handles follow the
   * SELECTION rather than an edit mode: clicking a border reveals its vertices, which is what makes the
   * old Border/Panels switch unnecessary. Pass null for none (ghost layers).
   */
  const strokeBorderOutlines = (
    layer: FacadeLayer,
    stroke: string,
    width: number,
    handlesFor: Set<number> | null,
  ) => {
    borderPolygons(layer).forEach((poly, bi) => {
      tracePoly(poly);
      ctx.strokeStyle = stroke;
      // The entered shape reads heavier — the one cue that the pointer is editing its contents. Only the
      // active layer can be entered, and it is the only caller that passes a handle set.
      ctx.lineWidth = handlesFor && opts.enteredBorder === bi ? width + 2 : width;
      ctx.stroke();
      if (!handlesFor?.has(bi)) return;
      for (const c of poly) {
        const p = worldToScreen(c.x, c.y, camera);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    });
  };

  // Live width/height dimension brackets around the SELECTED border's bounding box (Border mode only), in the
  // trim accent — the same CAD geometry rooms/footprints use, so they read identically and stay editable. Drawn
  // UNCLIPPED (the brackets hang outside the border). Gated exactly like a Plan-mode room's: they appear on the
  // one border a click selects, and only when it's alone in the selection, so an unclicked facade stays clean.
  /**
   * The four edge-midpoint "+" buttons around the single-selected border — the Plan-mode duplicate
   * affordance, in the facade accent instead of the room theme. Click one to drop a copy of the whole
   * shape (outline, lattice and panels) against that side; drag outward to run a row of them, previewed
   * as ghost outlines. Shown only at shape level: once the user is inside a shape they are editing its
   * panels, and a button hovering off its edge would just be in the way.
   */
  const drawEdgePlusButtons = (layer: FacadeLayer) => {
    const sel = opts.selectedBorders;
    if (!sel || sel.size !== 1) return;
    const bi = [...sel][0];
    if (bi === opts.enteredBorder) return;
    const poly = borderPolygons(layer)[bi];
    if (!poly || poly.length < 3) return;

    // Rotation affordance: the same corner arcs a selected room wears in Plan mode, at half the dimension
    // gap so they sit between the outline and the dimension spines.
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    drawCornerRotationArcs(
      ctx,
      poly.map((p) => worldToScreen(p.x, p.y, camera)),
      BORDER_DIM_GAP / 2,
    );
    ctx.restore();

    // Ghost the pending copies first, so the buttons sit on top of them.
    const preview = opts.plusPreview;
    if (preview && preview.border === bi && preview.count > 0) {
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      for (let i = 1; i <= preview.count; i++) {
        tracePoly(poly.map((p) => ({ x: p.x + preview.dx * i, y: p.y + preview.dy * i })));
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const p of edgePlusAnchorsScreen(polygonShape(poly), camera)) {
      drawPlusCircle(ctx, Math.round(p.x), Math.round(p.y), EDGE_PLUS_RADIUS, ACCENT, '#ffffff');
    }
  };

  const drawBorderDimensions = (layer: FacadeLayer) => {
    const unit = opts.unit;
    if (!unit) return;
    const sel = opts.selectedBorders;
    if (!sel || sel.size !== 1) return;
    const scale = camera.scale;
    borderPolygons(layer).forEach((poly, bi) => {
      if (!sel.has(bi)) return;
      const bb = polyBBox(poly);
      const wS = bb.w * scale;
      const hS = bb.h * scale;
      if (Math.min(wS, hS) <= BORDER_DIM_MIN_PX) return;
      const c = worldToScreen(bb.x + bb.w / 2, bb.y + bb.h / 2, camera);
      const hw = wS / 2;
      const hh = hS / 2;
      const corners: Vec2[] = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh },
      ];
      // Irregular border ⇒ also stroke the bounding box (in the dimension-line style) so the extents read
      // clearly. A rectangular border's bbox IS its own outline, so skip the outline there to avoid a
      // double-stroke over the blue border edge.
      const EPS = 1e-6;
      const isRect =
        poly.length === 4 &&
        poly.every(
          (p) =>
            (Math.abs(p.x - bb.x) < EPS || Math.abs(p.x - (bb.x + bb.w)) < EPS) &&
            (Math.abs(p.y - bb.y) < EPS || Math.abs(p.y - (bb.y + bb.h)) < EPS),
        );
      ctx.save();
      ctx.translate(Math.round(c.x), Math.round(c.y));
      // Smaller gap than rooms (no wall band) → the dimensions hug the border's actual edges. For a
      // deformed/irregular border the dims (and the outline box) fall back to the bounding box.
      drawBoxDimensions(ctx, corners, corners, bb.w, bb.h, 0, unit, BORDER_DIM_THEME, !isRect, BORDER_DIM_GAP);
      ctx.restore();
    });
  };

  // Draw an assigned panel material's fill PATTERN inside a cell's screen rect (already clipped to the border
  // by the caller). Each pattern is clipped to the cell so it never bleeds into neighbours.
  const drawPanelPattern = (kind: PanelKind, x: number, y: number, w: number, h: number) => {
    if (w < 2 || h < 2) return;
    // n clean 45° diagonal lines (AutoCAD glass convention), CENTRED on the panel: the bundle is symmetric
    // about the centre, so the middle line of an odd count runs straight through it. A fixed 45° angle keeps
    // the slash steep regardless of the panel's aspect ratio. Each line is extended past the cell and clipped.
    const inv = 1 / Math.SQRT2;
    const glassDiagonals = (n: number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const spacing = Math.max(5, Math.min(14, Math.min(w, h) * 0.16)); // clear gap between adjacent lines
      const L = w + h; // half-length; long enough to span the cell before clipping
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * spacing; // perpendicular offset along (1,1)
        const px = cx + off * inv;
        const py = cy + off * inv;
        ctx.beginPath();
        ctx.moveTo(px - L, py + L); // direction (1,-1): a "/" slash up to the right
        ctx.lineTo(px + L, py - L);
        ctx.stroke();
      }
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    switch (kind) {
      case 'vision1':
      case 'vision2':
      case 'vision3':
        glassDiagonals(kind === 'vision1' ? 1 : kind === 'vision2' ? 2 : 3, VISION_LINE, 1.4);
        break;
      case 'spandrel':
        ctx.fillStyle = SPANDREL_FILL;
        ctx.fillRect(x, y, w, h);
        glassDiagonals(2, SPANDREL_LINE, 1.4);
        break;
      case 'solid': {
        // Smooth metal/composite cassette: a soft diagonal sheen gradient (no inset line — that read as a
        // frame). The gradient runs corner-to-corner so the panel looks like a flat reflective solid surface.
        const g = ctx.createLinearGradient(x, y, x + w, y + h);
        g.addColorStop(0, SOLID_SHEEN_HI);
        g.addColorStop(0.5, SOLID_SHEEN_MID);
        g.addColorStop(1, SOLID_SHEEN_LO);
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
        break;
      }
      case 'cladding': {
        // Dot stippling on a regular grid.
        const step = 7;
        ctx.fillStyle = CLADDING_DOT;
        for (let gy = y + step / 2; gy < y + h; gy += step) {
          for (let gx = x + step / 2; gx < x + w; gx += step) {
            ctx.beginPath();
            ctx.arc(gx, gy, 1.1, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }
      case 'louver': {
        // Dense horizontal parallel lines.
        const step = 5;
        ctx.strokeStyle = LOUVER_LINE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let ly = y + step; ly < y + h; ly += step) {
          ctx.moveTo(x, ly);
          ctx.lineTo(x + w, ly);
        }
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  };

  /** The outlines of the borders currently in Edge-Profile mode — the only ones that carry a trim band. */
  const trimBorders = (layer: FacadeLayer): Vec2[][] =>
    borderPolygons(layer).filter((p, b) => p.length >= 3 && borderMode(layer, b) === 'edge-profile');

  /** Trace a set of polygons as ONE path (multiple subpaths), for a combined fill/stroke. */
  const tracePolys = (polys: Vec2[][]) => {
    ctx.beginPath();
    for (const poly of polys) {
      if (poly.length < 2) continue;
      const p0 = worldToScreen(poly[0].x, poly[0].y, camera);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) {
        const p = worldToScreen(poly[i].x, poly[i].y, camera);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    }
  };

  // Edge-Profile mode: fill each such border's region with the single trim colour as an underlay. The whole
  // rectangular panels (only cells fully inside the border) then paint on top, leaving the sliced perimeter
  // showing through as one consistent trim band. Caller must already have clipped to the border.
  const fillTrim = (layer: FacadeLayer) => {
    const polys = trimBorders(layer);
    if (!polys.length) return;
    tracePolys(polys);
    ctx.fillStyle = TRIM_FILL;
    ctx.fill();
  };

  /**
   * Re-assert the Edge-Profile trim on top of the frame shadow pass, then outline it like a mullion.
   *
   * The trim sits at the SAME height as the frames, so nothing at that height can cast onto it — a shadow
   * running across the trim would read as the trim being recessed behind the mullions it abuts. Drawing the
   * ring last is what occludes those shadows, exactly as the real coplanar profile would. Shadows still fall
   * where they should: on the recessed glass, and on the wall outside the border.
   *
   * The ring is the border minus the whole panels, punched with even-odd. In Edge-Profile mode `cellRects`
   * returns only the cells that fit entirely inside the boundary, so what's left over IS the trim band.
   */
  const paintTrimRing = (layer: FacadeLayer) => {
    const polys = trimBorders(layer);
    if (!polys.length) return;
    ctx.save();
    tracePolys(polys); // begins the path with the trim-mode border outlines
    for (const rect of cellRects(layer)) {
      const [x, y, w, h] = screenRect(rect);
      ctx.rect(x, y, w, h);
    }
    ctx.fillStyle = TRIM_FILL;
    ctx.fill('evenodd');
    tracePolys(polys);
    ctx.strokeStyle = FRAME_STROKE;
    ctx.lineWidth = FRAME_STROKE_WIDTH;
    ctx.stroke();
    ctx.restore();
  };

  // Per-group frames (Edit-a-panel): an inset band along every edge of each cell whose group has an override,
  // plus the live Edit-session affordances (representative-cell outline + hovered-side magenta strip).
  const drawGroupFrames = (layer: FacadeLayer) => {
    // The Edge-Profile trim belongs to the same white assembly as the frames, so it casts with them: its
    // silhouette is the border outline, swept along the light and punched back out so only the crescent
    // OUTSIDE the border survives — a drop shadow on the wall, never over the panels it surrounds.
    const trimPolys = trimBorders(layer);
    if ((layer.frames && Object.keys(layer.frames).length) || trimPolys.length) {
      ctx.save();
      // Each framed panel's band as (outer outline, inner glass) WORLD polygons. The band hugs every edge of
      // the panel's visible shape — including the trim-border cut — so border-sliced panels get a mullion that
      // runs along the (diagonal) border, and the band re-fits live as the border moves. `outer` is already
      // clipped to the border, so no extra canvas clip is needed.
      const bands: { outer: Vec2[]; glass: Vec2[] }[] = [];
      for (const { rect } of cellGroups(layer)) {
        const f = panelFrameAt(layer, cellKey(rect));
        if (!f) continue;
        const band = panelFrameBand(layer, rect, f);
        if (band) bands.push(band);
      }
      // Add a world polygon as a subpath in screen space (caller controls beginPath / fill / stroke).
      const addPoly = (poly: Vec2[]) => {
        if (poly.length < 2) return;
        const p0 = worldToScreen(poly[0].x, poly[0].y, camera);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < poly.length; i++) {
          const p = worldToScreen(poly[i].x, poly[i].y, camera);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      };
      // Shadow pass: cast a real extruded shadow, not a copy nudged down-right. Light comes from
      // the upper-left, so the frame's z-height throws a shadow toward the lower-right. We sweep
      // each band's outer silhouette along that offset (convex hull of the band and its offset
      // copy); the hull's tangent edges become the diagonal corner miters a 3D solid would cast.
      //
      // Everything goes into ONE path filled with NONZERO winding so that (a) where neighbouring
      // frames' shadows overlap they union into a continuous shape instead of cancelling to white
      // seams, and (b) a single fill keeps the translucency uniform (no double-darkening). Each
      // glass opening keeps its inner shadow: only the part that stays lit through the whole sweep,
      // `glass ∩ (glass+off)`, is punched back out — as a reverse-wound subpath so nonzero treats
      // it as a hole. The offset scales with zoom so the shadow stays glued to the frame.
      if (opts.frameShadow && (bands.length || trimPolys.length)) {
        ctx.save();
        ctx.fillStyle = FRAME_SHADOW;
        const off = 9 * camera.scale; // light direction, in screen px (equal x/y => 45° down-right)
        const toScreen = (poly: Vec2[]) => poly.map((p) => worldToScreen(p.x, p.y, camera));
        const shift = (pts: Vec2[]) => pts.map((p) => ({ x: p.x + off, y: p.y + off }));
        const traceScreen = (pts: Vec2[]) => {
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
        };
        ctx.beginPath();
        for (const poly of trimPolys) {
          const outline = toScreen(poly);
          if (outline.length < 3) continue;
          const swept = convexHull([...outline, ...shift(outline)]);
          traceScreen(swept);
          // Punch the border itself back out, so the trim's shadow lands on the wall, not on the facade.
          const hole =
            signedArea(outline) > 0 === signedArea(swept) > 0 ? outline.slice().reverse() : outline;
          traceScreen(hole);
        }
        for (const b of bands) {
          const outer = toScreen(b.outer);
          if (outer.length < 3) continue;
          const swept = convexHull([...outer, ...shift(outer)]);
          traceScreen(swept);
          if (b.glass.length >= 3) {
            const g = toScreen(b.glass);
            const lit = clipConvex(shift(g), g); // glass ∩ (glass+off): stays lit through the sweep
            if (lit.length >= 3) {
              // Wind the hole opposite to the hull so nonzero subtracts it (inner-edge shadow remains).
              const hole = signedArea(lit) > 0 === signedArea(swept) > 0 ? lit.slice().reverse() : lit;
              traceScreen(hole);
            }
          }
        }
        ctx.fill('nonzero');
        ctx.restore();
      }
      // Clean pass: white infill (outer − glass via even-odd) + thin grid-weight outline on both rings.
      ctx.fillStyle = FRAME_FILL;
      ctx.strokeStyle = FRAME_STROKE;
      ctx.lineWidth = FRAME_STROKE_WIDTH;
      for (const b of bands) {
        ctx.beginPath();
        addPoly(b.outer);
        if (b.glass.length >= 3) addPoly(b.glass);
        ctx.fill('evenodd');
        ctx.beginPath();
        addPoly(b.outer);
        ctx.stroke();
        if (b.glass.length >= 3) {
          ctx.beginPath();
          addPoly(b.glass);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    const fe = opts.frameEdit;
    // Every panel in the Edit selection is a live handle: grabbing any one of their mullions drives the
    // whole set, so all of them wear the affordance. Marking only one made the rest look like passengers.
    for (const feRect of fe?.rects ?? []) {
      const [rx, ry, rw, rh] = screenRect(feRect);
      // A panel that borders the trim (its visible shape is cut by the diagonal border) isn't really this
      // axis-aligned rectangle, so the dashed "original size" outline and the magenta wash both jut past the
      // border and read as wrong. Drop the dashed outline there, and clip the wash to the border polygon.
      const borderCut = panelBorderEdges(layer, feRect).length > 0;
      ctx.save();
      // Dashed outline of each panel being edited — only where it sits fully inside the border.
      if (!borderCut) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
      }
      // Magenta wash over the draggable face(s): all four strips when editing all sides at once (Shift),
      // otherwise just the hovered axis-aligned side.
      const litSides: ('n' | 'e' | 's' | 'w')[] = fe!.all
        ? ['n', 'e', 's', 'w']
        : fe!.hoverSide && fe!.hoverSide !== 'b'
          ? [fe!.hoverSide]
          : [];
      if (litSides.length) {
        const sc = camera.scale;
        const f = fe!.frame;
        ctx.save();
        // Clip the wash to the border so a border-sliced panel's strips don't bleed past the boundary.
        if (borderCut) {
          const border = borderContaining(layer, feRect);
          if (border.length >= 3) {
            ctx.beginPath();
            const p0 = worldToScreen(border[0].x, border[0].y, camera);
            ctx.moveTo(p0.x, p0.y);
            for (let i = 1; i < border.length; i++) {
              const p = worldToScreen(border[i].x, border[i].y, camera);
              ctx.lineTo(p.x, p.y);
            }
            ctx.closePath();
            ctx.clip();
          }
        }
        ctx.fillStyle = 'rgba(219, 39, 119, 0.5)'; // SEG_HIGHLIGHT magenta, translucent
        for (const side of litSides) {
          let strip: [number, number, number, number];
          if (side === 'n') strip = [rx, ry, rw, f.n * sc];
          else if (side === 's') strip = [rx, ry + rh - f.s * sc, rw, f.s * sc];
          else if (side === 'w') strip = [rx, ry, f.w * sc, rh];
          else strip = [rx + rw - f.e * sc, ry, f.e * sc, rh];
          ctx.fillRect(...strip);
        }
        ctx.restore();
      }
      // The diagonal border-cut frame edge(s): highlight every cut line so they read as draggable. Shown when
      // hovering the border frame, or when Shift previews scaling all edges (the border scales too).
      if (fe!.hoverSide === 'b' || fe!.all) {
        ctx.strokeStyle = 'rgba(219, 39, 119, 0.85)';
        ctx.lineWidth = 3;
        for (const be of panelBorderEdges(layer, feRect)) {
          const a = worldToScreen(be[0].x, be[0].y, camera);
          const b2 = worldToScreen(be[1].x, be[1].y, camera);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b2.x, b2.y);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  };

  // Optimize overlay: paint each panel its shape-group number, centred. The label is composited with the
  // 'difference' blend over white, so its colour auto-inverts against whatever is behind it (like the Windows
  // inverted mouse pointer) — maximum contrast on any panel colour with NO outline/halo/shadow. Identical
  // panels share a number, so the result reads like a paint-by-number key.
  const drawPanelNumbers = (layer: FacadeLayer) => {
    if (!opts.showPanelNumbers) return;
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff'; // difference vs white ⇒ inverted colour of the background pixel
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const { cx, cy, num } of cellNumbers(layer)) {
      const p = worldToScreen(cx, cy, camera);
      ctx.fillText(String(num), p.x, p.y);
    }
    ctx.restore();
  };

  // --- Material-ID view: the active layer's cells as flat segmentation colours, clipped to the border —
  //     a clean paint-by-numbers map for masking (no inner grid lines/ghosts). In Border mode the editable
  //     boundary outline + corner dots are drawn on top so the user can still reshape it; Panels mode keeps
  //     the map handle-free.
  const sel = opts.selectedCells;
  const flagged = opts.flaggedCells;
  /** Wash + outline one panel as constraint-violating. Drawn last so it survives every fill beneath it. */
  const drawFlag = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = FLAG_OVERLAY;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = FLAG_STROKE;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x, y, w, h);
  };
  const activeLayer = doc.layers[doc.activeIndex];
  if (opts.idView && activeLayer && hasBoundary(activeLayer)) {
    ctx.save();
    traceAllBorders(activeLayer);
    // Always clip. Stepped mode used to draw unclipped so its half-outside cells could show whole; now
    // every panel it keeps fits inside the border, so the clip is a guarantee rather than a restriction.
    ctx.clip();
    fillTrim(activeLayer); // Edge-Profile: perimeter trim underlay (no-op otherwise)
    for (const { rect, color } of cellIdColors(activeLayer)) {
      const [x, y, w, h] = screenRect(rect);
      const k = cellKey(rect);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      if (sel?.has(k)) {
        ctx.fillStyle = SELECTED_OVERLAY_ID; // darken the hue to mark selection, colour still readable
        ctx.fillRect(x, y, w, h);
      }
      if (flagged?.has(k)) drawFlag(x, y, w, h);
    }
    ctx.restore();
    // The boundary stays editable over the Material-ID map too, so draw the blue outline on top of the
    // colours — with corner dots on the selected border(s) only, keeping an unselected map handle-free.
    drawGroupFrames(activeLayer);
    paintTrimRing(activeLayer); // after the frames: coplanar, so their shadows must not cross it
    strokeBorderOutlines(activeLayer, ACCENT, 2, opts.selectedBorders ?? null);
    drawPanelNumbers(activeLayer);
    return;
  }

  // --- Ghosted layers (every layer except the active one), each clipped to its own trim border ---
  doc.layers.forEach((layer, i) => {
    if (i === doc.activeIndex || !hasBoundary(layer)) return;
    ctx.save();
    traceAllBorders(layer);
    ctx.clip();
    ctx.strokeStyle = GHOST_STROKE;
    ctx.lineWidth = 1;
    for (const rect of cellRects(layer)) {
      const [x, y, w, h] = screenRect(rect);
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
    // The trim outline itself (clean sliced edge), per border. No corner handles on ghost layers.
    strokeBorderOutlines(layer, GHOST_STROKE, 1, null);
  });

  // --- Active layer: clip the regular grid to the trim border, then draw the border + corner handles ---
  // A hovered Optimize option is applied to a CLONE first, so the panels below render as that strategy
  // would leave them while the document itself is untouched until the option is clicked.
  let active = doc.layers[doc.activeIndex];
  const mp = opts.optimizePreview;
  if (active && mp) {
    const preview = JSON.parse(JSON.stringify(active)) as FacadeLayer;
    optimizeBorder(preview, mp.border, mp.strategy);
    active = preview;
  }
  if (active && hasBoundary(active)) {
    ctx.save();
    traceAllBorders(active);
    ctx.clip(); // every mode's panels now fit inside the border, so the clip only enforces that
    fillTrim(active); // Edge-Profile: perimeter trim underlay (no-op otherwise)
    // Inner cell outlines are only drawn once SOME border has actually been subdivided (a grid exists). Before
    // that the whole boundary is a single panel whose edge IS the blue border outline — stroking the fixed
    // root rect here would linger as a stray dark rectangle once the border is deformed off its drawn spot.
    const showCellOutlines = active.grids.some((g) => g != null);
    // We need the per-cell walk when a panel is selected (cell keys) OR any panel has an assigned material
    // kind (group keys). Otherwise take the cheaper plain `cellRects` path (no clipping for keys).
    const hasKinds = !!active.panelKinds && Object.keys(active.panelKinds).length > 0;
    // Constraint flags are keyed per cell, so they need the keyed walk too — not just selection/materials.
    if ((sel && sel.size) || hasKinds || (flagged && flagged.size)) {
      for (const { rect } of cellGroups(active)) {
        const [x, y, w, h] = screenRect(rect);
        const k = cellKey(rect);
        ctx.fillStyle = CELL_FILL;
        ctx.fillRect(x, y, w, h);
        // A hovered Assign option overrides the assigned material on the selected panels only.
        const preview = opts.kindPreview && sel?.has(k) ? opts.kindPreview : null;
        const kind = preview ? preview.kind : hasKinds ? panelKindAt(active, k) : null;
        if (kind) drawPanelPattern(kind, x, y, w, h);
        // The selection grey is dropped on previewed panels: at half opacity it muddies the very material
        // the user is trying to judge, and the previewed panels ARE the selection, so nothing is ambiguous.
        if (sel?.has(k) && !preview) {
          ctx.fillStyle = SELECTED_OVERLAY; // white + grey overlay → a light grey selected panel
          ctx.fillRect(x, y, w, h);
        }
        if (showCellOutlines) {
          ctx.strokeStyle = CELL_STROKE;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(x, y, w, h);
        }
        if (flagged?.has(k)) drawFlag(x, y, w, h);
      }
    } else {
      for (const rect of cellRects(active)) {
        const [x, y, w, h] = screenRect(rect);
        ctx.fillStyle = CELL_FILL;
        ctx.fillRect(x, y, w, h);
        if (showCellOutlines) {
          ctx.strokeStyle = CELL_STROKE;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(x, y, w, h);
        }
      }
    }

    // Shift-selected segment highlight (drawn inside the clip so it slices with the border).
    if (opts.selectedSegment) {
      const ends = segmentEndpoints(active, opts.selectedSegment);
      if (ends) {
        const a = worldToScreen(ends[0].x, ends[0].y, camera);
        const b = worldToScreen(ends[1].x, ends[1].y, camera);
        ctx.strokeStyle = SEG_HIGHLIGHT;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Live split-menu preview — dashed outline of the ACTUAL cells the split will produce. We apply the split
    // to a throwaway clone of the active layer and draw its resulting cell grid, so the preview tiles the real
    // lattice across the WHOLE boundary and (being inside the border clip above) is sliced exactly like the
    // committed panels will be — an accurate picture of how they'll populate, not a naive even subdivision.
    const pv = opts.splitPreview;
    if (pv && (pv.cols > 1 || pv.rows > 1)) {
      const preview = JSON.parse(JSON.stringify(active)) as FacadeLayer;
      splitCell(preview, pv.ref, pv.cols, pv.rows);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = SPLIT_PREVIEW;
      ctx.lineWidth = 1.25;
      for (const rect of cellRects(preview)) {
        const [x, y, w, h] = screenRect(rect);
        ctx.strokeRect(x, y, w, h);
      }
      ctx.restore();
    }
    ctx.restore();

    // Boolean preview: with exactly two borders picked in Border mode, tint their shared interior cyan (the
    // click target). Hovering it shows the UNION "+" grid; hovering an edge that bounds it shows the SUBTRACT
    // hatch over the region the trimmed border loses, plus a red dashed outline of that border. Mirrors the
    // Plan-mode room booleans — the in-canvas replacement for the old Combine buttons.
    if (opts.selectedBorders && opts.selectedBorders.size === 2) {
      const polys = borderPolygons(active);
      const idx = [...opts.selectedBorders].filter((i) => i >= 0 && i < polys.length);
      if (idx.length === 2) {
        const A = polys[idx[0]];
        const B = polys[idx[1]];
        // Screen bounding box of both borders — the lattice/hatch is anchored to it and clipped to A ∩ B,
        // so the marks stay put on screen and fill exactly the shared interior.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const poly of [A, B]) {
          for (const p of poly) {
            const s = worldToScreen(p.x, p.y, camera);
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x);
            maxY = Math.max(maxY, s.y);
          }
        }
        const bh = opts.boolHover;
        ctx.save();
        tracePoly(A);
        ctx.clip();
        tracePoly(B);
        ctx.clip(); // now clipped to A ∩ B (the shared interior)
        ctx.fillStyle = BOOL_OVERLAP_FILL;
        tracePoly(A);
        ctx.fill();
        ctx.strokeStyle = BOOL_CUE_LINE;
        ctx.lineWidth = 1;
        if (bh?.kind === 'union') {
          // "+" lattice = "click to merge".
          ctx.lineCap = 'round';
          const GRID = 12;
          const ARM = 4;
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
        } else if (bh?.kind === 'difference') {
          // Diagonal hatch = "this overlap is erased from the trimmed border".
          ctx.beginPath();
          const HATCH_GAP = 8;
          for (let c = minX + minY; c <= maxX + maxY; c += HATCH_GAP) {
            ctx.moveTo(c - minY, minY);
            ctx.lineTo(c - maxY, maxY);
          }
          ctx.stroke();
        }
        ctx.restore();
        // Outside the clip: outline the border that a subtract would trim, so the direction is unambiguous.
        if (bh?.kind === 'difference' && polys[bh.target]) {
          ctx.save();
          tracePoly(polys[bh.target]);
          ctx.strokeStyle = BOOL_TRIM_EDGE;
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    drawGroupFrames(active);
    paintTrimRing(active); // after the frames: coplanar, so their shadows must not cross it
    // Chrome last, so the trim's white ring can't creep over the blue outline or the corner handles.
    // Trim border outline (the clean sliced boundary) for every border, with corner handles on the
    // selected one(s) — select a border and its vertices become draggable, no edit mode required.
    strokeBorderOutlines(active, ACCENT, 2, opts.selectedBorders ?? null);
    // Live, editable width/height dimensions on the single-selected border.
    drawBorderDimensions(active);
    drawEdgePlusButtons(active);
    drawPanelNumbers(active);
  }
}
