#!/usr/bin/env bash
#
# deploy.sh: builds the catalog app, deploys the platform (Log Analytics, the portfolio workbook,
# and the catalog app), then the demo apps unless DEMO=false.
#
#   ./deploy.sh                                # appinsights-catalog-demo in centralus
#   RG=my-rg LOCATION=eastus2 ./deploy.sh
#   DEMO=false ./deploy.sh                     # platform only
#   APP_LOCATION=westus2 SQL_LOCATION=eastus2 ./deploy.sh   # split regions if one lacks capacity
#
# Safe to re-run: Bicep converges the resources and the app package is replaced.

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_az
require_bicep
require_node
command -v curl >/dev/null 2>&1 || die "curl not found."

# Build before touching Azure, so a local problem stops the script before anything is created.
say "Building the catalog app"
app_src="$REPO_ROOT/standalone-catalog-graph"
(
  cd "$app_src"
  npm install --no-audit --no-fund --loglevel=error
  npm run build --silent
) >&2
# Vite bundles the server with every package it imports, so the package needs no node_modules.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/package/server"
cp -R "$app_src/dist" "$app_src/dist-server" "$app_src/package.json" "$stage/package/"
cp "$app_src/server/estate.kql" "$stage/package/server/"
make_zip "$stage/package" "$stage/catalog-app.zip"
ok "catalog-app.zip, $(du -h "$stage/catalog-app.zip" | cut -f1)"

say "Generating the workbook"
node "$(native_path "$REPO_ROOT/workbook/build-workbook.mjs")" >&2

say "Resource group $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none
ok "ready"

say "Deploying the platform (Bicep)"
params=(location="$LOCATION")
[[ -n "${APP_LOCATION:-}" ]] && params+=(appLocation="$APP_LOCATION")
[[ -n "${SQL_LOCATION:-}" ]] && params+=(sqlLocation="$SQL_LOCATION")
az deployment group create -g "$RG" -n "$PLATFORM_DEPLOYMENT" \
  --template-file "$(native_path "$REPO_ROOT/infra/main.bicep")" \
  --parameters "${params[@]}" -o none
WEB_APP="$(platform_output webAppName)"
CATALOG_URL="$(platform_output catalogUrl)"
WORKBOOK_ID="$(platform_output workbookId)"
ok "workspace $(platform_output workspaceName), catalog app $WEB_APP"

say "Deploying the catalog app"
# Async upload, then the CLI polls until the site has restarted on the new package.
az webapp deploy -g "$RG" -n "$WEB_APP" --src-path "$(native_path "$stage/catalog-app.zip")" \
  --type zip --async true --track-status true -o none
ok "deployed"

say "Waiting for $CATALOG_URL"
for attempt in $(seq 1 60); do
  if curl -fsS "$CATALOG_URL/api/health" >/dev/null 2>&1; then
    ok "healthy"
    break
  fi
  [[ "$attempt" -lt 60 ]] || die "No response from $CATALOG_URL/api/health. Check: az webapp log tail -g $RG -n $WEB_APP"
  sleep 10
done

if [[ "${DEMO:-true}" != "false" ]]; then
  "$REPO_ROOT/demo/setup.sh"
fi

say "Done"
cat >&2 <<EOF
    Workbook:     https://portal.azure.com/#resource${WORKBOOK_ID}/workbook
    Catalog app:  $CATALOG_URL
    Add an app:   ./add-app.sh <name> --domain <domain> --criticality <tier1|tier2|tier3> --owner <team>
    Clean up:     ./teardown.sh
EOF
if [[ "${DEMO:-true}" != "false" ]]; then
  cat >&2 <<EOF
    Simulator:    cd demo/simulator && dotnet run -c Release -- --backfill-hours 24
EOF
fi
