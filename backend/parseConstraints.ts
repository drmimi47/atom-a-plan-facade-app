import type { Constraints, FacadeConstraints } from './types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

/** The single tool the model must fill — its schema mirrors {@link Constraints}. */
const SET_CONSTRAINTS_TOOL = {
  name: 'set_constraints',
  description: 'Record the floorplan design constraints described by the user.',
  input_schema: {
    type: 'object',
    properties: {
      minWallThicknessInches: {
        type: 'number',
        description: 'Minimum thickness of any wall, in inches.',
      },
      maxWallThicknessInches: {
        type: 'number',
        description: 'Maximum thickness of any wall, in inches.',
      },
      maxRoomAreaSqft: {
        type: 'number',
        description: 'Maximum interior area of any single room, in square feet.',
      },
      minRoomAreaSqft: {
        type: 'number',
        description: 'Minimum interior area every room must maintain, in square feet.',
      },
      minRoomSideFt: {
        type: 'number',
        description: 'Minimum length of any single room side (interior edge), in feet.',
      },
      maxTotalAreaSqft: {
        type: 'number',
        description:
          'Maximum TOTAL combined interior area of ALL rooms together (a global budget ' +
          'across the whole floorplan, not per-room), in square feet.',
      },
      maxTotalGrossAreaSqft: {
        type: 'number',
        description:
          'Maximum TOTAL GROSS area of ALL rooms together — each room\'s outer footprint ' +
          'including its wall thickness (interior area plus the wall band), summed across ' +
          'the whole floorplan, in square feet. Distinct from maxTotalAreaSqft, which is ' +
          'interior-only.',
      },
      maxRoomCount: {
        type: 'integer',
        description:
          'Maximum NUMBER of rooms allowed on the whole floorplan (a global count of ' +
          'rooms, not an area or a size).',
      },
    },
  },
} as const;

const SYSTEM_PROMPT =
  'You convert floorplan design constraints written in plain English into the ' +
  'set_constraints tool. Only include fields the user actually states; omit the ' +
  "rest. Convert each value to the unit named in that field's description " +
  '(inches, feet, or square feet) — e.g. 5 feet → 5 for a feet field, 5 feet → 60 ' +
  'for an inches field.';

/** The facade counterpart — its schema mirrors {@link FacadeConstraints}. */
const SET_FACADE_CONSTRAINTS_TOOL = {
  name: 'set_facade_constraints',
  description: 'Record the curtain-wall / facade design constraints described by the user.',
  input_schema: {
    type: 'object',
    properties: {
      maxPanelWidthFt: {
        type: 'number',
        description: 'Maximum width of any single facade panel, in feet.',
      },
      minPanelWidthFt: {
        type: 'number',
        description: 'Minimum width of any single facade panel, in feet.',
      },
      maxPanelHeightFt: {
        type: 'number',
        description: 'Maximum height of any single facade panel, in feet.',
      },
      minPanelHeightFt: {
        type: 'number',
        description: 'Minimum height of any single facade panel, in feet.',
      },
      maxPanelAreaSqft: {
        type: 'number',
        description: 'Maximum area of any single facade panel, in square feet.',
      },
      minWwrPct: {
        type: 'number',
        description:
          'Minimum window-to-wall ratio (vision glass area divided by facade area), as a ' +
          'percentage 0-100.',
      },
      maxWwrPct: {
        type: 'number',
        description:
          'Maximum window-to-wall ratio (vision glass area divided by facade area), as a ' +
          'percentage 0-100.',
      },
      maxUValue: {
        type: 'number',
        description:
          'Maximum area-weighted assembly U-factor / U-value for the whole facade, in ' +
          'Btu/h·ft²·°F. Lower insulates better, so this is an upper bound.',
      },
      minStandardizationPct: {
        type: 'number',
        description:
          'Minimum standardization: the share of panels that reuse an existing panel type, ' +
          'as a percentage 0-100. Higher means more repetition and cheaper fabrication.',
      },
      maxPanelTypes: {
        type: 'integer',
        description:
          'Maximum number of DISTINCT panel types (unique panel shapes) the facade may use.',
      },
      maxPanelCount: {
        type: 'integer',
        description: 'Maximum TOTAL number of panels on the whole facade.',
      },
      maxCostPerSqft: {
        type: 'number',
        description:
          'Maximum supply-and-install cost RATE, in US dollars per square foot of facade. ' +
          'Distinct from maxFacadeCost, which is an absolute total.',
      },
      maxFacadeCost: {
        type: 'number',
        description:
          'Maximum TOTAL supply-and-install cost for the whole facade, in US dollars. ' +
          'Distinct from maxCostPerSqft, which is a per-square-foot rate.',
      },
    },
  },
} as const;

const FACADE_SYSTEM_PROMPT =
  'You convert curtain-wall / facade design constraints written in plain English into the ' +
  'set_facade_constraints tool. Only include fields the user actually states; omit the rest. ' +
  "Convert each value to the unit named in that field's description (feet, square feet, " +
  'percent, or US dollars). A ratio written as a fraction becomes a percentage — 0.4 → 40.';

/**
 * Removes Python-style comment lines — any line whose first non-whitespace
 * character is `#` (e.g. "# note" or "#note") — so users can annotate the
 * Constraints box with text the parser (and the LLM) ignore entirely.
 */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Parse the constraints text into the structured schema. Prefers the Anthropic
 * LLM (handles free-form phrasing) but falls back to a small deterministic parser
 * when no API key is set or the request fails — so the app always works, key or
 * not. Comment lines are stripped first; empty input yields no constraints.
 */
export async function parseConstraints(text: string): Promise<Constraints> {
  const trimmed = stripComments(text).trim();
  if (!trimmed) return {};

  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!key) return parseConstraintsLocally(trimmed);

  try {
    const raw = await parseWithLLM(trimmed, key, SET_CONSTRAINTS_TOOL, SYSTEM_PROMPT);
    return sanitize(raw);
  } catch (err) {
    console.warn('[constraints] LLM parse failed; using local fallback:', err);
    return parseConstraintsLocally(trimmed);
  }
}

/**
 * The Facade-mode counterpart of {@link parseConstraints}: same LLM-with-regex-fallback pipeline, but it
 * fills the facade vocabulary (panel sizes, WWR, U-value, standardization, cost) instead of the room one.
 * The two are parsed separately and never merged — each mode enforces only its own rules.
 */
export async function parseFacadeConstraints(text: string): Promise<FacadeConstraints> {
  const trimmed = stripComments(text).trim();
  if (!trimmed) return {};

  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!key) return parseFacadeConstraintsLocally(trimmed);

  try {
    const raw = await parseWithLLM(
      trimmed,
      key,
      SET_FACADE_CONSTRAINTS_TOOL,
      FACADE_SYSTEM_PROMPT,
    );
    return sanitizeFacade(raw);
  } catch (err) {
    console.warn('[constraints] facade LLM parse failed; using local fallback:', err);
    return parseFacadeConstraintsLocally(trimmed);
  }
}

/** One tool-use round-trip. Returns the raw tool input; the caller sanitizes it into its own schema. */
async function parseWithLLM(
  text: string,
  key: string,
  tool: { name: string },
  system: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Required for direct browser calls (this app is client-side; see README).
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);

  const data = (await res.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  };
  const block = data.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!block?.input) throw new Error(`No ${tool.name} tool_use block in response`);
  return block.input as Record<string, unknown>;
}

/** Keep only the known positive-number fields, dropping anything malformed. */
function sanitize(raw: Record<string, unknown>): Constraints {
  const out: Constraints = {};
  if (typeof raw.minWallThicknessInches === 'number' && raw.minWallThicknessInches > 0) {
    out.minWallThicknessInches = raw.minWallThicknessInches;
  }
  if (typeof raw.maxWallThicknessInches === 'number' && raw.maxWallThicknessInches > 0) {
    out.maxWallThicknessInches = raw.maxWallThicknessInches;
  }
  if (typeof raw.maxRoomAreaSqft === 'number' && raw.maxRoomAreaSqft > 0) {
    out.maxRoomAreaSqft = raw.maxRoomAreaSqft;
  }
  if (typeof raw.minRoomAreaSqft === 'number' && raw.minRoomAreaSqft > 0) {
    out.minRoomAreaSqft = raw.minRoomAreaSqft;
  }
  if (typeof raw.minRoomSideFt === 'number' && raw.minRoomSideFt > 0) {
    out.minRoomSideFt = raw.minRoomSideFt;
  }
  if (typeof raw.maxTotalAreaSqft === 'number' && raw.maxTotalAreaSqft > 0) {
    out.maxTotalAreaSqft = raw.maxTotalAreaSqft;
  }
  if (typeof raw.maxTotalGrossAreaSqft === 'number' && raw.maxTotalGrossAreaSqft > 0) {
    out.maxTotalGrossAreaSqft = raw.maxTotalGrossAreaSqft;
  }
  if (typeof raw.maxRoomCount === 'number' && raw.maxRoomCount > 0) {
    out.maxRoomCount = Math.floor(raw.maxRoomCount);
  }
  return out;
}

/** Keep only the known positive-number facade fields, dropping anything malformed. */
function sanitizeFacade(raw: Record<string, unknown>): FacadeConstraints {
  const out: FacadeConstraints = {};
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  // Percentages are ratios in disguise: a model that answers 0.4 for "40%" is corrected here rather
  // than silently enforcing a 0.4% window-to-wall ratio.
  const pct = (v: unknown): number | undefined => {
    const n = num(v);
    if (n == null) return undefined;
    return Math.min(100, n <= 1 ? n * 100 : n);
  };
  const int = (v: unknown): number | undefined => {
    const n = num(v);
    return n == null ? undefined : Math.floor(n);
  };

  out.maxPanelWidthFt = num(raw.maxPanelWidthFt);
  out.minPanelWidthFt = num(raw.minPanelWidthFt);
  out.maxPanelHeightFt = num(raw.maxPanelHeightFt);
  out.minPanelHeightFt = num(raw.minPanelHeightFt);
  out.maxPanelAreaSqft = num(raw.maxPanelAreaSqft);
  out.minWwrPct = pct(raw.minWwrPct);
  out.maxWwrPct = pct(raw.maxWwrPct);
  out.maxUValue = num(raw.maxUValue);
  out.minStandardizationPct = pct(raw.minStandardizationPct);
  out.maxPanelTypes = int(raw.maxPanelTypes);
  out.maxPanelCount = int(raw.maxPanelCount);
  out.maxCostPerSqft = num(raw.maxCostPerSqft);
  out.maxFacadeCost = num(raw.maxFacadeCost);

  // Drop the keys that came back undefined, so `hasAnyFacadeConstraint` and the violated-key
  // highlighting both see a clean "field absent" rather than an explicit undefined.
  for (const k of Object.keys(out) as (keyof FacadeConstraints)[]) {
    if (out[k] == null) delete out[k];
  }
  return out;
}

/**
 * Deterministic fallback covering the known vocabulary. Recognises lines like
 * `minimum wall thickness 3"` and `max room area 200 sq ft`. Used when there's no
 * API key or the LLM call fails, so the seeded constraint keeps working offline.
 */
export function parseConstraintsLocally(text: string): Constraints {
  const out: Constraints = {};
  text = stripComments(text); // ignore any annotation lines, same as the LLM path

  const minWall = text.match(
    /min(?:imum)?\s+wall\s+thickness\s+(\d+(?:\.\d+)?)\s*(?:"|in\b|inch|inches)?/i,
  );
  if (minWall) out.minWallThicknessInches = parseFloat(minWall[1]);

  const maxWall = text.match(
    /max(?:imum)?\s+wall\s+thickness\s+(\d+(?:\.\d+)?)\s*(?:"|in\b|inch|inches)?/i,
  );
  if (maxWall) out.maxWallThicknessInches = parseFloat(maxWall[1]);

  const maxArea = text.match(
    /max(?:imum)?\s+(?:room\s+)?(?:size|area)\s+(\d+(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
  );
  if (maxArea) out.maxRoomAreaSqft = parseFloat(maxArea[1]);

  // Min room area, e.g. "area ≥ 36 sq ft", "minimum room area 36", "at least 36 sq ft".
  const minArea = text.match(
    /(?:area\s*(?:≥|>=|of at least|at least)|min(?:imum)?\s+(?:room\s+)?area)\s*(\d+(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
  );
  if (minArea) out.minRoomAreaSqft = parseFloat(minArea[1]);

  // Min room side length (feet), e.g. "no room side may become < 5'", "min side 5 ft".
  const minSide = text.match(
    /side\b[^\n]*?(\d+(?:\.\d+)?)\s*(?:'|ft\b|feet|foot)/i,
  );
  if (minSide) out.minRoomSideFt = parseFloat(minSide[1]);

  // Max TOTAL area (global), e.g. "Maximum total area 5,000 sq ft" or "total area
  // must not exceed 5000". Numbers may be comma-grouped, so strip commas. Checked
  // before nothing else captures it; "total" distinguishes it from per-room max area.
  const maxTotal =
    text.match(
      /max(?:imum)?\s+total\s+(?:combined\s+)?area\s+(\d[\d,]*(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
    ) ??
    text.match(
      /total\s+(?:combined\s+)?area\b[^\n]*?(?:exceed|over|above|more than|max(?:imum)?|under|below|no more than|≤|<=)\D*?(\d[\d,]*(?:\.\d+)?)/i,
    );
  if (maxTotal) out.maxTotalAreaSqft = parseFloat(maxTotal[1].replace(/,/g, ''));

  // Max TOTAL GROSS area (global) — the outer footprints summed, e.g. "Maximum total
  // gross area 20,000 sq ft". The word "gross" distinguishes it from the interior
  // total above; numbers may be comma-grouped.
  const maxGross =
    text.match(
      /max(?:imum)?\s+(?:total\s+)?gross\s+(?:total\s+)?area\s+(\d[\d,]*(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
    ) ??
    text.match(
      /gross\s+(?:total\s+)?area\b[^\n]*?(?:exceed|over|above|more than|max(?:imum)?|under|below|no more than|≤|<=)\D*?(\d[\d,]*(?:\.\d+)?)/i,
    );
  if (maxGross) out.maxTotalGrossAreaSqft = parseFloat(maxGross[1].replace(/,/g, ''));

  // Max ROOM COUNT (global), e.g. "Maximum room count 100", "max rooms 50", "no more
  // than 50 rooms". Integer; "count"/"rooms" keeps it clear of the area rules above.
  const maxRooms =
    text.match(/max(?:imum)?\s+(?:number\s+of\s+)?rooms?\s+count\s+(\d+)/i) ??
    text.match(/max(?:imum)?\s+room\s+count\s+(\d+)/i) ??
    text.match(/max(?:imum)?\s+(?:number\s+of\s+)?rooms?\s+(\d+)/i) ??
    text.match(/(?:no more than|up to|at most|≤|<=)\s*(\d+)\s+rooms?\b/i);
  if (maxRooms) out.maxRoomCount = parseInt(maxRooms[1], 10);

  return out;
}

/**
 * Deterministic FACADE fallback, mirroring {@link parseConstraintsLocally}. Recognises the seeded
 * vocabulary — panel width/height/area, WWR, U-value, standardization, type/panel counts, cost — so the
 * default facade rules keep working with no API key. Numbers may be comma-grouped or carry a `$`/`%`.
 */
export function parseFacadeConstraintsLocally(text: string): FacadeConstraints {
  const out: FacadeConstraints = {};
  text = stripComments(text); // ignore annotation lines, same as the LLM path

  const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
  const val = (m: RegExpMatchArray | null): number | undefined =>
    m ? parseFloat(m[1].replace(/,/g, '')) : undefined;
  const set = <K extends keyof FacadeConstraints>(k: K, v: number | undefined) => {
    if (v != null && Number.isFinite(v) && v > 0) out[k] = v as FacadeConstraints[K];
  };
  // "panel" then the measure then the number, tolerating "max panel width", "maximum width of a panel",
  // and "panel width must not exceed". Anchored on `panel` so it can't collide with the room vocabulary.
  const panelRule = (bound: 'max' | 'min', measure: string) => {
    const lead = bound === 'max' ? String.raw`max(?:imum)?` : String.raw`min(?:imum)?`;
    return (
      text.match(new RegExp(String.raw`${lead}\s+panel\s+${measure}\s*(?:of\s+)?${NUM}`, 'i')) ??
      text.match(new RegExp(String.raw`${lead}\s+${measure}\s+of\s+(?:a|any)\s+panel\s*${NUM}`, 'i')) ??
      text.match(
        new RegExp(
          String.raw`panel\s+${measure}\b[^\n]*?(?:${
            bound === 'max' ? 'exceed|over|above|more than|no more than|≤|<=|at most' : 'at least|under|below|≥|>=|no less than'
          })\D*?${NUM}`,
          'i',
        ),
      )
    );
  };

  set('maxPanelWidthFt', val(panelRule('max', 'width')));
  set('minPanelWidthFt', val(panelRule('min', 'width')));
  set('maxPanelHeightFt', val(panelRule('max', 'height')));
  set('minPanelHeightFt', val(panelRule('min', 'height')));
  set('maxPanelAreaSqft', val(panelRule('max', 'area')));

  // Window-to-wall ratio, written either spelled out or as "WWR".
  const wwr = String.raw`(?:window[\s-]*to[\s-]*wall(?:\s+ratio)?|wwr)`;
  set(
    'minWwrPct',
    val(
      text.match(new RegExp(String.raw`min(?:imum)?\s+${wwr}\s*${NUM}`, 'i')) ??
        text.match(new RegExp(String.raw`${wwr}\b[^\n]*?(?:at least|≥|>=|no less than)\D*?${NUM}`, 'i')),
    ),
  );
  set(
    'maxWwrPct',
    val(
      text.match(new RegExp(String.raw`max(?:imum)?\s+${wwr}\s*${NUM}`, 'i')) ??
        text.match(
          new RegExp(String.raw`${wwr}\b[^\n]*?(?:exceed|over|above|more than|no more than|≤|<=|at most)\D*?${NUM}`, 'i'),
        ),
    ),
  );

  // U-value / U-factor — an upper bound (lower insulates better).
  set(
    'maxUValue',
    val(
      text.match(new RegExp(String.raw`max(?:imum)?\s+u[\s-]*(?:value|factor)\s*${NUM}`, 'i')) ??
        text.match(
          new RegExp(String.raw`u[\s-]*(?:value|factor)\b[^\n]*?(?:exceed|over|above|more than|no more than|≤|<=)\D*?${NUM}`, 'i'),
        ),
    ),
  );

  // Standardization / repetition share — a lower bound (more repetition is better).
  set(
    'minStandardizationPct',
    val(
      text.match(new RegExp(String.raw`min(?:imum)?\s+standard(?:ization|isation)\s*${NUM}`, 'i')) ??
        text.match(
          new RegExp(String.raw`standard(?:ization|isation)\b[^\n]*?(?:at least|≥|>=|no less than)\D*?${NUM}`, 'i'),
        ),
    ),
  );

  // Distinct panel TYPES, then TOTAL panel count. Types is matched first — "panel types" would
  // otherwise be swallowed by the looser panel-count pattern.
  set(
    'maxPanelTypes',
    val(
      text.match(new RegExp(String.raw`max(?:imum)?\s+(?:number\s+of\s+)?(?:panel\s+)?types?\s*(?:count\s*)?${NUM}`, 'i')) ??
        text.match(new RegExp(String.raw`(?:no more than|up to|at most|≤|<=)\s*${NUM}\s+(?:panel\s+)?types?\b`, 'i')),
    ),
  );
  set(
    'maxPanelCount',
    val(
      text.match(new RegExp(String.raw`max(?:imum)?\s+panels?\s+count\s*${NUM}`, 'i')) ??
        text.match(new RegExp(String.raw`max(?:imum)?\s+(?:number\s+of\s+)?panels?\s+${NUM}`, 'i')) ??
        text.match(new RegExp(String.raw`(?:no more than|up to|at most|≤|<=)\s*${NUM}\s+panels?\b`, 'i')),
    ),
  );

  // Cost: the per-ft² RATE is matched before the absolute total, since "$90 per sq ft" also contains
  // a bare number that the total pattern would otherwise claim.
  set(
    'maxCostPerSqft',
    val(
      text.match(
        new RegExp(String.raw`max(?:imum)?\s+(?:facade\s+)?cost\s*(?:of\s*)?\$?\s*${NUM}\s*(?:\$\s*)?(?:\/|per\s+)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+foot|square\s+feet)`, 'i'),
      ) ??
        text.match(
          new RegExp(String.raw`cost\b[^\n]*?\$?\s*${NUM}\s*(?:\$\s*)?(?:\/|per\s+)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+foot|square\s+feet)`, 'i'),
        ),
    ),
  );
  if (out.maxCostPerSqft == null) {
    set(
      'maxFacadeCost',
      val(
        text.match(new RegExp(String.raw`max(?:imum)?\s+(?:total\s+)?(?:facade\s+)?cost\s*(?:of\s*)?\$?\s*${NUM}`, 'i')) ??
          text.match(new RegExp(String.raw`cost\b[^\n]*?(?:exceed|over|above|more than|no more than|≤|<=)\s*\$?\s*${NUM}`, 'i')),
      ),
    );
  }

  return out;
}
