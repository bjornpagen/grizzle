/**
 * The rule judge runs a rule's statements only where the transaction wrote a relation they read (physical/ddl/rules.ts
 * addRules): it reads once a run whether each delta holds a row, the transaction's write, and runs each rule's block
 * where a delta its statements read does; a whole rule's region reads several deltas, so it runs where any of them
 * holds a row, a side of olds among them, and no transaction makes a delta: the session's stand-up made every one
 * (physical/ddl/rules.ts addStandUps). A learner's
 * write so runs the rules over the learner's relations alone, never every content rule's violation query over empty
 * deltas, each planned in the session and run, as edullm's qti.__judge did on every learner COMMIT, ~190 ms steady and
 * 2 to 2.9 s the first in a session (lanes ISOLATION and JUDGESIZE at 29e98c43d). On PostgreSQL 19, over Dispatch
 * (rule-dispatch.fixtures.ts): a package's documents and parts and a learner's visits and answers, each a unit under a
 * whole containment, and a learner's mutable notes under a probed containment into the documents that have a part,
 * Documented, a stored relation whose upkeep, phase A of the judge, runs where a delta of Doc or Part holds a row.
 *
 * Each case runs one to three transactions in one fresh session, each of one to four writes of one row each, an insert
 * or a delete of a relation, then the judge, by SET CONSTRAINTS ALL IMMEDIATE; the session first calls the stand-ups
 * of the tables its transactions write and no other's, as a served write's session does, so a capture that requires a
 * table no stand-up of those made refuses the write.
 *
 * Oracle: specification: a statement of the judge, a rule's or a stored relation's upkeep's, runs exactly where a delta
 * it reads holds a row, since over deltas that hold none a rule's region is empty and an upkeep's units are none
 * (README, Rules over queries; physical/ddl/rules.ts upkeepBlock). A statement holds ACCESS SHARE on every stored table
 * it reads until its transaction ends, and nothing else of the transaction reads a stored table, so the tables the
 * transaction holds it on are exactly those of the statements over the deltas that hold a row, the rules' and the
 * upkeeps' alike: an inserted document's upkeep reads Part, since whether the document has a part decides whether it
 * is documented; and the session holds no delta its stand-up did not make.
 *
 * Features: a statement over two deltas run by one of them alone, a statement run by a side of olds alone, a delta a
 * statement that ran read whose transaction wrote no row of it, a delta an earlier transaction wrote that holds no row
 * in a later one (a session's steady state), and a transaction whose writes run no statement.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DispatchFeature,
	dispatchTemplate,
	runWrites,
	standUpWritten,
	writesGen
} from "#test/pg/laws/rule-dispatch.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge runs exactly the statements of the rules and the upkeeps over the deltas a transaction's writes hold rows
 * of, and no transaction makes a delta.
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
					yield* standUpWritten(session, value, drawn)
					yield* runWrites(value, substrate.admin, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "a statement of the judge, a rule's or an upkeep's, runs exactly where a delta it reads holds a row: the stored tables the transaction holds ACCESS SHARE on are those of the statements over its written deltas, and the session holds no delta its stand-up did not make"
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
				original: "\t\t\tconst stood = [...own, ...own.flatMap((d) => besides.get(d.name) ?? [])]",
				replacement: "\t\t\tconst stood = [...own]",
				why: "A table's stand-up makes its own deltas and not the deltas the judge reads beside them, as the parts stood those up only where a block ran: a session that wrote a learner's answers never stood the visits' delta up, so the capture of its write, which requires every delta a block over its own may read, refuses it (55Z03)."
			}
		]
	}
)
