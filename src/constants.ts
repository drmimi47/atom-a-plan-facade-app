import type { GridTheme, LengthUnit, ShapeTheme } from './types';

/** Zoom limits and sensitivity for wheel-based zooming. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const ZOOM_SENSITIVITY = 0.0015;

/**
 * Cap the backing-store density. On 3×+ displays, rendering at full DPR means
 * ~9× the fill work per frame for no perceptible quality gain past 2×.
 */
export const MAX_DEVICE_PIXEL_RATIO = 2;

/** Cell size in world pixels. */
export const DEFAULT_GRID_SIZE = 20;

/** Extra cells added beyond the viewport so no background edge shows on load. */
export const GRID_EXTENT_PADDING_CELLS = 2;

/**
 * Half-extent of the finite grid square, in cells (out from the origin each
 * way), sized so the CPlane fully covers the viewport at the home view (scale
 * 1, origin centred). Because it keys off the larger screen dimension, the
 * square always blankets the screen on load while cells stay at `gridSize`px.
 */
export function computeGridExtentCells(
  viewportWidth: number,
  viewportHeight: number,
  gridSize: number,
): number {
  const halfMaxDimension = Math.max(viewportWidth, viewportHeight) / 2;
  return Math.ceil(halfMaxDimension / gridSize) + GRID_EXTENT_PADDING_CELLS;
}

/** Draw a stronger "major" line every N cells for visual rhythm. */
export const MAJOR_GRID_EVERY = 5;

/**
 * Once on-screen cell spacing drops below this many pixels the minor grid is
 * hidden to keep rendering cheap and avoid moiré when zoomed far out.
 */
export const MIN_VISIBLE_SPACING = 6;

/**
 * The CPlane, shared by BOTH editor modes: the grid drawn as a whisper. It keeps a sense of scale and
 * alignment under the drawing without competing with it, on a pure-white composing surface. Plan mode used
 * to carry a heavier, off-white variant of its own; one theme now means the canvas reads the same on either
 * side of a mode switch instead of the background shifting under the user.
 */
export const GRID_THEME: GridTheme = {
  background: '#ffffff',
  minorLine: 'rgba(15, 23, 42, 0.02)',
  majorLine: 'rgba(15, 23, 42, 0.045)',
  axisLine: 'rgba(15, 23, 42, 0.10)',
  border: 'rgba(15, 23, 42, 0.07)',
};

/**
 * Dimension-line offset (screen px) from a facade BORDER's edge. Matches the room/footprint gap: the trim
 * has no wall band to clear, but it does carry the edge-midpoint "+" duplicate buttons (EDGE_PLUS_OFFSET,
 * 16px out) and the corner rotation arcs (half this gap), so the spines have to sit beyond both. The old
 * hug-the-edge value predated those handles and ran straight through them. Used for both drawing and the
 * editable-label hit-test, so they stay in sync.
 */
export const BORDER_DIM_GAP = 36;

/** A freshly placed square spans this many screen pixels, regardless of zoom. */
export const DEFAULT_SQUARE_SCREEN_SIZE = 120;

/**
 * World-pixels per foot — the drawing's real-world scale. At the home view the
 * 120-world-unit default square therefore measures 12 ft on each side (12 × 12
 * = 144 ft²). Area readouts derive feet from world units via this factor.
 */
export const WORLD_UNITS_PER_FOOT = 10;

/** Exact feet-per-metre, so a length has the same physical size in either unit. */
export const FEET_PER_METER = 3.280839895;

/** World-pixels per metre, derived so 1 m renders 3.2808× a foot. */
export const WORLD_UNITS_PER_METER = WORLD_UNITS_PER_FOOT * FEET_PER_METER;

/** World-pixels per centimetre (1/100 of a metre). */
export const WORLD_UNITS_PER_CENTIMETER = WORLD_UNITS_PER_METER / 100;

/** World-pixels per one unit of the active measurement system. */
export function worldUnitsPerUnit(unit: LengthUnit): number {
  if (unit === 'meters') return WORLD_UNITS_PER_METER;
  if (unit === 'centimeters') return WORLD_UNITS_PER_CENTIMETER;
  return WORLD_UNITS_PER_FOOT;
}

/**
 * Wall thickness drawn around each room, in feet (6 inches). The band is offset
 * to the OUTSIDE of the shape, so the white interior keeps its true dimensions
 * (a default room stays 12×12 ft) and the outer footprint measures
 * 6" + 12' + 6" per side.
 */
export const WALL_THICKNESS_FEET = 0.5;

/** Default wall thickness in world units (6"). Starting value for every side. */
export const DEFAULT_WALL_WORLD = WALL_THICKNESS_FEET * WORLD_UNITS_PER_FOOT;

/** Walls can never be dragged thinner than this (1"), in world units. */
export const MIN_WALL_WORLD = (1 / 12) * WORLD_UNITS_PER_FOOT;

/**
 * Area-readout label: a constant on-screen size (matching the Space tooltip,
 * 15px) that does not scale with zoom. The fade keys off the shape's on-screen
 * short side instead, so the label hides on shapes that are too small to read.
 */
export const AREA_LABEL_FONT_PX = 15;
export const AREA_LABEL_FADE_START = 28; // shape short-side px below which hidden
export const AREA_LABEL_FADE_END = 56; // shape short-side px at/above which fully opaque

/** A square can never be resized smaller than this on screen. */
export const MIN_SHAPE_SCREEN_SIZE = 16;

/** Perpendicular grab tolerance for stretching anywhere along an edge (px). */
export const EDGE_HIT_TOLERANCE = 6;

/** Rotation snaps to this increment, in degrees (24 stops over a full turn). */
export const ROTATION_SNAP_DEG = 15;

/** Half-size of the square zone that activates rotation at a corner, in px. */
export const ROTATION_CORNER_RADIUS = 15;

/**
 * Outward nudge (px) of each rotation zone along its corner's bisector, so the
 * zone sits over the corner rotation arc rather than on the bare corner —
 * keeping the arc symbol, angle readout, and grabbable area cohesive. (≈10px per
 * axis on a right-angled corner.)
 */
export const ROTATION_CORNER_OFFSET = 14;

// Curved double-headed arrow, white halo over black, hotspot at its centre.
const ROTATE_CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
  '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 9.5A8 8 0 1 0 22.3 14.5" stroke="white" stroke-width="5"/>' +
  '<path d="M21.2 3.8 21.4 9.6 15.6 9.2" stroke="white" stroke-width="5"/>' +
  '<path d="M21 9.5A8 8 0 1 0 22.3 14.5" stroke="black" stroke-width="2.2"/>' +
  '<path d="M21.2 3.8 21.4 9.6 15.6 9.2" stroke="black" stroke-width="2.2"/>' +
  '</g></svg>';

/** Cursor signalling rotation, shown over a selected shape's corners. */
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  ROTATE_CURSOR_SVG,
)}") 14 14, auto`;

/**
 * Overlap visual cues — groundwork for boolean operations (not the ops
 * themselves). Where two rooms overlap, the grey wall lightens by this fraction
 * toward white (the shared-infill and wall-in-both sub-regions use debug colours
 * for now). NO transparency is introduced, so the per-pixel fill path stays
 * fully opaque.
 */
export const OVERLAP_WALL_LIGHTEN = 0.28; // mix the wall 28% toward white

// Fully opaque colors — no alpha blending on the per-pixel fill path.
export const SHAPE_THEME: ShapeTheme = {
  fill: '#ffffff',
  // Darkened interior shown when the white infill is the selected (move) region.
  selectedFill: '#e4e4e7',
  // Darker neutral grey wall; the selected edge is a darker grey still (not black).
  stroke: '#71717a',
  selectedStroke: '#3f3f46',
  edgeHover: '#ff00ff',
  label: '#18181b',
};

// Transient rubber-band selection rectangle (only drawn while dragging).
export const MARQUEE_FILL = 'rgba(37, 99, 235, 0.08)';
export const MARQUEE_STROKE = 'rgba(37, 99, 235, 0.7)';
