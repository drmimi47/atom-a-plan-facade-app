import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, firebaseEnabled } from './firebase';

/** A signed-in user's saved app state, stored at Firestore `users/{uid}`. */
export interface UserData {
  /** The raw PLAN constraints text the user last saved (seeds the Constraints editor in Plan mode). */
  constraintsText?: string;
  /**
   * The raw FACADE constraints text the user last saved. Stored separately because the two rule sets are
   * separate: each mode edits, parses, and enforces only its own, so they must round-trip independently.
   */
  facadeConstraintsText?: string;
  /** The user's room-prediction adjacency table (overrides the live ADJACENCY on load). */
  adjacency?: Record<string, Record<string, number>>;
  /** Last write time (ms epoch), for reference/debugging. */
  updatedAt?: number;
}

/** Read a user's saved data, or null when absent / Firebase disabled / on error. */
export async function loadUserData(uid: string): Promise<UserData | null> {
  if (!firebaseEnabled || !db) return null;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? (snap.data() as UserData) : null;
  } catch {
    return null; // offline / rules / transient — fall back to in-app defaults
  }
}

/** Merge-save the user's constraints text. No-op when Firebase is disabled. */
export async function saveUserConstraints(uid: string, constraintsText: string): Promise<void> {
  if (!firebaseEnabled || !db) return;
  try {
    await setDoc(doc(db, 'users', uid), { constraintsText, updatedAt: Date.now() }, { merge: true });
  } catch {
    // best-effort; the edit still applies locally this session
  }
}

/** Merge-save the user's FACADE constraints text. No-op when Firebase is disabled. */
export async function saveUserFacadeConstraints(
  uid: string,
  facadeConstraintsText: string,
): Promise<void> {
  if (!firebaseEnabled || !db) return;
  try {
    await setDoc(
      doc(db, 'users', uid),
      { facadeConstraintsText, updatedAt: Date.now() },
      { merge: true },
    );
  } catch {
    // best-effort; the edit still applies locally this session
  }
}

/** Merge-save the user's adjacency table. No-op when Firebase is disabled. */
export async function saveUserAdjacency(
  uid: string,
  adjacency: Record<string, Record<string, number>>,
): Promise<void> {
  if (!firebaseEnabled || !db) return;
  try {
    await setDoc(doc(db, 'users', uid), { adjacency, updatedAt: Date.now() }, { merge: true });
  } catch {
    // best-effort
  }
}
