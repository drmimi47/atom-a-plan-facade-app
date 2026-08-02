# atom-a-plan-facade-app

> ⚠️ **Test phase — incomplete.** This project is an early prototype under active
> development. Features are partial, APIs and data shapes may change, and some flows
> (e.g. password reset, a serverless key proxy) are stubbed or unfinished. It is not
> production-ready and is intended for internal testing and experimentation only.

**Atom** is an experimental, browser-based tool for rapidly sketching
architectural floor plans on an infinite canvas. You describe design rules in plain
English (e.g. minimum wall thickness) and lay out rooms whose relationships are driven
by an editable adjacency matrix; the app parses those constraints — via the Anthropic
LLM with a deterministic regex fallback — flags violations, and renders the resulting
partitions and facades. Sign-in (optional, via Firebase) persists your constraints and
matrix per account, while Guest mode runs everything locally without saving.

## Setup & deployment

For provisioning on a VM or other host — prerequisites, build/run steps, the full
environment-variable reference, the client-bundle security caveats, and whether Firebase
project access is required — see **[SETUP.md](SETUP.md)**.
