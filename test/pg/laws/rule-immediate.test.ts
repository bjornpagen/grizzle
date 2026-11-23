/**
 * A rule's judge reads every row a transaction writes, after SET CONSTRAINTS ALL IMMEDIATE as at COMMIT
 * (physical/ddl/rules.ts addCapture): a capture writes its rows, marks the deltas it wrote in the sentinel's row where
 * it stands, and inserts the row last where none stands, naming them, so the judge its INSERT fires reads them. After
 * SET CONSTRAINTS ALL IMMEDIATE that trigger fires at the end of the INSERT, inside the capture: written first, the row
 * fired the judge over a written set no row of the statement was in yet, so a write that broke a rule ran unjudged and
 * committed, and its rows stood in the deltas past its COMMIT, ON COMMIT PRESERVE ROWS, for a later judge to read.
 *
 * Over each unit shape's whole judge of rule-whole.fixtures.ts, a document stored whole, then one statement in a
 * transaction of its own, deferred or after SET CONSTRAINTS ALL IMMEDIATE: a lawful document, one that breaks One type
 * (a key), or a delete that breaks Expressed (a containment). Each breaking one is refused by its rule's SQLSTATE, at
 * COMMIT deferred and at its statement immediate; the lawful one commits; after each transaction every session table
 * holds no row.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { immediateGen, runImmediate } from "#test/pg/laws/rule-immediate.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every write is judged in its transaction, at its statement after SET CONSTRAINTS ALL IMMEDIATE and at COMMIT before
 * it, a breaking insert and a breaking delete alike, and no delta row outlives the transaction that wrote it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const everyWriteIsJudgedInItsTransactionAtItsStatementAfterSetConstraintsAllImmediate =
	property.explore(immediateGen, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.fresh),
		situations: [
			"a lawful write committed",
			"a breaking insert refused at COMMIT",
			"a breaking delete refused at COMMIT",
			"a breaking insert refused at its statement",
			"a breaking delete refused at its statement"
		],
		check: (judges, c) => (k) =>
			Effect.gen(function* () {
				const judge = yield* judges[`whole ${k.shape}`]
				const session = yield* judge.substrate.session({ ...ownerSession(), label: "writer" })
				yield* standUpJudge(session, judge.value.installation)
				yield* runImmediate(judge.value, session, k, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "each transaction's refusal and its SQLSTATE, against the rule its write breaks, and each session table's rows after it: a breaking write refused at its statement immediate and at COMMIT deferred, a lawful one committed, and no row held"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t): ReadonlyArray<PlStatement> => [\n\t\t...standing(\n\t\t\t[\n\t\t\t\tsentinelStood(sentinel, judge),\n\t\t\t\t...deltas.map(deltaStood),\n\t\t\t\t...deltas.flatMap((d) => besides.get(d.name) ?? []).map(deltaStood),\n\t\t\t\t...read\n\t\t\t],\n\t\t\trequired\n\t\t),\n\t\t...writes,\n\t\t...arming(sentinel, deltas)\n\t]",
				replacement:
					"\t): ReadonlyArray<PlStatement> => [\n\t\t...standing(\n\t\t\t[\n\t\t\t\tsentinelStood(sentinel, judge),\n\t\t\t\t...deltas.map(deltaStood),\n\t\t\t\t...deltas.flatMap((d) => besides.get(d.name) ?? []).map(deltaStood),\n\t\t\t\t...read\n\t\t\t],\n\t\t\trequired\n\t\t),\n\t\t...arming(sentinel, deltas),\n\t\t...writes\n\t]",
				why: "The capture inserts the sentinel's row before its rows, as before, so after SET CONSTRAINTS ALL IMMEDIATE the judge fires inside the capture over a written set naming no delta that holds a row yet: a breaking insert and a breaking delete run past their statements and commit, and their rows stand in the deltas after COMMIT."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'\t\t\t})),\n\t\t\t...(part.pass === "rules" ? part.deltas.map(emptiedWhereWritten) : [])\n',
				replacement: "\t\t\t}))\n",
				why: "No part deletes the rows it read, so a lawful document's rows stand in the deltas past its COMMIT."
			}
		]
	})
