/**
 * A stored derived relation's upkeep against PostgreSQL 19 under real concurrency (README "Derived tables"): the judge
 * keeps each stored relation equal to its definition at every COMMIT for every writer, each upkeep rewriting the stored
 * rows at the units its transaction wrote from its definition there. The shape (upkeep.fixtures.ts upkeepShape): Answer
 * and Key, closed, in the unit Learner(child), and three stored relations over them, none distributive over two
 * writers' rows, a join (Matched), a count (Tally) and a negation (Unkeyed), each kept at a unit narrower than the
 * learner's; the role `learner`, READ COMMITTED as generate certifies it, inserts each through a member of its own.
 *
 * A race (upkeep.fixtures.ts UpkeepRace) stores some answers and keys first; begins two or three sessions READ
 * COMMITTED, each a call of `answer` or `key` at one of two children, its judge run at its COMMIT, as a served write's
 * is, or at the end of its statement, as a direct transaction of the role that states SET CONSTRAINTS ALL IMMEDIATE has
 * it, inside its transaction; sends each call's statements in a drawn order, every earlier session holding its
 * transaction open; and ends the sessions in a drawn order, each committing or rolling back as drawn, a COMMIT on a
 * fiber of its own, since the judge it runs may wait: each in turn, or every session whose statements are through at
 * once, so served writes' COMMITs, and the judges they run, overlap.
 *
 * Oracle: specification, the stored relations' law (README "Derived tables"): after the race each stored relation's
 * rows are exactly its definition's over the answers and keys it left, whatever order the calls committed in and
 * wherever their judges ran; every call succeeds, as READ COMMITTED promises; and a call waits only on a call of its own
 * child, since an upkeep borrows the units it rewrites and no other.
 *
 * Features: an answer and its key committed by two calls at once, two answers of one sitting committed by two calls at
 * once, a call judged at its statement, one judged at its COMMIT, served calls of one child ended together, children
 * apart at once, a call rolled back, and a call's judge waiting on another call of its child.
 *
 * Beside a SERIALIZABLE writer: the same shape and races, but the learner inserts Answer alone and the role `grader`,
 * which states `write` on Key, open in its unit, and so runs SERIALIZABLE, inserts Key. Both keep Matched and Unkeyed,
 * whose upkeep a SERIALIZABLE judge runs at its transaction's snapshot, which the judge's borrow orders after a READ
 * COMMITTED writer's commit but never moves past it, and SSI never sees a READ COMMITTED write: so certification runs
 * the learner SERIALIZABLE too (README "READ COMMITTED writes" `writers`), and every call succeeds or is refused with
 * 40001. Oracle: the same law over the committed rows.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	aimedMixedRaces,
	aimedUpkeepRaces,
	featuresOf,
	generatedShape,
	mixedShape,
	problemsOf,
	runRace,
	type UpkeepFeature
} from "#test/pg/isolation/upkeep.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Each stored relation's rows are its definition's over the rows its READ COMMITTED writers committed, whatever order they committed in and wherever their judges ran, every call succeeds, and calls at different units never wait on each other. */
export const eachStoredRelationsRowsAreItsDefinitionsOverTheRowsItsReadCommittedWritersCommittedWhateverOrderTheyCommittedInAndWhereverTheirJudgesRanEveryCallSucceedsAndCallsAtDifferentUnitsNeverWaitOnEachOther =
	property.explore(steered(aimedUpkeepRaces), {
		needs: { fresh: Substrate.fresh(generatedShape) },
		situations: [
			"an answer and its key committed by two calls at once",
			"two answers of one sitting committed by two calls at once",
			"a call judged at its statement",
			"a call judged at its COMMIT",
			"served calls of one child ended together",
			"children apart at once",
			"a call rolled back",
			"a call's judge waited on another call at its child"
		] satisfies ReadonlyArray<Reached<UpkeepFeature>>,
		check:
			({ fresh }, c: Case<UpkeepFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const seat = yield* fresh
					const run = yield* Effect.provideService(
						runRace(seat.value, "oneLearner", race),
						Substrate,
						seat.substrate
					)
					for (const f of featuresOf(race, run)) {
						c.note(f)
					}
					const problems = problemsOf(seat.value, "oneLearner", race, run)
					if (problems.length > 0) {
						return yield* Effect.die(
							new Error(`${Formatter.format(race)}\n${Arr.join(problems, "\n")}`)
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "each stored relation's rows its definition's over the committed rows at every COMMIT (README \"Derived tables\")"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\t...judgeBorrow,\n\t\t\t\t\t...upkeep,\n",
				replacement: "\t\t\t\t\t...upkeep,\n",
				why: "The judge takes no borrow, as before this property: each upkeep reads its definition at a snapshot that misses another open writer of its unit, so an answer and its key judged at once leave Matched without their row and Unkeyed with it."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\t...judgeBorrow,\n\t\t\t\t\t...upkeep,\n\t\t\t\t\tconsumed,\n",
				replacement: "\t\t\t\t\t...upkeep,\n\t\t\t\t\t...judgeBorrow,\n\t\t\t\t\tconsumed,\n",
				why: "The borrow is taken after phase A, once every upkeep has read its definition: the lock orders the commits but not the reads, so an upkeep still keeps its unit at a snapshot that missed the other writer's rows."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "return { expr: col(alias, column), type }",
				replacement: "return { expr: lit.int(0, types.integer), type }",
				why: "The borrow drops its key, one lock for every key of the unit, a coarser one: a writer of one child waits on an open writer of another."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\t\tunit: lock.unit,\n",
				replacement: "\t\t\t\t\t\tunit: site.relation,\n",
				why: "The lock is named by the holder, not by the unit: an answer and a key of one child take two locks, so their upkeeps of Matched and Unkeyed still read past each other."
			}
		],
		show: Formatter.format
	})

/** A writer of a stored relation's holders that runs SERIALIZABLE makes every writer whose writes keep the same stored relation run SERIALIZABLE too, so each stored relation's rows are still its definition's over the rows its writers committed, each call succeeding or refused with 40001. */
export const aSerializableKeeperOfAStoredRelationMakesEveryWriterThatKeepsItSerializableSoItsRowsAreStillItsDefinitionsOverTheCommittedRows =
	property.explore(steered(aimedMixedRaces), {
		needs: { fresh: Substrate.fresh(mixedShape) },
		situations: [
			"an answer and its key called at once",
			"a call refused with 40001",
			"a call judged at its statement",
			"a call judged at its COMMIT",
			"children apart at once",
			"a call rolled back"
		] satisfies ReadonlyArray<Reached<UpkeepFeature>>,
		check:
			({ fresh }, c: Case<UpkeepFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const seat = yield* fresh
					const run = yield* Effect.provideService(
						runRace(seat.value, "learnerBesideGrader", race),
						Substrate,
						seat.substrate
					)
					for (const f of featuresOf(race, run)) {
						c.note(f)
					}
					const problems = problemsOf(seat.value, "learnerBesideGrader", race, run)
					if (problems.length > 0) {
						return yield* Effect.die(
							new Error(`${Formatter.format(race)}\n${Arr.join(problems, "\n")}`)
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: 'each stored relation\'s rows its definition\'s over the committed rows at every COMMIT (README "Derived tables"), its writers certified as README "READ COMMITTED writes" `writers` states'
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/isolation/certify.ts",
				original:
					"\t\tupkept: new Set([...written].flatMap((relation) => at.relations.get(relation)?.upkept ?? [])),",
				replacement: "\t\tupkept: new Set<string>(),",
				why: "Certification counts no upkeep: the learner runs READ COMMITTED beside the SERIALIZABLE grader, whose upkeep of Matched and Unkeyed reads at its snapshot after the learner's answer committed, so the answer's match is lost and its negation kept."
			}
		],
		show: Formatter.format
	})
