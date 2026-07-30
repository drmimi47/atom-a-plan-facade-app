import {
  cellGroups,
  cellKey,
  hasPanels,
  isSubdivided,
  type FacadeLayer,
  type FacadeMetrics,
} from '../src/facade/partition';
import { WORLD_UNITS_PER_FOOT } from '../src/constants';
import type { FacadeConstraints } from './types';

/** A facade-constraint field name — used to report exactly which rule(s) are broken. */
export type FacadeConstraintKey = keyof FacadeConstraints;

/** What the active facade currently breaks. */
export interface FacadeViolations {
  /**
   * Cell keys of the panels breaking a per-panel rule (too wide, too tall, too small, too big). Same key
   * space the selection highlight uses, so the renderer can flag them by lookup with no extra geometry.
   */
  flaggedCells: Set<string>;
  /**
   * Which facade constraint fields are broken — per-panel and global together. Lets the Constraints box
   * wash the exact offending line, exactly as the plan-mode keys do.
   */
  flaggedKeys: FacadeConstraintKey[];
  /**
   * True when a GLOBAL rule is breached (WWR, U-value, standardization, type/panel count, cost). These
   * describe the elevation as a whole, so — like the plan-mode budgets — they wash the canvas instead of
   * pointing at one panel.
   */
  globalBreached: boolean;
  /** Panels breaking at least one per-panel rule (the StatsBar / nav flag count). */
  flaggedCount: number;
}

const EPS = 1e-6;

export const NO_FACADE_VIOLATIONS: FacadeViolations = {
  flaggedCells: new Set(),
  flaggedKeys: [],
  globalBreached: false,
  flaggedCount: 0,
};

/**
 * Detect which facade constraints the active layer violates. Pure and read-only — it flags, it never
 * reshapes the partition.
 *
 * Panel sizes come from the live cell rects (world → feet); the global rules read the already-computed
 * {@link FacadeMetrics} so the flags and the StatsBar readouts can never disagree.
 *
 * NOTHING is checked until the facade has actually been split into panels. An un-subdivided border reports
 * its whole extent as one cell (see {@link isSubdivided}), which is the bare elevation, not a fabricated
 * unit — measuring it would flag the entire facade as one oversized sheet of glass, and price and glaze it
 * as one too. Rules are about panels, so they wait for panels: the first split switches them on, and each
 * border earns its checks separately as it is split.
 */
export function findFacadeViolations(
  layer: FacadeLayer,
  metrics: FacadeMetrics,
  c: FacadeConstraints,
): FacadeViolations {
  if (!hasPanels(layer)) return NO_FACADE_VIOLATIONS;

  const flaggedCells = new Set<string>();
  const keys = new Set<FacadeConstraintKey>();

  const needsPanelWalk =
    c.maxPanelWidthFt != null ||
    c.minPanelWidthFt != null ||
    c.maxPanelHeightFt != null ||
    c.minPanelHeightFt != null ||
    c.maxPanelAreaSqft != null;

  if (needsPanelWalk) {
    for (const { rect, border } of cellGroups(layer)) {
      // A border the user hasn't split yet contributes one whole-extent pseudo-panel. Skip it, so dropping
      // a second boundary next to a finished one doesn't immediately light up as an oversized panel.
      if (!isSubdivided(layer, border)) continue;
      const wFt = rect.w / WORLD_UNITS_PER_FOOT;
      const hFt = rect.h / WORLD_UNITS_PER_FOOT;
      let bad = false;
      if (c.maxPanelWidthFt != null && wFt > c.maxPanelWidthFt + EPS) {
        keys.add('maxPanelWidthFt');
        bad = true;
      }
      if (c.minPanelWidthFt != null && wFt < c.minPanelWidthFt - EPS) {
        keys.add('minPanelWidthFt');
        bad = true;
      }
      if (c.maxPanelHeightFt != null && hFt > c.maxPanelHeightFt + EPS) {
        keys.add('maxPanelHeightFt');
        bad = true;
      }
      if (c.minPanelHeightFt != null && hFt < c.minPanelHeightFt - EPS) {
        keys.add('minPanelHeightFt');
        bad = true;
      }
      if (c.maxPanelAreaSqft != null && wFt * hFt > c.maxPanelAreaSqft + EPS) {
        keys.add('maxPanelAreaSqft');
        bad = true;
      }
      if (bad) flaggedCells.add(cellKey(rect));
    }
  }

  // Global rules only mean something once there is an elevation to measure.
  let globalBreached = false;
  if (metrics.panels > 0) {
    const breach = (key: FacadeConstraintKey, over: boolean) => {
      if (!over) return;
      keys.add(key);
      globalBreached = true;
    };
    breach('minWwrPct', c.minWwrPct != null && metrics.wwrPct < c.minWwrPct - EPS);
    breach('maxWwrPct', c.maxWwrPct != null && metrics.wwrPct > c.maxWwrPct + EPS);
    breach('maxUValue', c.maxUValue != null && metrics.uValue > c.maxUValue + EPS);
    breach(
      'minStandardizationPct',
      c.minStandardizationPct != null && metrics.standardizationPct < c.minStandardizationPct - EPS,
    );
    breach('maxPanelTypes', c.maxPanelTypes != null && metrics.types > c.maxPanelTypes);
    breach('maxPanelCount', c.maxPanelCount != null && metrics.panels > c.maxPanelCount);
    breach('maxFacadeCost', c.maxFacadeCost != null && metrics.cost > c.maxFacadeCost + EPS);
    breach(
      'maxCostPerSqft',
      c.maxCostPerSqft != null &&
        metrics.areaSqft > 0 &&
        metrics.cost / metrics.areaSqft > c.maxCostPerSqft + EPS,
    );
  }

  return {
    flaggedCells,
    flaggedKeys: [...keys],
    globalBreached,
    flaggedCount: flaggedCells.size,
  };
}
