import styles from './StatsBar.module.css';
import type { FacadeMetrics } from '../../facade/partition';

interface StatsBarProps {
  /** Stats fade in while the Analyze button is on. */
  visible: boolean;
  /** Which set of readouts to show — the plan metrics or the facade ones. */
  facade: boolean;
  roomCount: number;
  /** When true, the global Max Room Count limit is exceeded — flag this readout. */
  roomCountExceeded: boolean;
  /** Gross Internal Area (GIA) — Σ room interiors. */
  totalAreaSqft: number;
  /** When true, the global Max Total Area budget is exceeded — flags the GIA readout. */
  totalAreaExceeded: boolean;
  /** Gross Floor Area (GFA) — Σ room footprints incl. walls. */
  grossAreaSqft: number;
  /** When true, the global Max Total Gross Area budget is exceeded — flags the GFA readout. */
  grossAreaExceeded: boolean;
  /** Usable Floor Area (UFA) — Σ interior of usable rooms (excl. circulation/service). */
  usableAreaSqft: number;
  /** Live facade engineering readouts, used in Facade mode. */
  facadeMetrics: FacadeMetrics;
  /** Screen edges of the central nav pill, used to centre each pair beside it. */
  navBounds: { left: number; right: number } | null;
  /** Current viewport width, to centre the right pair against the right edge. */
  viewportWidth: number;
}

/** Space reserved at each screen edge so a stat group never collides with the menu. */
const EDGE_INSET = 120;

/**
 * Window-to-wall ratio above which most energy codes require extra justification (prescriptive
 * compliance paths typically cap it around here) — the readout flags past this.
 */
const WWR_ALERT_PCT = 40;

/** Money in the compact form a cost plan is quoted in: $84k, $1.2M. */
function formatCost(dollars: number): string {
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars)}`;
}

function Stat({
  label,
  value,
  display,
  unit,
  alert,
  tooltip,
}: {
  label: string;
  value: number;
  /** Pre-formatted figure, when the raw number isn't what should be read (money, decimals). */
  display?: string;
  /** Shown after the label on the caption line (e.g. "ft²", "%"); omit for none. */
  unit?: string;
  alert?: boolean;
  tooltip?: string;
}) {
  return (
    <span
      className={`${styles.stat}${alert ? ` ${styles.alert}` : ''}`}
      title={tooltip}
    >
      <span className={styles.statValue}>{display ?? value}</span>
      <span className={styles.statLabel}>{unit ? `${label} ${unit}` : label}</span>
    </span>
  );
}

/**
 * Live statistics along the bottom edge: two groups of three readouts, each centred on
 * its half of the screen (the central nav menu sits at 50%, so the groups sit at
 * ~25% / ~75%). They fade in and out with the Analyze toggle.
 *
 * Each mode gets the six figures its users work to; the layout, type, and fade are identical.
 *
 * PLAN — area metrics, all derived from the per-room interior + gross sums:
 *  - GFA — Gross Floor Area, to the outside face of walls (Σ interior + walls).
 *  - GIA — Gross Internal Area, to the inside face of walls (Σ interior).
 *  - UFA — Usable Floor Area (Σ interior of usable rooms; excl. circulation/service).
 *  - NIA % — Net Internal share: UFA ÷ GIA × 100.
 *  - Efficiency — GIA ÷ GFA × 100 (how little floor is lost to wall thickness).
 *
 * FACADE — what a facade engineer, architect, or cost planner reads off an elevation. The left group is
 * envelope performance (how much wall, how much of it is glass, how well it insulates); the right is
 * fabrication and cost (how many units, how many distinct ones to tool, what it comes to):
 *  - Facade Area — total clipped elevation area; border-sliced panels count only what survives the cut.
 *  - WWR % — window-to-wall ratio, the daylight/view share; flagged past the usual code threshold.
 *  - U-Value — area-weighted assembly U-factor, Btu/h·ft²·°F (lower insulates better).
 *  - Panels — total units to fabricate, ship, and hang.
 *  - Unq. Panels — unique panel shapes, i.e. how many the shop has to tool for. Fewer = cheaper.
 *  - Cost — supply + install estimate.
 * Geometry is measured from the live partition; the per-material performance and cost constants behind
 * the last four are placeholders (see `PANEL_PERFORMANCE` in facade/partition.ts).
 */
export function StatsBar({
  visible,
  facade,
  roomCount,
  roomCountExceeded,
  totalAreaSqft,
  totalAreaExceeded,
  grossAreaSqft,
  grossAreaExceeded,
  usableAreaSqft,
  facadeMetrics,
  navBounds,
  viewportWidth,
}: StatsBarProps) {
  const show = visible ? styles.show : '';

  // Efficiency: internal area as a share of the gross footprint (100% = zero walls).
  const efficiency = grossAreaSqft > 0 ? Math.round((totalAreaSqft / grossAreaSqft) * 100) : 0;
  // NIA %: usable area as a share of the gross internal area (higher = more efficient).
  const niaPct = totalAreaSqft > 0 ? Math.round((usableAreaSqft / totalAreaSqft) * 100) : 0;

  // Centre each group in the gap between the central menu and the reserved edge
  // (Debug on the left, FPS on the right). Falls back to the screen quarters
  // until the menu has been measured (the groups are hidden then anyway).
  const leftCenter = navBounds
    ? (EDGE_INSET + navBounds.left) / 2
    : viewportWidth * 0.25;
  const rightCenter = navBounds
    ? (navBounds.right + (viewportWidth - EDGE_INSET)) / 2
    : viewportWidth * 0.75;

  return (
    <>
      <div className={`${styles.pair} ${show}`} style={{ left: `${leftCenter}px` }}>
        {facade ? (
          <>
            <Stat
              label="Facade Area"
              value={facadeMetrics.areaSqft}
              unit="ft²"
              tooltip="Total elevation area, clipped to the trim border"
            />
            <Stat
              label="WWR"
              value={facadeMetrics.wwrPct}
              unit="%"
              alert={facadeMetrics.wwrPct > WWR_ALERT_PCT}
              tooltip="Window-to-Wall Ratio — vision glass ÷ facade area"
            />
            <Stat
              label="U-Value"
              value={facadeMetrics.uValue}
              display={facadeMetrics.uValue.toFixed(2)}
              tooltip="Area-weighted assembly U-factor, Btu/h·ft²·°F (lower insulates better)"
            />
          </>
        ) : (
          <>
            <Stat
              label="GFA"
              value={grossAreaSqft}
              unit="ft²"
              alert={grossAreaExceeded}
              tooltip="Gross Floor Area"
            />
            <Stat
              label="GIA"
              value={totalAreaSqft}
              unit="ft²"
              alert={totalAreaExceeded}
              tooltip="Gross Internal Area"
            />
            <Stat
              label="Efficiency"
              value={efficiency}
              unit="%"
              tooltip="Gross Internal Area ÷ Gross Floor Area × 100"
            />
          </>
        )}
      </div>

      <div className={`${styles.pair} ${show}`} style={{ left: `${rightCenter}px` }}>
        {facade ? (
          <>
            <Stat
              label="Panels"
              value={facadeMetrics.panels}
              tooltip="Units to fabricate, ship, and hang"
            />
            <Stat
              label="Unq. Panels"
              value={facadeMetrics.types}
              tooltip="Unique panel shapes to tool for — fewer is cheaper"
            />
            <Stat
              label="Cost"
              value={facadeMetrics.cost}
              display={formatCost(facadeMetrics.cost)}
              tooltip="Supply + install estimate (placeholder rates)"
            />
          </>
        ) : (
          <>
            <Stat
              label="Room Count"
              value={roomCount}
              alert={roomCountExceeded}
              tooltip="Number of rooms placed"
            />
            <Stat
              label="NIA"
              value={niaPct}
              unit="%"
              tooltip="Net Internal Area"
            />
            <Stat
              label="UFA"
              value={usableAreaSqft}
              unit="ft²"
              tooltip="Usable Floor Area"
            />
          </>
        )}
      </div>
    </>
  );
}
