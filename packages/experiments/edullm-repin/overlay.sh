#!/usr/bin/env bash
# REPIN: the local harness's two files in an edullm tree, from edullm-overlay.patch (IMPORTPAR's, untracked, never part
# of the repin diff): packages/data/qti-database/importpar.config.ts, grizzle.config.ts's schemas, logins and
# migrations connected to a local cluster as qti_admin, and packages/platform/data-infrastructure/scripts/
# importpar-publish.ts, edullm's publishPackage without S3. Applied once; a tree that holds them is left as it is.
# Usage: overlay.sh <edullm tree>
set -euo pipefail
S=$(dirname "$(readlink -f "$0")")
cd "$1"
if git apply --check "$S/edullm-overlay.patch" 2> /dev/null; then
	git apply "$S/edullm-overlay.patch"
else
	git apply --reverse --check "$S/edullm-overlay.patch"
fi
