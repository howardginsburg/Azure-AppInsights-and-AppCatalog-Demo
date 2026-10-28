import { DefaultAzureCredential } from '@azure/identity';

/**
 * One credential for every Azure call: Log Analytics, Resource Graph, and Azure SQL.
 * On App Service it resolves to the system-assigned managed identity; locally, to your
 * Azure CLI sign-in. No keys or connection-string secrets.
 */
export const credential = new DefaultAzureCredential();
