#!/usr/bin/env bash
#
# teardown.sh — delete the entire demo estate.
#
# Everything the demo creates lives in one resource group, so cleanup is one call.
# This is deliberate: a demo you cannot delete confidently is a demo that quietly bills.
#
set -euo pipefail

RG="${RG:-AppInsightsDemo}"

if ! az group show -n "$RG" >/dev/null 2>&1; then
  echo "Resource group '$RG' does not exist. Nothing to do."
  exit 0
fi

echo "About to DELETE resource group '$RG' and everything in it:"
az resource list -g "$RG" --query "[].{name:name,type:type}" -o table 2>/dev/null || true
echo

read -r -p "Type the resource group name to confirm: " CONFIRM
if [[ "$CONFIRM" != "$RG" ]]; then
  echo "Confirmation did not match. Aborted."
  exit 1
fi

# Workspaces go to a soft-deleted state for 14 days and keep the name reserved.
# --force purges instead, so redeploying with the same name works immediately.
echo "Purging Log Analytics workspaces..."
for ws in $(az monitor log-analytics workspace list -g "$RG" --query "[].name" -o tsv 2>/dev/null || true); do
  az monitor log-analytics workspace delete -g "$RG" -n "$ws" --force true --yes --only-show-errors || true
  echo "    purged $ws"
done

echo "Deleting resource group '$RG'..."
az group delete -n "$RG" --yes --no-wait
echo "Delete issued (running in background)."

rm -f "$(dirname "$0")/.env"
echo "Removed local .env"
