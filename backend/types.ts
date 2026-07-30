/**
 * Structured floorplan constraints — the single source of truth the rest of the
 * app enforces. The natural-language Constraints box is parsed into this shape
 * (by the LLM, or a regex fallback); the canvas reads it every frame to flag any
 * room that breaks a rule. Add fields here as the constraint vocabulary grows.
 */
export interface Constraints {
  /** Every wall side must be at least this thick, in inches. */
  minWallThicknessInches?: number;
  /** No wall side may be thicker than this, in inches. */
  maxWallThicknessInches?: number;
  /** A room's interior area must not exceed this, in square feet. */
  maxRoomAreaSqft?: number;
  /** A room's interior area must be at least this, in square feet. */
  minRoomAreaSqft?: number;
  /** No room side (interior edge) may be shorter than this, in feet. */
  minRoomSideFt?: number;
  /**
   * The summed interior area of ALL rooms must not exceed this, in square feet — a
   * GLOBAL budget (not per-room). Breaking it washes the whole canvas yellow until
   * enough rooms are deleted to get back under budget; it never clamps a drag.
   */
  maxTotalAreaSqft?: number;
  /**
   * The summed GROSS area of ALL rooms — each room's outer footprint (interior plus
   * its wall band) — must not exceed this, in square feet. Like {@link maxTotalAreaSqft}
   * it's a global, flag-only budget: breaking it washes the canvas yellow until rooms
   * are deleted back under budget.
   */
  maxTotalGrossAreaSqft?: number;
  /**
   * The total number of rooms on the floorplan must not exceed this (a global,
   * flag-only count). Breaking it washes the canvas yellow until rooms are deleted
   * back under the limit; it never blocks placement.
   */
  maxRoomCount?: number;
}

/** No rules set — the canvas does zero per-shape work in this state. */
export const EMPTY_CONSTRAINTS: Constraints = {};

/** True when at least one rule is set (lets hot paths skip checks entirely). */
export function hasAnyConstraint(c: Constraints): boolean {
  return (
    c.minWallThicknessInches != null ||
    c.maxWallThicknessInches != null ||
    c.maxRoomAreaSqft != null ||
    c.minRoomAreaSqft != null ||
    c.minRoomSideFt != null ||
    c.maxTotalAreaSqft != null ||
    c.maxTotalGrossAreaSqft != null ||
    c.maxRoomCount != null
  );
}

/**
 * Structured FACADE constraints — the Facade-mode counterpart to {@link Constraints}. A facade is checked
 * against a different vocabulary entirely: a curtain wall is judged on what the shop can fabricate and ship,
 * what the energy code allows, and what the elevation costs — not on room areas or wall thicknesses. The two
 * sets are never mixed; each editor mode enforces only its own.
 *
 * Per-panel rules flag individual panels on the canvas. Global rules describe the elevation as a whole and,
 * like the plan-mode budgets, wash the canvas rather than pointing at one unit.
 */
export interface FacadeConstraints {
  // --- Per-panel: fabrication, shipping, and handling limits ---
  /** No panel may be wider than this, in feet (shipping / unit width). */
  maxPanelWidthFt?: number;
  /** No panel may be narrower than this, in feet — slivers aren't fabricable. */
  minPanelWidthFt?: number;
  /** No panel may be taller than this, in feet (floor-to-floor / handling). */
  maxPanelHeightFt?: number;
  /** No panel may be shorter than this, in feet. */
  minPanelHeightFt?: number;
  /** No single panel may exceed this area, in square feet (glass weight / crane pick). */
  maxPanelAreaSqft?: number;

  // --- Global: the elevation as a whole ---
  /** Window-to-wall ratio must be at least this, 0–100 (daylight). */
  minWwrPct?: number;
  /** Window-to-wall ratio must not exceed this, 0–100 (solar gain / energy code). */
  maxWwrPct?: number;
  /** Area-weighted assembly U-factor must not exceed this, Btu/h·ft²·°F (thermal envelope). */
  maxUValue?: number;
  /** Share of panels reusing an existing type must be at least this, 0–100 (fabrication repetition). */
  minStandardizationPct?: number;
  /** The elevation may use at most this many distinct panel types (tooling). */
  maxPanelTypes?: number;
  /** The elevation may carry at most this many panels in total. */
  maxPanelCount?: number;
  /** Supply + install must not exceed this rate, US$ per ft² of facade. */
  maxCostPerSqft?: number;
  /** Supply + install must not exceed this total, US$. */
  maxFacadeCost?: number;
}

/** No facade rules set — the canvas does zero per-panel work in this state. */
export const EMPTY_FACADE_CONSTRAINTS: FacadeConstraints = {};

/** True when at least one facade rule is set (lets the draw loop skip checks entirely). */
export function hasAnyFacadeConstraint(c: FacadeConstraints): boolean {
  return (
    c.maxPanelWidthFt != null ||
    c.minPanelWidthFt != null ||
    c.maxPanelHeightFt != null ||
    c.minPanelHeightFt != null ||
    c.maxPanelAreaSqft != null ||
    c.minWwrPct != null ||
    c.maxWwrPct != null ||
    c.maxUValue != null ||
    c.minStandardizationPct != null ||
    c.maxPanelTypes != null ||
    c.maxPanelCount != null ||
    c.maxCostPerSqft != null ||
    c.maxFacadeCost != null
  );
}
