/**
 * The rule judge runs a rule's statements only where the transaction wrote a relation they read (physical/ddl/rules.ts
 * addRules): it reads once a run whether each delta holds a row, the transaction's write, and runs each rule's block
 * where a delta its statements read does; a whole rule's region reads several deltas, so it runs where any of them
 * holds a row, a side of olds among them, and the judge stands up only the deltas of the blocks it runs. A learner's
 * write so runs the rules over the learner's relations alone, never every content rule's violation query over empty
 * deltas, each planned in the session and run, as edullm's qti.__judge did on every learner COMMIT, ~190 ms steady and
 * 2 to 2.9 s the first in a session (lanes ISOLATION and JUDGESIZE at 29e98c43d). On PostgreSQL 19, over Dispatch
 * (rule-dispatch.fixtures.ts): a package's documents and parts and a learner's visits and answers, each a unit under a
 * whole containment, and a learner's mutable notes under a probed containment into the documents that have a part.
 *
 * Each case runs one to three transactions in one fresh session, each of one to four writes of one row each, an insert
 * or a delete of a relation, then the judge, by SET CONSTRAINTS ALL IMMEDIATE.
 *
 * Oracle: specification: a statement of a rule runs exactly where a delta it reads holds a row, since over deltas that
 * hold none its region is empty (README, Rules over queries). A statement holds ACCESS SHARE on every stored table it
 * reads until its transaction ends, and nothing else of the transaction reads a stored table, so the tables the
 * transaction holds it on are exactly those of the statements over the deltas that hold a row; and every delta the
 * session newly holds holds a row, its capture's, or is read by a statement that ran.
 *
 * Features: a statement over two deltas run by one of them alone, a statement run by a side of olds alone, a delta
 * stood up for a statement whose transaction wrote no row of it, a delta an earlier transaction stood up that holds no
 * row in a later one (a session's steady state), and a transaction whose writes run no statement.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DispatchFeature,
	dispatchTemplate,
	runWrites,
	writesGen
} from "#test/pg/laws/rule-dispatch.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge runs exactly the statements of the rules over the deltas a transaction's writes hold rows of, and stands
 * up only the deltas they read.
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
			"a delta stood up for a statement whose transaction wrote no row of it",
			"a delta an earlier transaction stood up, holding no row in a later one",
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
			name: "a rule's statement runs exactly where a delta it reads holds a row: the stored tables the transaction holds ACCESS SHARE on are those of the statements over its written deltas, and every delta the session newly holds holds a row or is read by a statement that ran"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t\tbranches: [{ condition: anyRowed(j.reads), body: [performed(blockOf(j), [])] }],",
				replacement:
					"\t\t\t\tbranches: [{ condition: lit.bool(true), body: [performed(blockOf(j), [])] }],",
				why: "Every rule's block of a part runs whatever the transaction wrote, as before the dispatch: a write of a package's parts runs the probes over the documents' deltas the session never stood up, which PostgreSQL refuses (42P01), or, once they stand, over deltas holding no row, each statement read and its tables locked."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t\tbranches: [{ condition: anyRowed(j.reads), body: [performed(blockOf(j), [])] }],",
				replacement:
					"\t\t\t\tbranches: [{ condition: anyRowed([headNonEmpty(j.reads)]), body: [performed(blockOf(j), [])] }],",
				why: "A rule's block runs on its first delta alone, so a whole containment a transaction wrote only the target of, a document or a visit deleted, is never judged, and its tables are never read."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\tbranches: [{ condition: wrote(delta.name), body: kept }],",
				replacement: "\t\t\tbranches: [{ condition: standing(delta.name), body: kept }],",
				why: "A delta counts as written wherever the session holds it, as the judge read it before the written set: in a session's later transaction every rule over a relation an earlier one wrote runs again over its empty side of olds, its tables read and locked, and a learner's steady COMMIT reads every delta it ever stood up."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t\t\t\t\t\t\t\tmapNonEmpty([s0, ...ss], (x) => deltaStood(x.delta, anyRowed(x.besides)))",
				replacement:
					"\t\t\t\t\t\t\t\t\tmapNonEmpty([s0, ...ss], (x) => deltaStood(x.delta, undefined))",
				why: "Every delta a part's whole rule reads is stood up at every run of its part, as the judge stood every unit's delta up before the dispatch: a transaction that writes a learner's answers creates the visits' delta, and one that writes a package's parts the documents', a temporary table each, whose every COMMIT truncates it."
			}
		]
	}
)
