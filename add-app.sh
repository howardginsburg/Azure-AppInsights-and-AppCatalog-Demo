#!/usr/bin/env bash
#
# add-app.sh: registers an app. Creates a workspace-based Application Insights resource linked
# to the shared workspace and tagged with the app's domain, criticality, and owner, then prints
# the two settings the app needs.
#
#   ./add-app.sh orders-api --domain Sales --criticality tier1 --owner sales-team
#
# Set those settings in the app and turn on OpenTelemetry with the Azure Monitor exporter; see
# docs/02-end-to-end-correlation.md. The app then appears in the workbook and the catalog app with
# no other changes.

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  cat >&2 <<'EOF'
usage: ./add-app.sh <app-name> --domain <domain> --criticality <tier> --owner <team>

  <app-name>     The app's service name (OTEL_SERVICE_NAME), for example orders-api
  --domain       Business domain, for example Sales
  --criticality  Criticality tier, for example tier1, tier2, or tier3
  --owner        Owning team, for example sales-team
EOF
  exit 1
}

[[ $# -ge 1 && "$1" != -* ]] || usage
NAME="$1"
shift
DOMAIN="" CRITICALITY="" OWNER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --criticality) CRITICALITY="${2:-}"; shift 2 ;;
    --owner) OWNER="${2:-}"; shift 2 ;;
    -h | --help) usage ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ -n "$DOMAIN" && -n "$CRITICALITY" && -n "$OWNER" ]] || usage
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ && "$NAME" != *. ]] ||
  die "App names use letters, digits, '.', '_', and '-' (up to 100 characters), and can't end with '.'."

require_az
require_bicep

WORKSPACE_ID="$(platform_output workspaceId)"
PLATFORM_LOCATION="$(platform_output location)"

say "Registering $NAME ($DOMAIN, $CRITICALITY, $OWNER)"
RESOURCE_ID="$(azq deployment group create -g "$RG" -n "app-${NAME:0:59}" \
  --template-file "$(native_path "$REPO_ROOT/infra/modules/app.bicep")" \
  --parameters name="$NAME" domain="$DOMAIN" criticality="$CRITICALITY" owner="$OWNER" \
               workspaceId="$WORKSPACE_ID" location="$PLATFORM_LOCATION" \
  --query properties.outputs.resourceId.value -o tsv)"
CONNECTION_STRING="$(azq resource show --ids "$RESOURCE_ID" --query properties.ConnectionString -o tsv)"
ok "$RESOURCE_ID"

say "Set these in the app"
printf 'OTEL_SERVICE_NAME=%s\nAPPLICATIONINSIGHTS_CONNECTION_STRING=%s\n' "$NAME" "$CONNECTION_STRING"
