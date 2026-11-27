/**
 * A whole rule's statement reads its relations within the units a transaction wrote through whatever index PostgreSQL
 * takes: every created B-tree all of whose keys a lookup of one unit binds holds that unit's fields
 * (physical/indexes/engine.ts confined). On PostgreSQL 19, over nodes of tens of documents of tens of packages,
 * analyzed or not, a whole rule's lookup of one node by its key, kind and governor beside a probed rule's index of
 * (pkg, kind, at), smaller than the node's key's and estimated at one row as it is, which without the node's document
 * reads every document of the package at that place (rule-confined.fixtures.ts).
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { confinedTemplates, runConfined, storedGen } from "#test/pg/laws/rule-confined.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Each scan a whole rule's statement makes of a stored table reads the rows of one unit a loop, however many documents
 * of its package stand beside it, with statistics or none.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aWholeRulesLookupReadsOneUnitALoopThroughWhateverIndexPostgreSQLTakes =
	property.explore(storedGen, {
		needs: Substrate.oneOf(confinedTemplates, Substrate.rolledBack),
		situations: ["measured with no statistics", "measured analyzed"],
		check: (templates, c) => (stored) =>
			Effect.gen(function* () {
				const { connection, value } = yield* templates[`${stored.size}`]
				yield* runConfined(value, connection, stored, c)
			}),
		oracle: {
			kind: "universal",
			name: "bound: each scan of a stored table a whole rule's statement makes reads at most its unit's one row a loop, its output and its filters' removals together"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: 'const proposed = method === "btree" ? confined(drafts, reads) : drafts',
				replacement: "const proposed = drafts",
				why: "A created B-tree is drafted without the units of the whole rules that read its relation, so the index Placed's probe asks of Node, (at, kind, pkg), lacks doc: PostgreSQL reads Typed's lookup of a node through it, kind among its keys and governor a filter, and each lookup reads every document of the package at that place (21 rows a loop beside 20 documents)."
			}
		]
	})
