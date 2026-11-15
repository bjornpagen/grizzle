#!/usr/bin/env bash
# REPIN: one arm's imports, as FAMWRITE's pair-md5.sh drove them: alphascience g3t15, its md5 (one REPEATABLE READ
# snapshot), then g3-science-shadow-g3-15 and its md5, each publish profiled by run-profile.sh through the given tree's
# runtime (its importpar-publish.ts: edullm's publishPackage without S3, one SERIALIZABLE transaction as publisher_app).
# Usage: arm.sh <tag> <port> <publish tree> <columns file>
set -uo pipefail
S=$(dirname "$(readlink -f "$0")")
tree=$(readlink -f "$3")
bash "$S/overlay.sh" "$tree"
PK=${REPIN_PACKAGES:-/Users/bjorn/Documents/edullm/out/qti-rebuild-20261114/packages}
bash "$S/run-profile.sh" "$1" "$2" "$tree" "$PK/alphascience-g3-v2-scroll-pilot-g3t15/01a1cc8f-d3d3-7445-a9a0-f23a9bd53683" alphascience-g3-v2-scroll-pilot-g3t15 1000
bash "$S/table-md5.sh" "$1" "$2" "$REPIN_OUT/$1/md5-g3t15.tsv" "$4"
bash "$S/run-profile.sh" "$1" "$2" "$tree" "$PK/g3-science-shadow-g3-15/01a1d115-c8a3-7df6-a4f1-b000d1ccf2f1" g3-science-shadow-g3-15 1000
bash "$S/table-md5.sh" "$1" "$2" "$REPIN_OUT/$1/md5-both.tsv" "$4"
echo "arm $1 done"
