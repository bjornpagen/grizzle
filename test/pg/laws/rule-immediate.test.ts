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
 * (a key), or a delete that breaks Expressed (a containment). The breaking insert is refused by its rule's SQLSTATE, at
 * COMMIT deferred and at its statement immediate. The delete removes a closed relation's row, a data step's, inside the
 * bracket a migration's runner sends (data-step.ts dataStepOf): the judge reads none of a closed relation's removed
 * rows, so it passes its statement in either mode and the bracket's re-check refuses it under Expressed's law (23000).
 * The lawful one commits; after each transaction every session table holds no row.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { immediateGen, runImmediate } from "#test/pg/laws/rule-immediate.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every served write is judged in its transaction, at its statement after SET CONSTRAINTS ALL IMMEDIATE and at COMMIT
 * before it, a data step's breaking delete by its bracket's re-check in either mode, and no delta row outlives the
 * transaction that wrote it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const everyWriteIsJudgedInItsTransactionAtItsStatementAfterSetConstraintsAllImmediate =
	property.explore(immediateGen, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.fresh),
		situations: [
			"a lawful write committed",
			"a breaking insert refused at COMMIT",
			"a breaking insert refused at its statement",
			"a breaking delete refused by its bracket's re-check, deferred",
			"a breaking delete refused by its bracket's re-check, immediate"
		],
		check: (judges, c) => (k) =>
			Effect.gen(function* () {
				const judge = yield* judges[`whole ${k.shape}`]
				const session = yield* judge.substrate.session({ ...ownerSession(), label: "writer" })
				yield* runImmediate(judge.value, session, k, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "each transaction's refusal and its SQLSTATE, against the rule its write breaks, and each session table's rows after it: a breaking insert refused at its statement immediate and at COMMIT deferred, a breaking delete by its bracket's re-check under Expressed's law, a lawful one committed, and no row held"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.row)]] }',
				replacement:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.head)]] }',
				why: "A capture leaves the arm's head where it read it, so the judge its arm row fires claims none of the statement's rows: a breaking insert runs past its statement and commits."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\tarmDeleted(log),\n",
				replacement: "",
				why: "The judge leaves the transaction's arm row, so a later statement's capture finds it standing and inserts none: no judge fires for that statement, and a breaking insert after a lawful one commits."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'\t\t\t\t\t{\n\t\t\t\t\t\tkind: "createConstraintTrigger",\n\t\t\t\t\t\tname: identifierOf(identity.ruleJudge()),\n\t\t\t\t\t\ttable: log.arm,\n\t\t\t\t\t\tevents: [{ kind: "insert" }],\n\t\t\t\t\t\tfunction: judge\n\t\t\t\t\t}\n',
				replacement: "",
				why: "The arm stands without its trigger: no judge fires, so a breaking insert commits, deferred and immediate alike."
			}
		]
	})
