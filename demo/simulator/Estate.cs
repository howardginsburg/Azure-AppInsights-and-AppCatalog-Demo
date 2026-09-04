using System.Diagnostics;
using Azure.Monitor.OpenTelemetry.Exporter;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace ObsDemo.Simulator;

/// <summary>
/// One simulated workload. Each maps 1:1 to an Application Insights resource,
/// which is exactly the topology doc 02 recommends: one resource per workload
/// per environment, with business domain carried as a tag rather than as a boundary.
/// </summary>
public sealed record ServiceDef(string Workload, string Domain, string EnvVar)
{
    public string SourceName => $"sim.{Workload}";
}

/// <summary>
/// A node in a synthetic distributed trace. The whole trace is built as a tree of these
/// with explicit start/end times first, then emitted. Building before emitting is what
/// lets a parent's duration properly enclose its children.
/// </summary>
public sealed class SpanNode
{
    public required string Service { get; init; }
    public required string Name { get; init; }
    public required ActivityKind Kind { get; init; }

    /// <summary>Set on root spans only, purely so the console can name the flow it just sent.</summary>
    public string? Flow { get; set; }
    public DateTime StartUtc { get; set; }
    public DateTime EndUtc { get; set; }
    public Dictionary<string, object?> Attributes { get; } = new();
    public bool Failed { get; set; }
    public string? ErrorMessage { get; set; }
    public string? ExceptionType { get; set; }
    public List<SpanNode> Children { get; } = new();
    public List<LogEntry> Logs { get; } = new();

    public TimeSpan Duration => EndUtc - StartUtc;

    public SpanNode Log(Microsoft.Extensions.Logging.LogLevel level, double offsetMs,
                        string template, params object?[] args)
    {
        Logs.Add(new LogEntry(level, template, args, offsetMs));
        return this;
    }

    public SpanNode Add(SpanNode child)
    {
        Children.Add(child);
        return child;
    }

    public SpanNode Tag(string key, object? value)
    {
        Attributes[key] = value;
        return this;
    }
}

/// <summary>
/// Owns one TracerProvider per simulated service. Each provider listens only to its own
/// ActivitySource and exports to only its own Application Insights connection string —
/// that isolation is what makes eight distinct resources light up correctly.
/// </summary>
public sealed class Estate : IDisposable
{
    public static readonly ServiceDef[] Services =
    [
        new("retail-web",            "Retail",   "APPINSIGHTS_RETAIL_WEB"),
        new("retail-api-orders",     "Retail",   "APPINSIGHTS_RETAIL_API_ORDERS"),
        new("retail-api-catalog",    "Retail",   "APPINSIGHTS_RETAIL_API_CATALOG"),
        new("pay-api-gateway",       "Payments", "APPINSIGHTS_PAY_API_GATEWAY"),
        new("pay-worker-settlement", "Payments", "APPINSIGHTS_PAY_WORKER_SETTLEMENT"),
        new("cust-api-profile",      "Customer", "APPINSIGHTS_CUST_API_PROFILE"),
        new("cust-worker-notify",    "Customer", "APPINSIGHTS_CUST_WORKER_NOTIFY"),
        new("shared-api-inventory",  "Platform", "APPINSIGHTS_SHARED_API_INVENTORY"),
    ];

    private readonly Dictionary<string, ActivitySource> _sources = new();
    private readonly List<TracerProvider> _providers = new();
    private readonly Dictionary<string, ILogger> _loggers = new();
    private readonly List<ILoggerFactory> _loggerFactories = new();

    public Estate(IReadOnlyDictionary<string, string> connectionStrings)
    {
        foreach (var svc in Services)
        {
            if (!connectionStrings.TryGetValue(svc.EnvVar, out var cs) || string.IsNullOrWhiteSpace(cs))
                throw new InvalidOperationException(
                    $"Missing connection string for {svc.Workload} (expected {svc.EnvVar} in .env). Run deploy.sh first.");

            var source = new ActivitySource(svc.SourceName);
            _sources[svc.Workload] = source;

            var provider = Sdk.CreateTracerProviderBuilder()
                .SetResourceBuilder(ResourceBuilder.CreateDefault()
                    // service.name becomes cloud_RoleName, which is the single most
                    // important field here: without it Application Map does not function.
                    .AddService(serviceName: svc.Workload, serviceInstanceId: $"{svc.Workload}-01"))
                .AddSource(svc.SourceName)
                .AddAzureMonitorTraceExporter(o =>
                {
                    o.ConnectionString = cs;
                    // Exporter 1.8.x defaults to RATE-LIMITED sampling at TracesPerSecond = 5
                    // and installs its own sampler, which silently overrides any sampler set
                    // earlier on the builder. A backfill emits far faster than 5 traces/sec, so
                    // leaving these at their defaults discards most of the telemetry.
                    o.TracesPerSecond = null;
                    o.SamplingRatio = 1.0f;
                })
                // Set AFTER the exporter so this sampler is the one that survives.
                .SetSampler(new AlwaysOnSampler())
                .Build()!;

            _providers.Add(provider);

            // One logger pipeline per service, exporting to that service's own resource, so
            // AppTraces carries the correct AppRoleName — the same isolation as the traces.
            var loggerFactory = LoggerFactory.Create(builder =>
            {
                builder.SetMinimumLevel(LogLevel.Information);
                builder.AddOpenTelemetry(o =>
                {
                    o.SetResourceBuilder(ResourceBuilder.CreateDefault()
                        .AddService(serviceName: svc.Workload, serviceInstanceId: $"{svc.Workload}-01"));
                    o.IncludeFormattedMessage = true;
                    o.IncludeScopes = false;
                    o.AddProcessor(new BackdateLogProcessor());
                    o.AddAzureMonitorLogExporter(x => x.ConnectionString = cs);
                });
            });

            _loggerFactories.Add(loggerFactory);
            _loggers[svc.Workload] = loggerFactory.CreateLogger(svc.Workload);
        }
    }

    /// <summary>
    /// Emits a fully built trace tree. Parent context is threaded down explicitly so the
    /// trace stitches across services (and therefore across Application Insights resources).
    /// </summary>
    public int Emit(SpanNode root) => EmitNode(root, default);

    private int EmitNode(SpanNode node, ActivityContext parentContext)
    {
        if (!_sources.TryGetValue(node.Service, out var source))
            throw new InvalidOperationException($"Unknown service '{node.Service}'.");

        var tags = node.Attributes.Select(kv => new KeyValuePair<string, object?>(kv.Key, kv.Value));

        var activity = source.StartActivity(
            node.Name,
            node.Kind,
            parentContext,
            tags,
            links: null,
            startTime: new DateTimeOffset(node.StartUtc, TimeSpan.Zero));

        if (activity is null)
        {
            // No listener sampled it. Should not happen with AlwaysOnSampler, but if it
            // does, failing loudly beats silently emitting a broken trace.
            throw new InvalidOperationException(
                $"ActivitySource '{node.Service}' produced no Activity — check TracerProvider wiring.");
        }

        var count = 1;

        if (node.Failed)
        {
            activity.SetStatus(ActivityStatusCode.Error, node.ErrorMessage ?? "failed");
            if (node.ExceptionType is not null)
            {
                // Standard OpenTelemetry exception event shape. The Azure Monitor exporter
                // turns this into an entry in the exceptions table, which is what makes the
                // Failures blade drill-down work.
                activity.AddEvent(new ActivityEvent("exception", tags: new ActivityTagsCollection
                {
                    { "exception.type", node.ExceptionType },
                    { "exception.message", node.ErrorMessage ?? "failed" },
                    { "exception.stacktrace", $"   at {node.Service}.{node.Name}()" },
                }));
            }
        }
        else
        {
            activity.SetStatus(ActivityStatusCode.Ok);
        }

        // Emitted while this span is Activity.Current, so the OpenTelemetry ILogger provider
        // picks up TraceId/SpanId automatically and the log rows correlate to this exact span.
        EmitLogs(node);

        var childContext = activity.Context;
        foreach (var child in node.Children)
            count += EmitNode(child, childContext);
        // Set the end time explicitly, then Stop(). Stop() only back-fills Duration when it
        // is still zero, so an explicit SetEndTime survives — this is what makes historical
        // backfill possible at all.
        activity.SetEndTime(node.EndUtc);
        activity.Stop();

        return count;
    }

    private void EmitLogs(SpanNode node)
    {
        if (node.Logs.Count == 0 || !_loggers.TryGetValue(node.Service, out var logger)) return;

        foreach (var entry in node.Logs)
        {
            BackdateLogProcessor.Override.Value = node.StartUtc.AddMilliseconds(entry.OffsetMs);
            try
            {
#pragma warning disable CA2254 // Template is data here by design; this is a generator.
                logger.Log(entry.Level, entry.Template, entry.Args);
#pragma warning restore CA2254
            }
            finally
            {
                BackdateLogProcessor.Override.Value = null;
            }
        }
    }

    /// <summary>
    /// Flushes pending telemetry without tearing anything down, so emission can continue
    /// afterwards. Live mode depends on this being non-destructive.
    /// </summary>
    public void Flush()
    {
        foreach (var p in _providers)
            p.ForceFlush(30_000);
    }

    public void Dispose()
    {
        Flush();

        // Disposing the logger factories flushes the log exporters; there is no ForceFlush
        // on ILoggerFactory. This belongs at shutdown ONLY — doing it inside Flush() clears
        // _loggers and silently kills logging for everything emitted afterwards, which is
        // exactly what broke live mode.
        foreach (var f in _loggerFactories) f.Dispose();
        _loggerFactories.Clear();
        _loggers.Clear();

        foreach (var p in _providers) p.Dispose();
        foreach (var s in _sources.Values) s.Dispose();
    }
}
