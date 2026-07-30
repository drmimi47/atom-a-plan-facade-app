/**
 * Which render layer(s) a redraw request affects. The grid is static during
 * shape edits, so most interactions only dirty the 'scene' layer.
 */
export type DrawLayer = 'grid' | 'scene' | 'all';

/** Website-wide measurement unit for dimensions and area readouts. */
export type LengthUnit = 'feet' | 'meters' | 'centimeters';

/** Viewport transform for the infinite canvas. */
export interface Camera {
  /** Horizontal pan offset in CSS pixels (screen space). */
  x: number;
  /** Vertical pan offset in CSS pixels (screen space). */
  y: number;
  /** Zoom factor. 1 = 100%. */
  scale: number;
}

/**
 * A square armed for placement: a preview that follows the cursor (in
 * canvas-local screen pixels) and is not committed until the user clicks.
 */
export interface PendingPlacement {
  sx: number;
  sy: number;
  /**
   * Interior square size in WORLD units. Set from the radial menu's highlighted
   * room type; when absent the preview falls back to the default on-screen size.
   */
  worldSize?: number;
  /** Room title to inherit on commit; when absent the shape is named "Room". */
  name?: string;
  /**
   * A saved Library cluster being placed: its shapes normalised so the cluster's
   * outer bounding box is centred on the world origin. When set, the preview draws
   * the whole arrangement (at the current zoom) and commit drops a fresh, re-id'd
   * copy centred on the cursor — overriding the single-square placement above.
   */
  clusterShapes?: Square[];
  /**
   * Wall-snapped world centre for the single-square preview, set by the draw layer
   * when alignment snapping engages. Commit uses it so the placed room lands snapped.
   */
  snapCenter?: { x: number; y: number };
}

/** A rubber-band selection rectangle, in canvas-local screen pixels. */
export interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Per-side wall thickness, in world units, each offset outward from the rect. */
export interface Walls {
  n: number;
  e: number;
  s: number;
  w: number;
}

/** A rectangular "space" placed on the canvas, in world units. */
export interface Square {
  id: string;
  /** Top-left corner of the un-rotated rect, in world coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation about the centre, in degrees (clockwise), snapped to 15°. */
  rotation: number;
  /** Outward wall thickness per side; the interior (x/y/width/height) is the room. */
  walls: Walls;
  /** Whether the four inner-vertex dots are shown (toggled by double-click). */
  dots: boolean;
  /**
   * Optional free-form interior corners, in the shape's LOCAL frame (centre-origin,
   * pre-rotation, world units), ordered [nw, ne, se, sw]. When present the room is
   * this quadrilateral rather than the axis-aligned rect; x/y/width/height track its
   * local bounding box. Absent ⇒ a plain rectangle (the default).
   */
  corners?: { x: number; y: number }[];
  /**
   * Per-edge wall thickness (world units), one entry per interior edge (edge `i`
   * runs corner `i`→`i+1`). Set on free polygons — chiefly boolean (N-gon) results —
   * so each wall can be thickened independently; a plain rect/quad leaves this unset
   * and uses {@link Walls} (n/e/s/w). Always kept the same length as `corners`.
   */
  wallEdges?: number[];
  /**
   * Display title shown above the area readout (e.g. "Patient Room"). Defaults
   * to "Room" for a plain square; inherited from the radial menu when dragged
   * from a room segment.
   */
  name?: string;
  /**
   * When true, the room's interior square footage is locked: edge/vertex edits
   * scale the whole shape about its centroid to preserve the area. Toggled by the
   * little lock icon under the ft² readout (shown only while dimensions are).
   */
  areaLocked?: boolean;
}

/**
 * A building footprint: an axis-aligned rectangle (world units) drawn with a black
 * outline and white infill BEHIND every room, so shapes/dimensions sit on top of it.
 * No walls or rotation — it's the gross building boundary, drawn by the Generate
 * tool menu's square tool and resizable via its own Length/Width dimension labels.
 */
export interface Footprint {
  id: string;
  /** Top-left corner, in world coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Live canvas statistics surfaced to the bottom StatsBar (all areas in ft²). */
export interface CanvasStats {
  roomCount: number;
  /**
   * Number of things currently flagged (yellow) for violating a constraint: rooms in Plan mode, facade
   * panels in Facade mode. The two rule sets are mode-scoped and never both active, so one counter serves
   * both — it is always "how many units the ACTIVE mode's rules flag".
   */
  constraintFlags: number;
  /** Sum of every room's interior (white infill) area — Gross Internal Area (GIA). */
  totalAreaSqft: number;
  /** Sum of every room's outer footprint (infill + wall band) — Gross Floor Area (GFA). */
  grossAreaSqft: number;
  /**
   * Usable Floor Area (UFA): sum of interior area of usable rooms only (excludes the
   * circulation/service types in NON_USABLE_ROOM_KEYS). Always ≤ totalAreaSqft (GIA).
   */
  usableAreaSqft: number;
  /**
   * True when the summed interior area exceeds the global Max Total Area constraint —
   * drives the full-canvas yellow wash until rooms are deleted back under budget.
   */
  totalAreaExceeded: boolean;
  /** True when the summed GROSS area exceeds the global Max Total Gross Area constraint. */
  grossAreaExceeded: boolean;
  /** True when the room count exceeds the global Max Room Count constraint. */
  roomCountExceeded: boolean;
  /**
   * Facade mode: true when a whole-elevation facade rule is breached (WWR, U-value, standardization,
   * type/panel count, cost). Those describe the facade as a whole rather than one panel, so — like the
   * plan-mode budgets above — they wash the canvas instead of flagging a unit. Always false in Plan mode.
   */
  facadeGlobalExceeded: boolean;
  /**
   * Names of the constraint fields currently being violated anywhere on the canvas — per-unit rules
   * unioned across every room/panel, plus the breached global budgets. Lets the Constraints box highlight
   * the exact lines whose rules are in effect and broken. Each entry is a `keyof Constraints` in Plan mode
   * and a `keyof FacadeConstraints` in Facade mode (the box is showing that mode's rules either way).
   */
  violatedKeys: string[];
}

/** Colors used when rendering placed squares and their selection handles. */
export interface ShapeTheme {
  fill: string;
  /** Interior fill when the white infill itself is selected (move target). */
  selectedFill: string;
  stroke: string;
  selectedStroke: string;
  /** Highlight on the inner & outer faces of a selected edge when hovered. */
  edgeHover: string;
  /** Colour of the centred square-footage readout. */
  label: string;
}

/** Colors used when rendering the grid. */
export interface GridTheme {
  background: string;
  minorLine: string;
  majorLine: string;
  /** Lines passing through the world origin (0,0). */
  axisLine: string;
  /** Outline of the finite grid square (the CPlane boundary). */
  border: string;
}
