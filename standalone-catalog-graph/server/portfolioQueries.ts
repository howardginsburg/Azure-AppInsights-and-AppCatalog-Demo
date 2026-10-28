import type { QueryWindow } from '../common/portfolio.js';
import { estateSource } from './estate.js';

export function makeWindow(hours: number, end = new Date()): QueryWindow {
  const start = new Date(end.getTime() - hours * 3_600_000);
  return {
    hours, end: end.toISOString(), start: start.toISOString(),
    previousStart: new Date(start.getTime() - hours * 3_600_000).toISOString(),
    binMinutes: Math.max(5, Math.ceil(hours * 60 / 48)),
  };
}

export const kqlString = (value: string) => JSON.stringify(value);
const bounds = (start: string, end: string) =>
  `TimeGenerated >= datetime(${start}) and TimeGenerated < datetime(${end})`;
const summarize = `Rows=count(), Calls=sum(Weight), Good=sumif(Weight, Success == true),
Fails=sumif(Weight, Success == false), Unknown=sumif(Weight, isnull(Success)),
P95=percentilew(DurationMs, Weight, 95), FirstSeen=min(TimeGenerated), LastSeen=max(TimeGenerated)`;

export function portfolioQuery(window: QueryWindow): string {
  return `let data=AppRequests | where ${bounds(window.previousStart, window.end)}
| extend Period=iff(TimeGenerated >= datetime(${window.start}),"current","previous"),
         Weight=coalesce(ItemCount,1);
union
(data | summarize ${summarize}, ResourceIds=make_set(tolower(_ResourceId),50) by App=AppRoleName, Period
 | extend Section="app"),
(data | where Period == "current" | summarize ${summarize}
 by App=AppRoleName, Bucket=bin_at(TimeGenerated,${window.binMinutes}m,datetime(${window.start})) | extend Section="trend"),
(union AppRequests,AppDependencies,AppTraces,AppExceptions
 | where ${bounds(new Date(new Date(window.end).getTime() - 30 * 86_400_000).toISOString(), window.end)}
 | summarize LastSeen=max(TimeGenerated), ResourceIds=make_set(tolower(_ResourceId),50) by App=AppRoleName
 | extend Section="freshness"),
(AppMetrics | where ${bounds(new Date(new Date(window.end).getTime() - 30 * 86_400_000).toISOString(), window.end)}
 | where Name in ("_OTELRESOURCE_","_APPRESOURCEPREVIEW_")
 | summarize arg_max(TimeGenerated, Properties) by App=AppRoleName, Instance=AppRoleInstance, Component=tolower(_ResourceId)
 | project Section="host", App, Instance, Component, LastSeen=TimeGenerated,
           HostId=tostring(Properties["cloud.resource_id"]), AttributeKeys=bag_keys(Properties))
| take 12001`;
}

export function groupQuery(window: QueryWindow, domains: Record<string, string>, owners: Record<string, string>): string {
  return `let domains=dynamic(${JSON.stringify(domains)});
let owners=dynamic(${JSON.stringify(owners)});
let data=AppRequests | where ${bounds(window.previousStart, window.end)}
| extend Period=iff(TimeGenerated >= datetime(${window.start}),"current","previous"),
         Weight=coalesce(ItemCount,1), Domain=tostring(domains[AppRoleName]), Owner=tostring(owners[AppRoleName]);
union
(data | summarize ${summarize} by Group=Domain, Period | extend GroupKind="domain",Section="group"),
(data | summarize ${summarize} by Group=Owner, Period | extend GroupKind="owner",Section="group"),
(data | where Period == "current" | summarize ${summarize}
 by Group=Domain, Bucket=bin_at(TimeGenerated,${window.binMinutes}m,datetime(${window.start})) | extend GroupKind="domain",Section="group-trend"),
(data | where Period == "current" | summarize ${summarize}
 by Group=Owner, Bucket=bin_at(TimeGenerated,${window.binMinutes}m,datetime(${window.start})) | extend GroupKind="owner",Section="group-trend")
| take 6001`;
}

export function topologyQuery(window: QueryWindow): string {
  return `${estateSource().replaceAll('{TimeRange}', `>= datetime(${window.start}) and TimeGenerated < datetime(${window.end})`)}
nodes | extend Section="node"
| union (links | extend Section="edge")
| take 6001`;
}

export function examplesQuery(window: QueryWindow, app: string, failed: boolean): string {
  return `AppRequests | where ${bounds(window.start, window.end)}
| where AppRoleName == ${kqlString(app)} and isnotempty(OperationId)
${failed ? '| where Success == false' : ''}
| project OperationId, Id, App=AppRoleName, Name, TimeGenerated, DurationMs, Success, ResultCode
| top 51 by ${failed ? 'TimeGenerated' : 'DurationMs'} desc`;
}

export function transactionQuery(window: QueryWindow, operation: string): string {
  const where = `where ${bounds(window.start, window.end)} | where OperationId == ${kqlString(operation)}`;
  return `union
(union
 (AppRequests | ${where} | project Section="span",Kind="request",App=AppRoleName,Name,TimeGenerated,
 DurationMs,Success,ResultCode,Id,ParentId,ResourceId=tolower(_ResourceId),Target="",DependencyType=""),
 (AppDependencies | ${where} | project Section="span",Kind="dependency",App=AppRoleName,Name,TimeGenerated,
 DurationMs,Success,ResultCode,Id,ParentId,ResourceId=tolower(_ResourceId),Target,DependencyType)
 | sort by TimeGenerated asc | take 2001),
(AppTraces | ${where} | where SeverityLevel >= 2
 | project Section="event",Kind="log",App=AppRoleName,TimeGenerated,ParentId,Message,SeverityLevel,ExceptionType=""
 | sort by TimeGenerated asc | take 201),
(AppExceptions | ${where}
 | project Section="event",Kind="exception",App=AppRoleName,TimeGenerated,ParentId,Message=OuterMessage,SeverityLevel,ExceptionType
 | sort by TimeGenerated asc | take 201)`;
}
