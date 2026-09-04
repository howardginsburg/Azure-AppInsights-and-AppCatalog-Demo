using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace ObsDemo.Simulator;

/// <summary>
/// Builds synthetic distributed traces. Attributes follow the CURRENT stable OpenTelemetry
/// semantic conventions, and span names follow what the latest Azure/OTel .NET
/// instrumentation libraries actually emit today — the goal is that this telemetry is
/// indistinguishable from a real .NET app built with current SDKs. Deliberate divergences
/// from the raw spec are commented individually where they occur.
/// </summary>
public static class Flows
{
    private const string SqlServer = "sql-obsdemo.database.windows.net";
    private const string CosmosHost = "cosmos-obsdemo.documents.azure.com";
    private const string RedisHost = "redis-obsdemo.redis.cache.windows.net";
    private const string PaymentProcessor = "api.globalpayments-example.com";
    private const string EmailProvider = "api.emailprovider-example.com";
    private const string ServiceBusHost = "sb-obsdemo.servicebus.windows.net";

    // Realistic, valid, parameterized statements — what Microsoft.Data.SqlClient would
    // actually report. Parameter placeholders stand in for values that must never be
    // allowed to reach telemetry (doc 03).
    //
    // Two behaviours of the current instrumentation are modelled here deliberately:
    //   1. OpenTelemetry.Instrumentation.SqlClient 1.12.0-beta.3+ REMOVED SetDbStatementForText,
    //      so db.query.text is now ALWAYS captured. A modern app does populate Data for SQL —
    //      unlike the older vendored instrumentation, where it was empty by default.
    //   2. Since 1.11.0-beta.1 the captured text is SANITIZED: literal values are replaced
    //      with '?'. Named parameters survive as written, which is why the bare literal in
    //      SqlSelectProducts appears as '?' rather than as the '1' the developer typed.
    private const string SqlReserveStock =
        "UPDATE dbo.StockLevels SET Available = Available - @Quantity, Reserved = Reserved + @Quantity " +
        "WHERE Sku = @Sku AND Available >= @Quantity";

    private const string SqlCommitStock =
        "UPDATE dbo.StockLevels SET Reserved = Reserved - @Quantity, OnHand = OnHand - @Quantity " +
        "WHERE Sku = @Sku AND Reserved >= @Quantity";

    private const string SqlInsertSettlement =
        "INSERT INTO dbo.Settlements (SettlementId, OrderId, AuthorizationCode, AmountMinor, CurrencyCode, SettledUtc) " +
        "VALUES (@SettlementId, @OrderId, @AuthorizationCode, @AmountMinor, @CurrencyCode, @SettledUtc)";

    private const string SqlInsertOrder =
        "INSERT INTO dbo.Orders (OrderId, CustomerId, TotalMinor, CurrencyCode, Status, CreatedUtc) " +
        "VALUES (@OrderId, @CustomerId, @TotalMinor, @CurrencyCode, @Status, @CreatedUtc)";

    private const string SqlSelectProducts =
        "SELECT TOP (@PageSize) p.ProductId, p.Sku, p.Name, p.ListPriceMinor " +
        "FROM dbo.Products AS p WHERE p.CategoryId = @CategoryId AND p.IsActive = ? ORDER BY p.Rank DESC";

    private static SpanNode Node(string service, string name, ActivityKind kind,
                                 DateTime start, TimeSpan duration)
        => new() { Service = service, Name = name, Kind = kind, StartUtc = start, EndUtc = start + duration };

    private static SpanNode HttpServer(string service, string method, string route,
                                       DateTime start, TimeSpan duration, int status = 200)
    {
        var n = Node(service, $"{method} {route}", ActivityKind.Server, start, duration);
        n.Tag("http.request.method", method)
         .Tag("url.path", route)
         .Tag("url.scheme", "https")
         .Tag("http.route", route)
         .Tag("server.address", $"{service}.contoso-demo.internal")
         .Tag("server.port", 443)
         .Tag("http.response.status_code", status);
        if (status >= 500) n.Tag("error.type", status.ToString());
        return n;
    }

    private static SpanNode HttpClient(string service, string method, string targetHost,
                                       string path, DateTime start, TimeSpan duration, int status = 200)
    {
        var n = Node(service, $"{method} {path}", ActivityKind.Client, start, duration);
        n.Tag("http.request.method", method)
         .Tag("url.full", $"https://{targetHost}{path}")
         .Tag("server.address", targetHost)
         .Tag("server.port", 443)
         .Tag("http.response.status_code", status);
        if (status >= 500) n.Tag("error.type", status.ToString());
        return n;
    }

    private static SpanNode SqlClient(string service, string operation, string table, string statement,
                                      DateTime start, TimeSpan duration, string db = "OrdersDb")
    {
        // Current stable OTel database semantic conventions only. `microsoft.sql_server` is
        // in the exporter's s_dbSystems set, so DependencyType still resolves to "SQL".
        // Statements are valid and parameterized on purpose: doc 03's redaction rule says
        // literal values must never reach telemetry, so the demo models that rather than violating it.
        var n = Node(service, $"{operation} {table}", ActivityKind.Client, start, duration);
        n.Tag("db.system.name", "microsoft.sql_server")
         .Tag("db.namespace", db)
         .Tag("db.query.text", statement)
         .Tag("db.operation.name", operation)
         .Tag("db.collection.name", table)
         .Tag("db.query.summary", $"{operation} {table}")
         .Tag("server.address", SqlServer)
         .Tag("server.port", 1433);
        return n;
    }

    private static SpanNode CosmosClient(string service, string op, DateTime start, TimeSpan duration)
    {
        // DELIBERATE DIVERGENCE FROM THE SPEC — the only one in this file.
        //
        // The current OTel registry value for Cosmos DB is `azure.cosmosdb`, but the exporter
        // passes unknown db systems through verbatim, and the Cosmos .NET SDK has NOT adopted
        // that value yet. Emitting the spec value would produce DependencyType "azure.cosmosdb",
        // which appears in no real production app's data today. Since this simulator exists to
        // mirror what a real deployment produces, it follows the SDK here and emits "cosmosdb"
        // (plus az.namespace, exactly as the real SDK does).
        //
        // Revisit when the Cosmos SDK adopts `azure.cosmosdb` and the exporter maps it.
        var n = Node(service, $"{op} profiles", ActivityKind.Client, start, duration);
        n.Tag("db.system.name", "cosmosdb")
         .Tag("az.namespace", "Microsoft.DocumentDB")
         .Tag("db.namespace", "CustomerDb")
         .Tag("db.collection.name", "profiles")
         .Tag("db.operation.name", op)
         .Tag("server.address", CosmosHost);
        return n;
    }

    private static SpanNode RedisClient(string service, string op, DateTime start, TimeSpan duration)
    {
        var n = Node(service, op, ActivityKind.Client, start, duration);
        n.Tag("db.system.name", "redis")
         .Tag("db.query.text", $"{op} catalog:page")
         .Tag("db.operation.name", op)
         .Tag("server.address", RedisHost);
        return n;
    }

    private static SpanNode QueueProducer(string service, string queue, DateTime start, TimeSpan duration)
    {
        // Span NAME follows Azure.Messaging.ServiceBus, not the generic OTel messaging
        // convention. The real SDK names its spans after the client operation
        // ("ServiceBusSender.Send"), NOT "{destination} {operation}" — and since the exporter
        // copies DisplayName verbatim into AppDependencies.Name for messaging spans, this is
        // exactly the string a real app shows. az.namespace is set by every Azure SDK span.
        var n = Node(service, "ServiceBusSender.Send", ActivityKind.Producer, start, duration);
        n.Tag("messaging.system", "servicebus")
         .Tag("az.namespace", "Microsoft.ServiceBus")
         .Tag("messaging.destination.name", queue)
         .Tag("messaging.operation.name", "send")
         .Tag("messaging.operation.type", "send")
         .Tag("server.address", ServiceBusHost);
        return n;
    }

    private static SpanNode QueueConsumer(string service, string queue, DateTime start, TimeSpan duration)
    {
        var n = Node(service, "ServiceBusProcessor.ProcessMessage", ActivityKind.Consumer, start, duration);
        n.Tag("messaging.system", "servicebus")
         .Tag("az.namespace", "Microsoft.ServiceBus")
         .Tag("messaging.destination.name", queue)
         .Tag("messaging.operation.name", "process")
         .Tag("messaging.operation.type", "process")
         .Tag("server.address", ServiceBusHost);
        return n;
    }

    private static SpanNode Fail(this SpanNode n, string exceptionType, string message,
                                 int status = 500, string? dbStatusCode = null)
    {
        n.Failed = true;
        n.ExceptionType = exceptionType;
        n.ErrorMessage = message;

        // `error.type` is stable and SHOULD be set on any span that ended in error. For HTTP
        // spans the convention is the status code; elsewhere the exception type is the
        // recommended low-cardinality value.
        if (n.Attributes.ContainsKey("http.response.status_code"))
        {
            n.Tag("http.response.status_code", status).Tag("error.type", status.ToString());
        }
        else
        {
            n.Tag("error.type", exceptionType);
        }

        if (dbStatusCode is not null) n.Tag("db.response.status_code", dbStatusCode);

        return n;
    }

    private static TimeSpan Ms(double ms) => TimeSpan.FromMilliseconds(ms);

    private static double Jitter(Random r, double baseMs, double spreadPct = 0.35)
        => baseMs * (1.0 + (r.NextDouble() - 0.5) * 2 * spreadPct);

    /// <summary>
    /// Checkout — the flagship flow. One trace spans three business domains, two databases,
    /// a queue hop, and an uninstrumented third party. This single screen is the demo.
    /// </summary>
    public static SpanNode Checkout(DateTime t0, Random r, Scenario s)
    {
        var inventoryFails = s.InventoryFailing && r.NextDouble() < 0.25;
        var paySlow = s.PaymentSlow;

        var cursor = t0;

        // shared-api-inventory: SQL reserve
        var invSqlDur = Ms(Jitter(r, 22));
        var invSvcDur = invSqlDur + Ms(Jitter(r, 14));
        var payExtDur = Ms(Jitter(r, paySlow ? 2400 : 180));
        var payProdDur = Ms(Jitter(r, 12));
        var settleSqlDur = Ms(Jitter(r, 30));
        var commitSqlDur = Ms(Jitter(r, 18));
        var commitSvcDur = commitSqlDur + Ms(Jitter(r, 12));
        var settleDur = settleSqlDur + commitSvcDur + Ms(Jitter(r, 18));
        var payDur = payExtDur + payProdDur + Ms(Jitter(r, 20));
        var orderSqlDur = Ms(Jitter(r, 26));

        var ordersDur = invSvcDur + payDur + orderSqlDur + Ms(Jitter(r, 30));
        var webDur = ordersDur + Ms(Jitter(r, 18));

        var web = HttpServer("retail-web", "POST", "/checkout", cursor, webDur,
                             inventoryFails ? 500 : 200);
        if (inventoryFails) web.Fail("Contoso.Retail.CheckoutFailedException", "Checkout failed: inventory reservation unavailable");

        var webCall = web.Add(HttpClient("retail-web", "POST", "retail-api-orders.contoso-demo.internal",
                                         "/api/orders", cursor + Ms(6), ordersDur + Ms(6),
                                         inventoryFails ? 500 : 200));
        if (inventoryFails) webCall.Fail("System.Net.Http.HttpRequestException", "Response status code 500");

        var orders = webCall.Add(HttpServer("retail-api-orders", "POST", "/api/orders",
                                            cursor + Ms(10), ordersDur, inventoryFails ? 500 : 200));
        if (inventoryFails) orders.Fail("Contoso.Orders.InventoryUnavailableException", "Inventory service returned 500");

        // --- leg 1: inventory (shared service, crosses domains) ---
        var invCursor = cursor + Ms(16);
        var invCall = orders.Add(HttpClient("retail-api-orders", "POST", "shared-api-inventory.contoso-demo.internal",
                                            "/api/reserve", invCursor, invSvcDur, inventoryFails ? 500 : 200));
        var inv = invCall.Add(HttpServer("shared-api-inventory", "POST", "/api/reserve",
                                         invCursor + Ms(2), invSvcDur - Ms(4), inventoryFails ? 500 : 200));
        var invSql = inv.Add(SqlClient("shared-api-inventory", "UPDATE", "dbo.StockLevels", SqlReserveStock,
                                       invCursor + Ms(6), invSqlDur, "InventoryDb"));

        inv.Log(LogLevel.Information, 1, "Reserving {Quantity} units of {Sku}", 2, "SKU-40771");

        if (inventoryFails)
        {
            invCall.Fail("System.Net.Http.HttpRequestException", "Response status code 500");
            inv.Fail("Contoso.Inventory.ReservationConflictException", "Optimistic concurrency conflict reserving stock");
            invSql.Fail("Microsoft.Data.SqlClient.SqlException", "Deadlock victim on dbo.StockLevels",
                        dbStatusCode: "1205");
            inv.Log(LogLevel.Error, 30,
                    "Stock reservation failed for {Sku}: deadlock on dbo.StockLevels", "SKU-40771");
            orders.Log(LogLevel.Warning, 45,
                       "Inventory reservation unavailable for order {OrderId}; abandoning checkout", "ORD-88213");
        }

        if (!inventoryFails)
        {
            // --- leg 2: payments (only reached when inventory succeeded) ---
            var payCursor = invCursor + invSvcDur + Ms(4);
            var payCall = orders.Add(HttpClient("retail-api-orders", "POST", "pay-api-gateway.contoso-demo.internal",
                                                "/api/authorize", payCursor, payDur));
            var pay = payCall.Add(HttpServer("pay-api-gateway", "POST", "/api/authorize",
                                             payCursor + Ms(2), payDur - Ms(4)));

            // Deliberately uninstrumented third party: renders as an observed node with no
            // server side, which is a useful lesson about where instrumentation ends.
            pay.Add(HttpClient("pay-api-gateway", "POST", PaymentProcessor, "/v2/charges",
                               payCursor + Ms(6), payExtDur));

            var prod = pay.Add(QueueProducer("pay-api-gateway", "settlement-queue",
                                             payCursor + Ms(6) + payExtDur, payProdDur));
            var cons = prod.Add(QueueConsumer("pay-worker-settlement", "settlement-queue",
                                              payCursor + Ms(6) + payExtDur + payProdDur + Ms(140), settleDur));
            cons.Add(SqlClient("pay-worker-settlement", "INSERT", "dbo.Settlements", SqlInsertSettlement,
                               payCursor + Ms(10) + payExtDur + payProdDur + Ms(140), settleSqlDur, "PaymentsDb"));

            // The shared service is consumed by a SECOND domain here: once payment clears,
            // settlement calls inventory to convert the reservation into a real stock
            // decrement. This is what makes shared-api-inventory genuinely cross-domain —
            // when it degrades, the blast radius appears in Retail AND Payments at once,
            // which is the entire argument for treating domain as a tag, not a boundary.
            //
            // Note this failure is drawn independently of the reservation failure: a flaky
            // service fails per call, not per trace. It also lands AFTER the customer already
            // got their 200, which is exactly why async worker failures are easy to miss.
            var commitFails = s.InventoryFailing && r.NextDouble() < 0.25;
            var commitCursor = payCursor + Ms(12) + payExtDur + payProdDur + Ms(140) + settleSqlDur;

            var commitCall = cons.Add(HttpClient("pay-worker-settlement", "POST",
                                                 "shared-api-inventory.contoso-demo.internal", "/api/commit",
                                                 commitCursor, commitSvcDur, commitFails ? 500 : 200));
            var commit = commitCall.Add(HttpServer("shared-api-inventory", "POST", "/api/commit",
                                                   commitCursor + Ms(2), commitSvcDur - Ms(4),
                                                   commitFails ? 500 : 200));
            var commitSql = commit.Add(SqlClient("shared-api-inventory", "UPDATE", "dbo.StockLevels",
                                                 SqlCommitStock, commitCursor + Ms(5), commitSqlDur, "InventoryDb"));

            if (commitFails)
            {
                commitCall.Fail("System.Net.Http.HttpRequestException", "Response status code 500");
                commit.Fail("Contoso.Inventory.ReservationConflictException",
                            "Reservation already released for SKU-40771");
                commitSql.Fail("Microsoft.Data.SqlClient.SqlException", "Deadlock victim on dbo.StockLevels",
                               dbStatusCode: "1205");
                cons.Fail("Contoso.Payments.StockCommitFailedException",
                          "Settled payment but could not commit stock — order requires reconciliation");
                cons.Log(LogLevel.Error, 60,
                         "Stock commit failed for order {OrderId} after settlement {SettlementId}",
                         "ORD-88213", "STL-55129");
            }
            else
            {
                cons.Log(LogLevel.Information, 55, "Settled order {OrderId} and committed stock", "ORD-88213");
            }

            orders.Add(SqlClient("retail-api-orders", "INSERT", "dbo.Orders", SqlInsertOrder,
                                 payCursor + payDur + Ms(2), orderSqlDur));
        }

        return web;
    }

    /// <summary>Browse catalog — cache-then-database, and the SQL timeout scenario.</summary>
    public static SpanNode BrowseCatalog(DateTime t0, Random r, Scenario s)
    {
        var sqlFails = s.CatalogSqlTimeouts && r.NextDouble() < 0.30;

        var redisDur = Ms(Jitter(r, 4));
        var sqlDur = Ms(sqlFails ? Jitter(r, 1800, 0.1) : Jitter(r, 18));
        var catDur = redisDur + sqlDur + Ms(Jitter(r, 12));
        var webDur = catDur + Ms(Jitter(r, 14));

        var web = HttpServer("retail-web", "GET", "/products", t0, webDur, sqlFails ? 500 : 200);
        if (sqlFails) web.Fail("Contoso.Retail.CatalogUnavailableException", "Catalog query timed out");
        var call = web.Add(HttpClient("retail-web", "GET", "retail-api-catalog.contoso-demo.internal",
                                      "/api/products", t0 + Ms(5), catDur + Ms(4), sqlFails ? 500 : 200));
        var cat = call.Add(HttpServer("retail-api-catalog", "GET", "/api/products",
                                      t0 + Ms(8), catDur, sqlFails ? 500 : 200));

        cat.Add(RedisClient("retail-api-catalog", "GET", t0 + Ms(11), redisDur));
        var sql = cat.Add(SqlClient("retail-api-catalog", "SELECT", "dbo.Products", SqlSelectProducts,
                                    t0 + Ms(11) + redisDur, sqlDur, "CatalogDb"));

        if (sqlFails)
        {
            call.Fail("System.Net.Http.HttpRequestException", "Response status code 500");
            cat.Fail("Contoso.Catalog.QueryTimeoutException", "Timeout expired reading dbo.Products");
            sql.Fail("Microsoft.Data.SqlClient.SqlException",
                     "Timeout expired. The timeout period elapsed prior to completion of the operation.",
                     dbStatusCode: "-2");
            cat.Log(LogLevel.Error, 20,
                    "Product query for category {CategoryId} timed out after {TimeoutSeconds}s", 118, 30);
        }
        else
        {
            cat.Log(LogLevel.Information, 6, "Serving catalog page {Page} for category {CategoryId}", 1, 118);
        }

        return web;
    }

    /// <summary>Update profile — second async chain, different database technology.</summary>
    public static SpanNode UpdateProfile(DateTime t0, Random r, Scenario s)
    {
        var cosmosDur = Ms(Jitter(r, 14));
        var prodDur = Ms(Jitter(r, 9));
        var emailDur = Ms(Jitter(r, 260));
        var notifyDur = emailDur + Ms(Jitter(r, 15));
        var profDur = cosmosDur + prodDur + Ms(Jitter(r, 16));
        var webDur = profDur + Ms(Jitter(r, 12));

        var web = HttpServer("retail-web", "PUT", "/profile", t0, webDur);
        var call = web.Add(HttpClient("retail-web", "PUT", "cust-api-profile.contoso-demo.internal",
                                      "/api/profile", t0 + Ms(4), profDur + Ms(4)));
        var prof = call.Add(HttpServer("cust-api-profile", "PUT", "/api/profile", t0 + Ms(7), profDur));

        prof.Add(CosmosClient("cust-api-profile", "UPSERT", t0 + Ms(10), cosmosDur));
        var prod = prof.Add(QueueProducer("cust-api-profile", "notify-queue", t0 + Ms(10) + cosmosDur, prodDur));
        prof.Log(LogLevel.Information, 6, "Profile {CustomerId} updated; queued notification", "CU-88431");

        var cons = prod.Add(QueueConsumer("cust-worker-notify", "notify-queue",
                                          t0 + Ms(10) + cosmosDur + prodDur + Ms(120), notifyDur));
        cons.Log(LogLevel.Information, 6, "Sending {Template} email to customer {CustomerId}",
                 "profile-updated", "CU-88431");
        cons.Add(HttpClient("cust-worker-notify", "POST", EmailProvider, "/v3/mail/send",
                            t0 + Ms(14) + cosmosDur + prodDur + Ms(120), emailDur));

        return web;
    }
}

/// <summary>
/// Which failure/latency scenarios are active at a given point in simulated time.
/// Without these the demo is a pretty picture; with them it is something to investigate.
/// </summary>
public sealed record Scenario(bool InventoryFailing, bool PaymentSlow, bool CatalogSqlTimeouts)
{
    public static readonly Scenario Healthy = new(false, false, false);

    /// <summary>Scenario windows, expressed as hours before "now".</summary>
    public static Scenario At(DateTime nowUtc, DateTime pointUtc)
    {
        var hoursAgo = (nowUtc - pointUtc).TotalHours;
        return new Scenario(
            InventoryFailing:   hoursAgo is <= 6.0  and >= 4.5,
            PaymentSlow:        hoursAgo is <= 12.0 and >= 10.0,
            CatalogSqlTimeouts: hoursAgo is <= 18.0 and >= 17.0);
    }
}
