#!/usr/bin/env bash
# Checks the package the way a consumer sees it: packs it, installs the tarball into a fresh
# project, type-checks a strict consumer against the published declarations with the oldest
# supported TypeScript (5.7), runs the README quick start, and loads the package with require().
# Needs network access to install TypeScript. Usage: npm run check:package
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
# `npm pack` runs the prepare script (a fresh build), whose output precedes the tarball name.
tarball="$(npm pack --silent --pack-destination "$work" | tail -n 1)"
mkdir "$work/consumer"
cp scripts/consumer/package.json scripts/consumer/tsconfig.json scripts/consumer/quick-start.ts \
  scripts/consumer/require.cjs "$work/consumer/"

cd "$work/consumer"
npm install --silent --no-audit --no-fund "../$tarball" "typescript@~${TYPESCRIPT_VERSION:-5.7.0}"
npx tsc -p tsconfig.json
node out/quick-start.js
node require.cjs
echo "package check passed with TypeScript $(npx tsc --version | cut -d' ' -f2) on Node.js $(node --version)"
