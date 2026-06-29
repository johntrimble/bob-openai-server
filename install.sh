#!/usr/bin/env bash
set -euo pipefail

# Installs bob-openai-server globally from this repo's latest GitHub release
# tarball, the same npm-install-from-a-tarball approach you'd use for any
# package not on the public npm registry.
#
#   curl -fsSL https://raw.githubusercontent.com/johntrimble/bob-openai-server/main/install.sh | bash
#
# Edit REPO below once this is pushed to its actual GitHub location.
REPO="johntrimble/bob-openai-server"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (>=18) and was not found on PATH." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 18 ]; then
  echo "error: bob-openai-server requires Node.js >=18, found $(node -v)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required and was not found on PATH." >&2
  exit 1
fi

if ! command -v bob >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: the `bob` command was not found on PATH.

bob-openai-server runs your existing bobshell installation to source
credentials - it doesn't bundle its own copy. Install bobshell first:

  curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash

...then log in (run `bob` once interactively) before using this server.
EOF
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "Fetching latest release of ${REPO}..."
tarball_url="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const r=JSON.parse(d);const a=(r.assets||[]).find(x=>x.name.endsWith(".tgz"));console.log(a?a.browser_download_url:r.tarball_url);})')"

if [ -z "$tarball_url" ]; then
  echo "error: could not determine a release tarball URL for ${REPO}." >&2
  exit 1
fi

echo "Downloading ${tarball_url}..."
curl -fsSL "$tarball_url" -o "$tmp_dir/bob-openai-server.tgz"

echo "Installing globally via npm..."
npm install -g "$tmp_dir/bob-openai-server.tgz"

echo
echo "Installed. Next steps:"
echo "  1. Make sure 'bob' works and is logged in (run it once interactively if not)."
echo "  2. Set BOB_SERVER_API_KEY, then run: bob-openai-server"
