import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Dev-only endpoint that receives perf beacons from the running app and prints
 * them to the dev server's stdout. This makes live FPS / draw-time observable
 * from the terminal while experimenting on localhost.
 */
function perfLogger(): Plugin {
  return {
    name: 'perf-logger',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__perf', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const { fps, drawMs } = JSON.parse(body || '{}');
            const ts = new Date().toLocaleTimeString();
            console.log(`[perf ${ts}] ${fps} fps · ${drawMs} ms`);
          } catch {
            // ignore malformed beacons
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

/** Serialise one adjacency row's `{ target: weight }` map, heaviest weight first. */
function serializeRow(row: Record<string, number>): string {
  const pairs = Object.entries(row)
    .filter(([, w]) => typeof w === 'number' && w > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, w]) => `${k}: ${w}`);
  return pairs.length ? `{ ${pairs.join(', ')} }` : '{}';
}

/**
 * Regenerate the `ADJACENCY = { … }` object literal as source text, one row per line in the
 * existing hand-written style. The synthetic `default` row is emitted last, preceded by the
 * same explanatory comment the file ships with. Row order follows the POSTed object's key
 * order (the matrix tool sends catalog order, then `default`).
 */
function serializeAdjacency(adj: Record<string, Record<string, number>>): string {
  const lines: string[] = ['export const ADJACENCY: Record<string, Record<string, number>> = {'];
  for (const [source, row] of Object.entries(adj)) {
    if (source === 'default') continue;
    lines.push(`  ${source}: ${serializeRow(row)},`);
  }
  if (adj.default) {
    lines.push('');
    lines.push('  // Generic / unrecognised room: a plausible spread of everyday neighbours.');
    lines.push(`  default: ${serializeRow(adj.default)},`);
  }
  lines.push('};');
  return lines.join('\n');
}

/** True when `body` is a plain object of plain objects of finite numbers. */
function isAdjacencyShape(body: unknown): body is Record<string, Record<string, number>> {
  if (!body || typeof body !== 'object') return false;
  for (const row of Object.values(body as Record<string, unknown>)) {
    if (!row || typeof row !== 'object') return false;
    for (const w of Object.values(row as Record<string, unknown>)) {
      if (typeof w !== 'number' || !Number.isFinite(w)) return false;
    }
  }
  return true;
}

/**
 * Dev-only endpoint that persists edits from the Adjacency Matrix tool back into the source.
 * On `POST /__dev/adjacency` with `{ adjacency }`, it rewrites the `ADJACENCY` object literal
 * in src/rooms/roomAdjacency.ts (regenerated from the posted table), leaving the surrounding
 * file — including the factory snapshot in adjacencyDefaults.ts — untouched. Vite HMR then
 * reloads the module so predictions reflect the new table.
 */
function adjacencyWriter(): Plugin {
  const filePath = fileURLToPath(new URL('./src/rooms/roomAdjacency.ts', import.meta.url));
  // Matches the whole `export const ADJACENCY ... = { ... };` literal block.
  const blockRe =
    /export const ADJACENCY: Record<string, Record<string, number>> = \{[\s\S]*?\n\};/;
  return {
    name: 'adjacency-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/adjacency', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const adjacency = parsed.adjacency ?? parsed;
            if (!isAdjacencyShape(adjacency)) {
              res.statusCode = 400;
              res.end('Invalid adjacency payload');
              return;
            }
            const source = await readFile(filePath, 'utf8');
            if (!blockRe.test(source)) {
              res.statusCode = 500;
              res.end('Could not locate ADJACENCY block');
              return;
            }
            const next = source.replace(blockRe, serializeAdjacency(adjacency));
            await writeFile(filePath, next, 'utf8');
            res.statusCode = 204;
            res.end();
          } catch (err) {
            res.statusCode = 500;
            res.end(err instanceof Error ? err.message : 'write failed');
          }
        });
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), perfLogger(), adjacencyWriter()],
  // Served behind the VM's nginx (TLS). `ALLOWED_HOSTS` is a comma-separated list of
  // public hostnames; if unset, allow any host (the container only binds to localhost).
  server: {
    host: true,
    allowedHosts: process.env.ALLOWED_HOSTS
      ? process.env.ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
      : true,
    hmr: { protocol: 'wss', clientPort: 443 },
  },
});
