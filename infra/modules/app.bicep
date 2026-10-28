// Registers one app: a workspace-based Application Insights resource, linked to the shared
// Log Analytics workspace and tagged with the three classification tags.
//
// This is the whole registration contract. add-app.sh deploys it, demo/apps.bicep deploys it for
// the demo apps, and app teams with their own infrastructure as code can copy it.

@description('App name. Use the same value as the app\'s service name (OTEL_SERVICE_NAME).')
@minLength(1)
@maxLength(250)
param name string

@description('Business domain, for example Sales.')
@minLength(1)
param domain string

@description('Criticality tier, for example tier1.')
@minLength(1)
param criticality string

@description('Owning team, for example sales-team.')
@minLength(1)
param owner string

@description('Resource ID of the shared Log Analytics workspace.')
param workspaceId string

param location string = resourceGroup().location

resource component 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  kind: 'web'
  tags: {
    domain: domain
    criticality: criticality
    owner: owner
  }
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspaceId
    IngestionMode: 'LogAnalytics'
  }
}

output resourceId string = component.id
