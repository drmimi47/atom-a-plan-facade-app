# atom-a-plan-facade-app

A browser-based design tool prototype for exploring architectural workflows in plan and facade. Geometry is on an infinite canvas and governed by design rules written in plain English — minimum wall thickness, window-to-wall ratio, panel standardization — which are parsed into a typed schema and checked live, so what breaks a rule is flagged as you draw it.

**Plan** — drop rooms carrying real walls, areas and dimensions; reshape them by vertex, wall face or edge; unite and subtract them, with the operation chosen by where you click rather than by a toolbar. Violations wash against the rule that caused them, and a guided wand ghosts each repair before you approve it. Describe a layout in a sentence and it is built from a room catalog; sweep a cluster onto the Library to place it again later.

**Facade** — form an elevation, split it into a panel lattice, then tune it by dragging a whole mullion line or a single segment. Boundary rationalization offers four strategies, each previewed on hover, for absorbing angled edges into whole panels. Painted panel selections take shared parametric frames and materials, with window-to-wall ratio, U-value, standardization and cost updating as the design moves.

Constraint and prompt parsing run through an LLM with a deterministic regex fallback, so the rules still resolve with no model available. Sign-in (optional, via Firebase) persists constraints and the adjacency matrix per account; Guest mode runs entirely locally. 