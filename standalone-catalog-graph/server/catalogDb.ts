/**
 * Azure SQL catalog store. Holds business context only: display name, description, owners,
 * links, SLO, and on-call. Classification (domain, criticality, owner team) comes from the
 * Application Insights resource's Azure tags, never from this table.
 *
 * Authenticates with the shared managed-identity credential. No SQL logins or passwords.
 */
import sql from 'mssql';
import { credential } from './credential.js';
import type { CatalogInput, CatalogModel, ImportResult } from '../common/shared.js';

let poolPromise: Promise<sql.ConnectionPool> | null = null;

function config(): sql.config {
  const server = process.env.SQL_SERVER;
  const database = process.env.SQL_DATABASE;
  if (!server || !database) {
    throw new Error('SQL_SERVER and SQL_DATABASE must be set.');
  }
  return {
    server,
    database,
    authentication: { type: 'token-credential', options: { credential } },
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
}

function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config())
      .connect()
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

const CREATE_TABLE = `
IF OBJECT_ID('dbo.Catalog', 'U') IS NULL
CREATE TABLE dbo.Catalog (
  id            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  workload      NVARCHAR(100)  NOT NULL UNIQUE,
  displayName   NVARCHAR(200)  NOT NULL,
  businessOwner NVARCHAR(200)  NOT NULL,
  description   NVARCHAR(1000) NOT NULL,
  appUrl        NVARCHAR(500)  NOT NULL,
  docsUrl       NVARCHAR(500)  NOT NULL,
  runbookUrl    NVARCHAR(500)  NOT NULL,
  repoUrl       NVARCHAR(500)  NOT NULL,
  slo           NVARCHAR(10)   NOT NULL,
  onCall        NVARCHAR(200)  NOT NULL,
  isActive      BIT            NOT NULL DEFAULT 1
);
`;

const COLUMNS =
  'workload, displayName, businessOwner, description, appUrl, docsUrl, runbookUrl, repoUrl, slo, onCall, isActive';

export async function ensureSchema(): Promise<void> {
  const pool = await getPool();
  await pool.request().query(CREATE_TABLE);
}

function bindInput(req: sql.Request, m: CatalogInput): sql.Request {
  return req
    .input('workload', sql.NVarChar(100), m.workload)
    .input('displayName', sql.NVarChar(200), m.displayName)
    .input('businessOwner', sql.NVarChar(200), m.businessOwner)
    .input('description', sql.NVarChar(1000), m.description)
    .input('appUrl', sql.NVarChar(500), m.appUrl)
    .input('docsUrl', sql.NVarChar(500), m.docsUrl)
    .input('runbookUrl', sql.NVarChar(500), m.runbookUrl)
    .input('repoUrl', sql.NVarChar(500), m.repoUrl)
    .input('slo', sql.NVarChar(10), m.slo)
    .input('onCall', sql.NVarChar(200), m.onCall)
    .input('isActive', sql.Bit, m.isActive);
}

function rowToModel(r: Record<string, unknown>): CatalogModel {
  return { ...(r as unknown as CatalogModel), id: String(r.id), isActive: Boolean(r.isActive) };
}

export async function listCatalog(): Promise<CatalogModel[]> {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT id, ${COLUMNS} FROM dbo.Catalog ORDER BY displayName`);
  return result.recordset.map(rowToModel);
}

export async function getCatalogById(id: string): Promise<CatalogModel | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.UniqueIdentifier, id)
    .query(`SELECT id, ${COLUMNS} FROM dbo.Catalog WHERE id = @id`);
  return result.recordset[0] ? rowToModel(result.recordset[0]) : null;
}

/** Inserts a row and returns it. Throws on a duplicate workload. */
export async function createCatalog(input: CatalogInput): Promise<CatalogModel> {
  const pool = await getPool();
  const result = await bindInput(pool.request(), input).query(`
    INSERT INTO dbo.Catalog (${COLUMNS})
    OUTPUT INSERTED.id
    VALUES (@workload, @displayName, @businessOwner, @description, @appUrl, @docsUrl,
            @runbookUrl, @repoUrl, @slo, @onCall, @isActive)
  `);
  const created = await getCatalogById(String(result.recordset[0].id));
  if (!created) throw new Error('Insert succeeded but the row could not be read back.');
  return created;
}

/** Updates a row by id. Returns null when it does not exist. */
export async function updateCatalog(id: string, input: CatalogInput): Promise<CatalogModel | null> {
  const pool = await getPool();
  const result = await bindInput(pool.request().input('id', sql.UniqueIdentifier, id), input).query(`
    UPDATE dbo.Catalog SET
      workload = @workload, displayName = @displayName, businessOwner = @businessOwner,
      description = @description, appUrl = @appUrl, docsUrl = @docsUrl, runbookUrl = @runbookUrl,
      repoUrl = @repoUrl, slo = @slo, onCall = @onCall, isActive = @isActive
    WHERE id = @id
  `);
  if ((result.rowsAffected[0] ?? 0) === 0) return null;
  return getCatalogById(id);
}

/** Deletes a row by id. Returns true when a row was removed. */
export async function deleteCatalog(id: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.UniqueIdentifier, id)
    .query('DELETE FROM dbo.Catalog WHERE id = @id');
  return (result.rowsAffected[0] ?? 0) > 0;
}

/** Inserts rows whose workload is not cataloged yet. Existing rows are never overwritten. */
export async function importCatalog(rows: CatalogInput[]): Promise<ImportResult> {
  const pool = await getPool();
  const existing = await pool.request().query('SELECT workload FROM dbo.Catalog');
  const have = new Set<string>(existing.recordset.map((r) => String(r.workload).toLowerCase()));

  let inserted = 0;
  for (const row of rows) {
    const key = row.workload.toLowerCase();
    if (have.has(key)) continue;
    await bindInput(pool.request(), row).query(`
      INSERT INTO dbo.Catalog (${COLUMNS})
      VALUES (@workload, @displayName, @businessOwner, @description, @appUrl, @docsUrl,
              @runbookUrl, @repoUrl, @slo, @onCall, @isActive)
    `);
    have.add(key);
    inserted += 1;
  }
  return { inserted, skipped: rows.length - inserted, total: rows.length };
}
