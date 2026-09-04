using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace ObsDemo.Simulator;

/// <summary>
/// A structured log line attached to a span, offset from that span's start.
/// </summary>
public sealed record LogEntry(LogLevel Level, string Template, object?[] Args, double OffsetMs);

/// <summary>
/// Rewrites <see cref="LogRecord.Timestamp"/> as records leave the pipeline.
///
/// The OpenTelemetry SDK stamps log timestamps at emit time and the Logs Bridge API
/// (<c>LoggerProvider.GetLogger</c> / <c>Logger.Emit</c>), which would let a caller supply
/// its own timestamp, is still <c>internal</c> in the stable OpenTelemetry package. A
/// processor is therefore the only way to back-date a log record using public, stable API —
/// and <see cref="LogRecord.Timestamp"/> is publicly settable precisely so processors can
/// enrich records like this.
///
/// Trace correlation needs no help: the OpenTelemetry ILogger provider reads
/// <c>Activity.Current</c>, and logs are emitted while the synthetic span is current, so
/// TraceId and SpanId are already correct.
/// </summary>
internal sealed class BackdateLogProcessor : BaseProcessor<LogRecord>
{
    internal static readonly AsyncLocal<DateTime?> Override = new();

    public override void OnEnd(LogRecord data)
    {
        if (Override.Value is DateTime ts)
        {
            data.Timestamp = ts;
            data.ObservedTimestamp = ts;
        }
    }
}
