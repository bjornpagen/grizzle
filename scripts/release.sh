#!/usr/bin/env bash
# The release check, one command from a checkout's root (`pnpm release`): every property of both test tiers searched,
# `toolchain-test run`, at once under the one seed the release gates on (scripts/tiers.sh: the units, the logs under
# ${XDG_STATE_HOME:-~/.local/state}/grizzle-release/, the summary). It proves the product right at the commit it runs
# on: every search passed. It judges no kill (Bjorn, 2026-11-23): a surviving kill says a test got weak, not that the
# product is wrong, and every engine change re-judges every kill. Whether each test still catches the bug it declares is
# the kill census's, scripts/kills.sh, which grizzle main runs on each pin candidate beside or after this check.
exec "$(dirname -- "$0")/tiers.sh" release run
