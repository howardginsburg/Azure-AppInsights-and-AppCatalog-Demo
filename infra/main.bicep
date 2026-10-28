// Platform: the shared Log Analytics workspace, the Application Portfolio workbook, and the
// catalog app (App Service, private Azure SQL, and the network that connects them).
//
// Apps are not defined here. Each app registers through modules/app.bicep (see add-app.sh).
//
// Security posture:
//   - Managed identity only. No keys, passwords, or connection-string secrets.
//   - Azure SQL uses Microsoft Entra authentication only, with public network access disabled.
//     The web app reaches it through VNet integration and a private endpoint.
//   - No storage account is needed.
//   - The catalog API is anonymous. Add authentication before storing real data.

targetScope = 'resourceGroup'

@description('Region for every resource, unless appLocation or sqlLocation override it.')
param location string = resourceGroup().location

@description('Region for the App Service plan, web app, and virtual network.')
param appLocation string = location

@description('Region for Azure SQL.')
param sqlLocation string = location

@description('App Service plan SKU. Must support virtual network integration (Basic or higher).')
param appServiceSku string = 'B1'

var suffix = uniqueString(resourceGroup().id)
var workspaceName = 'log-estate-${suffix}'
var planName = 'asp-catalog-${suffix}'
var webAppName = 'app-catalog-${suffix}'
var sqlServerName = 'sql-catalog-${suffix}'
var vnetName = 'vnet-catalog-${suffix}'
var dbName = 'catalogdb'
var privateDnsZoneName = 'privatelink${environment().suffixes.sqlServerHostname}'
var sqlFqdn = '${sqlServerName}${environment().suffixes.sqlServerHostname}'
var catalogUrl = 'https://${webApp.properties.defaultHostName}'
// The supported Node.js range lives in the app's package.json; App Service gets its major version.
var nodeMajorVersion = split(replace(loadJsonContent('../standalone-catalog-graph/package.json').engines.node, '^', ''), '.')[0]
// Built-in role: Log Analytics Reader. Grants workspace queries and read access to the
// resource group's resources, which is how the catalog app reads Application Insights tags.
var logAnalyticsReaderRoleId = '73c42c96-874c-492b-b04d-ab87d138a893'

resource workspace 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    // A cost fuse for the demo. Ingestion stops for the day at 1 GB.
    workspaceCapping: {
      dailyQuotaGb: 1
    }
  }
}

resource appNsg 'Microsoft.Network/networkSecurityGroups@2026-01-01' = {
  name: 'nsg-catalog-app-${suffix}'
  location: appLocation
}

resource peNsg 'Microsoft.Network/networkSecurityGroups@2026-01-01' = {
  name: 'nsg-catalog-pe-${suffix}'
  location: appLocation
}

resource vnet 'Microsoft.Network/virtualNetworks@2026-01-01' = {
  name: vnetName
  location: appLocation
  properties: {
    addressSpace: {
      addressPrefixes: ['10.20.0.0/16']
    }
    subnets: [
      {
        name: 'snet-app'
        properties: {
          addressPrefix: '10.20.1.0/24'
          networkSecurityGroup: {
            id: appNsg.id
          }
          delegations: [
            {
              name: 'webapp'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: '10.20.2.0/24'
          networkSecurityGroup: {
            id: peNsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: planName
  location: appLocation
  kind: 'linux'
  sku: {
    name: appServiceSku
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2025-03-01' = {
  name: webAppName
  location: appLocation
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: '${vnet.id}/subnets/snet-app'
    outboundVnetRouting: {
      allTraffic: true
    }
    siteConfig: {
      linuxFxVersion: 'NODE|${nodeMajorVersion}-lts'
      appCommandLine: 'node --enable-source-maps dist-server/server/index.js'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        // deploy.sh uploads a built package, which App Service mounts read-only and runs as-is.
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
        {
          name: 'LA_WORKSPACE_ID'
          value: workspace.properties.customerId
        }
        {
          name: 'LA_WORKSPACE_RESOURCE_ID'
          value: workspace.id
        }
        {
          name: 'SQL_SERVER'
          value: sqlFqdn
        }
        {
          name: 'SQL_DATABASE'
          value: dbName
        }
      ]
    }
  }
}

// Deployments authenticate with Microsoft Entra ID, so publishing credentials stay off.
resource scmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: webApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource ftpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: webApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

// The web app's managed identity is the SQL Microsoft Entra admin, so it creates the catalog
// table itself on first boot. No SQL logins and no human database access are needed.
resource sqlServer 'Microsoft.Sql/servers@2025-01-01' = {
  name: sqlServerName
  location: sqlLocation
  properties: {
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'Application'
      login: webAppName
      sid: webApp.identity.principalId
      tenantId: subscription().tenantId
      azureADOnlyAuthentication: true
    }
  }
}

resource sqlDb 'Microsoft.Sql/servers/databases@2025-01-01' = {
  parent: sqlServer
  name: dbName
  location: sqlLocation
  sku: {
    name: 'Basic'
    tier: 'Basic'
    capacity: 5
  }
  properties: {
    maxSizeBytes: 2147483648
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneName
  location: 'global'
}

resource dnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource sqlPrivateEndpoint 'Microsoft.Network/privateEndpoints@2026-01-01' = {
  name: 'pep-${sqlServerName}'
  location: appLocation
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/snet-pe'
    }
    privateLinkServiceConnections: [
      {
        name: 'sql'
        properties: {
          privateLinkServiceId: sqlServer.id
          groupIds: ['sqlServer']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2026-01-01' = {
  parent: sqlPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'sql'
        properties: {
          privateDnsZoneId: privateDnsZone.id
        }
      }
    ]
  }
}

resource readerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, webApp.id, logAnalyticsReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logAnalyticsReaderRoleId)
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// A deterministic GUID name, so redeploying updates this workbook instead of adding another.
resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, 'portfolio-workbook')
  location: location
  kind: 'shared'
  properties: {
    displayName: 'Application Portfolio'
    category: 'workbook'
    sourceId: workspace.id
    version: 'Notebook/1.0'
    serializedData: replace(
      replace(loadTextContent('../workbook/workbook.json'), '__WORKSPACE_ID__', workspace.id),
      '__CATALOG_URL__',
      catalogUrl
    )
  }
}

output location string = location
output workspaceId string = workspace.id
output workspaceName string = workspace.name
output webAppName string = webApp.name
output catalogUrl string = catalogUrl
output workbookId string = workbook.id
