/** What the properties of isolation-reads.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"
import { type Focus, opIn, requiredWhere, startingWith } from "#test/support/worlds/drive/suite.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Tenant and login isolation over the documents base, judged by the worlds model, as a role reads: every read a role
 * makes, through a Db (executed, by key, page by page under a drawn order, from the first page or the last, whose ties
 * grizzle breaks by a key it proves of a table's entry, or by the whole heading, so every row
 * arrives exactly once; prepared; with another of its relations attached to each row; as the pairs a recursive query
 * chains, over a reality holding a chain at every relation one chains (docsChainedRealities), so a chain past one step
 * is there to read whatever installation is drawn; both artifacts must agree, a paged read's window by window, on the
 * windows after and before every row's key its windows reached too) or as a direct writer that took the role on (its
 * views and tables, with predicates that raise on one value, prepared and executed under other claims), answers
 * exactly its world under the claims it holds, whatever lies outside it.
 *
 * The isolation suites are four files, isolation-reads, isolation-writes, isolation-claims and isolation-hand-set, each
 * a worker of its own, so they run at once. Realities hold facts outside every world (the owner loads them), so the
 * model's answers over them are docs/access.md "Security model"'s promise: a role reads exactly its own view, whatever lies
 * outside it.
 */
export const reads: Focus = [
	"open-db",
	"read",
	"apply",
	"close",
	"direct-begin",
	"direct",
	"direct-end"
]

/** What the reads suite must reach. */
export const readsRequired: Situations<WorldFeature> = [
	...requiredWhere(
		(f) =>
			opIn({ kinds: ["read"], writers: ["db"], observations: ["rows"] })(f) ||
			opIn({ kinds: ["direct"], writers: ["direct-role"], observations: ["rows"] })(f) ||
			startingWith("object:view:", "object:barrier-view:")(f)
	),
	"claim-unread:negation",
	"via:execute",
	"via:get",
	"via:page",
	"via:compile",
	"via:attach",
	"via:reach",
	"page:proven-key:first",
	"page:proven-key:last",
	"page:heading-key:first",
	"page:heading-key:last",
	"attach:nested",
	"reach:chained",
	"reach:union-refused"
]
