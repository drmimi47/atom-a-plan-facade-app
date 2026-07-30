# backend/

The constraints "service" layer: it turns the plain-English text from the
**Constraints** box into structured rules and decides which rooms break them.

| File | Role |
| --- | --- |
| `types.ts` | The `Constraints` and `FacadeConstraints` schemas — the single source of truth. |
| `parseConstraints.ts` | English → either schema, via the Anthropic LLM with a regex fallback. |
| `violations.ts` | Given a room + the active plan constraints, which rules it breaks. |
| `facadeViolations.ts` | Given the facade layer + its metrics, which facade rules it breaks. |

## Two rule sets, one per mode

There are **two independent vocabularies**, and they are never mixed:

| | Plan mode | Facade mode |
| --- | --- | --- |
| Schema | `Constraints` | `FacadeConstraints` |
| Seeded from | `src/constraints_file.txt` | `src/facade_constraints_file.txt` |
| Rules about | room area, wall thickness, side length, global area/count budgets | panel size, window-to-wall ratio, U-value, standardization, type/panel counts, cost |
| Flags | offending **rooms** | offending **panels** |
| Persisted as | `users/{uid}.constraintsText` | `users/{uid}.facadeConstraintsText` |

Scoping is enforced in one place — `InfiniteCanvas` swaps whichever set is inactive for an empty one when
the mode changes. Every downstream consumer (violation flags, the drag clamp, the global wash, the fix
wand) reads through that, so a Plan rule can never act on a facade or vice versa.

The guided auto-fix wand reshapes rooms, so it is disabled in Facade mode.

## Running today vs. tomorrow

This currently runs **client-side** — Vite bundles these modules into the page and
`parseConstraints` calls the Anthropic API directly from the browser. This folder
is the seam where a real **serverless proxy** would later live, so the API key
never ships to the client.

## API key

`parseConstraints` reads `import.meta.env.VITE_ANTHROPIC_API_KEY`. Put it in a
gitignored `.env.local` (see `.env.example`). ⚠️ A `VITE_`-prefixed key is
embedded in the client bundle — fine for local/demo use, not for production.

Without a key, `parseConstraints` automatically uses the deterministic regex
fallback, so the seeded `Minimum wall thickness 3"` rule still works offline.
