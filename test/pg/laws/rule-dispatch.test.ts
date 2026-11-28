/**
 * The rule judge runs a rule's statements only where the transaction wrote a relation they read (physical/ddl/rules.ts
 * addRules): it reads once a run whether each delta holds a row, the transaction's write, and runs each rule's block
 * where a delta its statements read does; a whole rule's region reads several deltas, so it runs where any of them
 * holds a row, a side of olds among them. A learner's
 * write so runs the rules over the learner's relations alone, never every content rule's violation query over empty
 * deltas, each planned in the session and run, as edullm's qti.__judge did on every learner COMMIT, ~190 ms steady and
 * 2 to 2.9 s the first in a session (lanes ISOLATION and JUDGESIZE at 29e98c43d). On PostgreSQL 19, over Dispatch
 * (rule-dispatch.fixtures.ts): a package's documents and parts and a learner's visits and answers, each a unit under a
 * whole containment, and a learner's mutable notes under a probed containment into the documents that have a part,
 * Documented, a stored relation whose upkeep, phase A of the judge, runs where a delta of Doc or Part holds a row.
 *
 * Each case runs one to three transactions in one fresh session, each of one to four writes of one row each, an insert
 * or a delete of a relation, then the judge, by SET CONSTRAINTS ALL IMMEDIATE.
 *
 * Oracle: specification: a statement of the judge, a rule's or a stored relation's upkeep's, runs exactly where an
 * argument of its block holds a row, its delta's rows the transaction wrote or the selection of them it reads, since over deltas that hold none a rule's region is empty and an upkeep's units are none
 * (README, Rules over queries; physical/ddl/rules.ts upkeepBlock). A statement holds ACCESS SHARE on every stored table
 * it reads until its transaction ends, and nothing else of the transaction reads a stored table, so the tables the
 * transaction holds it on are exactly those of the statements over the deltas that hold a row, the rules' and the
 * upkeeps' alike: an inserted document's upkeep reads Part, since whether the document has a part decides whether it
 * is documented, and never Documented's table, which only the re-derivation of the documents a removal touches seeks.
 *
 * Features: a statement over two deltas run by one of them alone, a statement run by a side of olds alone, a delta a
 * statement that ran read whose transaction wrote no row of it, a delta an earlier transaction wrote that holds no row
 * in a later one (a session's steady state), and a transaction whose writes run no statement.
 */
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DispatchFeature,
	dispatchTemplate,
	runWrites,
	writesGen
} from "#test/pg/laws/rule-dispatch.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge runs exactly the statements of the rules and the upkeeps over the deltas a transaction's writes hold rows
 * of.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theRuleJudgeRunsExactlyTheRulesOverTheRelationsATransactionWrote = property.explore(
	writesGen,
	{
		needs: { dispatch: Substrate.fresh(dispatchTemplate) },
		situations: [
			"a statement over two deltas run by a write of one of them alone",
			"a statement run by a side of olds alone",
			"a delta a statement that ran read, whose transaction wrote no row of it",
			"a delta an earlier transaction wrote, holding no row in a later one",
			"a transaction whose writes run no statement"
		] satisfies ReadonlyArray<DispatchFeature>,
		check:
			({ dispatch }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* dispatch
					const session = yield* substrate.session({ ...ownerSession(), label: "dispatch" })
					yield* runWrites(value, substrate.admin, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "a statement of the judge, a rule's or an upkeep's, runs exactly where an argument of its block holds a row: the stored tables the transaction holds ACCESS SHARE on are those of the statements that run over its written deltas"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/rule-dispatch.test.ts#theRuleJudgeRunsExactlyTheRulesOverTheRelationsATransactionWrote:1f.0:1.1.0"
				),
				reason:
					"a document inserted alone: Documented's upkeep, a monotone delta form, ran its removal's DELETE and INSERT at the units of Doc's and Part's empty sides of olds beside its gain, in one call, the DELETE's seek holding ACCESS SHARE on Documented's table to COMMIT (the merged tree's red at b69e328a6)",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t\t\t\tcondition: anyHolds(mapNonEmpty(blockCall.params, (p) => p.variable)),",
				replacement: "\t\t\t\t\t\tcondition: lit.bool(true),",
				why: "Every block of a part runs whatever the transaction wrote of its deltas, as before the dispatch: a write of a package's parts runs the probes over the documents' empty deltas, each statement read and its tables locked; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t\t\t\tcondition: anyHolds(mapNonEmpty(blockCall.params, (p) => p.variable)),",
				replacement: "\t\t\t\t\t\tcondition: anyHolds([headNonEmpty(blockCall.params).variable]),",
				why: "A block runs on its first argument alone, so a whole containment a transaction wrote only the target of, a document or a visit deleted, is never judged, and its tables are never read; the property fails."
			}
		]
	}
)
