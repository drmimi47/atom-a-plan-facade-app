import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasStats, Square } from './types';
import {
  type LibraryCluster,
  makeCluster,
  loadLibrary,
  saveLibrary,
} from './library';
import constraintsFile from './constraints_file.txt?raw';
import facadeConstraintsFile from './facade_constraints_file.txt?raw';
import {
  type Constraints,
  type FacadeConstraints,
  EMPTY_CONSTRAINTS,
  EMPTY_FACADE_CONSTRAINTS,
} from '../backend/types';
import { parseConstraints, parseFacadeConstraints } from '../backend/parseConstraints';
import { parsePrompt } from '../backend/parsePrompt';
import { resolveRoomList } from './rooms/roomCatalog';
import { isFindQuery } from './search/findQuery';
import type { FixResult } from './constraints/autofix';
import {
  InfiniteCanvas,
  type CanvasHandle,
  type SelectedPanelInfo,
} from './components/InfiniteCanvas/InfiniteCanvas';
import { ActionButton } from './components/ActionButton/ActionButton';
import { NavBar } from './components/NavBar/NavBar';
import { StatsBar } from './components/StatsBar/StatsBar';
import { AdjacencyMatrix } from './components/AdjacencyMatrix/AdjacencyMatrix';
import { TopBar, type Mode, type TopBarHandle } from './components/TopBar/TopBar';
import { TopRightBar } from './components/TopRightBar/TopRightBar';
import { RenderPanel, type RenderState } from './components/RenderPanel/RenderPanel';
import { AssemblyInspector } from './components/AssemblyInspector/AssemblyInspector';
import { FacadePanel } from './components/FacadePanel/FacadePanel';
import { CellSplitMenu } from './components/CellSplitMenu/CellSplitMenu';
import { DemoOverlay } from './components/DemoOverlay/DemoOverlay';
import type { DemoContext } from './demo/demoScript';
import {
  newDoc,
  summarizeDoc,
  type CellRef,
  type FacadeMetrics,
  type FacadeSummary,
  type OptimizeStrategy,
  type PanelMode,
  type PanelKind,
  type Rect,
} from './facade/partition';

/** Facade readouts before a border exists — also the fallback when the canvas isn't mounted yet. */
const EMPTY_FACADE_METRICS: FacadeMetrics = {
  panels: 0,
  types: 0,
  standardizationPct: 0,
  areaSqft: 0,
  wwrPct: 0,
  uValue: 0,
  cost: 0,
};
import { renderFacadeSelection } from './facade/render';
import type { AssemblyMetadata } from './facade/metadata';
import {
  seedAssemblyMetadata,
  metadataForAssembly,
  fieldGroupsFor,
  facadeType,
  bandInchesFor,
  withBandInches,
} from './facade/catalog';
import { LoginModal } from './components/LoginModal/LoginModal';
import { useAuth } from './auth/useAuth';
import { firebaseEnabled } from './auth/firebase';
import { signOutUser } from './auth/auth';
import {
  loadUserData,
  saveUserConstraints,
  saveUserFacadeConstraints,
  saveUserAdjacency,
} from './auth/userData';
import { applyAdjacency, DEFAULT_ADJACENCY } from './rooms/roomAdjacency';
import { useWindowSize } from './hooks/useWindowSize';
import { DEFAULT_GRID_SIZE } from './constants';

export default function App() {
  // Imperative bridge: the button drives square placement on the canvas without
  // either component re-rendering during interaction.
  const canvasHandle = useRef<CanvasHandle>(null);

  const { width } = useWindowSize();

  // Central nav pill's screen edges — lets the StatsBar centre each stat pair in
  // the open space beside the menu (rather than jammed to the screen edges).
  const [navBounds, setNavBounds] = useState<{ left: number; right: number } | null>(null);

  // Constraints: the textbox content (seeded from constraints_file.txt) and the
  // structured rules parsed from it. Parsing is debounced and runs off the main
  // thread of typing, so the LLM is hit at most once after the user pauses.
  //
  // There are TWO independent rule sets, one per editor mode, kept side by side rather than merged: a
  // floorplan is judged on room areas and wall thicknesses, a facade on panel sizes, glazing ratio, and
  // cost. Each is edited, parsed, persisted, and enforced on its own; the Constraints box shows whichever
  // belongs to the current mode, and the canvas enforces only that one.
  const [constraintsText, setConstraintsText] = useState(constraintsFile);
  const [constraints, setConstraints] = useState<Constraints>(EMPTY_CONSTRAINTS);
  const [facadeConstraintsText, setFacadeConstraintsText] = useState(facadeConstraintsFile);
  const [facadeConstraints, setFacadeConstraints] =
    useState<FacadeConstraints>(EMPTY_FACADE_CONSTRAINTS);

  // Adjacency Matrix window (room-prediction rank editor) — opened from the Generate submenu. It tunes
  // what Generate reaches for next, so it is no longer behind the Dev toggle.
  const [matrixOpen, setMatrixOpen] = useState(false);
  // Catalog key of the room the cursor is over, used to highlight its row/column in the
  // matrix. Only tracked while the matrix is open (gated below) to avoid re-renders otherwise.
  const [hoverRoomKey, setHoverRoomKey] = useState<string | null>(null);
  const matrixHoverGate = useRef(false);
  useEffect(() => {
    matrixHoverGate.current = matrixOpen;
    if (!matrixHoverGate.current) setHoverRoomKey(null);
  }, [matrixOpen]);
  const handleHoverRoomKey = useCallback((key: string | null) => {
    if (!matrixHoverGate.current) return;
    setHoverRoomKey((prev) => (prev === key ? prev : key));
  }, []);

  // Auth: the Firebase session (null = signed out) and whether the first auth state has
  // arrived. `guest` is a session-only "skip sign-in" flag set from the login modal.
  const { user, authResolved } = useAuth();
  const [guest, setGuest] = useState(false);

  // Guided demo: null when not running. The overlay owns which mode and which step; App only owns the
  // switch and the context object the script drives the app through.
  const [demoOpen, setDemoOpen] = useState(false);
  // Nav popups are owned by the NavBar, so the script asks for one via a bumped sequence number.
  const [panelRequest, setPanelRequest] = useState<{
    panel: 'constraints' | 'prompt' | 'library' | null;
    seq: number;
  } | null>(null);
  const panelSeq = useRef(0);
  // ...and reports back which one ended up open, however it was opened (the tour presses the real nav
  // buttons as often as it asks). Stepping BACK in the tour restores the view a step ended on, and the
  // open panel is part of that view. A ref, not state: nothing here re-renders on it.
  const openPanelRef = useRef<'constraints' | 'prompt' | 'library' | null>(null);
  const handlePanelChange = useCallback((panel: 'constraints' | 'prompt' | 'library' | null) => {
    openPanelRef.current = panel;
  }, []);
  // The title bar, so pressing Demo can bank whatever is on the canvas before the tour takes it over.
  const topBarRef = useRef<TopBarHandle>(null);
  /**
   * Start the guided tour on an empty canvas — but never at the cost of the user's drawing.
   *
   * The tour drives the REAL canvas and builds from nothing, so it cannot run over existing geometry.
   * Banking first means the work is filed in the Saved list under its current title and is one click away
   * again as soon as the tour is over, instead of being silently thrown out by pressing Demo.
   */
  const handleDemo = useCallback(() => {
    topBarRef.current?.stashToSaved();
    setDemoOpen(true);
  }, []);

  // Saved Library clusters (persisted to localStorage). The Library button's screen
  // rect is the canvas's save drop-target; `libraryDragOver` highlights it mid-drag.
  const [library, setLibrary] = useState<LibraryCluster[]>(() => loadLibrary());
  const [libraryDragOver, setLibraryDragOver] = useState(false);
  const libraryButtonRectRef = useRef<DOMRect | null>(null);
  // Rect of the open Library popup (null when closed) — a second save drop-target.
  const libraryPopupRectRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    saveLibrary(library);
  }, [library]);

  // A selection dropped onto the Library button → store it as a new cluster (newest
  // first). Memoised so the canvas interaction effect doesn't re-subscribe needlessly.
  const addClusterToLibrary = useCallback((shapes: Square[]) => {
    if (shapes.length === 0) return;
    setLibrary((prev) => [makeCluster(shapes), ...prev]);
  }, []);

  const deleteCluster = useCallback((id: string) => {
    setLibrary((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // Rename a cluster; an empty title clears it back to the live "N spaces" count.
  const renameCluster = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    setLibrary((prev) =>
      prev.map((c) => (c.id === id ? { ...c, name: trimmed || undefined } : c)),
    );
  }, []);

  // Apply a drag-reordered saved-cluster order (persisted by the saveLibrary effect).
  const reorderClusters = useCallback((orderedIds: string[]) => {
    setLibrary((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is LibraryCluster => c != null);
      // Safety: keep any cluster not present in the incoming order (shouldn't happen).
      for (const c of prev) if (!orderedIds.includes(c.id)) next.push(c);
      return next;
    });
  }, []);

  const handleLibraryBounds = useCallback((rect: DOMRect) => {
    libraryButtonRectRef.current = rect;
  }, []);

  // Track the open Library popup's rect (null when closed) so dropping a selection onto the
  // popup itself also saves it — not just the Library button.
  const handleLibraryPopupBounds = useCallback((rect: DOMRect | null) => {
    libraryPopupRectRef.current = rect;
  }, []);

  // True while the Prompt box's LLM request is in flight (shows "Generating…").
  const [promptBusy, setPromptBusy] = useState(false);

  // Smart-find: match count from the last search (null = no active highlight). Drives
  // the "N matches · Esc to clear" chip; the canvas reports null when an edit clears it.
  const [findCount, setFindCount] = useState<number | null>(null);

  const clearFind = useCallback(() => {
    canvasHandle.current?.clearFind();
    setFindCount(null);
  }, []);

  // Whether the yellow constraint-violation highlights are shown on the canvas. The
  // Constraints "Visibility" eye toggles this; the violation count/superscript is
  // independent, so it keeps showing even when the highlights are hidden.
  const [constraintHighlightsOn, setConstraintHighlightsOn] = useState(true);

  // Editor mode shown in the TopBar ("Mode: Plan" ⇄ "Mode: Facade"). Lifted here so the
  // bottom cube (ActionButton) can switch to its Facade look when Facade is active.
  const [editorMode, setEditorMode] = useState<Mode>('Plan');

  // Analyze (nav toggle): shows/hides the live statistics along the bottom of the screen. On by
  // default in both modes — the readouts are the point, and the button is there to get them out of
  // the way. The same button does the same thing in both modes.
  const [statsVisible, setStatsVisible] = useState(true);
  // Facade mode's six readouts (area, WWR, U-value, panels, types, cost), re-read from the canvas
  // whenever the partition changes while they're on screen.
  const [facadeStats, setFacadeStats] = useState<FacadeMetrics>(EMPTY_FACADE_METRICS);

  // Facade-mode AI render: the idle/in-flight/finished render, plus the live selected-shape count
  // (gates the panel's Render button). Triggered by the NavBar Render button.
  const [render, setRender] = useState<RenderState | null>(null);
  const [selectionCount, setSelectionCount] = useState(0);

  // Facade "smart panel" assembly metadata, keyed by assembly type (e.g. "UCWP"). Shared by every
  // panel of a type — editing it in the inspector updates them all and feeds the render prompt.
  // `selectedPanel` is the single selected panel's live geometry + type (null otherwise), reported by
  // the canvas; it drives the inspector and the bidirectional size/band sync.
  const [assemblyMeta, setAssemblyMeta] = useState<Record<string, AssemblyMetadata>>(
    () => seedAssemblyMetadata(),
  );
  const [selectedPanel, setSelectedPanel] = useState<SelectedPanelInfo | null>(null);

  // Facade Layers tool (uniform sticky-cell partition): whether it's active, the live layer/cell summary
  // reported by the canvas (drives the top-center navigator), and the right-click cell-split popover.
  const [layersActive, setLayersActive] = useState(false);
  // Whether the tool was on when we last left Facade mode, so returning restores it (see the effect below).
  const layersOnLeavingFacadeRef = useRef(false);
  // Mirror of the live flag, so that effect can read it while running ONLY on a mode change.
  const layersActiveLiveRef = useRef(layersActive);
  layersActiveLiveRef.current = layersActive;
  // Material-ID (segmentation) view toggle for the Layers tool.
  const [idView, setIdView] = useState(false);
  // Purely-visual drop shadow under the per-group frame bands (depth only). Off by default.
  const [frameShadow, setFrameShadow] = useState(false);
  // Paint-by-number panel overlay (the "Panel Numbers" view switch).
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  // Edit-a-panel session: true while zoomed into a selected group editing its per-edge frame.
  const [editingFrame, setEditingFrame] = useState(false);
  const [facadeNav, setFacadeNav] = useState<FacadeSummary>(() => summarizeDoc(newDoc()));
  // The open panel menu: which cell Split/Edit act on, plus its live screen anchor. The anchor is republished
  // by the canvas on every scene draw from the CURRENT panel selection, so the bar sits under the bottom
  // centre of what's selected and follows it as it's dragged, panned, or zoomed.
  const [splitMenu, setSplitMenu] = useState<{
    /** Null until the canvas publishes the first anchor — the bar stays unmounted rather than
     *  flashing at a placeholder position for one frame. */
    x: number | null;
    y: number | null;
    ref: CellRef;
    rect: Rect | null;
    /** Whether the shape has been split yet — the panel actions only exist once it has panels. */
    subdivided: boolean;
    /** The shape's rationalization mode, ticked in the Optimize menu. */
    mode: PanelMode | null;
  } | null>(null);
  // Live faint preview of the pending split (cell ref + counts), shown on the canvas before Apply. The canvas
  // renders it from the actual resulting partition so it spans the whole boundary and clips like real panels.
  const [splitPreview, setSplitPreview] = useState<{ ref: CellRef; cols: number; rows: number } | null>(
    null,
  );
  // Hovered Assign option — the selected panels render in that material until the pointer leaves or the
  // option is clicked. Render-only; nothing reaches the document until then.
  const [kindPreview, setKindPreview] = useState<{ kind: PanelKind | null } | null>(null);
  // Hovered Optimize option — that shape renders as the strategy would leave it, uncommitted.
  const [optimizePreview, setOptimizePreview] = useState<{
    border: number;
    strategy: OptimizeStrategy;
  } | null>(null);

  // Stable so the canvas's pointer-listener effect doesn't re-subscribe on every App render. Opens with no
  // anchor yet; the canvas publishes the real one on the draw this triggers, and the bar mounts then.
  const handleCellMenu = useCallback(
    (info: { ref: CellRef; rect: Rect | null; subdivided: boolean; mode: PanelMode | null } | null) => {
      if (!info) {
        setSplitMenu(null);
        setSplitPreview(null);
        return;
      }
      setSplitMenu({
        x: null,
        y: null,
        ref: info.ref,
        rect: info.rect,
        subdivided: info.subdivided,
        mode: info.mode,
      });
    },
    [],
  );

  // Live anchor from the canvas. A null anchor means the selection is gone (its border was deleted) — close.
  const handleCellMenuAnchor = useCallback((anchor: { x: number; y: number } | null) => {
    setSplitMenu((prev) => {
      if (!prev) return prev;
      if (!anchor) return null;
      if (prev.x === anchor.x && prev.y === anchor.y) return prev; // no move → no re-render
      return { ...prev, x: anchor.x, y: anchor.y };
    });
  }, []);

  // Close the split menu and drop its preview together.
  const closeSplitMenu = useCallback(() => {
    setSplitMenu(null);
    setSplitPreview(null);
    setKindPreview(null);
    setOptimizePreview(null);
  }, []);

  // Pull the live facade readouts (drives the bottom statistics in Facade mode).
  const refreshFacadeStats = useCallback(() => {
    setFacadeStats(canvasHandle.current?.facadeMetrics() ?? EMPTY_FACADE_METRICS);
  }, []);

  // Toggle the paint-by-number panel overlay. It used to also expand the Optimize section; that section is
  // always on show now, so this is purely a view switch.
  const toggleOptimize = useCallback(() => setOptimizeOpen((open) => !open), []);

  // Rationalize the shape the panel bar belongs to (undoable), then re-read the unique-panel metric. The
  // bar closes with the selection the strategy invalidates, so the preview is cleared alongside it.
  const applyOptimize = useCallback(
    (strategy: OptimizeStrategy) => {
      const border = splitMenu?.ref.border;
      if (border == null) return;
      setOptimizePreview(null);
      canvasHandle.current?.optimizePartition(border, strategy);
    },
    [splitMenu],
  );

  // Edit-a-panel: start the session from the floating menu's Edit (zoom + auto-frame the selected group).
  const startFrameEdit = useCallback(() => {
    // Zoom to the panel that was clicked to open this menu, not the group's top-left cell.
    const res = canvasHandle.current?.startPanelFrameEdit(splitMenu?.rect ?? null);
    if (res) setEditingFrame(true);
    closeSplitMenu();
  }, [splitMenu, closeSplitMenu]);

  // Edit-a-panel: end the session (eases the camera back); the per-group frame persists.
  const endFrameEdit = useCallback(() => {
    canvasHandle.current?.endPanelFrameEdit();
    setEditingFrame(false);
  }, []);

  // The Layers tool is Facade-only, so it switches off on the way out of Facade mode — and back ON when we
  // return. Without the restore the partition (every border and panel drawn in Facade) simply isn't drawn on
  // re-entry, so the facade reads as EMPTY until the next cube gesture re-arms the tool and it all reappears.
  useEffect(() => {
    if (editorMode === 'Facade') {
      if (layersOnLeavingFacadeRef.current) setLayersActive(true);
      return;
    }
    layersOnLeavingFacadeRef.current = layersActiveLiveRef.current;
    setLayersActive(false);
  }, [editorMode]);

  // Close the Optimize popup whenever the Layers tool is off (also covers leaving Facade mode).
  useEffect(() => {
    if (!layersActive) setOptimizeOpen(false);
  }, [layersActive]);

  // End an Edit-a-panel session when the Layers tool turns off, and let Esc finish it too.
  useEffect(() => {
    if (!layersActive && editingFrame) endFrameEdit();
  }, [layersActive, editingFrame, endFrameEdit]);
  useEffect(() => {
    if (!editingFrame) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endFrameEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingFrame, endFrameEdit]);

  // Same for the bottom statistics: re-read the facade readouts on every partition change while they're
  // showing. Material assignments don't move geometry (so `facadeNav` is unchanged) — that path refreshes
  // them directly where the assignment is made.
  useEffect(() => {
    if (statsVisible && editorMode === 'Facade') refreshFacadeStats();
  }, [statsVisible, editorMode, facadeNav, refreshFacadeStats]);

  // Edit a type-level (non-band) metadata field — applies to the whole assembly type.
  const handleAssemblyFieldChange = useCallback(
    (assembly: string, key: keyof AssemblyMetadata, value: string | number) => {
      setAssemblyMeta((prev) => ({
        ...prev,
        [assembly]: { ...metadataForAssembly(prev, assembly), [key]: value },
      }));
    },
    [],
  );

  // Pick a different facade type for the selected panel (canvas sets name + band, keeps size).
  const handleChangeType = useCallback((key: string) => {
    canvasHandle.current?.setSelectionAssembly(key);
  }, []);

  // Resize the selected panel (per-panel). Edit the band width (type-level) → canvas is the source of
  // truth; it pushes the new band to every panel of the type and reports it back to sync the metadata.
  const handleChangeSize = useCallback((id: string, widthFt: number, heightFt: number) => {
    canvasHandle.current?.setShapeSize(id, widthFt, heightFt);
  }, []);
  const handleChangeBand = useCallback((assembly: string, inches: number) => {
    canvasHandle.current?.applyAssemblyBand(assembly, inches);
  }, []);

  // Bidirectional band sync (single source of truth = the canvas). Whenever the selected panel's live
  // band differs from the type metadata — from a canvas wall drag OR an inspector band edit — write it
  // into the metadata and propagate it to every sibling panel of that type.
  useEffect(() => {
    if (!selectedPanel) return;
    const type = selectedPanel.assembly;
    const metaBand = bandInchesFor(metadataForAssembly(assemblyMeta, type), type);
    if (Math.abs(metaBand - selectedPanel.bandIn) > 1e-3) {
      setAssemblyMeta((prev) => ({
        ...prev,
        [type]: withBandInches(metadataForAssembly(prev, type), type, selectedPanel.bandIn),
      }));
      canvasHandle.current?.applyAssemblyBand(type, selectedPanel.bandIn);
    }
  }, [selectedPanel, assemblyMeta]);

  // Single-pass render: one reference image of the selection + one category-aware prompt → one call.
  const runRender = useCallback(
    async (shapes: Square[], count: number) => {
      setRender({ status: 'loading', count });
      try {
        const { image, prompt } = await renderFacadeSelection({ shapes, metaByAssembly: assemblyMeta });
        setRender({ status: 'done', image, count, prompt });
      } catch (err) {
        setRender({
          status: 'error',
          error: err instanceof Error ? err.message : 'Render failed.',
          count,
        });
      }
    },
    [assemblyMeta],
  );

  // Render the current selection. With nothing selected the panel still opens in an idle state
  // ("Select geometry to render.") and its Render button stays disabled until geometry is selected.
  const handleRender = useCallback(() => {
    const sel = canvasHandle.current?.captureSelectionShapes();
    if (sel) void runRender(sel.shapes, sel.count);
    else setRender({ status: 'idle', count: 0 });
  }, [runRender]);

  // A nav popup (Constraints/Generate/Library) just opened → close the Render popup so only one
  // top-right popup is shown at a time.
  const handlePanelOpenChange = useCallback((open: boolean) => {
    if (open) setRender(null);
  }, []);

  // Guided constraint-fix flow: the current review step, or null when no session is
  // running. The canvas owns the session; this drives the Skip/Approve pill in the nav.
  const [fixStep, setFixStep] = useState<FixResult | null>(null);

  // Store a fresh step, or end the session (restoring the camera) once nothing's left.
  const settleFix = useCallback((r: FixResult | undefined) => {
    if (!r || r.done) {
      canvasHandle.current?.fixCancel();
      setFixStep(null);
    } else {
      setFixStep(r);
    }
  }, []);
  const startFix = useCallback(() => {
    setConstraintHighlightsOn(true); // make the violation visible under the ghost
    settleFix(canvasHandle.current?.fixStart());
  }, [settleFix]);
  const fixApprove = useCallback(
    () => settleFix(canvasHandle.current?.fixApprove()),
    [settleFix],
  );
  const fixSkip = useCallback(() => settleFix(canvasHandle.current?.fixSkip()), [settleFix]);
  const fixActive = fixStep != null && !fixStep.done;
  const fixCanApprove = fixStep != null && !fixStep.done && fixStep.canAutoFix;

  // True while a Save'd constraints text is being (re-)parsed and applied — the
  // Constraints box shows "Saving…" and stays open until this clears.
  const [constraintsBusy, setConstraintsBusy] = useState(false);

  // Save handler: adopt the new text, then parse + apply it. The Constraints box
  // watches `constraintsBusy` and closes itself the moment the rules are applied,
  // so "Saving…" reflects the real round-trip (LLM, or the local fallback).
  // Set + parse + apply the constraints text (no account write — used by load/reset too).
  const applyConstraintsText = useCallback(async (text: string) => {
    setConstraintsText(text);
    setConstraintsBusy(true);
    try {
      setConstraints(await parseConstraints(text));
    } finally {
      setConstraintsBusy(false);
    }
  }, []);

  // The facade twin: its own text, its own parser, its own rule object. Never merged with the plan set.
  const applyFacadeConstraintsText = useCallback(async (text: string) => {
    setFacadeConstraintsText(text);
    setConstraintsBusy(true);
    try {
      setFacadeConstraints(await parseFacadeConstraints(text));
    } finally {
      setConstraintsBusy(false);
    }
  }, []);

  // A user-initiated Save (from the Constraints editor / Reset defaults): apply, then —
  // when signed in — persist the text to the user's account. Routed by the CURRENT mode, so the box
  // always edits the rule set it is showing.
  const handleConstraintsSave = async (text: string) => {
    if (editorMode === 'Facade') {
      await applyFacadeConstraintsText(text);
      if (user) void saveUserFacadeConstraints(user.uid, text);
      return;
    }
    await applyConstraintsText(text);
    if (user) void saveUserConstraints(user.uid, text);
  };

  // Persist adjacency-matrix edits to the signed-in user's account (called by the dev
  // AdjacencyMatrix after Apply/Reset). No-op for guests / when Firebase is off.
  const handleAdjacencyPersist = useCallback(
    (next: Record<string, Record<string, number>>) => {
      if (user) void saveUserAdjacency(user.uid, next);
    },
    [user],
  );

  // Handle a Prompt-box submission. A search-style prompt ("show me all kitchens")
  // runs an instant local find + highlight; anything else is parsed by the LLM and
  // built as new rooms (e.g. "5 15'x15' rooms").
  const handlePromptSubmit = async (text: string) => {
    if (isFindQuery(text)) {
      const n = canvasHandle.current?.runFind(text) ?? 0;
      setFindCount(n); // no LLM, no busy state — find is synchronous and local
      return;
    }
    setPromptBusy(true);
    try {
      const spec = await parsePrompt(text);
      // The catalog resolver is the visible name→size translation step.
      const placed = resolveRoomList(spec.rooms);
      if (placed.length > 0) {
        canvasHandle.current?.createRoomsFromList(placed);
      }
    } finally {
      setPromptBusy(false);
    }
  };

  // Live canvas stats — drives the bottom StatsBar (fades in at roomCount ≥ 1).
  const [stats, setStats] = useState<CanvasStats>({
    roomCount: 0,
    constraintFlags: 0,
    totalAreaSqft: 0,
    grossAreaSqft: 0,
    usableAreaSqft: 0,
    totalAreaExceeded: false,
    grossAreaExceeded: false,
    roomCountExceeded: false,
    facadeGlobalExceeded: false,
    violatedKeys: [],
  });

  useEffect(() => {
    // Parse BOTH seeded rule sets once on mount (the regex fallback in
    // parseConstraints covers the no-API-key case). Every later change comes
    // through Save → handleConstraintsSave, which parses and applies explicitly.
    let cancelled = false;
    parseConstraints(constraintsText).then((next) => {
      if (!cancelled) setConstraints(next);
    });
    parseFacadeConstraints(facadeConstraintsText).then((next) => {
      if (!cancelled) setFacadeConstraints(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync app state with the auth session: on a fresh sign-in, load the account's saved
  // constraints + adjacency and apply them; on sign-out, restore the built-in defaults so
  // one account's data never leaks into the next session. Tracks the previous uid so the
  // initial signed-out state (guest / pre-auth) doesn't trigger a spurious reset.
  const prevUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authResolved) return;
    const uid = user?.uid ?? null;
    if (uid && uid !== prevUidRef.current) {
      prevUidRef.current = uid;
      void loadUserData(uid).then((data) => {
        if (!data) return;
        if (typeof data.constraintsText === 'string') void applyConstraintsText(data.constraintsText);
        if (typeof data.facadeConstraintsText === 'string') {
          void applyFacadeConstraintsText(data.facadeConstraintsText);
        }
        if (data.adjacency) applyAdjacency(data.adjacency);
      });
    } else if (!uid && prevUidRef.current) {
      prevUidRef.current = null;
      void applyConstraintsText(constraintsFile);
      void applyFacadeConstraintsText(facadeConstraintsFile);
      applyAdjacency(JSON.parse(JSON.stringify(DEFAULT_ADJACENCY)));
    }
  }, [user, authResolved, applyConstraintsText, applyFacadeConstraintsText]);

  // What the guided demo is allowed to touch — the real handle and the real setters, never a mock, so the
  // tour cannot drift from the product. `scene` carries the world rect a step built forward to later steps.
  const demoScene = useRef<{ rect: Rect | null; stage: number }>({ rect: null, stage: 0 });
  // Live mirror of the editor mode — a running demo step reads this rather than its snapshot.
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  const demoCtx: Omit<DemoContext, 'ui'> = {
    canvas: canvasHandle.current,
    getMode: () => editorModeRef.current,
    // World → viewport, so the tour's cursor can point at what the canvas is doing.
    toScreen: (w) => canvasHandle.current?.worldToClient(w) ?? { x: 0, y: 0 },
    setMode: setEditorMode,
    setLayersActive,
    setIdView,
    setPanelNumbers: setOptimizeOpen,
    setFrameShadow,
    setStatsVisible,
    setConstraintHighlights: setConstraintHighlightsOn,
    openPanel: (panel) => {
      panelSeq.current += 1;
      setPanelRequest({ panel, seq: panelSeq.current });
    },
    // Everything the tour's own switches can change, read live — what a step ends on is what stepping back
    // to it has to put back.
    getView: () => ({
      mode: editorModeRef.current,
      layers: layersActiveLiveRef.current,
      idView,
      panelNumbers: optimizeOpen,
      frameShadow,
      stats: statsVisible,
      highlights: constraintHighlightsOn,
      panel: openPanelRef.current,
    }),
    scene: demoScene.current,
  };

  // Esc clears an active smart-find highlight (and its chip).
  useEffect(() => {
    if (findCount === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearFind();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findCount, clearFind]);

  // Esc ends an active constraint-fix session (restoring the camera).
  useEffect(() => {
    if (!fixActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        canvasHandle.current?.fixCancel();
        setFixStep(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fixActive]);

  return (
    <>
      <InfiniteCanvas
        ref={canvasHandle}
        gridSize={DEFAULT_GRID_SIZE}
        constraints={constraints}
        facadeConstraints={facadeConstraints}
        facade={editorMode === 'Facade'}
        showConstraintHighlights={constraintHighlightsOn}
        onStatsChange={setStats}
        onSelectionChange={setSelectionCount}
        onSelectedPanelChange={setSelectedPanel}
        layersActive={layersActive && editorMode === 'Facade'}
        idView={idView}
        frameShadow={frameShadow}
        panelNumbers={optimizeOpen || idView}
        splitPreview={splitPreview}
        kindPreview={kindPreview}
        optimizePreview={optimizePreview}
        onPartitionChange={setFacadeNav}
        onCellMenu={handleCellMenu}
        menuCell={splitMenu?.ref ?? null}
        onCellMenuAnchorChange={handleCellMenuAnchor}
        onExitFrameEdit={endFrameEdit}
        libraryDropRef={libraryButtonRectRef}
        libraryPopupDropRef={libraryPopupRectRef}
        onLibraryHover={setLibraryDragOver}
        onLibraryDrop={addClusterToLibrary}
        onFindChange={setFindCount}
        onHoverRoomKey={handleHoverRoomKey}
      />
      <TopBar
        ref={topBarRef}
        mode={editorMode}
        onModeChange={setEditorMode}
        canvasRef={canvasHandle}
      />
      {/* Facade Layers tool: right-docked control panel (view switches + Optimize settings). */}
      {editorMode === 'Facade' && layersActive && (
        <FacadePanel
          idView={idView}
          frameShadow={frameShadow}
          optimizeActive={optimizeOpen}
          onToggleIdView={() => setIdView((v) => !v)}
          onToggleFrameShadow={() => setFrameShadow((v) => !v)}
          onToggleOptimize={toggleOptimize}
        />
      )}
      {/* Facade Layers tool: the floating panel menu, bottom-centred under the selected panel(s). */}
      {editorMode === 'Facade' && layersActive && splitMenu && splitMenu.x != null && splitMenu.y != null && (
        <CellSplitMenu
          x={splitMenu.x}
          y={splitMenu.y}
          canEditPanels={splitMenu.subdivided}
          onChange={(cols, rows) =>
            setSplitPreview(splitMenu.rect ? { ref: splitMenu.ref, cols, rows } : null)
          }
          onApply={(cols, rows) => {
            canvasHandle.current?.splitCell(splitMenu.ref, cols, rows);
            closeSplitMenu();
          }}
          onClose={closeSplitMenu}
          onEdit={startFrameEdit}
          onPreviewKind={setKindPreview}
          panelMode={splitMenu.mode}
          onOptimize={applyOptimize}
          onPreviewStrategy={(strategy) =>
            setOptimizePreview(strategy ? { border: splitMenu.ref.border, strategy } : null)
          }
          onAssignKind={(kind) => {
            canvasHandle.current?.assignPanelKind(kind);
            // A material swap changes WWR / U-value / cost without moving any geometry, so the
            // partition-change effect above won't fire — re-read the readouts here.
            refreshFacadeStats();
            closeSplitMenu();
          }}
        />
      )}
      {/* Global budget breach — in Plan mode Max Total Area / Max Total Gross Area / Max Room Count, in
          Facade mode a whole-elevation rule (WWR, U-value, standardization, counts, cost). Either way the
          rule describes the drawing as a whole rather than one unit, so it washes the canvas the constraint
          yellow until the design is back in range. Sits at z-index 1 — between the grid (0) and the
          scene/shape layer (2) — so it reads as a background BEHIND the rooms, leaving
          per-room flags (edges, infills) visible on top. Non-interactive so it never
          blocks canvas gestures. */}
      {constraintHighlightsOn &&
        (stats.totalAreaExceeded ||
          stats.grossAreaExceeded ||
          stats.roomCountExceeded ||
          stats.facadeGlobalExceeded) && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            background: 'rgba(250, 204, 21, 0.22)',
          }}
        />
      )}
      {/* The Constraints box edits whichever rule set belongs to the current mode — same editor, two
          bodies of rules. `constraintsScope` also tells it which parser to map lines to keys with, so the
          violated-line highlighting stays correct on both. */}
      <NavBar
        constraintsScope={editorMode}
        constraintsText={editorMode === 'Facade' ? facadeConstraintsText : constraintsText}
        onConstraintsTextChange={handleConstraintsSave}
        defaultConstraintsText={editorMode === 'Facade' ? facadeConstraintsFile : constraintsFile}
        constraintsBusy={constraintsBusy}
        violatedConstraintKeys={stats.violatedKeys}
        constraintHighlightsVisible={constraintHighlightsOn}
        onToggleConstraintHighlights={() => setConstraintHighlightsOn((v) => !v)}
        analyzeActive={statsVisible}
        onToggleAnalyze={() => setStatsVisible((v) => !v)}
        onPanelOpenChange={handlePanelOpenChange}
        requestPanel={panelRequest}
        onPanelChange={handlePanelChange}
        matrixOpen={matrixOpen}
        onToggleMatrix={() =>
          setMatrixOpen((open) => {
            if (!open) setRender(null); // one top-right card at a time
            return !open;
          })
        }
        onFix={startFix}
        // The guided auto-fix wand reshapes ROOMS, so it has nothing to act on in Facade mode.
        fixSupported={editorMode !== 'Facade'}
        findMatchCount={findCount}
        onBoundsChange={setNavBounds}
        onPromptSubmit={handlePromptSubmit}
        promptBusy={promptBusy}
        canvasRef={canvasHandle}
        library={library}
        constraintFlagCount={stats.constraintFlags}
        onDeleteCluster={deleteCluster}
        onRenameCluster={renameCluster}
        onReorderClusters={reorderClusters}
        onLibraryBoundsChange={handleLibraryBounds}
        onLibraryPopupBoundsChange={handleLibraryPopupBounds}
        libraryDragActive={libraryDragOver}
        fixActive={fixActive}
        fixCanApprove={fixCanApprove}
        onFixApprove={fixApprove}
        onFixSkip={fixSkip}
      >
        <ActionButton
          canvasRef={canvasHandle}
          facade={editorMode === 'Facade'}
          onArmFacadeBorder={() => setLayersActive(true)}
        />
      </NavBar>
      <StatsBar
        visible={statsVisible}
        facade={editorMode === 'Facade'}
        facadeMetrics={facadeStats}
        roomCount={stats.roomCount}
        roomCountExceeded={stats.roomCountExceeded}
        totalAreaSqft={stats.totalAreaSqft}
        totalAreaExceeded={stats.totalAreaExceeded}
        grossAreaSqft={stats.grossAreaSqft}
        grossAreaExceeded={stats.grossAreaExceeded}
        usableAreaSqft={stats.usableAreaSqft}
        navBounds={navBounds}
        viewportWidth={width}
      />
      {matrixOpen && (
        <AdjacencyMatrix
          key={user?.uid ?? 'guest'}
          onClose={() => setMatrixOpen(false)}
          onPersist={handleAdjacencyPersist}
          hoveredKey={hoverRoomKey}
        />
      )}
      {/* Top-right action cluster (Demo + sign-out). Always on screen — including over the
          login modal — so it doesn't pop in after sign-in / continue-as-guest. Sign-out signs a
          real user out or ends a guest session (a harmless no-op on the login screen itself). */}
      <TopRightBar
        onDemo={handleDemo}
        email={user?.email}
        onSignOut={() => {
          void signOutUser();
          setGuest(false);
        }}
      />
      {/* Facade mode: left "smart panel" inspector for the single selected panel. The title picks the
          facade type; size + band edits flow to the canvas (and back); other fields edit the
          type-level metadata (every panel of it) and feed the render prompt. */}
      {editorMode === 'Facade' && selectedPanel && (
        <AssemblyInspector
          assembly={selectedPanel.assembly}
          meta={metadataForAssembly(assemblyMeta, selectedPanel.assembly)}
          fieldGroups={fieldGroupsFor(selectedPanel.assembly)}
          bandField={facadeType(selectedPanel.assembly).bandField}
          widthFt={selectedPanel.widthFt}
          heightFt={selectedPanel.heightFt}
          onChangeType={handleChangeType}
          onChange={(key, value) => handleAssemblyFieldChange(selectedPanel.assembly, key, value)}
          onChangeBand={(inches) => handleChangeBand(selectedPanel.assembly, inches)}
          onChangeSize={(w, h) => handleChangeSize(selectedPanel.id, w, h)}
        />
      )}
      {/* Facade mode: floating render preview (triggered by the NavBar Render button). */}
      {render && (
        <RenderPanel
          state={render}
          selectionCount={selectionCount}
          onRender={handleRender}
          onClose={() => setRender(null)}
        />
      )}
      {demoOpen && <DemoOverlay ctx={demoCtx} onExit={() => setDemoOpen(false)} />}
      {authResolved && !user && !guest && (
        <LoginModal enabled={firebaseEnabled} onGuest={() => setGuest(true)} />
      )}
    </>
  );
}
