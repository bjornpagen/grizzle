/**
 * trees.md's theorem through grizzle's own lowering, on PostgreSQL 19rc1: a tree relation declared with grizzle's
 * `tree` former and installed by its first migration, every state of the boxes below written to it by a direct SQL
 * writer, the owner, as one transaction, and PostgreSQL's verdict judged three ways.
 *
 * - **The specification turned into a checker:** the theorem by a direct pre-order numbering (families/tree.ts
 *   treeBreachOf). PostgreSQL must commit exactly the states that are the numbering of the forest their parent links
 *   describe, per value of the root field r: one tree per r, every row reachable through rows of its own r, each row's
 *   children at slots 0 … n − 1, the root at slot 0, every copy its parent's and every interval its pre-order interval.
 *   A lawful state written in one INSERT must commit; a lawful state split across INSERTs may be refused at a statement
 *   that sends a row before one it references, as the model says.
 * - **A second implementation:** GT's substrate verdicts on the same states (test/pg/substrate/tree.ts predicted under
 *   its RFC lowering, the hand-written DDL its own suite proves against PostgreSQL). grizzle's verdict and moment must
 *   be GT's, with one declared difference: grizzle pins the root (w4-w7 §2.2), so a root at a slot other than 0, which
 *   GT's lowering leaves free, is refused here.
 * - **The lowering model** (families/tree.ts treePredicted): each native of §2.2's table at its moment. A refusal must be at
 *   the model's moment, by a constraint whose role (read off the installed catalog, installed.ts) is one the model
 *   allows there, with that native's SQLSTATE, reporting the tree's law (the identity, the relation's primary key).
 *
 * The boxes are GT's (test/pg/substrate/tree.ts), so there is one generator, each named in its test, every row's r over
 * two values: every state of at most two rows with every field over its range and one past it; every forest shape of
 * at most three rows with every start and end; every shape of four to six rows with every start and end its rows' own
 * checks pass; every single mutation, named, of every tree and forest of two trees of at most six rows; and every write
 * of each such forest, every row order in one INSERT and every split of its pre-order and its reverse. The operator's
 * whole bound, every state of six rows with every field over its range, is out of reach (GT's header counts it), so
 * these five boxes are the proof, and the box a test proves is in its name.
 *
 * **Mutation rediscovery:** three mutants of the installed lowering, each grizzle's installation with one native
 * re-created by DDL in a schema of its own, never the shared tree: the owner axis without T0's r → r pair ("without r's
 * copy"), the last axis without T5's end → end pair ("T5 without end"), and the root pin dropped ("root unpinned"). Each is judged by the same model under its own lowering and must be killed, committing a
 * state the theorem refuses: P3's cross-tree row, a parent whose last child ends early, and a root off slot 0. The
 * sentinel's leaked flags, the root's unpinned copies, cannot arise: the owner axis runs from the plain parent, so the
 * root references itself and its copies are its own values, which "a stale copy" of a root shows refused.
 */
import { layer } from "@effect/vitest"
import { exhaust, type Oracle } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, type Scope } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type Catalogued,
	cleared,
	constraintText,
	droppedPairsSql,
	droppedSql,
	mutated,
	type Seat,
	seatOf,
	theConstraint
} from "#test/pg/fin/installed.ts"
import {
	nodeInsertSql,
	nativeOf,
	RELATIONS,
	nodeReadSql,
	nodeRowsOfRead,
	Trees
} from "#test/pg/fin/tree.ts"
import {
	checkedCases,
	checkedGen,
	forestBox,
	forestsOf,
	fullCases,
	fullGen,
	isP3,
	type MutationKind,
	mutationsOf,
	placementsOf,
	canonical,
	predicted as gtPredicted,
	RFC,
	shapeCases,
	shapeGen,
	shapesBetween,
	statementsOf,
	type TreeRow,
	upToTwoRoots,
	type Write,
	writeGen
} from "#test/pg/substrate/tree.ts"
import { deepEquals, nonEmpty } from "#test/support/assert.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import {
	grizzleTree,
	type NumberingBreach,
	treeBreachOf,
	type TreeLowering,
	type TreeNative,
	type TreePredicted,
	treePredicted,
	treeSqlstate
} from "#test/support/families/tree.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	type Attempted,
	attempt,
	momentText,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The mutants of the installed lowering, each a seat of its own. */
type Mutant = "without r's copy" | "T5 without end" | "root unpinned"

type Label = "grizzle" | Mutant

const LOWERINGS: Readonly<Record<Label, TreeLowering>> = {
	grizzle: grizzleTree,
	"without r's copy": { ...grizzleTree, rootCopy: false },
	"T5 without end": { ...grizzleTree, lastEnd: false },
	"root unpinned": { ...grizzleTree, rootPin: false }
}

/** A seat with the lowering its model judges it by. */
interface TreeSeat {
	readonly label: Label
	readonly lowering: TreeLowering
	readonly seat: Seat
	/** The tree's own law, which every native but the identity reports. */
	readonly law: string
}

/** The installed constraint of a role on a seat, or the defect naming what it installed instead. */
const constraintOf = (seat: Seat, native: TreeNative): Catalogued =>
	theConstraint(seat, `the ${native}`, (c) => Option.contains(nativeOf(c), native))

/** Installs grizzle's lowering, or a mutant of it, in a schema of its own, with its owner session. */
const treeSeat = (
	label: Label
): Effect.Effect<
	TreeSeat,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const installed = yield* seatOf(Trees, RELATIONS, label)
		const ddl = (): ReadonlyArray<string> => {
			switch (label) {
				case "grizzle":
					return []
				case "without r's copy":
					return droppedPairsSql(
						installed,
						constraintOf(installed, "owner axis"),
						(s) => s === "doc"
					)
				case "T5 without end":
					return droppedPairsSql(
						installed,
						constraintOf(installed, "last axis"),
						(s) => s === "end"
					)
				case "root unpinned":
					return [droppedSql(installed, constraintOf(installed, "root pin"))]
			}
		}
		const seat =
			label === "grizzle" ? installed : yield* mutated(installed, RELATIONS, label, ddl())
		const [law, ...more] = seat.lawsOf("tree")
		if (law === undefined || more.length > 0) {
			return yield* Effect.die(
				`${label}: the schema holds ${seat.lawsOf("tree").length} tree laws, not one`
			)
		}
		return { label, lowering: LOWERINGS[label], seat, law }
	})

/** A verdict as a feature: committed, or refused naming the native PostgreSQL named. */
type Verdict = "committed" | `refused ${TreeNative}`

/** PostgreSQL's disagreement with the model, the theorem or GT, with both sides and the SQL spelt out. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

const predictedText = (model: TreePredicted): string =>
	model.kind === "committed"
		? "commit"
		: `refusal ${momentText(model.moment)} by any of ${Arr.join(
				Arr.dedupe(Arr.map(model.violations, (v) => v.native)),
				", "
			)}`

const attemptedText = (real: Attempted): string =>
	real.kind === "committed"
		? "commit"
		: `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`

const sqlText = (
	seat: Seat,
	statements: ReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>
): string =>
	Arr.join(
		[
			"BEGIN ISOLATION LEVEL SERIALIZABLE",
			...Arr.map(statements, (rows) => nodeInsertSql(seat, rows)),
			"COMMIT"
		],
		";\n"
	)

/** What PostgreSQL did with a transaction the model agreed with. */
interface Judged {
	readonly verdict: Verdict
	readonly committed: boolean
	readonly moment: Option.Option<Moment>
}

/**
 * One transaction of INSERTs on a seat with no rows, judged against the model: the same verdict; a refusal at the same
 * moment by an installed constraint whose role the model allows there, with its SQLSTATE and the law it reports; a
 * commit that reads back as written, whose rows are then cleared.
 */
const judged = (
	t: TreeSeat,
	statements: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>
): Effect.Effect<Judged, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const { seat } = t
		const model = treePredicted(
			t.lowering,
			[],
			Arr.map(statements, (rows) => ({ kind: "insert", rows }) as const)
		)
		const real = yield* attempt(
			seat.session,
			Arr.map(statements, (rows) => nodeInsertSql(seat, rows))
		)
		yield* seat.session.resetStatements
		const disagree = (why: string) =>
			Effect.fail(
				new Disagreed({
					message: `${t.label}: ${why}; the model predicts ${predictedText(model)}, PostgreSQL gave ${attemptedText(real)}, for\n${sqlText(seat, statements)}`
				})
			)
		if (model.kind === "committed" && real.kind === "committed") {
			const values = yield* seat.session.values(nodeReadSql(seat), [])
			const read = nodeRowsOfRead(values)
			yield* cleared(seat, ["Node"])
			if (!deepEquals(canonical(read), canonical(model.after))) {
				return yield* disagree(`the committed state reads back as ${Formatter.format(read)}`)
			}
			return { verdict: "committed", committed: true, moment: Option.none() }
		}
		if (model.kind === "refused" && real.kind === "refused") {
			if (!sameMoment(model.moment, real.moment)) {
				return yield* disagree("the moments differ")
			}
			const named = seat.refusedBy(real.fields)
			const native = Option.flatMap(named, nativeOf)
			if (Option.isNone(named) || Option.isNone(native)) {
				return yield* disagree(
					`PostgreSQL names ${Option.match(named, {
						onNone: () => "no constraint the installation holds",
						onSome: (c) => `${constraintText(c)}, a constraint of no native of §2.2`
					})}`
				)
			}
			if (
				!Arr.some(model.violations, (v) => v.native === native.value) ||
				real.fields.code !== treeSqlstate(native.value)
			) {
				return yield* disagree(
					`PostgreSQL names the ${native.value}, which the model does not allow there`
				)
			}
			if (native.value !== "identity" && !Option.contains(named.value.law, t.law)) {
				return yield* disagree(
					`the ${native.value} reports ${Formatter.format(named.value.law)}, not the tree's law ${t.law}`
				)
			}
			return {
				verdict: `refused ${native.value}`,
				committed: false,
				moment: Option.some(real.moment)
			}
		}
		return yield* disagree("the verdicts differ")
	})

/** Whether a state holds a parent whose last child ends before the parent does: what T5's end refuses. */
const endsEarly = (rows: ReadonlyArray<TreeRow>): boolean =>
	Arr.some(rows, (p) =>
		Arr.some(
			rows,
			(c) => c.parent === p.id && c.id !== p.id && c.at === p.children - 1 && c.end < p.end
		)
	)

/** Whether a state holds a root off slot 0, which only the root pin refuses: the root's own copies its owner axis holds. */
const offSlot = (rows: ReadonlyArray<TreeRow>): boolean =>
	Arr.some(rows, (r) => r.parent === r.id && r.at !== 0)

/** Whether a row hangs under a parent of another root value: P3's cross-tree row. */
const crossesTrees = (rows: ReadonlyArray<TreeRow>): boolean =>
	Arr.some(rows, (r) => Arr.some(rows, (p) => p.id === r.parent && p.root !== r.root))

/** What a case reached, as a feature. */
type StateFeature =
	| `${Label} ${Verdict}`
	| `grizzle refused ${NumberingBreach}`
	| "grizzle refused at commit"
	| "grizzle committed a forest of two trees"
	| "grizzle refused a root's at that GT commits"
	| `${Mutant} killed`
	| "without r's copy commits a row under another tree"
	| "T5 without end commits a parent whose last child ends early"
	| "root unpinned commits a root off slot 0"
	| "P3's counterexample refused by grizzle"
	| "P3's counterexample committed without r's copy"

/**
 * Judges one case on every seat at once: each against the model; grizzle's against the theorem, where a commit of a
 * non-tree or a one-INSERT tree refused is the theorem failing through grizzle's lowering, the finding this suite
 * exists for, and against GT's verdict on the same transaction; each mutant noted killed where it disagrees with the
 * theorem, by the state its drop admits.
 */
const judgeCase = (
	seats: ReadonlyArray<TreeSeat>,
	statements: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>,
	note: (feature: StateFeature) => void
): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> => {
	const rows = Arr.flatten(statements)
	const breach = treeBreachOf(rows)
	const lawful = Option.isNone(breach)
	const whole = statements.length === 1
	const wrong = (committed: boolean) => (committed ? !lawful : whole && lawful)
	return Effect.forEach(
		seats,
		(t) =>
			Effect.gen(function* () {
				const j = yield* judged(t, statements)
				note(`${t.label} ${j.verdict}`)
				if (t.label !== "grizzle") {
					if (wrong(j.committed)) {
						note(`${t.label} killed`)
					}
					if (j.committed && !lawful) {
						if (t.label === "without r's copy" && crossesTrees(rows)) {
							note("without r's copy commits a row under another tree")
							if (isP3(rows)) {
								note("P3's counterexample committed without r's copy")
							}
						}
						if (t.label === "T5 without end" && endsEarly(rows)) {
							note("T5 without end commits a parent whose last child ends early")
						}
						if (t.label === "root unpinned" && offSlot(rows)) {
							note("root unpinned commits a root off slot 0")
						}
					}
					return
				}
				if (wrong(j.committed)) {
					return yield* new Disagreed({
						message: `the theorem fails through grizzle's lowering: PostgreSQL ${j.verdict} a state ${Option.match(
							breach,
							{
								onNone: () => "that is one tree per root value with its pre-order intervals",
								onSome: (b) => `with ${b}`
							}
						)}, and the model agrees, for\n${sqlText(t.seat, statements)}`
					})
				}
				const gt = gtPredicted(RFC, statements)
				const rootsAt = Option.contains(breach, "a root's at")
				const agrees =
					gt.kind === "committed"
						? j.committed || rootsAt
						: !j.committed && Option.exists(j.moment, (m) => sameMoment(m, gt.moment))
				if (!agrees) {
					return yield* new Disagreed({
						message: `grizzle's lowering ${j.verdict}${Option.match(j.moment, {
							onNone: () => "",
							onSome: (m) => ` ${momentText(m)}`
						})} where GT's substrate lowering gives ${gt.kind === "committed" ? "a commit" : `a refusal ${momentText(gt.moment)}`}, for\n${sqlText(t.seat, statements)}`
					})
				}
				if (rootsAt && gt.kind === "committed") {
					note("grizzle refused a root's at that GT commits")
				}
				if (Option.isSome(breach)) {
					note(`grizzle refused ${breach.value}`)
				}
				if (Option.exists(j.moment, (m) => m.kind === "commit")) {
					note("grizzle refused at commit")
				}
				if (j.committed && Arr.dedupe(Arr.map(rows, (r) => r.root)).length > 1) {
					note("grizzle committed a forest of two trees")
				}
				if (isP3(rows) && !j.committed) {
					note("P3's counterexample refused by grizzle")
				}
			}),
		{ concurrency: "unbounded", discard: true }
	)
}

const THEOREM_ORACLE: Oracle = {
	kind: "specification",
	name: "trees.md §2's theorem as a checker by a direct pre-order numbering, per root value (families/tree.ts treeBreachOf); beside it GT's substrate verdicts on the same transactions (test/pg/substrate/tree.ts predicted under RFC), and the model of each installed native's moment (families/tree.ts treePredicted)"
}

/** The seats of a test: grizzle's lowering, and the mutants it must kill. */
const seatsOf = (labels: ReadonlyArray<Label>) => Effect.forEach(labels, treeSeat)

const MUTANTS: ReadonlyArray<Mutant> = ["without r's copy", "T5 without end", "root unpinned"]

/** A mutation's kind as a feature: its verdict on grizzle's seat, and each mutant it killed. */
type MutationFeature =
	| `${MutationKind} ${"committed" | "refused"}`
	| `${Mutant} killed by ${MutationKind}`

/** What a write reached. */
type WriteFeature =
	| "one insert committed"
	| "one insert with a child before its parent committed"
	| "a pre-order split committed"
	| `a reverse pre-order split ${"committed" | "refused"}`

layer(Substrate.layer)(
	"trees.md's theorem through grizzle's lowering on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"commit exactly the forests of numbered trees among every state of at most two rows, every field over its range and one past it",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seats = yield* seatsOf(["grizzle", "root unpinned"])
						const shapes = nonEmpty(shapesBetween(1, 2, upToTwoRoots, 2), "a box holds a shape")
						return yield* exhaust(
							{
								suite: "fin/tree-states",
								generator: fullGen(shapes),
								literal: Formatter.format,
								limit: fullCases(shapes),
								box: "every state of one or two rows: every shape with at most two self-parented rows, every assignment of two root values up to swapping them, each row's at, children and start over [0, N] and end over [0, N + 1], the copies the host's",
								oracle: THEOREM_ORACLE,
								coverage: requiredInSpace<StateFeature>([
									"grizzle committed",
									"grizzle committed a forest of two trees",
									"grizzle refused root pin",
									"grizzle refused bound",
									"grizzle refused document order",
									"grizzle refused root",
									"grizzle refused first child",
									"grizzle refused interval",
									"grizzle refused owner axis",
									"grizzle refused predecessor axis",
									"grizzle refused last axis",
									"grizzle refused at commit",
									"grizzle refused no root",
									"grizzle refused two roots",
									"grizzle refused a family",
									"grizzle refused an interval",
									"grizzle refused a root's at that GT commits",
									"root unpinned killed",
									"root unpinned commits a root off slot 0"
								]),
								caseHang
							},
							(rows, c) => judgeCase(seats, [rows], c.note)
						)
					})
				)
		)

		it.effect(
			"commit exactly the pre-order intervals among every start and end of every forest shape of at most three rows",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seats = yield* seatsOf(["grizzle", "without r's copy", "T5 without end"])
						const shapes = nonEmpty(shapesBetween(1, 3, upToTwoRoots, 2), "a box holds a shape")
						return yield* exhaust(
							{
								suite: "fin/tree-shapes",
								generator: shapeGen(shapes),
								literal: Formatter.format,
								limit: shapeCases(shapes),
								box: "every forest shape of one to three rows with at most two self-parented rows and every assignment of two root values, up to relabelling and swapping the values, each row's start in [0, N) and end in [1, N], the family and copies the host's",
								oracle: THEOREM_ORACLE,
								coverage: requiredInSpace<StateFeature>([
									"grizzle committed",
									"grizzle committed a forest of two trees",
									"grizzle refused owner axis",
									"grizzle refused document order",
									"grizzle refused root",
									"grizzle refused first child",
									"grizzle refused interval",
									"grizzle refused last axis",
									"grizzle refused at commit",
									"grizzle refused a cycle",
									"grizzle refused no root",
									"grizzle refused two roots",
									"grizzle refused a row under another tree",
									"grizzle refused an interval",
									"T5 without end killed",
									"T5 without end commits a parent whose last child ends early"
								]),
								caseHang
							},
							(rows, c) => judgeCase(seats, [rows], c.note)
						)
					})
				)
		)

		it.effect(
			"commit exactly the pre-order intervals among the starts and ends that pass the row checks, every shape of four and five rows with every root assignment and of six with one",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seats = yield* seatsOf(["grizzle", "without r's copy", "T5 without end"])
						const placements = nonEmpty(
							Arr.flatMap(
								[
									...shapesBetween(4, 5, { min: 1, max: 2 }, 2),
									...shapesBetween(6, 6, { min: 1, max: 1 }, 1)
								],
								placementsOf
							),
							"a box holds a placement"
						)
						return yield* exhaust(
							{
								suite: "fin/tree-checked",
								generator: checkedGen(placements),
								literal: Formatter.format,
								limit: Arr.reduce(placements, 0, (sum, p) => sum + checkedCases(p)),
								box: "every shape of four and five rows with one or two self-parented rows and every assignment of two root values, and of six rows with one root value, up to relabelling, with every start placement T1, T2 and T3 pass and every end T6 passes, the family and copies the host's",
								oracle: THEOREM_ORACLE,
								coverage: requiredInSpace<StateFeature>([
									"grizzle committed",
									"grizzle committed a forest of two trees",
									"grizzle refused owner axis",
									"grizzle refused predecessor axis",
									"grizzle refused last axis",
									"grizzle refused at commit",
									"grizzle refused a row under another tree",
									"grizzle refused an interval",
									"without r's copy killed",
									"without r's copy commits a row under another tree",
									"P3's counterexample refused by grizzle",
									"P3's counterexample committed without r's copy",
									"T5 without end killed",
									"T5 without end commits a parent whose last child ends early"
								]),
								caseHang
							},
							(rows, c) => judgeCase(seats, [rows], c.note)
						)
					})
				)
		)

		it.effect(
			"refuse every single named mutation of every tree and forest of two trees of at most six rows, by the native the model names",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seats = yield* seatsOf(["grizzle", ...MUTANTS])
						const mutations = nonEmpty(
							Arr.flatMap(forestsOf(forestBox.rows), mutationsOf),
							"a forest has a mutation"
						)
						return yield* exhaust(
							{
								suite: "fin/tree-mutations",
								generator: element(mutations),
								literal: Formatter.format,
								limit: mutations.length,
								box: "every single mutation of every tree of at most six rows and of every forest of two trees of at most six rows in all, each named (test/pg/substrate/tree.ts mutationsOf), written from no rows in one INSERT",
								oracle: THEOREM_ORACLE,
								coverage: requiredInSpace<StateFeature | MutationFeature>([
									"a wrong start refused",
									"a wrong end refused",
									"a wrong at refused",
									"a root's at refused",
									"a wrong count refused",
									"swapped siblings refused",
									"a second root refused",
									"a cycle refused",
									"a child outside its parent refused",
									"re-parented within an ancestor refused",
									"moved under another tree refused",
									"a row in another tree refused",
									"overlapping siblings refused",
									"a gap refused",
									"a stale copy refused",
									"without r's copy killed by a row in another tree",
									"without r's copy commits a row under another tree",
									"P3's counterexample committed without r's copy",
									"T5 without end killed by a wrong end",
									"T5 without end commits a parent whose last child ends early",
									"root unpinned killed by a root's at",
									"root unpinned commits a root off slot 0"
								]),
								caseHang
							},
							(m, c) =>
								Effect.gen(function* () {
									const kinds: Array<string> = []
									yield* judgeCase(seats, [m.rows], (f: StateFeature) => {
										c.note(f)
										kinds.push(f)
									})
									c.note(
										`${m.kind} ${kinds.includes("grizzle committed") ? "committed" : "refused"}`
									)
									for (const mutant of MUTANTS) {
										if (kinds.includes(`${mutant} killed`)) {
											c.note(`${mutant} killed by ${m.kind}`)
										}
									}
								})
						)
					})
				)
		)

		it.effect(
			"commit every tree and forest of at most six rows written in one INSERT in any row order, and split along its pre-order",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seats = yield* seatsOf(["grizzle"])
						const forests = forestsOf(forestBox.rows)
						const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))
						return yield* exhaust(
							{
								suite: "fin/tree-writes",
								generator: writeGen(forests),
								literal: Formatter.format,
								limit: Arr.reduce(
									forests,
									0,
									(sum, f) => sum + factorial(f.length) + 2 * 2 ** (f.length - 1)
								),
								box: "every tree and forest of two trees of at most six rows: every order of its rows in one INSERT, and every split of its pre-order and of its reverse pre-order into consecutive INSERTs",
								oracle: THEOREM_ORACLE,
								coverage: requiredInSpace<StateFeature | WriteFeature>([
									"one insert committed",
									"one insert with a child before its parent committed",
									"a pre-order split committed",
									"a reverse pre-order split refused",
									"a reverse pre-order split committed"
								]),
								caseHang
							},
							(write: Write, c) =>
								Effect.gen(function* () {
									const statements = statementsOf(write)
									const seen: Array<string> = []
									yield* judgeCase(seats, statements, (f: StateFeature) => {
										c.note(f)
										seen.push(f)
									})
									const committed = seen.includes("grizzle committed")
									if (write.kind === "one insert") {
										if (committed) {
											c.note("one insert committed")
											if (
												Arr.some(write.rows, (r, i) =>
													Arr.some(
														write.rows.slice(i + 1),
														(p) => p.id === r.parent && p.id !== r.id
													)
												)
											) {
												c.note("one insert with a child before its parent committed")
											}
										}
									} else if (write.order === "pre-order") {
										if (committed) {
											c.note("a pre-order split committed")
										}
									} else {
										c.note(`a reverse pre-order split ${committed ? "committed" : "refused"}`)
									}
								})
						)
					})
				)
		)
	}
)
