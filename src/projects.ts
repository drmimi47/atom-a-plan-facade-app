import type { Footprint, LengthUnit, Square } from './types';
import type { FacadeDoc } from './facade/partition';

/**
 * One mode's workspace. Plan and Facade each keep their own rooms/panels + footprints,
 * so a project has to carry both — saving in Plan mode must not lose the Facade work.
 */
export interface WorkspaceState {
  shapes: Square[];
  footprints: Footprint[];
}

/**
 * Everything that makes up a drawing, as plain serialisable data: both mode workspaces,
 * the facade partition document, and the active measurement unit. A `null` workspace means
 * that mode was never visited, matching the canvas's own "starts empty" state.
 */
export interface ProjectSnapshot {
  plan: WorkspaceState | null;
  facade: WorkspaceState | null;
  partition: FacadeDoc;
  unit: LengthUnit;
}

/** A named drawing in the Saved list. */
export interface SavedProject {
  id: string;
  name: string;
  snapshot: ProjectSnapshot;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'obd.projects.v1';

/** The name a project falls back to when the title pill is left blank. */
export const UNTITLED_PROJECT = 'Untitled Project';

/**
 * True when a snapshot holds no drawing at all — no rooms, no footprints, no facade
 * boundary. A pristine canvas like this isn't worth an entry in the Saved list.
 */
export function isEmptySnapshot(snapshot: ProjectSnapshot): boolean {
  const blank = (w: WorkspaceState | null) => !w || (w.shapes.length === 0 && w.footprints.length === 0);
  const noPartition = snapshot.partition.layers.every((l) => l.borders.length === 0);
  return blank(snapshot.plan) && blank(snapshot.facade) && noPartition;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `prj_${Math.random().toString(36).slice(2)}`;
}

/** Load saved projects from localStorage, newest-saved first (returns [] on any error). */
export function loadProjects(): SavedProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedProject[]) : [];
  } catch {
    return [];
  }
}

/** Persist projects to localStorage (best-effort; ignores quota/serialisation errors). */
export function saveProjects(projects: SavedProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // ignore (private mode / quota); the in-memory list still works this session.
  }
}

/**
 * Write `snapshot` into the list under `name`. Passing the id of an existing project
 * overwrites it in place (a re-save keeps its slot in the list); anything else appends a
 * new entry. Returns the new list and the id the drawing now lives under, so the caller
 * can keep tracking it across further saves.
 */
export function upsertProject(
  projects: SavedProject[],
  id: string | null,
  name: string,
  snapshot: ProjectSnapshot,
): { projects: SavedProject[]; id: string } {
  const now = Date.now();
  const index = id ? projects.findIndex((p) => p.id === id) : -1;
  if (index >= 0) {
    const next = projects.slice();
    next[index] = { ...next[index], name, snapshot, updatedAt: now };
    return { projects: next, id: next[index].id };
  }
  const created: SavedProject = { id: newId(), name, snapshot, createdAt: now, updatedAt: now };
  return { projects: [...projects, created], id: created.id };
}
