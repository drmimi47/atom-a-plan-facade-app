import type { CanvasHandle } from '../components/InfiniteCanvas/InfiniteCanvas';
import { PROMPT_EXAMPLES } from '../components/NavBar/NavBar';
import type { Mode } from '../components/TopBar/TopBar';
import { DEFAULT_SQUARE_SCREEN_SIZE, DEFAULT_WALL_WORLD } from '../constants';
import type { Rect } from '../facade/partition';
import { DemoDriver } from './demoDriver';

/**
 * Everything a demo step is allowed to touch. The script drives the REAL app — the same imperative canvas
 * handle, the same App state setters, and (through the driver) genuine clicks on the actual buttons — so
 * what the tour shows is what the user gets. Nothing here is a mock.
 */
/**
 * The view a step leaves the app in — everything the tour's switches touch that is React state rather than
 * canvas state. Snapshotted alongside the canvas so stepping BACK restores the whole picture, not half of it.
 */
export interface DemoView {
  mode: Mode;
  layers: boolean;
  idView: boolean;
  panelNumbers: boolean;
  frameShadow: boolean;
  stats: boolean;
  /** Whether the yellow constraint flags are being drawn — the subject of half the Plan tour. */
  highlights: boolean;
  panel: 'constraints' | 'prompt' | 'library' | null;
}

export interface DemoContext {
  canvas: CanvasHandle | null;
  /** Animates the cursor and clicks real controls. */
  ui: DemoDriver;
  /**
   * LIVE editor mode. A function, not a value: the context is snapshotted when a step begins, so a plain
   * field would go stale the moment the step switched modes — and `gotoMode` would then press the pill a
   * second time and toggle straight back. Reading through a ref keeps it honest mid-step.
   */
  getMode: () => Mode;
  setMode: (m: Mode) => void;
  setLayersActive: (on: boolean) => void;
  setIdView: (on: boolean) => void;
  setPanelNumbers: (on: boolean) => void;
  setFrameShadow: (on: boolean) => void;
  setStatsVisible: (on: boolean) => void;
  /**
   * Show/hide the yellow constraint flags. The Plan tour asserts these ON: a step that breaks a rule on
   * purpose and then fixes it has nothing to show if the user had switched the flags off before starting.
   */
  setConstraintHighlights: (on: boolean) => void;
  openPanel: (panel: 'constraints' | 'prompt' | 'library' | null) => void;
  /** Live read of {@link DemoView} — the state a step ended in, captured once it finishes. */
  getView: () => DemoView;
  /** Viewport point for a world coordinate, so the cursor can point at what the canvas is doing. */
  toScreen: (world: { x: number; y: number }) => { x: number; y: number };
  /** Carried between steps: the world rect a step built, and how far the scene has been taken. */
  scene: { rect: Rect | null; stage: number };
}

export interface DemoStep {
  title: string;
  body: string;
  /** Optional call to action, when the step hands the gesture to the user. */
  tryIt?: string;
  /**
   * Put the app into this step's state, animating the cursor through the controls it uses.
   *
   * Async and IDEMPOTENT: the user can jump to any step at any time, so each one rebuilds the world it
   * needs rather than assuming the step before it ran. Awaiting is also what keeps React's asynchronous
   * state updates ordered against the canvas's immediate ones.
   */
  run?: (ctx: DemoContext) => Promise<void>;
}

/**
 * The tour BUILDS in screen pixels and FRAMES in world coordinates.
 *
 * The cube drops a shape sized in screen pixels, so the only zoom-independent way to aim the drags that
 * follow is to aim them in pixels too — every gesture below is therefore pixel-aimed, against a screen box
 * read back through {@link screenBox} rather than predicted. The camera then moves only between steps, to
 * put the subject of the next one in the middle of the viewport at a size worth looking at.
 */
const SHAPE_W_PX = 380;
const SHAPE_H_PX = 220;
/** Pixels the NE corner is pulled in, angling the right edge. */
const CUT_X_PX = 120;
/** Pixels the SW corner is pulled up, angling the bottom edge. */
const CUT_Y_PX = 60;
const SPLIT_COLS = 6;
const SPLIT_ROWS = 3;
/** Least the Edit step lifts a bottom rail by, in screen pixels — below this the parametric change is invisible. */
const MIN_RAIL_LIFT_PX = 14;

/**
 * Where the cube is dropped: the point that leaves the FINISHED elevation centred on the viewport, which
 * (the camera having just been reset to the world origin) is the centre of the grid.
 *
 * The drop lands a {@link DEFAULT_SQUARE_SCREEN_SIZE} square centred on the cursor and {@link shapeIt} then
 * grows it right and down only, so the shape's centre ends up half a default square up-left of the finished
 * middle. Backing that out is what puts the elevation on the origin instead of hanging off it.
 */
const LAYOUT = {
  shape: () => ({
    x: window.innerWidth / 2 - SHAPE_W_PX / 2 + DEFAULT_SQUARE_SCREEN_SIZE / 2,
    y: window.innerHeight / 2 - SHAPE_H_PX / 2 + DEFAULT_SQUARE_SCREEN_SIZE / 2,
  }),
};

/** Room left above a framed subject for the dimension strings the canvas draws over its top edge. */
const DIMENSION_HEADROOM = 46;

/**
 * Screen margins the camera framing keeps clear, per side. The viewport is not empty: the tour card is
 * docked top-centre, the Layers panel top-right, the nav pill bottom-centre — and the floating panel bar
 * hangs UNDER whatever is selected, so the bottom margin has to hold the bar plus the pill beneath it or
 * the elevation pushes its own toolbar off the screen. Fractions cap each one on a small window.
 *
 * The top is MEASURED off the card rather than guessed: it is a real element in the same viewport, and its
 * height moves with the length of the step's copy and the width of the window. Guessing it left the
 * dimension strings tucked under the card on the steps whose text ran an extra line.
 */
function frameInsets() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const card = document.querySelector('[data-demo="tour-card"]')?.getBoundingClientRect();
  return {
    // Falls back to the pill row when the card is somehow not up yet.
    top: Math.min((card?.bottom ?? 56) + DIMENSION_HEADROOM, h * 0.36),
    right: Math.min(332, w * 0.24), // the right-docked Layers panel (300px + margins)
    bottom: Math.min(196, h * 0.26), // floating bar (~44) + the nav pill under it
    left: Math.min(180, w * 0.14), // margin only, but wide enough to balance the panel on the right
  };
}

/** How much of that free box the subject fills. Short of 1 so it sits IN the view rather than against it. */
const FRAME_FILL = 0.94;

/**
 * The boolean aside is built in empty world space BELOW the elevation, never on top of it — so the shape
 * the tour has already formed survives the step untouched. The strip is wider than the elevation because
 * the example squares drop at a fixed SCREEN size: a wider world strip is framed at a smaller zoom, which
 * buys them room without shrinking the elevation above them any further.
 *
 * The Plan tour uses the same strip for the same reason: rooms generated from a prompt are laid out on the
 * CURRENT view centre, so framing this before typing is what keeps the new row off the work already built.
 */
const BAY = { gap: 0.25, height: 1.0, width: 1.6 };

/** The staging strip's world rect, given the work above it. */
function bayRect(r: Rect): Rect {
  return {
    x: r.x - (r.w * (BAY.width - 1)) / 2,
    y: r.y + r.h * (1 + BAY.gap),
    w: r.w * BAY.width,
    h: r.h * BAY.height,
  };
}

/**
 * How far the facade scene has been carried.
 *
 * The tour is CUMULATIVE: walking it forwards, each step inherits the shape the previous one left and
 * only adds its own move — framing panels and then switching Frame Shadow on has to act on the same
 * mullions, not on a rebuilt copy of them. The stage is what makes that safe to rely on, because the
 * progress dots also let the user land on any step out of order; see {@link atStage}.
 */
const STAGE = {
  EMPTY: 0,
  DROPPED: 1,
  SHAPED: 2,
  BOOLEAN: 3,
  SPLIT: 4,
  ADJUSTED: 5,
  RATIONALIZED: 6,
  FRAMED: 7,
  CLAD: 8,
} as const;
type Stage = (typeof STAGE)[keyof typeof STAGE];

/** Switch editor mode through the REAL Mode pill, then wait for the workspace swap to land. */
async function gotoMode(ctx: DemoContext, want: Mode): Promise<void> {
  if (ctx.getMode() === want) return;
  await ctx.ui.press('mode', 120); // there are two modes, so one press toggles
  ctx.setMode(want); // assert the destination in case the pill gains a third mode later
  // The mode swap stashes one workspace and restores the other in an effect. Anything written to the
  // canvas before that lands would be thrown away by it — so the wait here is correctness, not pacing.
  await ctx.ui.settle(3);
}

/** Reset the view switches so a step's state is exactly what it declares, however the user arrived. */
function plainView(ctx: DemoContext) {
  ctx.setIdView(false);
  ctx.setPanelNumbers(false);
  ctx.setFrameShadow(false);
}

/** The Optimize menu's order, mirroring CellSplitMenu's STRATEGIES so the walk down the list matches it. */
const OPTIMIZE_ORDER = ['edge-normalize', 'edge-profile', 'stepped-edge', 'modular-cluster'] as const;
/**
 * The one the tour commits: Perimeter Trim. Unlike Snap to Grid (a one-shot nudge of the outline) it is a
 * MODE the border stays in — every panel is kept a whole rectangle and the diagonal is absorbed into one
 * continuous trim band, which is the answer the cut corners were set up to ask for.
 */
const OPTIMIZE_PICK = 'edge-profile';

/** Screen-space box of a world rect. Every gesture below is aimed in pixels; see {@link SHAPE_W_PX}. */
function screenBox(ctx: DemoContext, r: Rect): { x: number; y: number; w: number; h: number } {
  const a = ctx.toScreen({ x: r.x, y: r.y });
  const b = ctx.toScreen({ x: r.x + r.w, y: r.y + r.h });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/**
 * Empty Facade workspace, camera back on the world origin at 100%.
 *
 * The camera reset is what makes the tour repeatable: everything below is built from a fixed-SIZE screen
 * drop, so the world size of the elevation is decided by the zoom at that moment. Rebuilding from a
 * zoomed-in step without this would produce a smaller shape every time.
 */
async function freshCanvas(ctx: DemoContext): Promise<void> {
  await gotoMode(ctx, 'Facade');
  ctx.canvas?.resetForDemo();
  ctx.scene.rect = null;
  ctx.scene.stage = STAGE.EMPTY;
  await ctx.ui.settle(2);
}

/**
 * Ease the camera onto a world rect and WAIT for it — every gesture after this is aimed through it.
 *
 * A step being skipped to its end lands the camera in one frame instead, so the wait has nothing left to
 * wait for: the aim stays correct and the skip stays instant.
 */
async function frameOn(ctx: DemoContext, rect: Rect): Promise<void> {
  const instant = ctx.ui.fast;
  ctx.canvas?.focusWorldRect(rect, { insets: frameInsets(), fill: FRAME_FILL, instant });
  if (!instant) await ctx.ui.hold(300); // the camera tween runs 250ms; aiming mid-flight would miss
  await ctx.ui.settle(2);
}

/**
 * Drag the cube out onto the canvas — the real way a shape gets created.
 *
 * The size that lands is decided by the camera (the cube drops a fixed SCREEN square), so the world rect
 * is read back off the canvas rather than assumed.
 */
async function dropShape(ctx: DemoContext): Promise<Rect | null> {
  await ctx.ui.dragFrom('cube', LAYOUT.shape());
  await ctx.ui.settle(2);
  const rect = ctx.canvas?.demoBorderRect() ?? null;
  ctx.scene.rect = rect;
  ctx.scene.stage = rect ? STAGE.DROPPED : STAGE.EMPTY;
  return rect;
}

/**
 * Stretch the dropped square out to the elevation and cut two corners off it — edge drags then corner
 * drags, exactly the handles a user grabs. Each gesture re-reads the boundary instead of predicting it,
 * because the drags snap to the grid and would otherwise accumulate drift into the next grab point.
 */
async function shapeIt(ctx: DemoContext): Promise<Rect | null> {
  const box = () => {
    const r = ctx.canvas?.demoBorderRect();
    return r ? { r, s: screenBox(ctx, r) } : null;
  };
  let b = box();
  if (!b) return null;
  const left = b.s.x;
  const top = b.s.y;

  // Right edge outward, grabbed at its midpoint so the corner handles don't win the hit test.
  await ctx.ui.canvasDrag(
    { x: b.s.x + b.s.w, y: b.s.y + b.s.h / 2 },
    { x: left + SHAPE_W_PX, y: b.s.y + b.s.h / 2 },
  );
  b = box() ?? b;

  // Bottom edge down.
  await ctx.ui.canvasDrag(
    { x: b.s.x + b.s.w / 2, y: b.s.y + b.s.h },
    { x: b.s.x + b.s.w / 2, y: top + SHAPE_H_PX },
  );
  b = box() ?? b;

  // NE corner in along x -> the right edge runs at a diagonal.
  await ctx.ui.canvasDrag(
    { x: b.s.x + b.s.w, y: b.s.y },
    { x: b.s.x + b.s.w - CUT_X_PX, y: b.s.y },
  );
  b = box() ?? b;

  // SW corner up along y -> the bottom edge runs at a diagonal too.
  await ctx.ui.canvasDrag(
    { x: b.s.x, y: b.s.y + b.s.h },
    { x: b.s.x, y: b.s.y + b.s.h - CUT_Y_PX },
  );

  const rect = ctx.canvas?.demoBorderRect() ?? null;
  ctx.scene.rect = rect;
  if (rect) ctx.scene.stage = STAGE.SHAPED;
  await ctx.ui.settle(2);
  // Now that the shape exists, go and look at it: the elevation is the subject of every step that follows,
  // and it was built at whatever size the drop happened to be. Framing it here means each later step
  // inherits a camera already on the work instead of having to move it back.
  if (rect) await frameOn(ctx, rect);
  return rect;
}

/**
 * Both booleans, each on its OWN fresh pair of squares, in the empty bay under the elevation.
 *
 * There are no combine buttons: arm exactly two borders, then WHERE you click decides the operation — the
 * shared interior unites them, a boundary running through that interior subtracts. Two independent pairs
 * rather than one: subtracting from the shape the union just produced reads as an afterthought to the
 * union, and it hands the difference a polygon whose overlapping collinear edges were already fused once.
 *
 * All four squares land at the fixed screen size the cube drops, so every offset here is a fraction of
 * that size and the arrangement holds at any zoom.
 */
async function booleanDemo(ctx: DemoContext, elevation: Rect): Promise<void> {
  const bay = bayRect(elevation);
  // Pull back to hold the elevation AND the bay under it: the aside happens beside the work, not instead
  // of it, and the shapes below land in genuinely empty space so nothing here can touch the elevation.
  await frameOn(ctx, { ...bay, y: elevation.y, h: bay.y + bay.h - elevation.y });

  const s = screenBox(ctx, bay);
  const H = DEFAULT_SQUARE_SCREEN_SIZE / 2; // half a dropped square — the unit every offset below is in
  const cy = s.y + s.h / 2;
  // The two pairs sit either side of the bay's centre, far enough apart never to overlap each other.
  const spread = Math.max(2.5 * H, Math.min(s.w * 0.23, 4.3 * H));
  const unite = s.x + s.w / 2 - spread;
  const cut = s.x + s.w / 2 + spread;

  /* ---- UNITE: two squares STAGGERED on both axes, meeting corner to corner.
     The stagger is what makes the union work and what makes it worth watching. Squares offset along one
     axis only share two collinear edges, which is the degenerate case for a polygon clipper — and even
     when it survives, merging them just yields a wider rectangle, which doesn't look like a boolean at
     all. Offset on both axes they merge into a stepped L, and every edge of the result is one you can
     point at and trace back to one of the two shapes. ---- */
  await ctx.ui.dragFrom('cube', { x: unite - H / 2, y: cy - 0.4 * H });
  await ctx.ui.dragFrom('cube', { x: unite + H / 2, y: cy + 0.4 * H });
  // Arm the pair: a plain click picks one, Shift adds the second. A boolean needs exactly two. Each click
  // goes to the part of a square the other does NOT cover — clicking either centre would land inside both,
  // hit whichever is on top, and the Shift-click would then toggle that same one back off.
  await ctx.ui.canvasClick({ x: unite - H, y: cy - H });
  await ctx.ui.canvasClick({ x: unite + H, y: cy + H }, { shift: true });
  // The middle of the shared corner region — half a square clear of either outline, so it can only
  // mean UNITE.
  await ctx.ui.canvasClick({ x: unite, y: cy }, {}, 650);

  /* ---- SUBTRACT: two more, offset on BOTH axes so they meet at a corner. A corner overlap leaves a
     notch you can see; squares offset along one axis only would just make the survivor shorter. ---- */
  const keep = { x: cut - H / 2, y: cy + 0.4 * H }; // the one that gets bitten
  const tool = { x: cut + H / 2, y: cy - 0.4 * H }; // the one doing the biting
  await ctx.ui.dragFrom('cube', keep);
  await ctx.ui.dragFrom('cube', tool);
  await ctx.ui.canvasClick({ x: cut - H, y: cy + H }); // deep in `keep`, clear of `tool`
  await ctx.ui.canvasClick({ x: cut + H, y: cy - H }, { shift: true }); // ...and vice versa
  // ON `keep`'s own top edge, inside `tool` → subtract `tool` FROM `keep` (clicking a shape's edge trims
  // that shape). The pick order above is what decides which of the two survives.
  await ctx.ui.canvasClick({ x: cut, y: cy - 0.6 * H }, {}, 650);

  // Pull the cutter clear: the bite is hidden underneath it until it moves.
  await ctx.ui.canvasDrag({ x: cut + H, y: cy - H }, { x: cut + 3.2 * H, y: cy - H });
  ctx.scene.stage = STAGE.BOOLEAN;
}

/** Double-click into a shape, so the pointer edits its panels and the floating bar appears. */
async function openShape(ctx: DemoContext, rect: Rect): Promise<void> {
  await ctx.ui.canvasDoubleClick(centreOf(ctx, rect));
}

/** Dial the bar's steppers up from their 2 x 2 default and split. */
async function splitIt(ctx: DemoContext): Promise<void> {
  for (let i = 0; i < SPLIT_COLS - 2; i++) await ctx.ui.press('spin-cols-up', 60);
  for (let i = 0; i < SPLIT_ROWS - 2; i++) await ctx.ui.press('spin-rows-up', 60);
  await ctx.ui.wait(200);
  await ctx.ui.press('bar-split', 480);
  // Only claim the stage if a lattice actually appeared. Every step after this aims at mullions, and a
  // stage claimed on a split that didn't happen would send them all at panels that don't exist — better
  // for the next step to notice the shortfall and rebuild.
  if (ctx.canvas?.demoGridLines()) ctx.scene.stage = STAGE.SPLIT;
}

/** An index safely INSIDE a line list — never an outer edge, which is the boundary rather than a mullion. */
function innerLine(count: number, frac: number): number {
  return Math.max(1, Math.min(count - 2, Math.round((count - 1) * frac)));
}

/**
 * The middle of a cell that line `avoid` does not bound — where a grab along the other axis is unambiguous,
 * and where the raw-pitch cell lookup behind the segment hit test is still exact.
 */
function midCellAway(lines: number[], avoid: number): number {
  const cell = avoid >= 2 ? avoid - 2 : Math.min(avoid + 1, lines.length - 2);
  return (lines[cell] + lines[cell + 1]) / 2;
}

/**
 * Move the lattice the split just laid down: a whole column, a whole row, then ONE segment on its own.
 *
 * Grab points are read back from the live lattice every time rather than derived from `SPLIT_COLS × ROWS`,
 * because each drag writes a per-line override and the next grab would otherwise aim at where the mullion
 * used to be. Two rules decide where they go:
 *
 *  • A whole-line grab sits at the MIDDLE OF A CELL along the other axis, so the perpendicular lines are
 *    half a bay away and can't win the hit test.
 *  • The Shift-jog goes on a line neither drag has touched. The segment hit test locates its cell from the
 *    lattice's raw pitch, so it is only exact where no override has displaced the line.
 *
 * Everything is aimed near the middle of the elevation, well clear of the two cut corners.
 */
async function adjustGrid(ctx: DemoContext): Promise<void> {
  const lines = () => ctx.canvas?.demoGridLines() ?? null;
  let g = lines();
  if (!g || g.x.length < 4 || g.y.length < 4) return;

  const vi = innerLine(g.x.length, 0.5); // the column line to slide
  const hj = innerLine(g.y.length, 0.5); // the row line to slide
  const si = vi >= 2 ? vi - 1 : vi + 1; // the column whose SEGMENT is jogged — never the one moved above
  const pitchX = g.x[1] - g.x[0];
  const pitchY = g.y[1] - g.y[0];

  // A whole COLUMN of mullions, dragged sideways — every panel either side of it reflows.
  const vGrabY = midCellAway(g.y, hj);
  await ctx.ui.canvasDrag(
    ctx.toScreen({ x: g.x[vi], y: vGrabY }),
    ctx.toScreen({ x: g.x[vi] + pitchX * 0.34, y: vGrabY }),
  );

  // ...then a whole ROW, dragged down. Re-read first: the column above now carries an override.
  g = lines();
  if (!g) return;
  const hGrabX = midCellAway(g.x, vi);
  await ctx.ui.canvasDrag(
    ctx.toScreen({ x: hGrabX, y: g.y[hj] }),
    ctx.toScreen({ x: hGrabX, y: g.y[hj] + pitchY * 0.3 }),
  );

  // Shift → the same grab takes ONE SEGMENT instead of the whole line: a single bay widens and the
  // mullions above and below it stay exactly where they are.
  g = lines();
  if (!g) return;
  const segY = midCellAway(g.y, hj);
  await ctx.ui.canvasDrag(
    ctx.toScreen({ x: g.x[si], y: segY }),
    ctx.toScreen({ x: g.x[si] - pitchX * 0.36, y: segY }),
    { shift: true },
  );
  await ctx.ui.wait(400);
  ctx.scene.stage = STAGE.ADJUSTED;
}

/** Preview every Optimize option in turn, then commit {@link OPTIMIZE_PICK}. */
async function rationalize(ctx: DemoContext, dwell: number): Promise<void> {
  await ctx.ui.press('bar-optimize', 200);
  // Walk the whole list first — each hover is the real preview, so the comparison IS the step.
  for (const id of OPTIMIZE_ORDER) await ctx.ui.hover(`opt-${id}`, dwell);
  // ...then go back up the list to the one being chosen and commit it.
  await ctx.ui.hover(`opt-${OPTIMIZE_PICK}`, Math.min(dwell, 420));
  await ctx.ui.press(`opt-${OPTIMIZE_PICK}`, 480);
  ctx.scene.stage = STAGE.RATIONALIZED;
}

/* -------------------------------------------------------------------------- */
/*  Painting panels                                                            */
/* -------------------------------------------------------------------------- */

type Lattice = { x: number[]; y: number[] };

/** World centre of cell (i, j). */
function cellCentre(g: Lattice, i: number, j: number): { x: number; y: number } {
  return { x: (g.x[i] + g.x[i + 1]) / 2, y: (g.y[j] + g.y[j + 1]) / 2 };
}

/** A rectangular block of cells, inclusive on both ends. */
interface Block {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

/**
 * A block as ONE serpentine path: across the first row, down a bay, back across the second, and so on.
 *
 * The brush adds whatever the stroke's path crosses, so a region does not need a stroke per row — sweeping
 * back and forth is how one is really picked up, and it covers the same cells in a single gesture. Two
 * details make it exact rather than approximate:
 *
 *  • Every turn lands on a cell CENTRE, so the horizontal legs run down the middle of a row and cover it
 *    end to end. A diagonal corner-to-corner sweep would clip the cells it passed instead of covering them.
 *  • The vertical legs join the ends of consecutive rows, so they only ever cross cells inside the block.
 *
 * Only the FIRST point has to clear the mullions (the grab is arbitrated on pointerdown alone), and a cell
 * centre is half a bay from the nearest line — after that the stroke crosses grid lines freely.
 */
function serpentine(g: Lattice, b: Block): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  for (let j = b.j0; j <= b.j1; j++) {
    const rightward = (j - b.j0) % 2 === 0;
    const from = rightward ? b.i0 : b.i1;
    const to = rightward ? b.i1 : b.i0;
    path.push(cellCentre(g, from, j), cellCentre(g, to, j));
  }
  // A one-cell block would collapse to a path of no length, and a press that never travels is not a stroke
  // at all — the canvas reads it as a click, which means something else entirely (take the whole material
  // group). Give it a short sweep across the middle of that one cell instead.
  if (path.length === 2 && path[0].x === path[1].x && path[0].y === path[1].y) {
    const w = g.x[b.i0 + 1] - g.x[b.i0];
    path[0] = { x: path[0].x - w * 0.2, y: path[0].y };
    path[1] = { x: path[1].x + w * 0.2, y: path[1].y };
  }
  return path;
}

/**
 * Paint-select blocks, one continuous serpentine stroke each.
 *
 * The first stroke replaces the selection and the rest hold Shift to add to it — which is what lets the
 * selection be a composition rather than a single band.
 */
async function paintBlocks(ctx: DemoContext, g: Lattice, blocks: Block[]): Promise<void> {
  for (let k = 0; k < blocks.length; k++) {
    await ctx.ui.canvasStroke(serpentine(g, blocks[k]).map((p) => ctx.toScreen(p)), { shift: k > 0 });
  }
}

/**
 * The composition the tour picks out of the grid: a wide MASS filling the left of the elevation, and a
 * narrower WING carrying on to the right of it. Two solid blocks, each several cells across and every row
 * deep — the point of the step is a piece of facade, and a one-cell-wide run reads as a diagram of the
 * gesture instead of a design.
 *
 * Expressed in fractions of the grid rather than fixed indices so it survives a different split — and the
 * split is not the one the tour asked for: the bar sizes panels to the assembly, so 6 × 3 on a 38′ × 22′
 * elevation comes back as a far finer lattice. Held back from the right and bottom edges, which is where the
 * two cut corners have already eaten into the cells (Perimeter Trim then drops what the boundary crosses, so
 * the strokes below simply find nothing there).
 */
function facadeBlocks(g: Lattice): { mass: Block; wing: Block; bare: { i: number; j: number } } {
  const cols = g.x.length - 1;
  const rows = g.y.length - 1;
  // A column and a row in from the right and bottom edges: those are the two corners the elevation was
  // cut at, so the cells beyond them are ones the boundary has clipped away or reduced to slivers.
  const lastCol = Math.max(1, cols - 2);
  const lastRow = Math.max(0, rows - 2);
  const split = Math.max(1, Math.min(lastCol - 1, Math.floor(cols * 0.45)));
  return {
    mass: { i0: 0, i1: split, j0: 0, j1: lastRow },
    wing: { i0: split + 1, i1: lastCol, j0: 0, j1: lastRow },
    // A cell in neither block, for the click that closes an Edit session. The bottom-right corner of the
    // lattice: under Perimeter Trim there is no panel there at all, which ends the session just as well —
    // it exits on any clean click that isn't on a panel of the group being edited.
    bare: { i: cols - 1, j: rows - 1 },
  };
}

/**
 * The panel to grab the composition's bottom rail by.
 *
 * It has to be a LIVE panel rect, never a lattice cell. The lattice is the border's bounding box, so on an
 * elevation with cut corners its lower rows exist only where the boundary has not eaten them — a point
 * derived from one lands in empty space as often as not, and a press there grabs nothing at all.
 *
 * Of the real panels, the one wanted is on the OUTSIDE of the selection: a mullion between two selected
 * panels is one's south face and the other's north face at the same pixel, and whichever won the hit test
 * would decide which way "up" thickened the frame. A panel with nothing selected below it has no such
 * ambiguity. Slivers left by the cut are dropped — too small to grab, too small to read — and of what is
 * left the most CENTRAL wins: only the bottom panel of a column can be an outer one, so picking by column
 * already picks the lowest, and it puts the gesture in the middle of the elevation where the eye is rather
 * than out on a corner the boundary happened to leave hanging lowest.
 */
function bottomRailPanel(rects: Rect[]): Rect | null {
  const T = 1e-3;
  const outer = rects.filter(
    (r) =>
      !rects.some(
        (o) => Math.abs(o.y - (r.y + r.h)) < T && o.x < r.x + r.w - T && o.x + o.w > r.x + T,
      ),
  );
  const pool = outer.length ? outer : rects;
  if (!pool.length) return null;
  const biggest = pool.reduce((m, r) => Math.max(m, r.w * r.h), 0);
  const usable = pool.filter((r) => r.w * r.h >= biggest * 0.6);
  const mid = rects.reduce((s, r) => s + r.x + r.w / 2, 0) / rects.length;
  const off = (r: Rect) => Math.abs(r.x + r.w / 2 - mid);
  return usable.reduce((best, r) => {
    const nearer = off(best) - off(r);
    if (nearer > T) return r;
    if (nearer < -T) return best;
    return r.y + r.h > best.y + best.h ? r : best;
  }, usable[0]);
}

/**
 * Sweep up both blocks, frame the lot, then raise ONE mullion to show that the frame is a parametric width
 * shared by every panel in the selection.
 *
 * The drag takes a panel's BOTTOM face and pulls it up, and deliberately holds no modifier: plain, so only
 * that ONE side moves — on every selected panel at once, which is the relationship worth showing. (Shift
 * would drive all four faces together instead, and the change stops reading as a specific edit.)
 *
 * It grabs at the middle of the face, not near an end: the edge hit test excludes a zone at each corner so
 * they stay unambiguous, and on a narrow panel that zone is most of the width.
 */
async function framePattern(ctx: DemoContext): Promise<void> {
  const g = ctx.canvas?.demoGridLines();
  if (!g || g.x.length < 4 || g.y.length < 3) return;
  const b = facadeBlocks(g);
  // Mass and wing share their rows and meet along one column, so together they ARE a rectangle — the whole
  // composition comes up in a single sweep here. They are only painted apart in the step after this one,
  // where they take different materials.
  await paintBlocks(ctx, g, [{ i0: b.mass.i0, i1: b.wing.i1, j0: b.mass.j0, j1: b.mass.j1 }]);
  await ctx.ui.press('bar-edit', 420);

  const target = bottomRailPanel(ctx.canvas?.demoSelectedPanelRects() ?? []);
  if (!target) {
    ctx.scene.stage = STAGE.FRAMED;
    return;
  }
  const grab = { x: target.x + target.w / 2, y: target.y + target.h };
  // Hover it first: the magenta strip appears on that face of EVERY selected panel, which is the whole
  // claim of the step made before a single pixel moves.
  const from = ctx.toScreen(grab);
  await ctx.ui.canvasHover(from, 620);
  // Upward = INTO the panel. The mullion's outer face is pinned to the panel edge, so its inner face rising
  // is the band growing upward — the 2″ seed becomes a deep bottom rail on every framed panel at once.
  //
  // Sized off the panel, but floored in SCREEN pixels: a rail that grew by a proportion of a small panel
  // could come out a pixel or two wide and the step would look like nothing happened. The floor is what
  // makes the lift legible whatever the split and the zoom left the panels at — still a fraction of a
  // panel, so it reads as a rail thickening rather than the panel closing up.
  const lift = Math.max(MIN_RAIL_LIFT_PX, from.y - ctx.toScreen({ x: grab.x, y: grab.y - target.h * 0.12 }).y);
  await ctx.ui.canvasDrag(from, { x: from.x, y: from.y - lift });
  // Let the new rail stand on its own for a beat before the step hands back.
  await ctx.ui.hold(420);
  ctx.scene.stage = STAGE.FRAMED;
}

/**
 * End an Edit-a-panel session the way a user does — one clean click on a panel that isn't in it.
 *
 * While the session is live it owns every press on the canvas (that is what makes the mullions grabbable),
 * so anything that wants to paint again has to close it first. Clicking a panel that IS in the session is
 * not enough: the session treats that as carrying on with the same group.
 */
async function exitFrameEdit(ctx: DemoContext, g: Lattice, at: { i: number; j: number }): Promise<void> {
  await ctx.ui.canvasClick(ctx.toScreen(cellCentre(g, at.i, at.j)), {}, 220);
}

/**
 * Materials, on the two blocks the frames just picked out: the mass becomes triple-glazed vision glass and
 * the wing beside it spandrel. Each pass hovers the list first — the hover IS the live preview, painted on
 * the real selection — before committing one.
 */
async function assignDemo(ctx: DemoContext): Promise<void> {
  const g = ctx.canvas?.demoGridLines();
  if (!g || g.x.length < 4 || g.y.length < 3) return;
  const b = facadeBlocks(g);
  await exitFrameEdit(ctx, g, b.bare);

  // The mass → Vision 3, so it reads as glazed wall.
  await paintBlocks(ctx, g, [b.mass]);
  await ctx.ui.press('bar-assign', 200);
  await ctx.ui.hover('kind-cladding', 550); // preview one...
  await ctx.ui.hover('kind-vision3', 550); // ...then the one that belongs here
  await ctx.ui.press('kind-vision3', 420);

  // The wing → spandrel: opaque glass reading against the glazed mass beside it.
  await paintBlocks(ctx, g, [b.wing]);
  await ctx.ui.press('bar-assign', 200);
  await ctx.ui.hover('kind-solid', 500);
  await ctx.ui.hover('kind-spandrel', 500);
  await ctx.ui.press('kind-spandrel', 420);
  ctx.scene.stage = STAGE.CLAD;
}

/**
 * Guarantee the scene is at EXACTLY `want`, and return its rect.
 *
 * Walking the tour forwards this is a no-op — the previous step left the scene at this stage, so the work
 * it did is inherited rather than repeated. It only does anything when the user arrives out of order via
 * the progress dots: too early, and the missing stages are built; too late, and the scene is rebuilt from
 * an empty canvas, so a step that ADDS something never compounds onto its own previous run.
 *
 * The rebuild replays the real gestures rather than injecting geometry, because injected geometry would
 * land wherever the world happens to be and need a camera move to find — and the tour does not pan.
 */
async function atStage(ctx: DemoContext, want: Stage): Promise<Rect | null> {
  if (ctx.scene.stage === want && ctx.scene.rect) return ctx.scene.rect;

  await freshCanvas(ctx);
  await dropShape(ctx);
  const rect = await shapeIt(ctx);
  if (!rect) return null;
  // The boolean pairs are an aside on their own shapes — they leave the elevation untouched, so catching
  // up PAST them only has to record that it happened, not replay it.
  if (want >= STAGE.BOOLEAN) ctx.scene.stage = STAGE.BOOLEAN;
  if (want >= STAGE.SPLIT) {
    await openShape(ctx, rect);
    await splitIt(ctx);
  }
  // No `openShape` here: splitting leaves the pointer inside the shape, which is what makes its mullions
  // grabbable in the first place.
  if (want >= STAGE.ADJUSTED) await adjustGrid(ctx);
  if (want >= STAGE.RATIONALIZED) {
    await openShape(ctx, rect);
    await rationalize(ctx, 120);
  }
  if (want >= STAGE.FRAMED) {
    // Optimize steps back OUT of the shape (its panels may not have survived the reshape), so painting
    // them needs the pointer taken back in.
    await openShape(ctx, rect);
    await framePattern(ctx);
  }
  if (want >= STAGE.CLAD) await assignDemo(ctx);
  return rect;
}

/** A world rect's centre in viewport coordinates — where the tour clicks to open a shape. */
function centreOf(ctx: DemoContext, r: Rect): { x: number; y: number } {
  return ctx.toScreen({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
}

/* ==============================================================================================
 *  PLAN MODE
 *
 *  One continuous piece of work rather than a list of features. Four rooms are dropped in two overlapping
 *  pairs; one of them is opened and reshaped by vertex, wall thickness and edge; one pair is then united
 *  and the other cut — with the cut sized to BREAK a rule on purpose; the violation it leaves is read in
 *  the Constraints box and healed with the wand; more rooms are generated from a sentence typed into the
 *  real Generate box; and those are dragged into the Library and taken back out of it. Each step consumes
 *  what the one before it left, so nothing here is a set-piece.
 * ============================================================================================== */

/** One room as the tour sees it — see {@link CanvasHandle.demoRoomRects}. */
type DemoRoom = ReturnType<CanvasHandle['demoRoomRects']>[number];

/** A viewport or world point, depending on what produced it. */
type Point = { x: number; y: number };

/** How far the Plan scene has been carried. The twin of {@link STAGE}; see {@link atPlanStage}. */
const PLAN = {
  EMPTY: 0,
  DROPPED: 1,
  RESHAPED: 2,
  COMBINED: 3,
  FIXED: 4,
  GENERATED: 5,
  SAVED: 6,
} as const;
type PlanStage = (typeof PLAN)[keyof typeof PLAN];

/**
 * Edge indices as {@link CanvasHandle.demoRoomRects} reports a room's corners: edge `i` runs from corner
 * `i` to corner `i + 1`, so on a freshly dropped (unrotated) room they are the four compass sides.
 */
const EDGE = { N: 0, E: 1, S: 2, W: 3 } as const;

/**
 * Screen pixels of room the corner bite takes — 4 ft at the 100% zoom the drops happen at, and therefore
 * UNDER the 5 ft minimum side the rules carry.
 *
 * This number is the hinge of the whole tour. Subtracting one room from another at a corner leaves a
 * notch whose two new edges are exactly this long, so the trimmed room breaks "No room side may become
 * < 5'" the instant the boolean lands — which is what gives step 3 something to open the Constraints box
 * for and something for the wand to repair. Raise it past 50 and the three steps after the cut have
 * nothing to talk about.
 */
const PLAN_CUT_PX = 40;

/**
 * The sentence the tour types into the Generate box, taken from the box's OWN rotating examples (minus
 * the ellipsis they are displayed with) rather than restated here — so the tour can only ever demonstrate
 * a prompt the box actually offers, and it follows that list if it is edited.
 */
const PLAN_PROMPT = (
  PROMPT_EXAMPLES.find((e) => e.startsWith('I want')) ?? PROMPT_EXAMPLES[0]
).replace(/[.…]+$/, '');

/**
 * Where the four rooms are dropped, in SCREEN pixels, aimed from the 100% camera {@link freshPlan} has
 * just reset to — so one pixel is one world unit and the arrangement comes out the same on every run.
 *
 * Two independent pairs, because the two booleans are two different lessons, and both are staggered on
 * BOTH axes so they meet corner to corner. That stagger is doing real work in each case:
 *
 *  • UNITE — squares offset along one axis only share two collinear edges, the degenerate case for a
 *    polygon clipper, and even when it survives the result is just a longer rectangle, which doesn't read
 *    as a boolean at all. Offset diagonally they merge into a stepped L whose every edge traces back to
 *    one of the two rooms.
 *  • SUBTRACT — the overlap is sized so the OUTER footprint of the second room eats exactly
 *    {@link PLAN_CUT_PX} of the first's interior in each axis: `step` is the gap that puts the cutter's
 *    outer face that far inside the target (half a square across to reach its edge, less the bite, plus
 *    the cutter's own wall band).
 *
 * The two pairs use the SAME step, and the second pair is dropped a step lower, which lines every
 * horizontal wall centreline of one pair up exactly with one of the other's. That is deliberate: rooms
 * snap to each other's wall centrelines within 12 px as they land, and a near-miss would shove a room
 * off its mark and change the size of the bite. Exact coincidence is the one alignment a snap cannot
 * move. The horizontal gap between the pairs is then chosen to keep every centreline pairing well
 * outside that same 12 px catch.
 */
function planLayout(): { unite: [Point, Point]; cut: [Point, Point] } {
  const S = DEFAULT_SQUARE_SCREEN_SIZE;
  const W = DEFAULT_WALL_WORLD; // the wall band, in px at the 100% the drops happen at
  const step = S - PLAN_CUT_PX + W;
  // Clear of every centreline-to-centreline distance the two pairs can produce (0, 40, 85, 125 and 210 px
  // apart), by a comfortable margin on either side of the 12 px snap zone.
  const gap = 260;
  // The block the four rooms occupy, wall bands included, centred on the canvas — held a little BELOW the
  // middle, on the centre of the band left between the tour card at the top and the nav pill at the bottom.
  const width = gap + step + S + 2 * W;
  const height = step + S + 2 * W;
  const x0 = window.innerWidth / 2 - width / 2 + S / 2 + W;
  const y0 = window.innerHeight * 0.56 - height / 2 + S / 2 + W;
  return {
    unite: [
      { x: x0, y: y0 },
      { x: x0 + step, y: y0 + step },
    ],
    // Mirrored: the cutter goes up and to the right, so the bite lands on the target's top-right corner.
    cut: [
      { x: x0 + gap, y: y0 + step },
      { x: x0 + gap + step, y: y0 },
    ],
  };
}

/** Live rooms, in creation order. */
function rooms(ctx: DemoContext): DemoRoom[] {
  return ctx.canvas?.demoRoomRects() ?? [];
}

/** The world box enclosing a set of rooms, wall bands included, or null for none. */
function roomsRect(list: DemoRoom[]): Rect | null {
  if (!list.length) return null;
  const x = Math.min(...list.map((r) => r.outer.x));
  const y = Math.min(...list.map((r) => r.outer.y));
  const x1 = Math.max(...list.map((r) => r.outer.x + r.outer.w));
  const y1 = Math.max(...list.map((r) => r.outer.y + r.outer.h));
  return { x, y, w: x1 - x, h: y1 - y };
}

/** Centre of a rect. */
function mid(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * The empty corner up and to the left of a group of rooms.
 *
 * Bare canvas, which is what both a deselecting click and the start of a marquee sweep need: a press that
 * lands ON a room moves it instead. Up-LEFT because the tour always builds downward and rightward, so
 * that corner is the one nothing has been put in.
 */
function clearOf(group: Rect): Point {
  const pad = group.h * 0.25;
  return { x: group.x - pad, y: group.y - pad };
}

/**
 * The two pairs, picked out of the live rooms by position rather than carried between steps.
 *
 * The union pair is the leftmost two and the cut pair the rightmost two, which stays true after the union
 * has merged its pair into ONE room — the merged L still sits left of everything else. Within each pair
 * the left-hand room comes first, and that is the one the tour clicks first: for the union it anchors the
 * merge (the result keeps its title), and for the difference it is the TARGET, the room that gets bitten.
 */
function planPairs(list: DemoRoom[]): { unite: [DemoRoom, DemoRoom]; cut: [DemoRoom, DemoRoom] } | null {
  if (list.length < 3) return null;
  const byX = [...list].sort((p, q) => mid(p.inner).x - mid(q.inner).x);
  return {
    unite: [byX[0], byX[1]],
    cut: [byX[byX.length - 2], byX[byX.length - 1]],
  };
}

/**
 * A point deep inside `a` and clear of `b` — where a click can only mean "pick this one".
 *
 * Both booleans need exactly two rooms armed, and the arming is two clicks: one plain, one with Shift.
 * Aiming either at a room's CENTRE would be wrong on an overlapping pair — the press would land inside
 * both, hit whichever is on top, and the Shift-click would then toggle that same room straight back off.
 * Leaning away from the other room is what keeps each click unambiguous.
 */
function soloPoint(a: DemoRoom, b: DemoRoom): Point {
  const ac = mid(a.inner);
  const bc = mid(b.inner);
  // A third of the way out, not further: by the time this runs the left-hand room has been reshaped into
  // a quad, and a point pushed hard into the corner of its bounding box can fall outside the room itself.
  return {
    x: ac.x + (ac.x <= bc.x ? -1 : 1) * a.inner.w * 0.3,
    y: ac.y + (ac.y <= bc.y ? -1 : 1) * a.inner.h * 0.3,
  };
}

/**
 * A point on a room's floor, clear of its centre readout.
 *
 * The name and area sit at the centroid and are click-to-edit, so a double-click aimed at the middle of a
 * room opens the rename box over it instead of opening the room's vertices. Held off the walls too, so the
 * press can't be read as an edge grab.
 */
function floorPoint(room: DemoRoom): Point {
  const c = mid(room.inner);
  return { x: c.x - room.inner.w * 0.24, y: c.y + room.inner.h * 0.28 };
}

/** The middle of interior edge `e`, and that edge's outward unit normal. */
function edgeAim(room: DemoRoom, e: number): { at: Point; out: Point } {
  const pts = room.corners;
  const a = pts[e % pts.length];
  const b = pts[(e + 1) % pts.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return {
    at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    out: { x: (b.y - a.y) / len, y: -(b.x - a.x) / len },
  };
}

/** A point `d` world units outward from the middle of edge `e` — i.e. somewhere inside its wall band. */
function offEdge(room: DemoRoom, e: number, d: number): Point {
  const { at, out } = edgeAim(room, e);
  return { x: at.x + out.x * d, y: at.y + out.y * d };
}

/** The middle of the region where both interiors overlap — the one press that can only mean UNITE. */
function unitePoint(a: DemoRoom, b: DemoRoom): Point {
  const span = (a0: number, a1: number, b0: number, b1: number) =>
    (Math.max(a0, b0) + Math.min(a1, b1)) / 2;
  return {
    x: span(a.inner.x, a.inner.x + a.inner.w, b.inner.x, b.inner.x + b.inner.w),
    y: span(a.inner.y, a.inner.y + a.inner.h, b.inner.y, b.inner.y + b.inner.h),
  };
}

/**
 * The middle of `target`'s RIGHT wall band where `other`'s interior crosses it — the one press that can
 * only mean "subtract other FROM target".
 *
 * A click on a room's own wall, over another room's floor, trims THAT room; the pair is arranged so the
 * cutter sits up and to the right, which puts the unambiguous strip on the target's right-hand band. It
 * is only one wall thick, so it is measured off the live rects rather than guessed — and the step frames
 * the pair first, which widens the strip on screen well past anything the aim has to resolve.
 */
function cutPoint(target: DemoRoom, other: DemoRoom): Point {
  return {
    x: (target.inner.x + target.inner.w + target.outer.x + target.outer.w) / 2,
    y:
      (Math.max(target.inner.y, other.inner.y) +
        Math.min(target.inner.y + target.inner.h, other.inner.y + other.inner.h)) /
      2,
  };
}

/** Empty Plan workspace, camera back on the world origin at 100% — the zoom every drop below is sized in. */
async function freshPlan(ctx: DemoContext): Promise<void> {
  await gotoMode(ctx, 'Plan');
  ctx.setLayersActive(false);
  ctx.canvas?.resetForDemo();
  ctx.scene.rect = null;
  ctx.scene.stage = PLAN.EMPTY;
  await ctx.ui.settle(2);
}

/** Drag the cube out four times, then go and look at what landed. */
async function dropRooms(ctx: DemoContext): Promise<Rect | null> {
  const at = planLayout();
  for (const pt of [...at.unite, ...at.cut]) await ctx.ui.dragFrom('cube', pt);
  await ctx.ui.settle(2);
  const rect = roomsRect(rooms(ctx));
  ctx.scene.rect = rect;
  ctx.scene.stage = rect ? PLAN.DROPPED : PLAN.EMPTY;
  if (rect) await frameOn(ctx, rect);
  return rect;
}

/**
 * Three ways to reshape one room, all on the leftmost of the four.
 *
 * They are deliberately three DIFFERENT gestures on three different parts of the same wall assembly, which
 * is the point: a room is not a box with handles, it is a polygon whose vertices, wall thicknesses and edge
 * positions are each editable in place.
 *
 *  1. A double-click opens the room's vertices; dragging one moves that corner alone and the two walls
 *     meeting there follow it, so the rectangle becomes a quad.
 *  2. Clicking a wall arms it and lights its two faces; dragging the OUTER one thickens that wall only,
 *     outward, so the interior keeps its dimensions.
 *  3. Dragging any other wall along its length translates that whole edge — the room gets deeper without
 *     the adjacent walls changing angle.
 *
 * Everything happens on the room's NORTH and WEST sides, away from the corner it overlaps its neighbour at,
 * so the boolean the next step runs on this pair is still aimed at an overlap this one hasn't touched.
 *
 * Each gesture re-reads the room first. The one before it has changed the geometry the next one aims into —
 * a moved vertex leaves two walls running at an angle, and the midpoint of an angled wall is not where the
 * rectangle's was.
 */
async function reshapeRoom(ctx: DemoContext): Promise<void> {
  /** The leftmost room, re-read. */
  const leftmost = (): DemoRoom | null => {
    const list = rooms(ctx).sort((a, b) => mid(a.inner).x - mid(b.inner).x);
    return list[0] && list[0].corners.length >= 4 ? list[0] : null;
  };
  let room = leftmost();
  if (!room) return;

  // Close in on it. A wall band is a few world units across and two of the three gestures are aimed
  // INSIDE one, so the step is unreadable — and the aim marginal — from a zoom that holds all four rooms.
  const pad = room.outer.w * 0.5;
  await frameOn(ctx, {
    x: room.outer.x - pad,
    y: room.outer.y - pad,
    w: room.outer.w + pad * 2,
    h: room.outer.h + pad * 2,
  });

  // 1) Open the vertices, then pull the top-left one out.
  room = leftmost();
  if (!room) return;
  await ctx.ui.canvasDoubleClick(ctx.toScreen(floorPoint(room)));
  room = leftmost();
  if (!room) return;
  const nw = room.corners[0];
  await ctx.ui.canvasHover(ctx.toScreen(nw), 420); // the dot is a grab target — show it being found
  await ctx.ui.canvasDrag(
    ctx.toScreen(nw),
    ctx.toScreen({ x: nw.x - room.inner.w * 0.26, y: nw.y - room.inner.h * 0.2 }),
  );
  await ctx.ui.wait(300);

  // 2) Thicken the west wall. The click arms the edge and the hover lights the face under the cursor —
  //    which is what turns the next press into a thickness drag rather than another edge stretch, so both
  //    are load-bearing, not pacing.
  room = leftmost();
  if (!room) return;
  const band = room.thickness[EDGE.W];
  const onFace = offEdge(room, EDGE.W, band * 0.72); // the outer half of the band
  await ctx.ui.canvasClick(ctx.toScreen(onFace), {}, 260);
  await ctx.ui.canvasHover(ctx.toScreen(onFace), 520);
  const west = edgeAim(room, EDGE.W).out;
  const grow = band * 3; // 6" of wall becomes two feet — thick enough to read, inside the 36" rule
  await ctx.ui.canvasDrag(ctx.toScreen(onFace), ctx.toScreen({
    x: onFace.x + west.x * grow,
    y: onFace.y + west.y * grow,
  }));
  await ctx.ui.wait(300);

  // 3) Stretch the north wall outward. The hover FIRST is what un-lights the west wall's face: the app
  //    still has it armed from the drag above, and a press with that face lit would thicken it again
  //    instead of translating this edge.
  room = leftmost();
  if (!room) return;
  const grab = offEdge(room, EDGE.N, room.thickness[EDGE.N] * 0.5);
  const north = edgeAim(room, EDGE.N).out;
  const reach = room.inner.h * 0.3;
  await ctx.ui.canvasHover(ctx.toScreen(grab), 420);
  await ctx.ui.canvasDrag(ctx.toScreen(grab), ctx.toScreen({
    x: grab.x + north.x * reach,
    y: grab.y + north.y * reach,
  }));

  ctx.scene.rect = roomsRect(rooms(ctx)) ?? ctx.scene.rect;
  ctx.scene.stage = PLAN.RESHAPED;
  await ctx.ui.wait(400);
}

/**
 * Both booleans, each on its own pair: the left pair united, the right pair cut.
 *
 * There are no combine buttons — arm exactly two rooms, then WHERE you click decides which operation
 * runs. Every point is measured off the live rects (see {@link cutPoint}), and the pairs are re-read
 * between the two operations because the union has by then removed a room from the drawing.
 */
async function combineRooms(ctx: DemoContext): Promise<void> {
  /** Arm exactly two rooms — plain click, then Shift-click — and press the point that runs the boolean. */
  const run = async (a: DemoRoom, b: DemoRoom, at: Point) => {
    const pair = roomsRect([a, b]);
    if (pair) await frameOn(ctx, pair); // in close, so the wall band the cut is aimed at is a broad strip
    await ctx.ui.canvasClick(ctx.toScreen(soloPoint(a, b)));
    await ctx.ui.canvasClick(ctx.toScreen(soloPoint(b, a)), { shift: true });
    await ctx.ui.canvasClick(ctx.toScreen(at), {}, 700);
  };

  const first = planPairs(rooms(ctx));
  if (!first) return;
  const [ua, ub] = first.unite;
  await run(ua, ub, unitePoint(ua, ub));

  // Re-read: the union has just removed one room from the drawing.
  const second = planPairs(rooms(ctx));
  if (!second) return;
  const [target, other] = second.cut;
  await run(target, other, cutPoint(target, other));
  ctx.scene.stage = PLAN.COMBINED;

  // Pull the cutter clear. The bite it took — and the two flagged edges that are the whole point of the
  // step — sit UNDERNEATH it until it moves, so without this the step ends on a violation nobody can see.
  // Far enough to clear the trimmed room's outer wall outright, plus a gap you can read across; the wall
  // snapping that catches the drag on the way can only nudge it by a fraction of that.
  const after = planPairs(rooms(ctx));
  if (after) {
    const [trimmed, cutter] = after.cut;
    const from = mid(cutter.inner);
    const clear = trimmed.outer.x + trimmed.outer.w - cutter.outer.x + trimmed.inner.w * 0.3;
    await ctx.ui.canvasDrag(ctx.toScreen(from), ctx.toScreen({ x: from.x + clear, y: from.y }));
    // Drop the selection the move left behind, so the notch reads as geometry rather than as a handle set.
    ctx.canvas?.demoDeselect();
    await ctx.ui.settle(2);
  }

  // The whole scene is what later steps frame their empty space against...
  ctx.scene.rect = roomsRect(rooms(ctx)) ?? ctx.scene.rect;
  // ...but this step ends CLOSE on the room that broke the rule: the flag is painted on the wall strip of
  // each short edge, which is a few pixels wide at a zoom that holds the whole drawing.
  const flagged = rooms(ctx).find((r) => r.flagged);
  if (flagged) {
    const pad = flagged.outer.w * 0.4;
    await frameOn(ctx, {
      x: flagged.outer.x - pad,
      y: flagged.outer.y - pad,
      w: flagged.outer.w + pad * 2,
      h: flagged.outer.h + pad * 2,
    });
    // Park IN the notch — top-right of the room's box, the empty corner the bite left, where the two 4'
    // edges meet. A canvas hover rather than a bare cursor move, so the app's own hover follows the tour's
    // pointer instead of staying lit on whatever the last gesture ended over; landing it in the void also
    // means nothing is washed with the hover fill while the yellow is being looked at.
    await ctx.ui.canvasHover(
      ctx.toScreen({
        x: flagged.inner.x + flagged.inner.w * 0.85,
        y: flagged.inner.y + flagged.inner.h * 0.15,
      }),
      800,
    );
  }
}

/**
 * Walk the guided fix: the wand reviews one violation at a time, so the tour presses Approve once per
 * step until the pill goes away.
 *
 * Bounded, and it checks the button rather than assuming it: a violation the app has no automatic answer
 * for leaves the pill up with Approve greyed out, and a loop that kept pressing a dead control would
 * never end. Skip is what moves past those.
 */
async function approveFixes(ctx: DemoContext): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (!DemoDriver.locate('fix-approve')) break;
    if (DemoDriver.disabled('fix-approve')) await ctx.ui.press('fix-skip', 380);
    else await ctx.ui.press('fix-approve', 480);
  }
  await ctx.ui.settle(2);
  await ctx.ui.hold(320); // the session ends by easing the camera back; let it land
  ctx.scene.stage = PLAN.FIXED;
}

/** Open the Constraints box on the broken rule, then hand it to the wand. */
async function fixViolations(ctx: DemoContext): Promise<void> {
  ctx.openPanel(null);
  await ctx.ui.settle(2);
  await ctx.ui.press('nav-constraints', 300);
  // Park over the rules for a beat: the line the trimmed room breaks is washed the same yellow as the
  // flag on the canvas, which is the whole point of opening the box.
  await ctx.ui.moveTo('constraints-box');
  await ctx.ui.wait(1100);
  await ctx.ui.hover('constraints-fix', 500);
  await ctx.ui.press('constraints-fix', 700); // closes the box and zooms the offending room
  await approveFixes(ctx);
}

/**
 * Type a prompt into the real Generate box and wait for the rooms it builds.
 *
 * The empty strip below the work is framed FIRST because generated rooms are laid out around the current
 * view centre — without it the new row lands straight on top of everything the tour has spent three steps
 * building.
 */
async function generateRooms(ctx: DemoContext): Promise<void> {
  const before = rooms(ctx).length;
  const work = ctx.scene.rect ?? roomsRect(rooms(ctx));
  if (work) await frameOn(ctx, bayRect(work));
  await ctx.ui.press('nav-generate', 260);
  await ctx.ui.typeInto('prompt-input', PLAN_PROMPT, { submit: true });
  // A generate prompt is an LLM round-trip (with a local fallback behind it), so wait for the ROOMS
  // rather than for a timer — a fixed pause is either a stall or a step that carries on empty-handed.
  await ctx.ui.until(() => rooms(ctx).length > before, 20000);
  await ctx.ui.settle(2);
  const box = roomsRect(rooms(ctx).filter((r) => r.selected));
  if (box) {
    await frameOn(ctx, box);
    // One click on bare canvas drops the selection the generation arrived with — which is also what
    // brings each room's name and area back, since those are held back across a multi-selection.
    await ctx.ui.canvasClick(ctx.toScreen(clearOf(box)), {}, 600);
  }
  ctx.scene.stage = PLAN.GENERATED;
}

/**
 * The rooms the prompt built, left to right.
 *
 * Identified by POSITION rather than by the selection they arrived with, because the step before this one
 * deliberately clicks that selection away. They are the only rooms below the block the tour drew by hand —
 * {@link generateRooms} frames the empty strip under it precisely so they land there.
 */
function generatedRooms(ctx: DemoContext): DemoRoom[] {
  const work = ctx.scene.rect;
  const all = rooms(ctx);
  const list = work ? all.filter((r) => r.outer.y >= work.y + work.h) : all;
  return list.sort((a, b) => mid(a.inner).x - mid(b.inner).x);
}

/**
 * Sweep up part of the generated row, save it to the Library, and take it back out onto the canvas twice.
 *
 * All three gestures are the real ones. A marquee takes whatever its box TOUCHES, so the sweep has to stop
 * in the gap between two rooms' interiors — the row is laid out with its outer walls flush, which makes
 * that gap exactly one wall wide, so the stop is measured rather than estimated. The drop then goes onto
 * the open panel (a save target in its own right, not just the button), and each pick-up out of it arms
 * the cursor-following ghost the same way a press on the card does — including the popup closing behind
 * each drop, which is why the second one reopens it.
 */
async function saveToLibrary(ctx: DemoContext): Promise<void> {
  const list = generatedRooms(ctx);
  const row = roomsRect(list);
  if (!row || !list.length) return;

  // Open the shelf first, so the sweep has somewhere visible to be dropped.
  await ctx.ui.press('nav-library', 450);

  // Take all but the last room — "some of these, not all of them" is the point of sweeping rather than
  // selecting everything.
  const keep = list.slice(0, Math.max(1, list.length - 1));
  const last = keep[keep.length - 1];
  const beyond = list[keep.length];
  const stopX = beyond
    ? (last.inner.x + last.inner.w + beyond.inner.x) / 2
    : row.x + row.w + row.h * 0.25;
  await ctx.ui.canvasDrag(
    ctx.toScreen(clearOf(row)),
    ctx.toScreen({ x: stopX, y: row.y + row.h * 1.25 }),
    { steps: 22 },
  );
  await ctx.ui.settle(2);

  // ...and drag them onto the panel. The whole selection travels with whichever room is pressed, and a
  // release over the shelf SAVES the arrangement rather than moving it — the rooms snap back where they
  // were, shrinking into the drop on the way.
  const picked = rooms(ctx).filter((r) => r.selected);
  const shelf = DemoDriver.locate('library-box');
  if (!picked.length || !shelf) return;
  await ctx.ui.canvasDrag(ctx.toScreen(mid(picked[0].inner)), shelf, { steps: 26 });
  await ctx.ui.settle(2);

  // Then put it back to use: two copies dropped into the empty strip under the row, which is what makes
  // the point that a saved cluster is a reusable unit and not just a screenshot of one.
  const zone = { x: row.x - row.w * 0.3, y: row.y + row.h * 1.7, w: row.w * 1.6, h: row.h * 1.2 };
  await frameOn(ctx, { x: zone.x, y: row.y, w: zone.w, h: zone.y + zone.h - row.y });
  for (const t of [0.25, 0.75]) {
    // The popup closes on each drop — reopen it for the next one, exactly as a user would.
    if (!DemoDriver.locate('library-item-0')) await ctx.ui.press('nav-library', 320);
    await ctx.ui.dragFrom(
      'library-item-0',
      ctx.toScreen({ x: zone.x + zone.w * t, y: zone.y + zone.h / 2 }),
      { steps: 24 },
    );
    await ctx.ui.settle(2);
  }
  ctx.scene.stage = PLAN.SAVED;
}

/**
 * Guarantee the Plan scene is at exactly `want`.
 *
 * Walking the tour forwards this is a no-op — each step inherits what the one before it left. It only
 * does anything when the user lands out of order via the progress dots, and then it replays the real
 * gestures rather than injecting geometry, so a step that ADDS something never compounds onto its own
 * previous run.
 */
async function atPlanStage(ctx: DemoContext, want: PlanStage): Promise<Rect | null> {
  if (ctx.scene.stage === want && ctx.scene.rect) return ctx.scene.rect;
  await freshPlan(ctx);
  if (!(await dropRooms(ctx))) return null;
  if (want >= PLAN.RESHAPED) await reshapeRoom(ctx);
  if (want >= PLAN.COMBINED) await combineRooms(ctx);
  if (want >= PLAN.FIXED) await fixViolations(ctx);
  if (want >= PLAN.GENERATED) await generateRooms(ctx);
  if (want >= PLAN.SAVED) await saveToLibrary(ctx);
  return ctx.scene.rect;
}

/** The view switches every Plan step declares: no facade overlays, and the constraint flags ON. */
function planView(ctx: DemoContext) {
  plainView(ctx);
  ctx.setConstraintHighlights(true);
  ctx.setStatsVisible(true);
}

export const PLAN_DEMO: DemoStep[] = [
  {
    title: 'Drag rooms onto the canvas',
    body: 'Plan starts empty. Every room you drop is real geometry — walls, areas and dimensions all measured. Four here, in two overlapping pairs.',
    tryIt: 'Drag the cube out for a room, then grab an edge or a corner.',
    run: async (ctx) => {
      ctx.openPanel(null);
      planView(ctx);
      await freshPlan(ctx);
      await ctx.ui.settle();
      await dropRooms(ctx);
    },
  },
  {
    title: 'Open a room and reshape it',
    body: 'Double-click in for the vertices. Drag one to move that corner; drag a wall’s outer face to thicken it, or the wall itself to slide the edge.',
    tryIt: 'Double-click a room, then drag a point, a wall face, or a wall.',
    run: async (ctx) => {
      ctx.openPanel(null);
      planView(ctx);
      if (!(await atPlanStage(ctx, PLAN.DROPPED))) return;
      await reshapeRoom(ctx);
    },
  },
  {
    title: 'Unite and subtract',
    body: 'Where you click decides: inside both floors UNITES, on one room’s wall over the other’s floor SUBTRACTS. That 4′ cut breaks the 5′ minimum side, so it flags yellow.',
    tryIt: 'Click one room, Shift-click the other, then click their overlap.',
    run: async (ctx) => {
      ctx.openPanel(null);
      planView(ctx);
      if (!(await atPlanStage(ctx, PLAN.RESHAPED))) return;
      await combineRooms(ctx);
    },
  },
  {
    title: 'Read the rule, then fix it',
    body: 'Rules are plain English, checked live. The broken line washes the same yellow as the flag, and the wand ghosts each fix before you approve it.',
    tryIt: 'Edit a rule and press Save — the canvas re-checks immediately.',
    run: async (ctx) => {
      planView(ctx);
      if (!(await atPlanStage(ctx, PLAN.COMBINED))) return;
      await fixViolations(ctx);
    },
  },
  {
    title: 'Type to generate',
    body: 'Describe a plan in plain English and it is built as real rooms, sized from the catalog. The box searches too: "show me all kitchens" highlights.',
    tryIt: 'Open Generate and type a layout — or a question — then Enter.',
    run: async (ctx) => {
      ctx.openPanel(null);
      planView(ctx);
      if (!(await atPlanStage(ctx, PLAN.FIXED))) return;
      await generateRooms(ctx);
    },
  },
  {
    title: 'Save it to the Library',
    body: 'Sweep up part of the row and drag it onto the shelf — the rooms stay put, the drop saves a copy. Drag the card back out to place the group again.',
    tryIt: 'Sweep a few rooms onto the Library, then drag the card back out.',
    run: async (ctx) => {
      ctx.openPanel(null);
      planView(ctx);
      if (!(await atPlanStage(ctx, PLAN.GENERATED))) return;
      await saveToLibrary(ctx);
    },
  },
  {
    title: 'That’s Plan mode',
    body: 'Rooms dropped, reshaped and combined, a broken rule repaired by the wand, a layout generated from a sentence, and the result saved to the Library.',
    run: async (ctx) => {
      ctx.openPanel(null);
      ctx.canvas?.demoDeselect();
      await ctx.ui.settle();
      ctx.ui.hide();
    },
  },
];

export const FACADE_DEMO: DemoStep[] = [
  {
    title: 'Drag out a shape and form it',
    body: 'Facade is its own workspace, and it starts empty. Drag the cube out, stretch its edges, then pull two corners in for an angled elevation.',
    tryIt: 'Drag the cube out, then grab an edge or a corner.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      ctx.setStatsVisible(true);
      await freshCanvas(ctx);
      await ctx.ui.settle();
      await dropShape(ctx);
      await shapeIt(ctx); // ...and frames the finished elevation, centred on the grid
    },
  },
  {
    title: 'Unite and subtract',
    body: 'Where you click decides: clear of both outlines UNITES, on one outline inside the other SUBTRACTS. Two pairs below the elevation, one of each.',
    tryIt: 'Click one shape, Shift-click another, then click their overlap.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      const rect = await atStage(ctx, STAGE.SHAPED);
      if (!rect) return;
      await booleanDemo(ctx, rect);
    },
  },
  {
    title: 'Split it into panels',
    body: 'Double-click in for the floating bar, then set Columns × Rows — 6 × 3 here. The lattice is fixed and the boundary clips it, so angles slice panels.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      const rect = await atStage(ctx, STAGE.BOOLEAN);
      if (!rect) return;
      await frameOn(ctx, rect); // the boolean aside pulled back to take in the bay; come back in
      await openShape(ctx, rect);
      await splitIt(ctx);
    },
  },
  {
    title: 'Adjust the grid',
    body: 'Drag any mullion and the whole line moves, panels either side reflowing. Shift-drag and only that segment jogs, so one bay widens on its own.',
    tryIt: 'Drag a mullion for the line; hold Shift for one segment.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      if (!(await atStage(ctx, STAGE.SPLIT))) return;
      await adjustGrid(ctx);
    },
  },
  {
    title: 'Rationalize the boundary',
    body: 'Cut corners leave a lot of one-off panels. Optimize has four fixes, previewed on hover. Perimeter Trim keeps panels whole, the diagonal one trim band.',
    tryIt: 'Open Optimize, run down the list, then click the one you want.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      const rect = await atStage(ctx, STAGE.ADJUSTED);
      if (!rect) return;
      await openShape(ctx, rect);
      await rationalize(ctx, 650);
    },
  },
  {
    title: 'Paint a selection, then Edit',
    body: 'Drag across panels to paint a selection; Shift-drag adds. Edit frames them all, and lifting one bottom rail raises every framed panel with it.',
    tryIt: 'Zigzag to paint panels; starting on a mullion moves the line.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      const rect = await atStage(ctx, STAGE.RATIONALIZED);
      if (!rect) return;
      await openShape(ctx, rect);
      await framePattern(ctx);
    },
  },
  {
    title: 'Paint a selection, then Assign',
    body: 'Same sweep, different action. Materials are per panel: the mass glazed Vision 3, the wing beside it spandrel. WWR, U-value and cost move with it.',
    tryIt: 'Sweep a selection, open Assign, and hover the list.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      // Inherits the framed composition and clads it: the two materials go onto the elements the frames
      // just picked out, so the elevation reads as one design rather than two unrelated demonstrations.
      if (!(await atStage(ctx, STAGE.FRAMED))) return;
      await assignDemo(ctx);
    },
  },
  {
    title: 'View modes',
    body: 'Material-ID flattens each panel type to a colour, Panel Numbers labels them by shape group, and Frame Shadow lifts the mullions off the wall.',
    run: async (ctx) => {
      ctx.openPanel(null);
      plainView(ctx);
      // Walking forward, this inherits the framed and clad elevation untouched — the frames and materials
      // are exactly what these three switches are for, so rebuilding anything here would undo them.
      if (!(await atStage(ctx, STAGE.CLAD))) return;
      // Cycle the three switches, one at a time so each reads on its own.
      await ctx.ui.press('toggle-idview', 850);
      await ctx.ui.press('toggle-idview', 150);
      await ctx.ui.press('toggle-numbers', 850);
      await ctx.ui.press('toggle-numbers', 150);
      await ctx.ui.press('toggle-shadow', 850); // left on — it flatters the frames just made
    },
  },
  {
    title: 'That’s Facade mode',
    body: 'One cube, stretched into an angled elevation, split into panels, tuned, rationalized, then framed and glazed — readouts moving as you go.',
    run: async (ctx) => {
      ctx.openPanel(null);
      // Drop the selection the last sweep left behind, so the tour ends on the elevation itself rather
      // than on a band of highlighted panels and the bar hanging off it.
      ctx.canvas?.demoDeselect();
      await ctx.ui.settle();
      ctx.ui.hide();
    },
  },
];

export const DEMOS: Record<Mode, DemoStep[]> = { Plan: PLAN_DEMO, Facade: FACADE_DEMO };
