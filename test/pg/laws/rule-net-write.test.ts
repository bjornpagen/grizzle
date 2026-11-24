/**
 * A rule over a query reads the rows a transaction adds as its net write (physical/ddl/rules.ts addRules): each
 * statement counts the images it puts and removes on the touched table's side of news, the judge nets them to the
 * images the transaction leaves that it did not find, and a probe of the facts a row adds reads the row there, never
 * from its table again (analysis/theory/query.ts probe). On PostgreSQL 19, over NetWrite
 * (rule-net-write.fixtures.ts): A keyed as a qti attribute is, by (package, path, start, name), two rules over its
 * facts, and an index of (governor, name, package) beside its key that grizzle plans for the second rule's deletes.
 *
 * - **netWrite**: a schedule of direct SQL transactions at SERIALIZABLE, each of writes over two packages, two starts
 *   and two names (puts, removals, updates of the governor the rules read, of the note none reads and of the key,
 *   references, declarations, and deletes of a package that a direct writer's foreign key cascades into A), with the
 *   judge run inside a transaction that then writes on. At each judge and at each transaction's end A's side of news,
 *   netted as a part nets it and read through its reader, which deduplicates nothing, holds no row twice; and every
 *   rule's whole check, its violation query lowered by the oracle baseline with every derived relation read through
 *   its definition (deploy/snapshot/violation.ts definedRuleChecks), judges the state first: the judge refuses exactly
 *   when one finds the state broken, under 23503 naming a rule it finds broken, and the transaction commits otherwise;
 *   and each rule's check over every row, the judge of the transaction that writes every row, which the migration that
 *   adds the rule runs (lawChecks), finds a row exactly when its whole check read as installed does
 *   (baselineRuleChecks), each reading the stored Media's table as the last COMMIT left it. That is the verdict the judge gave when its probes read every row they
 *   judged again from its table, so the two judges agree wherever either agrees with the whole check. Each situation of
 *   the net write is required, a constructed case aiming at each.
 * - **indexTie**: a database with no statistics, or analyzed, holding thousands of attributes of one package, name and
 *   governor, beside one row a transaction puts there: every statement the judge runs over that row reads the same
 *   rows whether a few thousand or twice as many share its (governor, name, package) (test/support/judge.ts judgeRun):
 *   each probe of the facts it adds, and Media's upkeep, which reads A at the row's key, Media stored at A's whole key,
 *   wider than its package (analysis/derived/storage.ts), so a rule over Media reads its table and its deltas and only
 *   its upkeep reads A's. Read from its table at its key, the row is planned without statistics through the index of
 *   (governor, name, package), which PostgreSQL prices at one row as it does the key's (selfuncs.c btcostestimate), and
 *   the shorter tree wins: the read takes every row of the prefix. Both statistics are required situations.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	netFeatures,
	netSpace,
	netWriteTemplate,
	runSchedule,
	runTie,
	tieGen
} from "#test/pg/laws/rule-net-write.fixtures.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge over a table's net write refuses exactly the transactions whose state a rule's whole check finds broken.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRuleOverAQueryJudgesTheTransactionsNetWriteAsTheRulesWholeCheckJudgesItsState =
	property.explore(netSpace, {
		needs: { net: Substrate.fresh(netWriteTemplate) },
		situations: netFeatures,
		check:
			({ net }, c) =>
			(schedule) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* net
					const session = yield* substrate.session({ ...ownerSession(), label: "net write" })
					yield* standUpJudge(session, value.installation)
					yield* runSchedule(value, substrate.admin, session, schedule, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "every rule's whole violation query, lowered by the oracle baseline, unseeded: the judge refuses exactly the states one finds broken, naming a rule it finds broken, and each rule's check over every row finds a row exactly where its whole check does"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: '\t\t\t\t\t\tgt(col("r3", "c3"), lit.int(1, types.bigint))',
				replacement: '\t\t\t\t\t\tgt(col("r3", "c3"), lit.int(2, types.bigint))',
				why: "The judge's netting keeps two rows of an image a transaction put, removed and put again, so its side of news holds the image twice, and its reader, which deduplicates nothing, returns it twice to every statement that reads it."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: '\t\t\t\t\t\tle(col("r3", "c2"), lit.int(0, types.bigint)),',
				replacement: '\t\t\t\t\t\tle(col("r3", "c2"), lit.int(-1, types.bigint)),',
				why: "The judge's netting keeps an image whose puts and removals cancel, so a row a transaction put and removed is judged as if it stood, and a transaction that leaves the rules kept is refused."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "\tconst removed = rows === transitionTables.olds",
				replacement: "\tconst removed = false",
				why: "A removal is counted as a put on the side of news, so a row a transaction put and removed sums to two and is judged as if it stood."
			},
			{
				file: "packages/engine/src/core/zset.ts",
				original: "export const weightOf = { added: 1, removed: -1 } as const",
				replacement: "export const weightOf = { added: 1, removed: 1 } as const",
				why: "A removal weighs as an addition in the one netting rule the judge and a write's outcome share (core/zset.ts weightOf), so a row a transaction put and removed sums to two on the side of news and is judged as if it stood."
			}
		]
	})

/**
 * Every statement the judge runs over a row, a probe of the facts it adds and a stored relation's upkeep at its key,
 * reads the same rows however many rows share a strict subset of its key's columns under an index, with statistics or
 * none.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbeOfTheFactsARowAddsReadsTheSameRowsBesideAnIndexOfPartOfItsKeyWithStatisticsOrNone =
	property.explore(tieGen, {
		needs: { tie: Substrate.rolledBack(netWriteTemplate) },
		situations: ["measured with no statistics", "measured analyzed"],
		check:
			({ tie }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* tie
					yield* runTie(value, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "invariance: each statement the judge runs over the row a transaction put, a probe's or an upkeep's, reads the same rows whatever other rows share its index's prefix"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\tarm.matches.filter((_, j) => j !== at),",
				replacement: "\t\tarm.matches,",
				why: "A probe of the added side reads the touched row again from its table, by every column it reads, as 12fa0a94 did: with no statistics PostgreSQL reads it through the index of (governor, name, package), every row of the touched row's prefix."
			}
		]
	})
