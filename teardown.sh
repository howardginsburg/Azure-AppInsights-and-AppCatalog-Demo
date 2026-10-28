#!/usr/bin/env bash
#
# teardown.sh: deletes the resource group and everything in it.
#
#   ./teardown.sh          # asks you to type the resource group name
#   ./teardown.sh --yes    # no prompt

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_az

if [[ "$(azq group exists -n "$RG")" != "true" ]]; then
  ok "Resource group '$RG' does not exist. Nothing to do."
  exit 0
fi

if [[ "${1:-}" != "--yes" ]]; then
  say "About to delete resource group '$RG' and everything in it"
  az resource list -g "$RG" --query "[].{name:name, type:type}" -o table >&2 || true
  read -r -p "Type the resource group name to confirm: " confirm
  [[ "$confirm" == "$RG" ]] || die "Confirmation did not match. Nothing was deleted."
fi

# Deleted workspaces stay recoverable for 14 days. Purge them so the data goes now.
for ws in $(azq monitor log-analytics workspace list -g "$RG" --query "[].name" -o tsv); do
  az monitor log-analytics workspace delete -g "$RG" -n "$ws" --force true --yes -o none
  ok "purged workspace $ws"
done

az group delete -n "$RG" --yes --no-wait
ok "Deleting $RG in the background."
rm -f "$REPO_ROOT/demo/.env"
