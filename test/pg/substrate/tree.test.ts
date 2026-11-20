/**
 * trees.md's theorem, proved against PostgreSQL 19 inside stated boxes: the tree relation's DDL written by hand
 * (test/pg/substrate/tree.ts), every state, mutation and write a box holds sent to PostgreSQL as a transaction of its
 * own, and PostgreSQL's verdict judged by two oracles.
 *
 * - **The specification turned into a checker:** the theorem (trees.md §2), per value of the root field. PostgreSQL
 *   must commit exactly the states where the rows of each root value are one tree rooted at its one self-parented row,
 *   every row reachable from it through rows of its own value, each row's children at the slots 0 … n − 1 of its count,
 *   each copy its parent's value, and `[start, end)` exactly the pre-order interval that a naive depth-first numbering
 *   of its tree computes (tree.ts breachOf), independent of the constraints.
 * - **A second implementation:** the model of each transaction (tree.ts predicted), which inserts the statements' rows
 *   on the host and checks each constraint at its moment, an immediate one at its statement's end and the deferred last
 *   slot at COMMIT. PostgreSQL must agree on the verdict, the moment, a constraint the model allows there and its
 *   SQLSTATE, and a committed state must read back as written.
 *
 * The lowering judged is T0 to T6 under fin.md §12.8's ruling: the root selected out of its own children family and
 * out of T3's check, every other law over every row (tree.ts). Each law is necessary: the boxes' properties kill
 * the lowering with T0 dropped from the parent copy, T3's check dropped, T5's `end` dropped from the last slot, and T6
 * dropped (tree.ts LAWS), each a state the theorem refuses committed.
 *
 * The boxes (doctrine rules 6, 9), whose generators tree.ts holds. Every row's root field ranges over two values,
 * every assignment of them to rows up to swapping the two, and a state holds at most two self-parented rows, one root
 * per value. The operator's bound, every state of at most six rows with every field over its range, is out of reach (a
 * row of six ranges over 6⁴ · 7 · 2 values), and so is every forest shape with every start and end beyond three rows
 * (11,599,872 cases at four). The proof is five boxes, each named in its test:
 *
 * - every state of at most two rows: every shape and root assignment, every `at`, `children` and `start` over its range
 *   and one past it, every `end` over [0, N + 1];
 * - every forest shape of at most three rows (every parent function, up to relabelling, its family and copies as the
 *   host draws them) with every root assignment, start in [0, N) and end in [1, N];
 * - every shape of four and five rows with every root assignment, and of six rows with one root value, with every start
 *   and end its rows' own checks pass (T1, T2, T3, T6), so the foreign keys and T0 alone decide;
 * - every single mutation of every tree, and of every forest of two trees, of at most six rows, each named;
 * - every write of every such tree and forest: every row order within one INSERT, and every split of its pre-order and
 *   of its reverse pre-order into consecutive INSERTs.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	checkedPlacements,
	Disagreed,
	forests,
	intervalShapes,
	judgeCase,
	type MutationFeature,
	seatIn,
	sentBefore,
	type StateFeature,
	stateShapes,
	THEOREM_ORACLE,
	treeTemplate,
	withoutT0,
	withoutT3Check,
	withoutT5,
	withoutT6,
	type WriteFeature
} from "#test/pg/substrate/tree.fixtures.ts"
import {
	MUTATION_KINDS,
	checkedGen,
	forestBox,
	forestMutationGen,
	fullGen,
	shapeGen,
	statementsOf,
	writeGen
} from "#test/pg/substrate/tree.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Commit exactly the forests of trees among every state of at most two rows, every field over its range and one past
 * it, each case on the worker's seat of the RFC's lowering.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/tree.test.ts at f91c01613).
 */
export const commitExactlyTheForestsOfTreesAmongEveryStateOfAtMostTwoRows = property.exhaust(
	finite(fullGen(stateShapes)),
	{
		needs: { tree: Substrate.seat(treeTemplate) },
		situations: [
			"tree committed",
			"tree committed a forest of two trees",
			"tree committed a root whose at is not 0",
			"tree refused copy",
			"tree refused bound",
			"tree refused order",
			"tree refused root",
			"tree refused first",
			"tree refused interval",
			"tree refused closure",
			"tree refused last",
			"tree refused at commit",
			"tree refused no root",
			"tree refused two roots",
			"tree refused a family",
			"tree refused an interval"
		] satisfies ReadonlyArray<Reached<StateFeature>>,
		check:
			({ tree }, c: Case<StateFeature>) =>
			(rows) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* tree
						const seat = yield* seatIn(taken)
						return yield* Effect.provideService(
							Effect.asVoid(judgeCase(seat, [rows], c)),
							Substrate,
							taken.substrate
						)
					})
				),
		oracle: THEOREM_ORACLE,
		box: "every state of one or two rows: every shape with at most two self-parented rows, every assignment of two root values up to swapping them, each row's at, children and start over [0, N] and end over [0, N + 1], the copies the host's",
		show: Formatter.format,
		kept: [],
		kills: [withoutT0, withoutT3Check, withoutT5, withoutT6]
	}
)

/**
 * Commit exactly the pre-order intervals among every start and end of every forest shape of at most three rows, each
 * case on the worker's seat of the RFC's lowering.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/tree.test.ts at f91c01613).
 */
export const commitExactlyThePreOrderIntervalsOfEveryForestShapeOfAtMostThreeRows =
	property.exhaust(finite(shapeGen(intervalShapes)), {
		needs: { tree: Substrate.seat(treeTemplate) },
		situations: [
			"tree committed",
			"tree committed a forest of two trees",
			"tree refused copy",
			"tree refused order",
			"tree refused root",
			"tree refused first",
			"tree refused interval",
			"tree refused last",
			"tree refused at commit",
			"tree refused a cycle",
			"tree refused no root",
			"tree refused two roots",
			"tree refused a row under another tree",
			"tree refused an interval"
		] satisfies ReadonlyArray<Reached<StateFeature>>,
		check:
			({ tree }, c: Case<StateFeature>) =>
			(rows) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* tree
						const seat = yield* seatIn(taken)
						return yield* Effect.provideService(
							Effect.asVoid(judgeCase(seat, [rows], c)),
							Substrate,
							taken.substrate
						)
					})
				),
		oracle: THEOREM_ORACLE,
		box: "every forest shape of one to three rows with at most two self-parented rows and every assignment of two root values, up to relabelling and swapping the values, with each row's start in [0, N) and end in [1, N], the family and copies the host's",
		show: Formatter.format,
		kept: [],
		kills: [withoutT0, withoutT3Check, withoutT5, withoutT6]
	})

/**
 * Commit exactly the pre-order intervals among the starts and ends that pass the row checks, every shape of four and
 * five rows with every root assignment and of six with one, each case on the worker's seat of the RFC's lowering.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/tree.test.ts at f91c01613).
 */
export const commitExactlyThePreOrderIntervalsAmongTheStartsAndEndsThatPassTheRowChecks =
	property.exhaust(finite(checkedGen(checkedPlacements)), {
		needs: { tree: Substrate.seat(treeTemplate) },
		situations: [
			"tree committed",
			"tree committed a forest of two trees",
			"tree refused copy",
			"tree refused closure",
			"tree refused last",
			"tree refused at commit",
			"tree refused a cycle",
			"tree refused a row under another tree",
			"tree refused an interval",
			"P3's counterexample refused by tree"
		] satisfies ReadonlyArray<Reached<StateFeature>>,
		check:
			({ tree }, c: Case<StateFeature>) =>
			(rows) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* tree
						const seat = yield* seatIn(taken)
						return yield* Effect.provideService(
							Effect.asVoid(judgeCase(seat, [rows], c)),
							Substrate,
							taken.substrate
						)
					})
				),
		oracle: THEOREM_ORACLE,
		box: "every shape of four and five rows with one or two self-parented rows and every assignment of two root values, and of six rows with one root and one value, up to relabelling, the family and copies the host's, with every start and end its rows' checks pass: T1's starts apart per value, T2's roots at 0, T3's first children one past their parents, a leaf's end its start + 1 and any other in (start, N]",
		show: Formatter.format,
		kept: [],
		kills: [withoutT0, withoutT5]
	})

/**
 * Refuse every single mutation of every tree and two-tree forest of at most six rows that leaves no forest of trees,
 * at the moment and by a constraint the model allows, each case on the worker's seat of the RFC's lowering.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/tree.test.ts at f91c01613).
 */
export const refuseEverySingleMutationOfEveryTreeAndTwoTreeForestThatLeavesNoForestOfTrees =
	property.exhaust(finite(forestMutationGen(forestBox.rows)), {
		needs: { tree: Substrate.seat(treeTemplate) },
		situations: [
			"a root's at committed",
			...Arr.map(MUTATION_KINDS, (k): MutationFeature => `${k} refused`),
			"tree refused copy",
			"tree refused at commit",
			"tree refused two roots",
			"tree refused a cycle",
			"tree refused a row under another tree"
		] satisfies ReadonlyArray<Reached<StateFeature | MutationFeature>>,
		check:
			({ tree }, c: Case<StateFeature | MutationFeature>) =>
			(mutation) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* tree
						const seat = yield* seatIn(taken)
						return yield* Effect.provideService(
							Effect.map(judgeCase(seat, [mutation.rows], c), (committed) => {
								c.note(`${mutation.kind} ${committed ? "committed" : "refused"}`)
							}),
							Substrate,
							taken.substrate
						)
					})
				),
		oracle: THEOREM_ORACLE,
		box: "every single mutation of every tree, and of every forest of two trees, of one to six rows in all, each named",
		show: Formatter.format,
		kept: [],
		kills: [withoutT0, withoutT3Check, withoutT5, withoutT6]
	})

/**
 * Commit every tree and two-tree forest of at most six rows from one INSERT in every row order and from its pre-order
 * in every split, and judge every split of its reverse pre-order by each constraint's moment, each case on the
 * worker's seat of the RFC's lowering.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/tree.test.ts at f91c01613).
 */
export const commitEveryTreeAndTwoTreeForestFromOneInsertInEveryRowOrderAndEverySplit =
	property.exhaust(finite(writeGen(forests)), {
		needs: { tree: Substrate.seat(treeTemplate) },
		situations: [
			"one insert in pre-order committed",
			"one insert with a child before its parent committed",
			"one insert with a sibling before its predecessor committed",
			"a pre-order split committed",
			"a reverse pre-order split committed",
			"a reverse pre-order split refused",
			"tree committed a forest of two trees"
		] satisfies ReadonlyArray<Reached<StateFeature | WriteFeature>>,
		check:
			({ tree }, c: Case<StateFeature | WriteFeature>) =>
			(write) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* tree
						const seat = yield* seatIn(taken)
						const statements = statementsOf(write)
						const committed = yield* Effect.provideService(
							judgeCase(seat, statements, c),
							Substrate,
							taken.substrate
						)
						const refusedWrite = (why: string) =>
							new Disagreed({ message: `${why}: ${Formatter.format(statements)}` })
						switch (write.kind) {
							case "one insert": {
								if (!committed) {
									return yield* refusedWrite("one insert of a forest was refused")
								}
								c.note(
									sentBefore(
										write.rows,
										(row, later) => later.id === row.parent && later.id !== row.id
									)
										? "one insert with a child before its parent committed"
										: sentBefore(
													write.rows,
													(row, later) =>
														row.parent !== row.id &&
														later.parent === row.parent &&
														later.at === row.at - 1
											  )
											? "one insert with a sibling before its predecessor committed"
											: "one insert in pre-order committed"
								)
								break
							}
							case "split": {
								if (write.order === "pre-order") {
									if (!committed) {
										return yield* refusedWrite("a pre-order split was refused")
									}
									if (write.statements.length > 1) {
										c.note("a pre-order split committed")
									}
								} else {
									c.note(`a reverse pre-order split ${committed ? "committed" : "refused"}`)
								}
								break
							}
						}
					})
				),
		oracle: THEOREM_ORACLE,
		box: "every tree and every forest of two trees of one to six rows in all, every order of its rows within one INSERT, and every split of its pre-order and its reverse pre-order into consecutive INSERTs",
		show: Formatter.format,
		kept: [],
		kills: []
	})
