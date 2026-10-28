using System.Diagnostics;

namespace ObsDemo.Simulator;

public static class Program
{
    // The Application Insights ingestion endpoint rejects records older than 48 hours.
    // 24 is the safe default; anything beyond MaxBackfill is silently dropped, so we refuse it.
    private const int MaxBackfillHours = 47;

    /// <summary>Where the connection strings came from; shown in the banner.</summary>
    private static string? _configPath;

    public static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"\nERROR: {ex.Message}");
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        if (args.Contains("--help") || args.Contains("-h"))
        {
            Console.WriteLine("""
                obsdemo-simulator — synthetic telemetry generator for the observability demo

                  --backfill-hours N   Generate N hours of history ending now (default 24, max 47)
                  --traces-per-hour N  Traces per simulated hour (default 60)
                  --live               After backfill, keep emitting in real time
                  --live-minutes N     Stop live mode after N minutes (default: run until Ctrl+C)
                  --live-rate N        Live traces per MINUTE (default 60, i.e. one per second)
                  --seed N             RNG seed for reproducible runs (default 1337)
                  --dry-run            Build traces and report shape without sending

                Tip: for a live demo on an estate that already has history, use
                     --backfill-hours 0 --live  to add real-time traffic without re-seeding.

                Note: this is a TELEMETRY GENERATOR, not an instrumentation reference.
                For how to instrument a real application, see docs/02-end-to-end-correlation.md.
                """);
            return 0;
        }

        // Reject unknown flags rather than silently ignoring them. An ignored "--hours 1"
        // looks like it worked but quietly runs the 24h default, which is a genuinely
        // confusing way to lose an afternoon.
        var known = new[]
        {
            "--backfill-hours", "--traces-per-hour", "--seed", "--live", "--live-minutes",
            "--live-rate", "--dry-run"
        };
        var unknown = args.Where(a => a.StartsWith("--", StringComparison.Ordinal) && !known.Contains(a)).ToList();
        if (unknown.Count > 0)
            throw new ArgumentException(
                $"Unknown option(s): {string.Join(", ", unknown)}. Run with --help for the supported list.");

        var backfillHours = GetInt(args, "--backfill-hours", 24);
        var tracesPerHour = GetInt(args, "--traces-per-hour", 60);
        var seed = GetInt(args, "--seed", 1337);
        var liveMinutes = GetInt(args, "--live-minutes", 0);
        var liveRate = GetInt(args, "--live-rate", 60);

        // Passing --live-minutes or --live-rate without --live is obviously an attempt to run
        // live mode, so honour the intent rather than silently ignoring the flag.
        var live = args.Contains("--live") || args.Contains("--live-minutes") || args.Contains("--live-rate");
        var dryRun = args.Contains("--dry-run");

        if (backfillHours > MaxBackfillHours)
            throw new ArgumentException(
                $"--backfill-hours {backfillHours} exceeds the {MaxBackfillHours}h limit. " +
                "The Application Insights ingestion endpoint rejects records older than 48 hours, " +
                "so older telemetry would be silently discarded.");

        var connectionStrings = LoadEnv();
        var rng = new Random(seed);
        var now = DateTime.UtcNow;

        PrintBanner(backfillHours, tracesPerHour, dryRun, live, liveRate, liveMinutes, connectionStrings.Count);

        // Build every trace first so a dry run reports the real shape.
        var plan = BuildPlan(now, backfillHours, tracesPerHour, rng);

        if (dryRun)
        {
            Console.WriteLine($"  DRY RUN - nothing will be sent. Planned {plan.Count} traces.\n");
            Report(plan);
            return 0;
        }

        using var estate = new Estate(connectionStrings);

        if (plan.Count > 0)
        {
            Console.WriteLine($"\n  Backfilling {backfillHours}h of history — {plan.Count} traces");
            Console.WriteLine("  " + new string('-', 74));

            var spans = 0;
            var sent = 0;
            var sw = Stopwatch.StartNew();

            foreach (var trace in plan)
            {
                spans += estate.Emit(trace);
                sent++;
                if (sent % 25 == 0 || sent == plan.Count)
                    DrawProgress(sent, plan.Count, spans, sw.Elapsed);
            }

            DrawProgress(sent, plan.Count, spans, sw.Elapsed);
            Console.WriteLine();

            Console.Write("\n  Flushing to Application Insights ... ");
            estate.Flush();
            Console.WriteLine($"done ({sw.Elapsed.TotalSeconds:F1}s total)\n");

            Report(plan);
        }
        else
        {
            Console.WriteLine("\n  Backfill skipped (--backfill-hours 0).\n");
        }

        if (live)
        {
            RunLive(estate, rng, liveMinutes, liveRate);
        }

        PrintNextSteps(plan.Count > 0);
        return 0;
    }

    /// <summary>
    /// Explains what is about to be simulated. Someone watching a demo over a shoulder should
    /// be able to read this and understand that no application is being deployed.
    /// </summary>
    private static void PrintBanner(
        int backfillHours, int tracesPerHour, bool dryRun, bool live, int liveRate, int liveMinutes, int configured)
    {
        Console.WriteLine($"""

            ==============================================================================
              Observability demo - synthetic telemetry simulator
            ==============================================================================

              This ONE process emits OpenTelemetry spans as if it were {Estate.Services.Length} independent
              apps. Nothing is deployed - no app, no database, no queue, no external API.
              Only the telemetry is real, so Application Map, end-to-end transactions and
              failure analysis all behave exactly as they would for a genuine distributed system.

              Simulated estate ({Estate.Services.Length} apps -> {Estate.Services.Length} App Insights resources -> 1 workspace)
                {string.Join(", ", Estate.Services.Take(4).Select(s => s.Workload))},
                {string.Join(", ", Estate.Services.Skip(4).Select(s => s.Workload))}
              Their domain, criticality and owner are Azure tags on each resource (demo/apps.bicep).
              shared-api-inventory is called from two domains: Retail and Payments.
            """);

        Console.WriteLine("""

              Simulated flows
                45%  checkout        retail-web > retail-api-orders > shared-api-inventory
                                     > SQL > pay-api-gateway > [external processor]
                                     > Service Bus > pay-worker-settlement > SQL
                                     > shared-api-inventory /api/commit
                                     multi-hop, cross-domain, sync + async, 2 DB calls
                35%  browse-catalog  retail-web > retail-api-catalog > Redis > SQL
                                     cache-then-database pattern
                20%  update-profile  retail-web > cust-api-profile > Cosmos DB
                                     > Service Bus > cust-worker-notify > [external email]
                                     second async chain, different database type

                [external ...] nodes are deliberately UNINSTRUMENTED. They appear on the
                map with no server side - showing exactly where your instrumentation ends.
            """);

        if (backfillHours > 0)
        {
            var now = DateTime.Now;

            // Only advertise incidents that actually fall inside the requested window.
            // Listing the 17h-ago SQL outage during a 2h backfill sends people hunting
            // for failures that were never generated.
            var incidents = new (double From, double To, string Name, string Effect)[]
            {
                (6.0,  4.5,  "inventory 500s",          "red edges in TWO domains"),
                (12.0, 10.0, "payment gateway latency", "P95 latency hotspot"),
                (18.0, 17.0, "catalog SQL timeouts",    "failed dependency + exceptions"),
            }.Where(i => i.From <= backfillHours).ToArray();

            if (incidents.Length > 0)
            {
                Console.WriteLine("\n  Injected incidents in the backfill window (local time)");
                foreach (var i in incidents)
                    Console.WriteLine($"    {i.Name,-24} {now.AddHours(-i.From):HH:mm} - {now.AddHours(-i.To):HH:mm}" +
                                      $"   ({i.From:0.#}-{i.To:0.#}h ago)   {i.Effect}");
            }
            else
            {
                Console.WriteLine($"\n  No incidents in this window - the earliest is 4.5h ago, " +
                                  $"so use --backfill-hours 6 or more to include one.");
            }
        }

        Console.WriteLine($"""

              This run
                backfill      : {(backfillHours > 0 ? $"{backfillHours}h at {tracesPerHour} traces/hour" : "none (--backfill-hours 0)")}
                live mode     : {(live ? $"{liveRate} traces/min, {(liveMinutes > 0 ? $"stops after {liveMinutes} min" : "until Ctrl+C")}" : "off (pass --live to enable)")}
                destination   : {(dryRun ? "DRY RUN - nothing sent" : $"{configured} connection strings loaded")}
                config        : {_configPath ?? "environment variables"}
            """);
    }

    private static void DrawProgress(int sent, int total, int spans, TimeSpan elapsed)
    {
        var frac = total == 0 ? 1.0 : (double)sent / total;
        var filled = (int)(frac * 40);
        var rate = elapsed.TotalSeconds > 0 ? sent / elapsed.TotalSeconds : 0;
        var eta = rate > 0 ? TimeSpan.FromSeconds((total - sent) / rate) : TimeSpan.Zero;

        Console.Write($"\r  [{new string('#', filled)}{new string('.', 40 - filled)}] {frac,4:P0}  " +
                      $"{sent}/{total} traces  {spans} spans  eta {eta.TotalSeconds,3:F0}s ");
    }

    private static void PrintNextSteps(bool backfilled)
    {
        Console.WriteLine($"""

              ------------------------------------------------------------------------
              Where to look now

                Application Map    any App Insights resource > Application Map
                                   cross-component discovery takes a few minutes
                Transactions       Investigate > Transaction search > pick a checkout
                Failures           Investigate > Failures > shared-api-inventory
                Portfolio          the Application Portfolio workbook (deploy.sh prints its link)
                Catalog            the catalog app (deploy.sh prints its link)
                Live Metrics       any resource > Live Metrics (live mode only)
            {(backfilled ? "\n              Backfilled telemetry takes 2-5 minutes to become queryable.\n" : "")}
              Guided walkthrough: demo/README.md
              ------------------------------------------------------------------------

            """);
    }


    private static List<SpanNode> BuildPlan(DateTime now, int hours, int perHour, Random rng)
    {
        var plan = new List<SpanNode>();
        var total = hours * perHour;
        var window = TimeSpan.FromHours(hours);
        var start = now - window;

        for (var i = 0; i < total; i++)
        {
            // Spread across the window with jitter, plus a mild daily traffic shape so the
            // charts do not look like a flat synthetic line.
            var frac = (i + rng.NextDouble()) / total;
            var t = start + TimeSpan.FromTicks((long)(window.Ticks * frac));

            var hourOfDay = t.Hour;
            var busy = hourOfDay is >= 9 and <= 21;
            if (!busy && rng.NextDouble() < 0.45) continue;

            var scenario = Scenario.At(now, t);
            plan.Add(PickFlow(t, rng, scenario));
        }

        return plan;
    }

    /// <summary>
    /// The traffic mix, defined once so backfill and live mode cannot drift apart, and
    /// tagged with a flow name so the console can say what it just sent.
    /// </summary>
    private static SpanNode PickFlow(DateTime t, Random rng, Scenario s)
    {
        var roll = rng.NextDouble();
        var (node, flow) = roll switch
        {
            < 0.45 => (Flows.Checkout(t, rng, s), "checkout"),
            < 0.80 => (Flows.BrowseCatalog(t, rng, s), "browse-catalog"),
            _      => (Flows.UpdateProfile(t, rng, s), "update-profile"),
        };
        node.Flow = flow;
        return node;
    }

    private static void RunLive(Estate estate, Random rng, int liveMinutes, int perMinute)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(0.1, 60.0 / Math.Max(1, perMinute)));
        var deadline = liveMinutes > 0 ? DateTime.UtcNow.AddMinutes(liveMinutes) : DateTime.MaxValue;

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        Console.WriteLine($"""

              ------------------------------------------------------------------------
              LIVE MODE - emitting in real time
              ------------------------------------------------------------------------
                rate        : {perMinute} traces/min (one every {interval.TotalSeconds:F1}s)
                stops       : {(liveMinutes > 0 ? $"automatically after {liveMinutes} min" : "when you press Ctrl+C")}
                incidents   : ~25% of traces run in a degraded window (~6-8% actually fail)
                live metrics: open any resource > Live Metrics for a sub-second view

                Each line below is one complete distributed trace, spanning several
                services. New telemetry appears in the portal within ~1-2 minutes;
                Live Metrics updates within seconds.

                time      flow             spans  duration  outcome
                --------  ---------------  -----  --------  -------------------------
            """);

        var n = 0;
        var degraded = 0;
        var failedTraces = 0;
        var totalSpans = 0;
        var started = DateTime.UtcNow;

        while (!cts.IsCancellationRequested && DateTime.UtcNow < deadline)
        {
            // Emit slightly in the past so the span has already "finished" when it is sent.
            var t = DateTime.UtcNow - TimeSpan.FromSeconds(2);

            // A steady stream of perfectly healthy traffic makes for a dull demo: the map
            // never goes red and the Failures blade stays empty. Keep a minority of traces
            // in a degraded window, choosing which incident at random. Note the failure is
            // then drawn again inside the flow, so the realised failure rate is lower than
            // this number - roughly 6-8%, matching the backfill scenarios.
            var incident = rng.NextDouble() < 0.25;
            var scenario = incident
                ? rng.Next(3) switch
                {
                    0 => Scenario.Healthy with { InventoryFailing = true },
                    1 => Scenario.Healthy with { PaymentSlow = true },
                    _ => Scenario.Healthy with { CatalogSqlTimeouts = true },
                }
                : Scenario.Healthy;

            var trace = PickFlow(t, rng, scenario);
            var spans = estate.Emit(trace);

            n++;
            totalSpans += spans;
            if (incident) degraded++;

            var anyFailed = AnyFailure(trace);
            if (anyFailed) failedTraces++;

            var outcome = anyFailed ? "FAILED  " + DescribeIncident(scenario)
                        : incident  ? "ok (degraded window)"
                        : "ok";

            Console.WriteLine($"    {DateTime.Now:HH:mm:ss}  {trace.Flow,-15}  {spans,5}  " +
                              $"{trace.Duration.TotalMilliseconds,6:F0}ms  {outcome}");

            // Every 25 traces, restate the totals so a long-running demo stays readable.
            if (n % 25 == 0)
            {
                var mins = Math.Max(0.01, (DateTime.UtcNow - started).TotalMinutes);
                Console.WriteLine($"    ----  {n} traces | {totalSpans} spans | {failedTraces} failed " +
                                  $"({100.0 * failedTraces / n:F1}%) | {n / mins:F0}/min  ----");
            }

            // No periodic ForceFlush here: the batch processors already export every 5s, and
            // a blocking flush across 8 providers stalls the loop for seconds at a time,
            // which shows up as visible gaps in the timestamps above.

            try { Task.Delay(interval, cts.Token).Wait(cts.Token); }
            catch (OperationCanceledException) { break; }
            catch (AggregateException) { break; }
        }

        var ran = DateTime.UtcNow - started;
        Console.WriteLine($"""

                live mode stopped after {ran.TotalMinutes:F1} min
                  {n} traces, {totalSpans} spans, {failedTraces} failed traces, {degraded} in a degraded window
            """);

        estate.Flush();
    }

    private static bool AnyFailure(SpanNode n) =>
        n.Failed || n.Children.Any(AnyFailure);

    private static string DescribeIncident(Scenario s) =>
        s.InventoryFailing   ? "shared-api-inventory 500"
      : s.CatalogSqlTimeouts ? "catalog SQL timeout"
      : s.PaymentSlow        ? "payment gateway slow"
      : "";

    private static void Report(List<SpanNode> plan)
    {
        var byService = new Dictionary<string, int>();
        var failures = new Dictionary<string, int>();
        var byFlow = new Dictionary<string, int>();
        var byDependency = new Dictionary<string, int>();

        void Walk(SpanNode n)
        {
            byService[n.Service] = byService.GetValueOrDefault(n.Service) + 1;
            if (n.Failed) failures[n.Service] = failures.GetValueOrDefault(n.Service) + 1;

            if (n.Attributes.TryGetValue("db.system.name", out var db) && db is string dbs)
                byDependency[dbs] = byDependency.GetValueOrDefault(dbs) + 1;
            else if (n.Attributes.ContainsKey("messaging.system"))
                byDependency["servicebus"] = byDependency.GetValueOrDefault("servicebus") + 1;

            foreach (var c in n.Children) Walk(c);
        }

        foreach (var t in plan)
        {
            byFlow[t.Flow ?? "?"] = byFlow.GetValueOrDefault(t.Flow ?? "?") + 1;
            Walk(t);
        }

        var totalSpans = byService.Values.Sum();

        Console.WriteLine("  What was generated");
        Console.WriteLine("  " + new string('-', 74));

        Console.WriteLine("\n  Traces by business flow");
        foreach (var kv in byFlow.OrderByDescending(k => k.Value))
            Console.WriteLine($"    {kv.Key,-18} {kv.Value,6} traces  ({100.0 * kv.Value / plan.Count,4:F1}%)");

        Console.WriteLine("\n  Spans by app (each one is a separate App Insights resource)");
        foreach (var kv in byService.OrderByDescending(k => k.Value))
        {
            var f = failures.GetValueOrDefault(kv.Key);
            var pct = kv.Value == 0 ? 0 : 100.0 * f / kv.Value;
            var flag = f > 0 ? "  <-- failures here" : "";
            Console.WriteLine($"    {kv.Key,-24} {kv.Value,6} spans  {f,4} failed ({pct,5:F1}%){flag}");
        }

        if (byDependency.Count > 0)
        {
            Console.WriteLine("\n  Backing-service calls (these become map nodes of their own)");
            foreach (var kv in byDependency.OrderByDescending(k => k.Value))
                Console.WriteLine($"    {kv.Key,-22} {kv.Value,6} calls");
        }

        Console.WriteLine($"\n  Total: {plan.Count} traces, {totalSpans} spans, " +
                          $"{failures.Values.Sum()} failed spans " +
                          $"({(totalSpans == 0 ? 0 : 100.0 * failures.Values.Sum() / totalSpans):F1}%)");
        Console.WriteLine($"  Average trace depth: {(plan.Count == 0 ? 0 : (double)totalSpans / plan.Count):F1} spans");
    }

    /// <summary>Reads the .env written by demo/setup.sh; real environment variables win.</summary>
    private static Dictionary<string, string> LoadEnv()
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".env"),
            Path.Combine(Directory.GetCurrentDirectory(), "..", ".env"),
            Path.Combine(Directory.GetCurrentDirectory(), ".env"),
        };

        var envFile = candidates.Select(Path.GetFullPath).FirstOrDefault(File.Exists);
        if (envFile is not null)
        {
            _configPath = envFile;
            foreach (var raw in File.ReadAllLines(envFile))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith('#')) continue;
                var idx = line.IndexOf('=');
                if (idx <= 0) continue;
                result[line[..idx].Trim()] = line[(idx + 1)..].Trim();
            }
        }

        foreach (var svc in Estate.Services)
        {
            var fromEnv = Environment.GetEnvironmentVariable(svc.EnvVar);
            if (!string.IsNullOrWhiteSpace(fromEnv)) result[svc.EnvVar] = fromEnv;
        }

        if (result.Count == 0)
            throw new InvalidOperationException(
                "No .env found and no APPINSIGHTS_* environment variables set. Run ./deploy.sh first.");

        return result;
    }

    private static int GetInt(string[] args, string name, int fallback)
    {
        var i = Array.IndexOf(args, name);
        if (i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var v)) return v;
        return fallback;
    }
}
