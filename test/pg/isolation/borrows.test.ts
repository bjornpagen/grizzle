/**
 * A call's borrows against PostgreSQL 19 (write/borrow: lock.ts lockId, statement.ts borrowQuery, function.ts): one
 * statement takes every lock a call borrows, each once at the strongest mode it is borrowed at, in the order of the
 * locks' ids, by the installation's borrow function, which every role executes. A lock's id is its kind's rank above a
 * digest of its kind's name and its key's values under equality, so equal keys of any spelling share one lock, keys
 * whose texts run together alike do not, and every lock of a kind of a lower rank comes first.
 *
 * A race (borrows.fixtures.ts BorrowRace) draws a lock order over four kinds of the box (a unit keyed by two texts, one
 * keyed by a numeric, one by a float, and a series' lock of no key) and two to four calls, each borrowing one to five
 * locks of them, shared or exclusive; begins each call's session READ COMMITTED as the installation's role; sends each
 * call's borrow statement in a drawn order while every call before it holds what it was granted and waits for the rest;
 * and ends the sessions in a drawn order, each committing or rolling back as drawn.
 *
 * Oracle: specification, the lock plan's claim (docs/errors-and-concurrency.md "READ COMMITTED writes"): two borrows take one lock exactly where
 * their kinds and key values under equality are one, a lower rank's every id is below a higher one's, and a call takes
 * its locks in id order, so where it waits it holds exactly its locks below the first that conflicts with a lock another
 * session holds or waits for, at their strongest modes, and once through it holds all of them; no call ever deadlocks.
 * Taking locks in one global order is what makes deadlock impossible: a waiter holds only locks below the one it waits
 * for, so no cycle of waits closes.
 *
 * Features: a waiter holding the locks below its wait, a shared borrow beside a shared holder, an exclusive one waiting
 * on a shared holder, a shared one queued behind a waiting exclusive one, one key by two spellings in one call, two keys
 * whose texts run together alike in one call, one lock borrowed shared and exclusive in one call, and the series' lock.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	aimedBorrowRaces,
	type BorrowFeature,
	borrowsTemplate,
	runRace
} from "#test/pg/isolation/borrows.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A call takes its locks in the order of their ids, each once at the strongest mode it borrows it at, equal keys of any spelling sharing one lock, so a waiter holds only the locks below the one it waits for and no calls deadlock. */
export const aCallTakesItsLocksInTheOrderOfTheirIdsEachOnceAtTheStrongestModeItBorrowsItAtEqualKeysOfAnySpellingSharingOneLockSoAWaiterHoldsOnlyTheLocksBelowTheOneItWaitsForAndNoCallsDeadlock =
	property.explore(steered(aimedBorrowRaces), {
		needs: { fresh: Substrate.fresh(borrowsTemplate) },
		situations: [
			"a call waiting while it holds the locks below the one it waits on",
			"a shared borrow beside a shared holder",
			"an exclusive borrow waiting on a shared holder",
			"a shared borrow queued behind a waiting exclusive one",
			"one key by two spellings in one call",
			"two keys whose texts run together alike in one call",
			"one lock borrowed shared and exclusive in one call",
			"the series' lock"
		] satisfies ReadonlyArray<Reached<BorrowFeature>>,
		check:
			({ fresh }, c: Case<BorrowFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const {
						substrate,
						value: { installed }
					} = yield* fresh
					const run = yield* Effect.provideService(runRace(installed, race), Substrate, substrate)
					for (const f of run.features) {
						c.note(f)
					}
					if (Arr.isReadonlyArrayNonEmpty(run.problems)) {
						return yield* Effect.die(
							new Error(`${Arr.join(run.problems, "\n")}\nin ${Formatter.format(race)}`)
						)
					}
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the lock plan's claim: equal keys under equality share one lock and no others do, a lower rank's ids come first, a call takes its locks in id order at their strongest modes, so a waiter holds exactly its locks below the first that conflicts with another session's held or awaited lock, and once through holds them all; no call deadlocks"
		},
		budget: { runs: 1, steered: 8 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/borrow/lock.ts",
				original: '\t\treturn text(call("trim_scale", [key.expr]))',
				replacement: "\t\treturn text(key.expr)",
				why: "A numeric key's image keeps its scale: 1.0 and 1.00, one value, take two locks, so two calls that borrow one unit by them never wait on each other."
			},
			{
				file: "packages/engine/src/write/borrow/lock.ts",
				original:
					"\treturn text(carrier === undefined ? key.expr : canonicalForm(key.expr, carrier))",
				replacement: "\treturn text(key.expr)",
				why: "A float key's image keeps its zero's sign: -0 and 0, one value, take two locks."
			},
			{
				file: "packages/engine/src/write/borrow/lock.ts",
				original: '\t\t(acc, key) => binary("||", acc, lengthPrefixed(keyImage(key))),',
				replacement: '\t\t(acc, key) => binary("||", acc, keyImage(key)),',
				why: "A key's parts run together unprefixed: (a, bc) and (ab, c), two keys, take one lock."
			},
			{
				file: "packages/engine/src/write/borrow/lock.ts",
				original: '\t\tbinary("<<", cast(rank, types.bigint), lit.int(digestBits, types.integer)),',
				replacement: "\t\tcast(rank, types.bigint),",
				why: "The rank is no longer the id's top byte: a kind of a lower rank's lock may have a higher id than a higher kind's, so a call takes them out of the lock order."
			},
			{
				file: "packages/engine/src/write/borrow/statement.ts",
				original: '\t\torderBy: [{ expr: col(locks, id), direction: "ASC" }]',
				replacement: '\t\torderBy: [{ expr: col(locks, id), direction: "DESC" }]',
				why: "The borrow statement hands the function its locks in descending id order: a waiter holds locks above the one it waits for, the order every call shares is lost, and two calls may wait on each other."
			},
			{
				file: "packages/engine/src/write/borrow/statement.ts",
				original: '\t\t\t\ttarget(call("bool_or", [col(each, exclusive)])),',
				replacement: '\t\t\t\ttarget(call("bool_and", [col(each, exclusive)])),',
				why: "A lock a call borrows shared and exclusive is taken at the weaker mode, shared, where its exclusive borrow excludes every other holder."
			},
			{
				file: "packages/engine/src/write/borrow/function.ts",
				original: '\t\t\t\t\t\t\t\t\tbody: [lockAt("pg_advisory_xact_lock")]',
				replacement: '\t\t\t\t\t\t\t\t\tbody: [lockAt("pg_advisory_xact_lock_shared")]',
				why: "The borrow function takes an exclusive borrow's lock shared: two calls that borrow one unit exclusively hold it at once."
			},
			{
				file: "packages/engine/src/write/borrow/function.ts",
				original: '\t\t\t\t\t\torderBy: [asc(col("r1", "c1"))]',
				replacement: '\t\t\t\t\t\torderBy: [{ expr: col("r1", "c1"), direction: "DESC" }]',
				why: "The borrow function walks its locks from the last subscript to the first, against the order the statement hands them in."
			}
		]
	})
