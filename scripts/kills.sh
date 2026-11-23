#!/usr/bin/env bash
# The kill census, one command from a checkout's root (`pnpm kills`): every kill each property of both test tiers
# declares judged, `toolchain-test kills`, at once under the one seed the release gates on (scripts/tiers.sh: the units,
# the logs under ${XDG_STATE_HOME:-~/.local/state}/grizzle-kills/, the summary). Each kill is applied in a worker tree
# of the checkout and its property's witnesses run under it; a kill whose red the verdict cache holds at its property's
# closure is answered from it, every verdict judged is kept there. It proves each test can still catch the bug it
# declares: a survivor (every witness passed with the kill applied), a stale kill (its original no longer stands once in
# its file) and an unjudged one (its property red with no kill at all) are each printed under its property's line, and
# fail the census. It proves nothing of the product: that is the release check's (scripts/release.sh, searches only).
# grizzle main runs it on each pin candidate, beside or after the release check (Bjorn, 2026-11-23).
exec "$(dirname -- "$0")/tiers.sh" kills kills
