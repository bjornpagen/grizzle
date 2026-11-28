/**
 * A relation parameter bound to a query of a level above is a closed import wherever the query's own bind map is
 * closed, keyed by the bound import's own key (check/checker.ts importedKey's boundPart), so the members of one write
 * that read one guard read one node of its DAG: the guard is analyzed and lowered once, however many members read it,
 * bound once for the whole ChangeSet (ChangeSet.bind) or in each member's own import (Query.bind).
 *
 * The box, exhausted: a write of 1, 2 or 4 inserts over the lower level, each of the open visits of the sittings the
 * app's guard over the upper level returns, bound either way. Property, per case, counting the write DAG's nodes
 * (write/frontend/compile.ts WriteFrontend `ir.dag`): the guard's scan of Stage is one, and so is openVisit's of Visit.
 * Oracle: specification, one node per distinct closed import. Kill: an import bound to a query's rows keyed by
 * nothing, each member's guard its own node.
 *
 * Features: one member and several; the ChangeSet's bind and the import's.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { compiled } from "#test/support/unit/write/changeset/fixtures.ts"
import { bindingGen, readersGen, Upper, writeOf } from "#test/unit/write/bound-rows.fixtures.ts"

/** The scans of `relation` among `nodes`. */
const scansOf = (nodes: ReadonlyArray<RelNode>, relation: string): number =>
	Arr.filter(nodes, (n) => n.kind === "Base" && n.relation === relation).length

/** One guard of a level above, read by every member of a write, is one node of its DAG, however it is bound. */
export const aGuardOfALevelAboveReadByEveryMemberOfAWriteIsOneNodeOfItsDag = property.exhaust(
	finite((source) => [source.draw(readersGen), source.draw(bindingGen)] as const),
	{
		needs: {},
		situations: ["one member", "several members", "the ChangeSet's bind", "the import's bind"],
		check:
			(_, k) =>
			([members, binding]) =>
				Effect.sync(() => {
					k.note(members === 1 ? "one member" : "several members")
					k.note(binding === "changeSet" ? "the ChangeSet's bind" : "the import's bind")
					const nodes = topoOrder(compiled(Upper, writeOf(members, binding)).ir.dag)
					assert.equal(
						scansOf(nodes, "Stage"),
						1,
						`the guard scans Stage once for ${members} members`
					)
					assert.equal(
						scansOf(nodes, "Visit"),
						1,
						`openVisit scans Visit once for ${members} members`
					)
				}),
		oracle: { kind: "specification", name: "one node per distinct closed import" },
		box: "1, 2 and 4 inserts, each of the open visits of the sittings an upper level's guard returns, bound by ChangeSet.bind or by each member's import",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\tconst key = importedKey(session, value.query, value.values)\n",
				replacement: "\t\t\tconst key = { text: String(Math.random()), closed: false }\n",
				why: "An import bound to a query's rows has no key, so each member that reads the guard builds its own: the DAG scans Stage and Visit once for each member."
			}
		]
	}
)
