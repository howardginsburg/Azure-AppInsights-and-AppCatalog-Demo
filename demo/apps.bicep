// The demo's eight apps, registered through the same module customers use. This file is the
// only place the demo's domains, criticality tiers, and owners are defined.

param workspaceId string
param location string = resourceGroup().location

var apps = [
  { name: 'retail-web', domain: 'Retail', criticality: 'tier1', owner: 'commerce-team' }
  { name: 'retail-api-orders', domain: 'Retail', criticality: 'tier1', owner: 'commerce-team' }
  { name: 'retail-api-catalog', domain: 'Retail', criticality: 'tier2', owner: 'commerce-team' }
  { name: 'pay-api-gateway', domain: 'Payments', criticality: 'tier1', owner: 'payments-team' }
  { name: 'pay-worker-settlement', domain: 'Payments', criticality: 'tier1', owner: 'payments-team' }
  { name: 'cust-api-profile', domain: 'Customer', criticality: 'tier2', owner: 'customer-team' }
  { name: 'cust-worker-notify', domain: 'Customer', criticality: 'tier3', owner: 'customer-team' }
  { name: 'shared-api-inventory', domain: 'Platform', criticality: 'tier1', owner: 'platform-team' }
]

module app '../infra/modules/app.bicep' = [
  for a in apps: {
    name: 'app-${a.name}'
    params: {
      name: a.name
      domain: a.domain
      criticality: a.criticality
      owner: a.owner
      workspaceId: workspaceId
      location: location
    }
  }
]

output apps array = [for (a, i) in apps: { name: a.name, resourceId: app[i].outputs.resourceId }]
