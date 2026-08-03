# Setup & deployment (for IT / VM provisioning)

> ⚠️ **Test phase — incomplete prototype.** APIs, data shapes, and env vars may still
> change. This guide reflects the current state of `main`.

This is a client-only [Vite](https://vite.dev) + React + TypeScript single-page app.
There is **no backend server** to run: `npm run build` produces a static bundle in
`dist/` that any static host (or the bundled preview server) can serve.

## Prerequisites

- **Node.js 20 LTS or newer** (Node 18 also works) + npm.
- Outbound HTTPS access from the VM to:
  - `registry.npmjs.org` (install dependencies),
  - `api.anthropic.com` and Google AI endpoints *only if* the optional AI features are enabled (these calls happen in the user's browser, not on the VM).

## Install, build, run

```bash
npm install              # install dependencies
npm run build            # type-check (tsc --noEmit) + produce static bundle in dist/
npm run preview          # serve the built bundle locally to verify (default :4173)
# — or —
npm run dev              # hot-reloading dev server (default :5173)
```

Serve the contents of `dist/` with any static file server (nginx, `vite preview`,
Vercel, etc.). The app is fully client-side, so no process needs to keep running
beyond the static host.

## Environment variables

All config is supplied through the `VITE_*` environment variables listed below — this
table is the full reference. Locally these go in a git-ignored `.env.local`; on a VM / CI they can
be real environment variables or injected at build time. **They are read at *build*
time and baked into the bundle**, so the build must run with them present.

| Variable | Required? | Purpose |
| --- | --- | --- |
| `VITE_FIREBASE_API_KEY` | needed for sign-in | Firebase web app config |
| `VITE_FIREBASE_AUTH_DOMAIN` | needed for sign-in | Firebase web app config |
| `VITE_FIREBASE_PROJECT_ID` | needed for sign-in | Firebase web app config |
| `VITE_FIREBASE_STORAGE_BUCKET` | needed for sign-in | Firebase web app config |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | needed for sign-in | Firebase web app config |
| `VITE_FIREBASE_APP_ID` | needed for sign-in | Firebase web app config |
| `VITE_ANTHROPIC_API_KEY` | optional | English→constraints parsing; falls back to a regex parser if absent |
| `VITE_GEMINI_API_KEY` | optional | AI facade renderer; the render action is disabled if absent |

Without the Firebase values the app still runs in **Guest** mode (no per-account
saving). Without the two AI keys the corresponding features degrade gracefully — the
app does not crash.

> ⚠️ **Security note:** every `VITE_`-prefixed value is embedded in the **public client
> bundle**. The six Firebase web-config values are *designed* to be public (access is
> controlled by Firestore security rules), so shipping them is fine. The
> `VITE_ANTHROPIC_API_KEY` and `VITE_GEMINI_API_KEY`, however, are real billable
> secrets that would be extractable from the deployed bundle — **do not set them on a
> publicly reachable deployment.** The long-term fix is a serverless proxy (see
> `backend/README.md`).
