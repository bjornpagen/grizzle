/**
 * A derived relation whose unit, the learner, bounds no upkeep is stored by its delta form (analysis/derived/storage.ts
 * boundOf, analysis/theory/upkeep.ts deltaBoundOf): on PostgreSQL 19, over DeltaBound (delta-bound.fixtures.ts), a
 * package's test, items and controls in a unit sealed at founding, and each learner's sittings, item sessions, response
 * snapshots, candidate sessions, suspensions, ends, attempts, processings, assertions and enrolment in the learner's unit,
 * keyed by the learner and then apart; ledger's TestSnapshot, SessionSnapshot over its query imported, read by
 * TestSnapshot's name, ItemSessionControl over the package's controls read by reference, and SettledSitting over its two
 * negated imports, each stored by its checked delta form; and each enrolled learner's snapshots, the enrolment matched
 * first, stored as monotone over closed relations.
 *
 * Exactness: a drawn sequence of transactions as the owner's direct SQL, each an insert of one row of a learner, every
 * relation closed, or a migration's data step removing a snapshot, a suspension, an enrolment or a processing; after
 * each COMMIT every stored relation's table holds exactly its definition's rows over the host's model. A served insert
 * gains each fact read from the rows it wrote outward and withdraws each fact a negated row's insert removes, read at the
 * fact and checked there; a data step's removal, which no capture
 * records, is followed by its bracket's re-check, which makes each stored relation over a closed relation its
 * definition's rows again (physical/ddl/recheck.ts). The oracle is the model: each definition read over the host's rows.
 *
 * The bound: the judge's work at COMMIT of each of learner 1's served writes at its measured sittings, a snapshot, a
 * suspension of a candidate session, an end, an item session, an attempt in an ended sitting and in an open one, and a
 * processing of a pending attempt, reads the rows it wrote, each stored relation beneath it at the keys they bind by
 * an index of its own (physical/ddl/rules.ts programRequests), and each fact it withdraws at the fact, however many
 * other learners and other sittings of the learner stand: a
 * suspension or an end withdraws the sitting's open snapshots, read from TestSnapshot's table at (child, stage), never
 * the learner's every snapshot (analysis/theory/query.ts lostFacts). A data step's removal is no write the judge reads:
 * no capture records a closed relation's removed rows, and its bracket's re-check, a whole read, makes each stored
 * relation its definition's rows again (physical/ddl/recheck.ts), which exactness holds. Each case stands none or 2,048 other
 * learners, so the tables are a page or a dozen and more, the measured sittings with one or four snapshots and their
 * ended ones, measures each write in a transaction rolled back, every statement explained with ANALYZE and BUFFERS before
 * the judge runs (test/support/judge.ts judgeRun); then adds sixteen or sixty-four other learners and as many other
 * sittings of learners 1 and 0, each with its snapshots, and measures again; with no planner setting and no ANALYZE. The
 * oracle: no statement reads a table larger than one index probe whole (judge.ts wideScans), and each does the same
 * keyed work both times (judge.ts keyedWork), rows counted over every loop, never a clock.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BoundFeature,
	boundGen,
	deltaBoundTemplate,
	type ExactFeature,
	exactCase,
	runBound,
	runExact
} from "#test/pg/derived/delta-bound.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A relation stored by its delta form equals its definition after every COMMIT, a served insert's and a data step's
 * removal alike. */
export const aRelationStoredByItsDeltaFormEqualsItsDefinitionAfterEveryCommit = property.explore(
	exactCase,
	{
		needs: { installed: Substrate.fresh(deltaBoundTemplate) },
		situations: [
			"a snapshot in an open session",
			"a session suspended over its snapshots",
			"a sitting ended over its snapshots",
			"an item session under a control",
			"an ended sitting settled",
			"a settled sitting unsettled",
			"an enrolled learner's snapshot",
			"a snapshot removed",
			"a suspension removed",
			"a suspension removed beneath an end in its session",
			"a sitting's last pending attempt processed",
			"a session's counted attempts reaching its limit",
			"an enrolment removed",
			"a processing removed"
		] satisfies ReadonlyArray<Reached<ExactFeature>>,
		check:
			({ installed }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* installed
					const session = yield* substrate.session({ ...ownerSession(), label: "delta exact" })
					yield* runExact(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "second-implementation",
			name: "the host's model: after each COMMIT each stored relation holds exactly its definition's rows over the rows the host wrote, its data steps' removals among them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\t\t...arms.filter(meets).map((a): InferredExpr => ({\n",
				replacement: "\t\t\t\t\t\t...arms.filter(() => false).map((a): InferredExpr => ({\n",
				why: "A lost candidate deleted unchecked at the fact: a data step's removal of a suspension withdraws its session's suspended snapshots, those the sitting's end in that session still derives among them, which no gain restores."
			}
		]
	}
)

/** Each of a learner's writes keeps the relations stored by their delta forms by the rows it wrote and the facts it
 * withdraws, read at the sitting, whatever other learners and other sittings of the learner stand. */
export const aLearnersWriteKeepsRelationsStoredByTheirDeltaFormsAtTheSittingItWrites =
	property.exhaust(finite(boundGen), {
		needs: { installed: Substrate.fresh(deltaBoundTemplate) },
		situations: [
			"TestSnapshot's upkeep ran",
			"SessionSnapshot's upkeep ran",
			"ItemSessionControl's upkeep ran",
			"SettledSitting's upkeep ran",
			"UnsettledSitting's upkeep ran",
			"ItemSessionOpen's upkeep ran",
			"EnrolledSnapshot's upkeep ran",
			"tables of a page",
			"tables of many pages"
		] satisfies ReadonlyArray<Reached<BoundFeature>>,
		check:
			({ installed }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* installed
					const session = yield* substrate.session({ ...ownerSession(), label: "delta bound" })
					yield* runBound(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "a bound and invariance: each statement the judge runs at each of learner 1's writes reads no table larger than a probe whole, and does the same keyed work beside few learners and sittings of learner 1 and beside many, at tables of a page and of many"
		},
		box: "learner 1's measured sitting with one or four snapshots and its ended sitting, beside no other learner or 2,048; sixteen or sixty-four other learners and as many other sittings of learner 1 added",
		kept: [
			{
				token: ReplayToken(
					"test/pg/derived/delta-bound.test.ts#aLearnersWriteKeepsRelationsStoredByTheirDeltaFormsAtTheSittingItWrites:-:0.0.0"
				),
				reason:
					"No other learner, one snapshot, sixteen more sittings: at an attempt in an ended sitting the unprocessed attempts' unit form deleted through a self-join on ctid PostgreSQL planned as a Hash Join over a Seq Scan of their stored table; and at a suspension or an end SessionSnapshot's statements read TestSnapshot by its key at the learner, filtered by the stage, 7 rows of keyed work beside one sitting and 39 beside sixteen more, the seek's range on the snapshot's instant in no index request (MERGE2's tip, 204d1be1)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\tblocks: isNonEmpty(ranges) ? [...led.blocks, ranges] : led.blocks,\n",
				replacement: "\t\t\t\tblocks: led.blocks,\n",
				why: "A seek's range left out of its one request: TestSnapshot's index holds the sitting's equalities alone, (stage, child), and SessionSnapshot's statements at a suspension read TestSnapshot by its key at the learner, filtered by the stage, every later snapshot of the learner read for each."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\tconst removed = removal(stale)\n",
				replacement:
					'\t\t\tconst removed: PlBlock = {\n\t\t\t\tdeclare: [],\n\t\t\t\tbody: [\n\t\t\t\t\t{\n\t\t\t\t\t\tkind: "modify",\n\t\t\t\t\t\tstatement: {\n\t\t\t\t\t\t\tkind: "delete",\n\t\t\t\t\t\t\twith: undefined,\n\t\t\t\t\t\t\ttable,\n\t\t\t\t\t\t\talias: "r1",\n\t\t\t\t\t\t\tusing: [derived(namedQuery(setQueryOf(headed(stale, reads), "the stale ids\' query headed"), ["c1"]), "r" + (unitNames + rowNames + 6), false)],\n\t\t\t\t\t\t\twhere: eq(col("r1", "ctid"), col("r" + (unitNames + rowNames + 6), "c1")),\n\t\t\t\t\t\t\treturning: []\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t]\n\t\t\t}\n',
				why: "A unit form's removal as one DELETE of its stale rows by a self-join on ctid against their ids: PostgreSQL plans it as a Hash Join over a Seq Scan of the stored table, the unprocessed attempts' canonical relation read whole at an attempt in an ended sitting (MERGE2's tip, 204d1be1)."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\tif (target === undefined || target.kind === "closed") {\n',
				replacement: '\t\tif (target === undefined || target.kind !== "relation") {\n',
				why: "No index on a stored relation's table for the seeks the statements over it print (physical/ddl/rules.ts programRequests), each a missed index at the installation where it was a read of the table: a suspension's or an end's open snapshots read from TestSnapshot's key at the learner and filtered by the sitting, the learner's every later snapshot read for each, 7 rows of keyed work beside one sitting and 39 beside sixteen more (the first run of this property)."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\tif (!isNonEmpty(keys)) {\n",
				replacement:
					'\t\tif (!isNonEmpty(keys) || ![target.primaryKey, ...target.keys].some((key) => key.every((f) => keys.some((k) => k.column.kind === "field" && k.column.field.name === f)))) {\n',
				why: "An existence step admitted without its index: no seek binding a prefix of a key asks for one (physical/ddl/rules.ts programRequests), so UnsettledSitting's check at a sitting a processing touched, a seek of the unprocessed attempts at the learner and the stage, finds no index, a missed index at the installation, where it read every pending attempt of the learner."
			}
		]
	})
