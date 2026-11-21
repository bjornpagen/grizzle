/**
 * A tree keyed by its root fields then its drawn start, on PostgreSQL 19, written whole through grizzle's own write
 * and read back: three relations of root arity 1, 2 and 3 over text, integer and uuid root fields, each folded by the
 * sum of its children's kinds and each row copying its parent's kind down the parent axis.
 *
 * - **A second implementation:** the direct pre-order numbering of each tree under its root value
 *   (test/support/families/tree.ts numbered): every row's parent (its parent's start in its own tree, a root's its own,
 *   0), slot, count, interval, its parent's kind (a root's the copy's start, 0) and the sum of its children's kinds. What a write of
 *   a forest leaves must be exactly that, and nothing else.
 * - **PostgreSQL as the judge:** every lawful forest commits, trees that share every position under different roots
 *   among them; the same forest written again changes nothing (`unchanged`); and a tree that differs from the one stored
 *   under its root value is refused on the relation's primary key (root…, start), the key law, witnessed by the stored
 *   root's key, its root value at start 0.
 *
 * The space, generated: a relation of one to three root fields, its text root fields' values over a and b to a width
 * drawn per case, so two roots share a prefix or a field; one to three trees of one to six nodes under distinct root
 * values, each tree's shape drawn by its parents and each node's kind; and the change that makes a differing tree, the
 * root's kind or a leaf added under it.
 *
 * Features: a root of 2 and of 3 fields, two trees sharing their positions under different roots, a copy along parent
 * a node's kind differs from, a fold over a node's children, the same forest written again, a differing tree refused
 * on the key with its witness.
 *
 * A second property writes the same kind of forest by a direct SQL writer, the owner, each row's every column the
 * numbering's or one named mutation of it (a field one past, or a row moved under another tree's root value), and
 * PostgreSQL must commit exactly the states the theorem as a checker calls lawful (test/support/families/tree.ts
 * lawful): the numbering of the forest the state's keys and parent links describe.
 */
import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import { seatIn } from "#test/pg/fin/installed.ts"
import {
	caseGen,
	changed,
	columns,
	copiedView,
	type DirectFeature,
	directGen,
	forestFeatures,
	type KeyedFeature,
	mutatedRows,
	nestedOf,
	OneRoot,
	type Read,
	readOf,
	rootText,
	rootUuid,
	sortedReads,
	ThreeRoots,
	TwoRoots,
	valuesOf,
	writtenFields,
	directTemplate,
	oneRootInstall,
	oneRootTemplate,
	threeRootsInstall,
	threeRootsTemplate,
	twoRootsInstall,
	twoRootsTemplate
} from "#test/pg/fin/tree-keyed.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { canonicalRows, type Forest, lawful, numbered } from "#test/support/families/tree.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { attemptChecked, refusalText } from "#test/support/substrate.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A tree keyed by its root fields then its start writes every lawful forest whole as the direct pre-order numbering of each tree under its root, writes it again as no change, and refuses a differing tree under a stored root on the key.
 *
 * Its pre-conversion budget: runs 8, coverage cases 16 (test/pg/fin/tree-keyed.test.ts at 991e0f9ab).
 */
export const aTreeKeyedByItsRootFieldsThenItsStartWritesEveryLawfulForestWholeAsTheDirectPreOrderNumberingOfEachTreeUnderItsRootWritesItAgainAsNoChangeAndRefusesADifferingTreeUnderAStoredRootOnTheKey =
	property.explore(caseGen, {
		needs: {
			one: Substrate.seat(oneRootTemplate),
			two: Substrate.seat(twoRootsTemplate),
			three: Substrate.seat(threeRootsTemplate)
		},
		situations: [
			"a root of 2",
			"a root of 3",
			"two trees sharing their positions under different roots",
			"a copy along parent its node's kind differs from",
			"a fold over a node's children",
			"the same forest written again",
			"a differing tree refused on the key",
			"the refusal witnessed by the stored root's key"
		] satisfies ReadonlyArray<Reached<KeyedFeature>>,
		check:
			({ one: oneSeat, two: twoSeat, three: threeSeat }, cx: Case<KeyedFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.gen(function* () {
						const takenOne = yield* oneSeat
						const takenTwo = yield* twoSeat
						const takenThree = yield* threeSeat
						const one = yield* openedIn(OneRoot, {}, oneRootInstall, takenOne)
						const two = yield* openedIn(TwoRoots, {}, twoRootsInstall, takenTwo)
						const three = yield* openedIn(ThreeRoots, {}, threeRootsInstall, takenThree)
						const layers = Layer.mergeAll(one.served.layer, two.served.layer, three.served.layer)
						return yield* Effect.gen(function* () {
							const dbOne = yield* Db.open(one.served.login.roles.app, {})
							const dbTwo = yield* Db.open(two.served.login.roles.app, {})
							const dbThree = yield* Db.open(three.served.login.roles.app, {})
							/** A seat's write of a forest's trees, nested from each root, and its read of every row. */
							const seats = {
								1: {
									installed: one.installed,
									write: (forest: Forest) =>
										writeAnswerOf(
											dbOne.workload.insertNodes.once({
												params: {},
												facts: {
													insert: {
														Node: Arr.map(forest, ({ root, tree: t }) => ({
															doc: rootText(root[0]),
															...nestedOf(t)
														}))
													}
												}
											})
										),
									read: rowsOf(dbOne.workload.nodes.once({ params: {}, facts: {} })).pipe(
										Effect.map(
											Arr.map((n): Read => ({
												root: [n.doc],
												parent: Number(n.parent),
												at: Number(n.at),
												children: Number(n.children),
												start: Number(n.start),
												end: Number(n.end),
												kind: n.kind,
												parentKind: n.parentKind,
												total: n.total
											}))
										)
									),
									keyFields: ["doc", "start"],
									key: (root: ReadonlyArray<string>) => ({
										doc: rootText(root[0]),
										start: 0n
									})
								},
								2: {
									installed: two.installed,
									write: (forest: Forest) =>
										writeAnswerOf(
											dbTwo.workload.insertNodes.once({
												params: {},
												facts: {
													insert: {
														Node: Arr.map(forest, ({ root, tree: t }) => ({
															site: Number(defined(root[0], "a site")),
															page: rootText(root[1]),
															...nestedOf(t)
														}))
													}
												}
											})
										),
									read: rowsOf(dbTwo.workload.nodes.once({ params: {}, facts: {} })).pipe(
										Effect.map(
											Arr.map((n): Read => ({
												root: [String(n.site), n.page],
												parent: Number(n.parent),
												at: Number(n.at),
												children: Number(n.children),
												start: Number(n.start),
												end: Number(n.end),
												kind: n.kind,
												parentKind: n.parentKind,
												total: n.total
											}))
										)
									),
									keyFields: ["site", "page", "start"],
									key: (root: ReadonlyArray<string>) => ({
										site: Number(defined(root[0], "a site")),
										page: rootText(root[1]),
										start: 0n
									})
								},
								3: {
									installed: three.installed,
									write: (forest: Forest) =>
										writeAnswerOf(
											dbThree.workload.insertNodes.once({
												params: {},
												facts: {
													insert: {
														Node: Arr.map(forest, ({ root, tree: t }) => ({
															a: rootUuid(root[0]),
															b: rootText(root[1]),
															c: Number(defined(root[2], "a c")),
															...nestedOf(t)
														}))
													}
												}
											})
										),
									read: rowsOf(dbThree.workload.nodes.once({ params: {}, facts: {} })).pipe(
										Effect.map(
											Arr.map((n): Read => ({
												root: [n.a, n.b, String(n.c)],
												parent: Number(n.parent),
												at: Number(n.at),
												children: Number(n.children),
												start: Number(n.start),
												end: Number(n.end),
												kind: n.kind,
												parentKind: n.parentKind,
												total: n.total
											}))
										)
									),
									keyFields: ["a", "b", "c", "start"],
									key: (root: ReadonlyArray<string>) => ({
										a: rootUuid(root[0]),
										b: rootText(root[1]),
										c: Number(defined(root[2], "a c")),
										start: 0n
									})
								}
							} as const

							const seat = seats[c.arity]
							yield* replaceRows(
								{ 1: takenOne, 2: takenTwo, 3: takenThree }[c.arity].substrate.admin,
								installationGroup(namesOf(seat.installed)),
								[]
							)
							const expected = numbered(c.forest)
							cx.noteAll(forestFeatures(c, expected))
							const first = yield* seat.write(c.forest)
							if (first.kind !== "accepted") {
								return assert.fail(
									`a lawful forest is accepted, not ${first.kind}: ${Formatter.format(first)}`
								)
							}
							const stored = yield* seat.read
							assert.ok(
								deepEquals(
									sortedReads(stored),
									sortedReads(Arr.map(canonicalRows(expected), readOf))
								),
								`the forest reads back as its numbering: ${Formatter.format(sortedReads(stored))}`
							)
							const again = yield* seat.write(c.forest)
							assert.equal(again.kind, "unchanged", "the same forest written again changes nothing")
							cx.note("the same forest written again")
							const [head] = c.forest
							const differing = defined(head, "a forest's first tree")
							const refused = yield* seat.write([
								{ root: differing.root, tree: changed(differing.tree, c.change) }
							])
							if (refused.kind !== "refused") {
								return assert.fail(
									`a differing tree under a stored root is refused, not ${refused.kind}`
								)
							}
							assert.ok(
								Arr.some(
									refusedLaws(refused.refused),
									(law) =>
										law.kind === "primaryKey" &&
										law.relation === "Node" &&
										deepEquals<ReadonlyArray<string>>(law.fields, seat.keyFields)
								),
								`a differing tree is refused on the key, not ${Formatter.format(refused.refused)}`
							)
							cx.note("a differing tree refused on the key")
							if (refused.witness.kind === "key") {
								assert.ok(
									refused.witness.relation === "Node" &&
										deepEquals(refused.witness.values, seat.key(differing.root)),
									`the refusal is witnessed by the stored root's key, not ${Formatter.format(refused.witness)}`
								)
								cx.note("the refusal witnessed by the stored root's key")
							}
							const after = yield* seat.read
							assert.ok(
								deepEquals(sortedReads(after), sortedReads(stored)),
								"a refused write leaves the stored forest as it was"
							)
						}).pipe(withLayer(layers))
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the direct pre-order numbering of each tree under its root value, its copies and its fold, and PostgreSQL's verdict on each write"
		},
		budget: { runs: 8, steered: 16 },
		kept: [],
		kills: []
	})

/**
 * A tree keyed by its root fields then its start commits exactly the lawful states a direct writer writes, each root value's rows one tree with its parent's start, slots, intervals and copies.
 *
 * Its pre-conversion budget: runs 32, coverage cases 64 (test/pg/fin/tree-keyed.test.ts at 991e0f9ab).
 */
export const aTreeKeyedByItsRootFieldsThenItsStartCommitsExactlyTheLawfulStatesADirectWriterWritesEachRootValuesRowsOneTreeWithItsParentsStartSlotsIntervalsAndCopies =
	property.explore(directGen, {
		needs: { direct: Substrate.seat(directTemplate) },
		situations: [
			"a lawful forest committed",
			"an unlawful state refused",
			...Arr.map(writtenFields, (f): DirectFeature => `a wrong ${f} refused`),
			"a row under another tree's root refused",
			"a root off slot 0 refused"
		] satisfies ReadonlyArray<Reached<DirectFeature>>,
		check:
			({ direct }, cx: Case<DirectFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(direct, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const seat = yield* seatIn(taken, ["Node"], "keyed direct")

								const rows = mutatedRows(c)
								const isLawful = lawful(rows, copiedView)
								const [first, ...rest] = rows
								if (first === undefined) {
									return assert.fail("a forest holds a row")
								}
								const insert = `INSERT INTO ${seat.table("Node")} (${Arr.join(
									Arr.map(columns, (role) => seat.column("Node", role)),
									", "
								)}) VALUES ${Arr.join(
									Arr.map([first, ...rest], (r) => `(${Arr.join(valuesOf(r), ", ")})`),
									", "
								)}`
								const real = yield* attemptChecked(seat.session, [insert], Effect.void)
								if ((real.kind === "committed") !== isLawful) {
									return assert.fail(
										`PostgreSQL ${real.kind === "committed" ? "committed" : `refused (${refusalText(real.fields)})`} a state the theorem calls ${isLawful ? "lawful" : "unlawful"}: ${Formatter.format(rows)}`
									)
								}
								const m = c.mutation
								if (isLawful) {
									cx.note("a lawful forest committed")
									return
								}
								cx.note("an unlawful state refused")
								if (m.kind === "field") {
									cx.note(`a wrong ${m.field} refused`)
									if (m.field === "at" && defined(rows[m.row], "the mutated row").start === 0) {
										cx.note("a root off slot 0 refused")
									}
								}
								if (m.kind === "root") {
									cx.note("a row under another tree's root refused")
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the theorem as a checker: a state is lawful exactly when it is the direct pre-order numbering of the forest its keys and parent links describe (test/support/families/tree.ts lawful)"
		},
		budget: { runs: 32, steered: 64 },
		kept: [],
		kills: []
	})
