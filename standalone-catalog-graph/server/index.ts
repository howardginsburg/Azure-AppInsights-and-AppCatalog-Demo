/**
 * Express server: serves the built React frontend and the JSON API.
 *
 *   GET    /api/health              liveness and configuration presence
 *   GET    /api/estate?rangeHours=N topology from Log Analytics, tags, and catalog, joined
 *   GET    /api/catalog             catalog rows
 *   GET    /api/catalog/:id         one catalog row
 *   POST   /api/catalog             create a row
 *   PUT    /api/catalog/:id         update a row
 *   DELETE /api/catalog/:id         delete a row
 *   POST   /api/catalog/import      insert rows that are not cataloged yet; never overwrites
 *
 * The API is anonymous: anyone who can reach the app can edit the catalog. Put authentication
 * in front of it before using real data.
 */
import express, { type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEstateGraph } from './estate.js';
import { assertSupportedNode } from './runtime.js';
import { isGuid, parseCatalogInput } from './catalogInput.js';
import {
  createCatalog,
  deleteCatalog,
  ensureSchema,
  getCatalogById,
  importCatalog,
  listCatalog,
  updateCatalog,
} from './catalogDb.js';
import type { CatalogInput } from '../common/shared.js';

assertSupportedNode();

const MAX_IMPORT_ROWS = 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built layout: dist-server/server/index.js and dist/public/* under the project root.
const STATIC_DIR = path.resolve(__dirname, '..', '..', 'dist', 'public');

const app = express();
app.use(express.json({ limit: '1mb' }));

function fail(res: Response, route: string, err: unknown) {
  console.error(`${route} failed:`, err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

function isDuplicateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate key|UNIQUE KEY|unique constraint/i.test(msg);
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasWorkspace: Boolean(process.env.LA_WORKSPACE_ID),
    hasWorkspaceResourceId: Boolean(process.env.LA_WORKSPACE_RESOURCE_ID),
    hasSql: Boolean(process.env.SQL_SERVER && process.env.SQL_DATABASE),
    nodeVersion: process.versions.node,
    time: new Date().toISOString(),
  });
});

app.get('/api/estate', async (req, res) => {
  try {
    res.json(await getEstateGraph(req.query.rangeHours));
  } catch (err) {
    fail(res, 'GET /api/estate', err);
  }
});

app.get('/api/catalog', async (_req, res) => {
  try {
    res.json(await listCatalog());
  } catch (err) {
    fail(res, 'GET /api/catalog', err);
  }
});

app.post('/api/catalog/import', async (req, res) => {
  const body: unknown = req.body;
  if (!Array.isArray(body)) {
    res.status(400).json({ error: 'Expected a JSON array of catalog rows.' });
    return;
  }
  if (body.length > MAX_IMPORT_ROWS) {
    res.status(400).json({ error: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` });
    return;
  }
  const rows: CatalogInput[] = [];
  for (const [i, item] of body.entries()) {
    const parsed = parseCatalogInput(item);
    if ('error' in parsed) {
      res.status(400).json({ error: `Row ${i + 1}: ${parsed.error}` });
      return;
    }
    rows.push(parsed);
  }
  try {
    await ensureSchema();
    res.json(await importCatalog(rows));
  } catch (err) {
    fail(res, 'POST /api/catalog/import', err);
  }
});

app.get('/api/catalog/:id', async (req, res) => {
  if (!isGuid(req.params.id)) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  try {
    const row = await getCatalogById(req.params.id);
    if (row) res.json(row);
    else res.status(404).json({ error: 'Not found.' });
  } catch (err) {
    fail(res, 'GET /api/catalog/:id', err);
  }
});

app.post('/api/catalog', async (req, res) => {
  const parsed = parseCatalogInput(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    await ensureSchema();
    res.status(201).json(await createCatalog(parsed));
  } catch (err) {
    if (isDuplicateError(err)) {
      res.status(409).json({ error: `"${parsed.workload}" is already in the catalog.` });
      return;
    }
    fail(res, 'POST /api/catalog', err);
  }
});

app.put('/api/catalog/:id', async (req, res) => {
  if (!isGuid(req.params.id)) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  const parsed = parseCatalogInput(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const updated = await updateCatalog(req.params.id, parsed);
    if (updated) res.json(updated);
    else res.status(404).json({ error: 'Not found.' });
  } catch (err) {
    if (isDuplicateError(err)) {
      res.status(409).json({ error: `"${parsed.workload}" is already in the catalog.` });
      return;
    }
    fail(res, 'PUT /api/catalog/:id', err);
  }
});

app.delete('/api/catalog/:id', async (req, res) => {
  if (!isGuid(req.params.id)) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  try {
    if (await deleteCatalog(req.params.id)) res.status(204).end();
    else res.status(404).json({ error: 'Not found.' });
  } catch (err) {
    fail(res, 'DELETE /api/catalog/:id', err);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Static frontend, with the SPA shell for every other GET (including ?workload= deep links).
app.use(express.static(STATIC_DIR));
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    next();
    return;
  }
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`catalog app listening on :${port} (Node.js ${process.versions.node})`);
});

// Create the catalog table on first boot of a new database. Failures are logged, not fatal.
if (process.env.SQL_SERVER && process.env.SQL_DATABASE) {
  ensureSchema().catch((err) => {
    console.warn('Catalog schema check skipped:', err instanceof Error ? err.message : err);
  });
}
