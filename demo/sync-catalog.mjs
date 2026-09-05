// Publishes the service catalog into Log Analytics so KQL can join against it directly,
// instead of the catalog being inlined into the workbook at build time.
//
//   node sync-catalog.mjs                            # from ./catalog/catalog.json
//   node sync-catalog.mjs --from ./exported.json     # any JSON array of rows
//   cat rows.json | node sync-catalog.mjs --from -   # or stdin
//
// One destination, deliberately: a workspace saved function aliased 'AppCatalog'.
//
// That function is ARM metadata, NOT log data. The distinction is the whole reason it
// was chosen:
//
//   * It has no retention and no TimeGenerated, so it never ages out. Nothing can be
//     silently dropped, and no keep-alive feeder has to exist to prevent that.
//   * It always reflects current state. Deletion is expressed by replacing the whole
//     body and omitting the row -- no tombstones, no arg_max(), no change log to reason
//     about at query time.
//
// So the canonical "current catalog" query is just:
//
//   AppCatalog
//
// The trade-off, stated plainly: a function knows only *now*. It cannot answer "who
// owned this service on the day of the incident?" If point-in-time history ever becomes
// a real requirement, the answer is a custom log table fed via the Logs Ingestion API
// -- added deliberately, as a second component with its own defined role, rather than
// as a duplicate of this one.
//
// Source-agnostic by design: it consumes a JSON array of row objects. Getting that array
// out of SQL Server is a one-liner and deliberately not this script's job --
//
//   sqlcmd -S <server> -d <db> -G -C -h -1 -W -Q \
//     "SET NOCOUNT ON; SELECT * FROM dbo.ServiceCatalog FOR JSON PATH" > rows.json
//   node sync-catalog.mjs --from rows.json
//
// Auth is the caller's `az login` identity, which needs write on the workspace's
// savedSearches.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const FROM = arg("from", "./catalog/catalog.json");
const RG = arg("rg", process.env.RESOURCE_GROUP || "AppInsightsDemo");
const WS = arg("workspace", process.env.WORKSPACE_NAME || "log-obsdemo");
let SUB = arg("subscription", process.env.SUBSCRIPTION_ID || "");
const ALIAS = arg("alias", "AppCatalog");
const DRYRUN = argv.includes("--dry-run");

// Column order is the contract. The saved function's datatable() is positional, so this
// list -- not the key order of whatever JSON arrived -- decides the schema.
const COLUMNS = [
    "workload", "displayName", "domain", "criticality", "owner", "businessOwner",
    "description", "appUrl", "docsUrl", "runbookUrl", "repoUrl", "slo", "onCall",
];

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

// ---------------------------------------------------------------- publish

function kqlString(v) {
    return '"' + String(v ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t") + '"';
}

function buildFunctionBody() {
    // isActive is part of the published schema and is always true here: a full replace
    // expresses deletion by simply omitting the row, so there is nothing to tombstone.
    // It is kept because it is a stable, documented column that consumers may filter on.
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
        console.error("  Past that the catalog has outgrown ARM metadata: move it to a custom log");
        console.error("  table fed by the Logs Ingestion API and join against that instead.");
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

// ---------------------------------------------------------------- run

if (!SUB) SUB = az(["account", "show", "-o", "json"]).id;

syncFunction();
