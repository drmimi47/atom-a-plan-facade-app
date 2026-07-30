import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react';
import styles from './TopBar.module.css';
import type { CanvasHandle } from '../InfiniteCanvas/InfiniteCanvas';
import { newDoc } from '../../facade/partition';
import {
  isEmptySnapshot,
  loadProjects,
  saveProjects,
  upsertProject,
  UNTITLED_PROJECT,
  type SavedProject,
} from '../../projects';

/** Available editor modes shown in the "Mode:" pill. */
const MODES = ['Plan', 'Facade'] as const;
export type Mode = (typeof MODES)[number];

interface TopBarProps {
  /** Current editor mode (controlled by the parent so other UI can react to it). */
  mode: Mode;
  /** Called with the next mode when the "Mode:" pill is clicked. */
  onModeChange: (mode: Mode) => void;
  /** The canvas, for reading the drawing to save and writing back the one to load. */
  canvasRef: RefObject<CanvasHandle>;
}

/** What the rest of the app can ask the title bar to do. */
export interface TopBarHandle {
  /**
   * Put whatever is on the canvas into the Saved list and hand back an empty one.
   *
   * The guided tour drives the real canvas, so it has to start from an empty one — but the user may have
   * been drawing when they pressed Demo, and clearing that without a word would destroy it. This is the
   * same save-then-clear "+" performs, so the work lands in the Saved list under its current title and can
   * be opened again the moment the tour is over. A drawing already in the list unchanged is not saved
   * twice, and a blank canvas is not saved at all.
   */
  stashToSaved(): void;
}

/**
 * Top-left toolbar — the "Mode:" pill (toggles Plan ⇄ Facade), the editable document-title
 * pill, and the Save / New pair. Save (or Ctrl/Cmd+S) writes the drawing to the Saved list
 * under the current title and opens that list; "+" starts a fresh drawing, saving the
 * current one first if it has unsaved work. Clicking a name in the list loads it back.
 * Mode is owned by the parent; the drawing itself lives in the canvas.
 */
export const TopBar = forwardRef<TopBarHandle, TopBarProps>(function TopBar(
  { mode, onModeChange, canvasRef },
  ref,
) {
  const [title, setTitle] = useState(UNTITLED_PROJECT);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clicking the "Mode:" pill cycles to the next mode (parent holds the value).
  const cycleMode = () => onModeChange(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);

  // The Saved list, and which entry the canvas is currently showing (null = this drawing
  // has never been saved, so the next save creates a new entry rather than overwriting).
  const [projects, setProjects] = useState<SavedProject[]>(() => loadProjects());
  const [currentId, setCurrentId] = useState<string | null>(null);
  // The Saved flyout under the Save pill.
  const [savedOpen, setSavedOpen] = useState(false);
  const savedWrapRef = useRef<HTMLDivElement>(null);

  // Focus + select the whole title when entering edit mode (easy to replace).
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Close the Saved flyout on an outside click or Escape.
  useEffect(() => {
    if (!savedOpen) return;
    const onDown = (e: MouseEvent) => {
      if (savedWrapRef.current && !savedWrapRef.current.contains(e.target as Node)) {
        setSavedOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSavedOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [savedOpen]);

  /**
   * Write the canvas to the Saved list under `name`. Re-saving a drawing that came from
   * the list overwrites its entry (`currentId`) instead of piling up duplicates.
   */
  const saveCurrent = useCallback(
    (name: string): SavedProject[] => {
      const snapshot = canvasRef.current?.snapshotProject();
      if (!snapshot) return projects;
      const result = upsertProject(projects, currentId, name.trim() || UNTITLED_PROJECT, snapshot);
      setProjects(result.projects);
      setCurrentId(result.id);
      saveProjects(result.projects);
      return result.projects;
    },
    [canvasRef, currentId, projects],
  );

  // Save, and show the list so the name that was just added is visible.
  const handleSave = useCallback(() => {
    saveCurrent(title);
    setSavedOpen(true);
  }, [saveCurrent, title]);

  // Ctrl/Cmd+S saves instead of opening the browser's own save dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      e.preventDefault();
      handleSave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSave]);

  /**
   * Bank the current drawing and hand back a blank canvas.
   *
   * The current one is saved first unless it's already in the list unchanged, so replacing what's on
   * screen can't lose work; then the canvas is emptied and the title reset, with no entry selected so the
   * next save creates a fresh one. An untouched canvas is skipped — this shouldn't litter the list with
   * empties. Shared by "+" and by starting the guided tour: both are about to replace the drawing, and
   * neither is allowed to destroy it.
   */
  const stash = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshot = canvas.snapshotProject();
    const stored = currentId ? projects.find((p) => p.id === currentId) : null;
    const unsaved =
      !stored || stored.name !== title || JSON.stringify(stored.snapshot) !== JSON.stringify(snapshot);
    if (unsaved && !isEmptySnapshot(snapshot)) saveCurrent(title);
    canvas.loadProject({ plan: null, facade: null, partition: newDoc(), unit: 'feet' });
    setCurrentId(null);
    setTitle(UNTITLED_PROJECT);
  }, [canvasRef, currentId, projects, saveCurrent, title]);

  /** "+" → a blank drawing, with the Saved list opened on what was just banked. */
  const handleNew = useCallback(() => {
    stash();
    setSavedOpen(true);
  }, [stash]);

  useImperativeHandle(
    ref,
    () => ({
      stashToSaved: () => {
        stash();
        // Deliberately NOT opening the Saved flyout the way "+" does. The tour is about to drive the whole
        // screen, and a menu hanging over the canvas is precisely the obstruction this is clearing.
        setSavedOpen(false);
      },
    }),
    [stash],
  );

  /** Click a name in the Saved list → load that drawing onto the canvas. */
  const handleOpen = useCallback(
    (project: SavedProject) => {
      canvasRef.current?.loadProject(project.snapshot);
      setCurrentId(project.id);
      setTitle(project.name);
      setSavedOpen(false);
    },
    [canvasRef],
  );

  const startEdit = () => {
    setDraft(title);
    setEditing(true);
  };
  const commit = () => {
    setTitle(draft.trim() || UNTITLED_PROJECT);
    setEditing(false);
  };

  return (
    <div className={styles.bar}>
      <button
        type="button"
        data-demo="mode"
        className={`${styles.pill} ${styles.modeBtn}`}
        onClick={cycleMode}
      >
        Mode: {mode}
      </button>
      <span className={styles.sep} aria-hidden="true">&gt;</span>
      {editing ? (
        <input
          ref={inputRef}
          className={`${styles.pill} ${styles.title} ${styles.titleInput}`}
          value={draft}
          spellCheck={false}
          aria-label="Rename plan"
          // Monospace font → 1ch == one character; + 36px for the pill's padding/border.
          style={{ width: `calc(${Math.max(draft.length, 1)}ch + 36px)` }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`${styles.pill} ${styles.title} ${styles.titleBtn}`}
          onClick={startEdit}
          title="Rename"
        >
          {title}
        </button>
      )}
      <span className={styles.sep} aria-hidden="true">/</span>
      <div className={styles.savedWrap} ref={savedWrapRef}>
        <button
          type="button"
          className={`${styles.pill} ${styles.saveBtn}`}
          onClick={handleSave}
          title="Save (Ctrl+S)"
          aria-haspopup="menu"
          aria-expanded={savedOpen}
        >
          Save
        </button>
        {savedOpen && (
          <div className={styles.savedMenu} role="menu">
            <div className={styles.savedHeader}>Saved</div>
            {projects.length === 0 ? (
              <div className={styles.savedEmpty}>No saved projects</div>
            ) : (
              projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${styles.savedRow} ${p.id === currentId ? styles.savedRowActive : ''}`}
                  role="menuitem"
                  onClick={() => handleOpen(p)}
                  title={`Open ${p.name}`}
                >
                  {p.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className={`${styles.pill} ${styles.newBtn}`}
        onClick={handleNew}
        aria-label="New project"
        title="New project"
      >
        +
      </button>
    </div>
  );
});
