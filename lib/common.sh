#!/usr/bin/env bash
# Shared settings and helpers for deploy.sh, add-app.sh, teardown.sh, and demo/setup.sh.
# Source it; don't run it.

set -euo pipefail

# Git Bash rewrites arguments that look like Unix paths, which corrupts Azure resource IDs.
# Harmless everywhere else.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# Used by the scripts that source this file.
# shellcheck disable=SC2034
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The only deployment settings. Override with environment variables.
export RG="${RG:-appinsights-catalog-demo}"
export LOCATION="${LOCATION:-centralus}"

PLATFORM_DEPLOYMENT="platform"
MIN_BICEP_VERSION="0.30.0"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*" >&2; }
ok()   { printf '    \033[0;32m%s\033[0m\n' "$*" >&2; }
warn() { printf '    \033[0;33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[0;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# az prints CRLF line endings on Windows; strip them so captured values are clean.
azq() { az "$@" | tr -d '\r'; }

# Windows programs (az, node, python, curl) can't open Git Bash paths like /c/repo, and path
# conversion is off (see above), so file arguments are converted explicitly. No-op elsewhere.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" == "$2" ]]; }

require_az() {
  command -v az >/dev/null 2>&1 || die "Azure CLI not found. Install it: https://aka.ms/installazurecli"
  az account show >/dev/null 2>&1 || die "Not signed in to Azure. Run: az login"
}

require_bicep() {
  local version
  version="$(az bicep version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
  if [[ -z "$version" ]]; then
    say "Installing Bicep CLI"
    az bicep install >/dev/null
  elif ! version_ge "$version" "$MIN_BICEP_VERSION"; then
    die "Bicep $version is older than $MIN_BICEP_VERSION. Run: az bicep upgrade"
  fi
}

# npm enforces the exact Node.js version from the catalog app's package.json during the build.
require_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    die "Node.js and npm not found. Install Node.js: https://nodejs.org"
  fi
}

# Reads one output of the platform deployment, so scripts never hard-code resource names.
platform_output() {
  local value
  value="$(azq deployment group show -g "$RG" -n "$PLATFORM_DEPLOYMENT" \
    --query "properties.outputs.$1.value" -o tsv 2>/dev/null || true)"
  [[ -n "$value" ]] || die "No '$1' output found in deployment '$PLATFORM_DEPLOYMENT' in '$RG'. Run ./deploy.sh first."
  printf '%s' "$value"
}

# Zips the contents of a directory with whichever archiver is available.
make_zip() {
  local src="$1" dest="$2"
  rm -f "$dest"
  if command -v zip >/dev/null 2>&1; then
    (cd "$src" && zip -qr "$dest" .)
    return
  fi
  local py
  for py in python3 python; do
    if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import zipfile' >/dev/null 2>&1; then
      "$py" - "$(native_path "$src")" "$(native_path "$dest")" <<'PY'
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        rel = os.path.relpath(root, src)
        if rel != ".":
            z.write(root, rel.replace(os.sep, "/") + "/")
        for name in files:
            path = os.path.join(root, name)
            z.write(path, os.path.relpath(path, src).replace(os.sep, "/"))
PY
      return
    fi
  done
  # Windows ships bsdtar, which writes zip files. Name the entries so they don't start with "./".
  if [[ -n "${SYSTEMROOT:-}" && -x "$(cygpath -u "$SYSTEMROOT")/System32/tar.exe" ]]; then
    (shopt -s dotglob && cd "$src" && "$(cygpath -u "$SYSTEMROOT")/System32/tar.exe" -a -c -f "$(cygpath -w "$dest")" -- *)
    return
  fi
  die "No zip tool found. Install zip or Python 3."
}
