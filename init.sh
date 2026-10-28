#!/usr/bin/env bash
# JustMaya — agent harness bootstrap (Unix / Git Bash)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

INSTALL_CMD=(npm install)
VERIFY_CMD="npm run lint --silent && npm run build"
START_CMD=(npm run dev)

echo "==> Working directory: $PWD"
echo "==> Syncing dependencies"
"${INSTALL_CMD[@]}"

echo "==> Running baseline verification"
npm run lint
npm run build

echo "==> Startup command (print only unless RUN_START_COMMAND=1)"
printf '    '
printf '%q ' "${START_CMD[@]}"
printf '\n'

if [ "${RUN_START_COMMAND:-0}" = "1" ]; then
  echo "==> Starting the app"
  exec "${START_CMD[@]}"
fi

echo "Set RUN_START_COMMAND=1 if you want init.sh to launch the app directly."
