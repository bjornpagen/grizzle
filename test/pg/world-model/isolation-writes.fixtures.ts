/** What the properties of isolation-writes.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"
import {
	everyWriter,
	type Focus,
	invalidFeatures,
	invalidKindsWith,
	opIn,
	requiredWhere,
	startingWith
} from "#test/support/worlds/drive/suite.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Tenant and login isolation over the documents base, judged by the worlds model, as a role writes: every write through
 * an entry (in one stratum, a union or a sequence, with its read-backs, each classified by the model's restatement of
 * the read-back rule, untouched, written, beside its written entry or undetermined and refused; as a direct INSERT, ON
 * CONFLICT or MERGE) lands inside its world or is refused as the README says; nothing a role of another login holds is
 * reachable from a session of this login (a SET ROLE to it, another role's filter and key-probe functions, another
 * tenant's claims set by hand). Beside the model, one rule is held directly: a direct writer's statement that reaches
 * past its login (another login's role or views, another identity, another role's filter or key probe) is refused
 * (drive/acting.ts reachingPastRefused).
 *
 * The isolation suites are four files, isolation-reads, isolation-writes, isolation-claims and isolation-hand-set, each
 * a worker of its own, so they run at once. Realities hold facts outside every world (the owner loads them), so the
 * model's answers over them are docs/access.md "Security model"'s promise: a role reads exactly its own view, whatever lies
 * outside it.
 */
export const crossing: Focus = [
	"open-db",
	"direct-begin",
	"direct",
	"direct-end",
	"read",
	"apply",
	"close"
]

/** What the writes suite must reach. */
export const writesRequired: Situations<WorldFeature> = [
	...requiredWhere(
		(f) =>
			opIn({
				kinds: ["apply"],
				writers: ["db"],
				observations: ["applied", "outside-world", "invariant-rejected"]
			})(f) ||
			opIn({
				kinds: ["direct"],
				writers: ["direct-role"],
				observations: ["ok", "refused", "law-refused"]
			})(f) ||
			opIn({ kinds: ["direct"], writers: everyWriter, observations: ["refused", "rows"] })(f) ||
			startingWith(
				"object:policy:",
				"object:filter-function:",
				"object:key-probe:",
				"object:membership:"
			)(f)
	),
	"strata:one",
	"strata:union",
	"strata:sequence",
	"strata:refused-order",
	"readback:untouched",
	"readback:written",
	"readback:beside",
	"readback:undetermined",
	...invalidFeatures([
		"fact:outside-world",
		"fact:hidden-key-collision",
		"fact:domain-refused",
		...invalidKindsWith("role:"),
		...invalidKindsWith("claims:"),
		"handle:other-role",
		"handle:other-login"
	])
]
