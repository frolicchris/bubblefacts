#!/usr/bin/env bash
# Check the GitHub workflow files with actionlint (https://github.com/rhysd/actionlint).
#
#   bash scripts/lint-workflows.sh
#
# On GitHub (CI is set) actionlint must be there. On your own computer the
# check is skipped with a note if it isn't installed: `brew install actionlint`
# on a Mac, or see the link above.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v actionlint >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then
    echo "actionlint is not installed, and CI needs it." >&2
    exit 1
  fi
  echo "Skipping the workflow check: actionlint is not installed (brew install actionlint)."
  exit 0
fi

actionlint
