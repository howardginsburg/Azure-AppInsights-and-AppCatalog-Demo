// Publishes the service catalog into Log Analytics so KQL can join against it directly,
// instead of the catalog being inlined into the workbook at build time.
//
//   node sync-catalog.mjs --target function          # default
//   node sync-catalog.mjs --target table
//   node sync-catalog.mjs --target both
//   node sync-catalog.mjs --target table --full      # rewrite every row, skip delta
//   node sync-catalog.mjs --from ./exported.json     # any JSON array of rows
//   cat rows.json | node sync-catalog.mjs --from -   # or stdin
//
// Two targets, because they answer two different questions:
//
//   function  ->  a workspace saved function aliased 'AppCatalog'. This is ARM metadata,
//                 NOT log data, so it has NO retention and never ages out. It always
//                 reflects current state, and deletion is expressed by simply replacing
//                 the whole body. This is the reference table you join against.
//
//   table     ->  rows pushed to the AppCatalog_CL custom table via the Logs Ingestion
//                 API. This IS log data and IS subject to retention (730d interactive
//                 max), so it decays unless this script keeps running. Its value is
//                 history: "who owned this service on the day of the incident?"
//
// The table is append-only, which means "the catalog" is not the set of rows -- it is
// the newest row per workload. Two consequences drive the design here:
//
//   1. Only changed rows are written (compared by content hash), so the history is a
//      real change log rather than N identical rows per sync.
//   2. A workload that disappears from the source gets an explicit tombstone row with
//      isActive=false. Without it, arg_max() would keep returning the retired service's
//      last known row forever and it could never be removed from the portfolio.
//
// So the canonical "current catalog" query is:
//
//   AppCatalog_CL | summarize arg_max(TimeGenerated, *) by workload | where isActive
//
// Use 'function' if you need the catalog to persist. Add 'table' only if you also want
// point-in-time history. Running 'both' keeps them consistent.
//
// Source-agnostic by design: it consumes a JSON array of row objects. Getting that array
// out of SQL Server is a one-liner and deliberately not this script's job --
//
//   sqlcmd -S <server> -d <db> -G -C -h -1 -W -Q \
//     "SET NOCOUNT ON; SELECT * FROM dbo.ServiceCatalog FOR JSON PATH" > rows.json
//   node sync-catalog.mjs --from rows.json --target both
//
// Auth is the caller's `az login` identity. Pushing to the table additionally requires
// Monitoring Metrics Publisher on the DCR.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const TARGET = arg("target", "function");
const FROM = arg("from", "./catalog/catalog.json");
const RG = arg("rg", process.env.RESOURCE_GROUP || "AppInsightsDemo");
const WS = arg("workspace", process.env.WORKSPACE_NAME || "log-obsdemo");
let SUB = arg("subscription", process.env.SUBSCRIPTION_ID || "");
const DCR = arg("dcr", "dcr-appcatalog");
const ALIAS = arg("alias", "AppCatalog");
const TABLE = arg("table-name", "AppCatalog_CL");
const DRYRUN = argv.includes("--dry-run");
// Skip delta detection and rewrite every row. Useful after a schema change, or to
// re-seed the table once rows have aged past retention.
const FULL = argv.includes("--full");
// Safety valve. If the source system half-fails and returns 12 of 500 services, the
// naive delta would tombstone the other 488 and the portfolio would empty itself. This
// caps how much of the catalog a single sync is allowed to retire.
const MAX_RETIRE_PCT = Number(arg("max-retire-pct", "10"));
const ALLOW_MASS_RETIRE = argv.includes("--allow-mass-retire");

if (!["function", "table", "both"].includes(TARGET)) {
    console.error(`--target must be function | table | both (got '${TARGET}')`);
    process.exit(1);
}

// Column order is the contract. The saved function's datatable() is positional, so this
// list -- not the key order of whatever JSON arrived -- decides the schema.
const COLUMNS = [
    "workload", "displayName", "domain", "criticality", "owner", "businessOwner",
    "description", "appUrl", "docsUrl", "runbookUrl", "repoUrl", "slo", "onCall",
];

// Bookkeeping columns. A custom log table is append-only, so "the catalog" is not the
// set of rows -- it is the newest row per workload. These three make that tractable:
//
//   isActive  a row is a tombstone when false. Without this, deleting a service from the
//             source is invisible: arg_max() keeps returning its last known row forever
//             and the retired service haunts the portfolio permanently.
//   rowHash   content hash of the business columns. Only changed rows are written, so
//             history becomes a genuine change log instead of N identical rows per day.
//   syncId    groups every row written by one run, so a bad sync can be identified and
//             excluded as a unit.
const META_COLUMNS = ["isActive", "rowHash", "syncId"];
const ALL_COLUMNS = [...COLUMNS, ...META_COLUMNS];

const KEY = "workload";

// ---------------------------------------------------------------- helpers

const tmp = mkdtempSync(join(tmpdir(), "synccat-"));

// Invoking the Azure CLI portably is fiddlier than it looks. On Windows `az` is a batch
// shim, and Node 24 refuses to spawn .cmd/.bat without a shell (EINVAL). But passing an
// args *array* together with shell:true is exactly the combination Node deprecated in
// DEP0190, because it concatenates rather than escapes. So: on Windows we quote the
// arguments ourselves and hand the shell one command string; on POSIX we skip the shell
// entirely and pass the array, which needs no quoting at all.
const IS_WIN = process.platform === "win32";

const winQuote = (a) =>
    /^[A-Za-z0-9_@:.,=\/\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`;

function az(args, { json = true } = {}) {
    const opts = { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
    const out = IS_WIN
        ? execSync(["az", ...args].map(winQuote).join(" "), opts)
        : execFileSync("az", args, opts);
    return json && out.trim() ? JSON.parse(out) : out;
}

// The Azure CLI reads --body @file using the OS locale codepage, not UTF-8. On Windows
// that silently mangles any non-ASCII character (an em dash becomes '?'). Escaping every
// non-ASCII codepoint to \uXXXX makes the payload pure ASCII, so the file decodes
// identically under any codepage. This is not cosmetic -- it corrupts your data.
function writeAsciiJson(path, obj) {
    const json = JSON.stringify(obj).replace(
        /[\u0080-\uFFFF]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
    writeFileSync(path, json, "ascii");
    return path;
}

function armPut(url, body) {
    const f = writeAsciiJson(join(tmp, "body.json"), body);
    return az(["rest", "--method", "put", "--url", url, "--body", `@${f}`,
        "--headers", "Content-Type=application/json", "-o", "json"]);
}

// ---------------------------------------------------------------- load

function loadRows(src) {
    const raw = src === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(src, "utf8");

    let data = JSON.parse(raw);

    // Accept a bare array, or an object wrapping one (catalog.json uses .applications).
    // Pick the first array *of objects* -- catalog.json's `$comment` is an array of
    // strings and would otherwise win purely by being declared first.
    if (!Array.isArray(data)) {
        const isRecords = (v) =>
            Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null;
        // Prefer an array of objects; fall back to any array so that an *empty* catalog
        // reaches the explicit "refusing to publish an empty catalog" guard below rather
        // than dying here with a stack trace.
        const key = Object.keys(data).find((k) => isRecords(data[k]))
            ?? Object.keys(data).find((k) => Array.isArray(data[k]));
        if (!key) {
            console.error(`No array of records found in ${src}`);
            process.exit(1);
        }
        data = data[key];
    }
    return data;
}

const rows = loadRows(FROM);
if (rows.length === 0) {
    console.error("Refusing to publish an empty catalog -- that would silently blank the portfolio.");
    process.exit(1);
}

const missingKey = rows.filter((r) => !r[KEY]);
if (missingKey.length) {
    console.error(`${missingKey.length} row(s) have no '${KEY}' -- that is the join key, so they can never match telemetry.`);
    process.exit(1);
}

const dupes = rows.map((r) => r[KEY]).filter((v, i, a) => a.indexOf(v) !== i);
if (dupes.length) {
    console.error(`Duplicate ${KEY} value(s): ${[...new Set(dupes)].join(", ")}`);
    process.exit(1);
}

console.log(`Loaded ${rows.length} row(s) from ${FROM === "-" ? "stdin" : FROM}`);

// ---------------------------------------------------------------- target: function

function kqlString(v) {
    return '"' + String(v ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t") + '"';
}

function buildFunctionBody() {
    // The function carries isActive so the same downstream query works unchanged against
    // either source. Here it is always true: a full replace expresses deletion by simply
    // omitting the row, so tombstones are meaningless.
    const schema = [...COLUMNS.map((c) => `${c}: string`), "isActive: bool"].join(", ");
    const literals = rows
        .map((r) => "    " + [...COLUMNS.map((c) => kqlString(r[c])), "true"].join(", "))
        .join(",\n");
    return `datatable(${schema})\n[\n${literals}\n]`;
}

function syncFunction() {
    const kql = buildFunctionBody();

    // A saved function is an ARM resource, so the whole catalog travels in one request
    // body and inherits ARM's ~1 MB limit. Measured against Log Analytics: 2,000 entries
    // (761 KB of KQL) succeeds; 2,500 entries (966 KB) fails with
    // "RequestedSizeExceeded / Request Entity Too Large". The guard sits below that with
    // margin, because the JSON-escaped body is larger than the raw KQL.
    const KB = Buffer.byteLength(kql, "utf8") / 1024;
    console.log(`  function body: ${KB.toFixed(1)} KB (${rows.length} entries)`);
    if (KB > 700) {
        console.error(`  Refusing: ${KB.toFixed(0)} KB exceeds the safe ceiling for a saved function.`);
        console.error("  ARM caps the request body near 1 MB, which lands around 2,000 catalog entries.");
        console.error("  Past that, drop --target function and join against AppCatalog_CL instead.");
        process.exit(1);
    }

    if (DRYRUN) {
        console.log(kql.split("\n").slice(0, 3).join("\n") + "\n    ...");
        return;
    }

    const url =
        `https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}` +
        `/providers/Microsoft.OperationalInsights/workspaces/${WS}` +
        `/savedSearches/${ALIAS}?api-version=2020-08-01`;

    armPut(url, {
        properties: {
            category: "Catalog",
            displayName: ALIAS,
            functionAlias: ALIAS,
            query: kql,
            version: 2,
        },
    });

    console.log(`  ✓ saved function '${ALIAS}' updated (no retention -- persists until deleted)`);
}

// ---------------------------------------------------------------- target: table

// Hash of the business columns only. Bookkeeping columns are excluded, otherwise the
// hash would change on every run and defeat its own purpose.
function hashRow(r) {
    const canonical = JSON.stringify(COLUMNS.map((c) => String(r[c] ?? "")));
    return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

// Reads back the current state so the sync can write a delta. Returns a Map keyed by
// workload. A brand-new table returns an empty Map, which makes the first run a full load.
async function readCurrentState(customerId) {
    const token = az(["account", "get-access-token", "--resource",
        "https://api.loganalytics.io", "-o", "json"]).accessToken;

    const kql = `${TABLE}
| summarize arg_max(TimeGenerated, *) by ${KEY}
| project ${KEY}, rowHash, isActive`;

    const res = await fetch(`https://api.loganalytics.io/v1/workspaces/${customerId}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: kql }),
    });

    if (!res.ok) {
        // A missing table is the expected first-run case, not an error.
        const body = await res.text();
        if (/does not (exist|refer)|Failed to resolve|SEM0100/i.test(body)) return new Map();
        throw new Error(`Log Analytics query failed (HTTP ${res.status}): ${body.slice(0, 400)}`);
    }

    const data = await res.json();
    const table = data.tables?.[0];
    if (!table) return new Map();

    const idx = Object.fromEntries(table.columns.map((c, i) => [c.name, i]));
    return new Map(table.rows.map((r) => [
        r[idx[KEY]],
        { rowHash: r[idx.rowHash], isActive: r[idx.isActive] === true || r[idx.isActive] === "true" },
    ]));
}

async function syncTable() {
    const dcrUrl =
        `https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}` +
        `/providers/Microsoft.Insights/dataCollectionRules/${DCR}?api-version=2023-03-11`;

    const dcr = az(["rest", "--method", "get", "--url", dcrUrl, "-o", "json"]);
    const endpoint = dcr.properties?.endpoints?.logsIngestion;
    const immutableId = dcr.properties?.immutableId;

    if (!endpoint || !immutableId) {
        console.error(`  DCR '${DCR}' has no logsIngestion endpoint. It must be created with kind: "Direct".`);
        process.exit(1);
    }

    const customerId = az(["monitor", "log-analytics", "workspace", "show",
        "-g", RG, "-n", WS, "--query", "customerId", "-o", "json"]);

    const current = FULL ? new Map() : await readCurrentState(customerId);
    const desired = new Map(rows.map((r) => [r[KEY], r]));

    const syncId = randomUUID();
    // One TimeGenerated for the whole batch, so a snapshot is a single point in time and
    // arg_max() returns one coherent generation rather than a smear across a few seconds.
    const stamp = new Date().toISOString();

    const payload = [];
    let changed = 0, added = 0, retired = 0;

    for (const [key, r] of desired) {
        const hash = hashRow(r);
        const prev = current.get(key);
        // Re-activation counts as a change: a workload that was tombstoned and has come
        // back must be written again even if its content hash is unchanged.
        if (prev && prev.rowHash === hash && prev.isActive) continue;
        prev ? changed++ : added++;
        payload.push({
            TimeGenerated: stamp,
            ...Object.fromEntries(COLUMNS.map((c) => [c, String(r[c] ?? "")])),
            isActive: true, rowHash: hash, syncId,
        });
    }

    // Tombstones. The business columns carry the last known values forward so the row
    // stays readable -- you can still answer "who owned this when we retired it?".
    for (const [key, prev] of current) {
        if (desired.has(key) || !prev.isActive) continue;
        retired++;
        payload.push({
            TimeGenerated: stamp,
            ...Object.fromEntries(COLUMNS.map((c) => [c, ""])),
            [KEY]: key,
            isActive: false, rowHash: prev.rowHash, syncId,
        });
    }

    if (payload.length === 0) {
        console.log("  no changes — nothing written (history stays a change log, not a daily duplicate)");
        return;
    }

    // The guard deliberately measures retirements against the *existing* active count,
    // not against what the source just returned -- the whole failure mode being defended
    // against is the source returning too little.
    const activeBefore = [...current.values()].filter((p) => p.isActive).length;
    if (retired > 0 && activeBefore > 0) {
        const pct = (retired / activeBefore) * 100;
        if (pct > MAX_RETIRE_PCT && !ALLOW_MASS_RETIRE) {
            console.error(`  Refusing: this sync would retire ${retired} of ${activeBefore} active entries (${pct.toFixed(1)}%).`);
            console.error(`  That is above the ${MAX_RETIRE_PCT}% ceiling and usually means the source system`);
            console.error("  returned a partial result rather than that the services were genuinely retired.");
            console.error("  If the retirement is real: --allow-mass-retire (or raise --max-retire-pct).");
            process.exit(1);
        }
    }

    console.log(`  delta: ${added} added, ${changed} changed, ${retired} retired`);

    if (DRYRUN) {
        console.log(`  would POST ${payload.length} row(s) to ${TABLE} (syncId ${syncId})`);
        return;
    }

    const token = az(["account", "get-access-token", "--resource",
        "https://monitor.azure.com", "-o", "json"]).accessToken;

    const url = `${endpoint}/dataCollectionRules/${immutableId}/streams/Custom-${TABLE}?api-version=2023-01-01`;

    // The Logs Ingestion API caps a single call at 1 MB. A first load of a few hundred
    // services clears that comfortably, but an initial seed of a large estate will not,
    // so batch rather than fail. 800 KB leaves room for JSON overhead.
    const MAX_BYTES = 800 * 1024;
    const batches = [];
    let batch = [];
    let batchBytes = 2;
    for (const row of payload) {
        const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
        if (batch.length > 0 && batchBytes + size > MAX_BYTES) {
            batches.push(batch);
            batch = [];
            batchBytes = 2;
        }
        batch.push(row);
        batchBytes += size;
    }
    if (batch.length) batches.push(batch);

    const totalKB = (Buffer.byteLength(JSON.stringify(payload), "utf8") / 1024).toFixed(1);
    console.log(`  payload: ${totalKB} KB in ${batches.length} batch(es)`);

    for (const [i, b] of batches.entries()) {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json; charset=utf-8",
            },
            body: Buffer.from(JSON.stringify(b), "utf8"),
        });

        if (res.status !== 204) {
            console.error(`  Batch ${i + 1}/${batches.length} failed: HTTP ${res.status} (expected 204)`);
            console.error("  " + (await res.text()).slice(0, 500));
            console.error(`  Partial write. Re-run to converge -- syncId ${syncId} identifies what landed.`);
            process.exit(1);
        }
    }

    console.log(`  ✓ ${payload.length} row(s) pushed to ${TABLE} @ ${stamp}`);
    console.log(`    syncId ${syncId}`);
    console.log("    current state:");
    console.log(`      ${TABLE} | summarize arg_max(TimeGenerated, *) by ${KEY} | where isActive`);
}

// ---------------------------------------------------------------- run

if (!SUB) SUB = az(["account", "show", "-o", "json"]).id;

if (TARGET === "function" || TARGET === "both") {
    console.log("Target: saved function");
    syncFunction();
}
if (TARGET === "table" || TARGET === "both") {
    console.log("Target: custom table");
    await syncTable();
}
