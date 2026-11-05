/**
 * trees.md's theorem, proved against PostgreSQL 19rc1 inside stated boxes: the tree relation's DDL written by hand
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
 * out of T3's check, every other law over every row (tree.ts). Four mutants run beside it on the state and mutation
 * boxes, each judged by the same model and required to disagree with the theorem somewhere, to be killed: T0 dropped
 * from the parent copy, T3's check dropped, T5's `end` dropped from the last slot, and T6 dropped. Two controls read
 * trees.md's text literally, with no root selection: every law over every row, and T4's and T5's targets over every
 * row.
 *
 * The boxes (doctrine rules 6, 9), whose generators tree.ts holds. Every row's root field ranges over two values,
 * every assignment of them to rows up to swapping the two, and a state holds at most two self-parented rows, one root
 * per value. The operator's bound, every state of at most six rows with every field over its range, is out of reach (a
 * row of six ranges over 6⁴ · 7 · 2 values), and so is every forest shape with every start and end beyond three rows
 * (11,599,872 cases at four). The proof is five boxes, each named in its test, beside the plans of T1's scans and the
 * cost of T0 to T6:
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
import { layer } from "@effect/vitest"
import { type Case, exhaust, type Oracle } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { summarize } from "#bench/cold/stats.ts"
import {
	explain,
	type ExplainOptions,
	explainServerStatement,
	findNodes,
	indexAccesses,
	type PlanMode,
	type PlanNode,
	rowsRead
} from "#bench/harness/explain.ts"
import { measureTransaction, type TransactionMeasure } from "#bench/harness/transaction.ts"
import { indices } from "#compiler/core/array.ts"
import { quoteString } from "#compiler/sql/print.ts"
import {
	batchInsertSql,
	batchParams,
	type TreeBreach,
	breachOf,
	canonical,
	checkedCases,
	checkedGen,
	clearSql,
	type NodeConstraint,
	constraintNamed,
	ddlOf,
	forestBox,
	forestsOf,
	fullCases,
	fullGen,
	insertSql,
	isP3,
	LAWS,
	type Law,
	loadTree,
	type Lowering,
	MUTATION_KINDS,
	type MutationKind,
	mutationsOf,
	placementsOf,
	type Predicted,
	predicted,
	RFC,
	readSql,
	rowsOfRead,
	shapeCases,
	shapeGen,
	shapesBetween,
	sqlstateOf,
	statementsOf,
	type TreeRow,
	truncateSql,
	upToTwoRoots,
	writeGen
} from "#test/pg/substrate/tree.ts"
import { assert, deepEquals, defined, nonEmpty } from "#test/support/assert.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	type Attempted,
	attempt,
	momentText,
	qualified,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const without = (law: Law): Lowering => ({ ...RFC, laws: Arr.filter(LAWS, (l) => l !== law) })

/** The RFC's lowering, its four mutants, and the two controls that read trees.md's text literally. */
const LOWERINGS = {
	tree: RFC,
	"without T0": without("T0"),
	"T3 without its check": without("T3 check"),
	"T5 without end": without("T5"),
	"without T6": without("T6"),
	"as written": { selection: "every row", targets: "every row", laws: LAWS },
	"targets every row": { selection: "non-root", targets: "every row", laws: LAWS }
} as const satisfies Record<string, Lowering>

type Label = keyof typeof LOWERINGS

type Mutant = "without T0" | "T3 without its check" | "T5 without end" | "without T6"

type Control = "as written" | "targets every row"

const MUTANTS: ReadonlyArray<Mutant> = [
	"without T0",
	"T3 without its check",
	"T5 without end",
	"without T6"
]

const CONTROLS: ReadonlyArray<Control> = ["as written", "targets every row"]

/** The lowerings of the given labels, for a test's seats. */
const loweringsOf = <L extends Label>(
	labels: ReadonlyArray<L>
): ReadonlyArray<readonly [L, Lowering]> =>
	Arr.map(labels, (label) => [label, LOWERINGS[label]] as const)

/** A lowering's verdict on one transaction, as a feature: committed, or refused naming the constraint PostgreSQL named. */
type Verdict = "committed" | `refused ${NodeConstraint}`

/** PostgreSQL's disagreement with the model or with the theorem, with both sides and the SQL spelt out. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** A lowering installed in a schema of its own, with the session its transactions run on. */
interface Seat<L extends string> {
	readonly label: L
	readonly lowering: Lowering
	readonly schema: string
	readonly session: RawSession
}

/** Installs each lowering in a fresh schema, with an owner session of its own, so the lowerings' cases run at once. */
const seatsOf = <L extends string>(lowerings: ReadonlyArray<readonly [L, Lowering]>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		return yield* Effect.forEach(lowerings, ([label, lowering]) =>
			Effect.gen(function* () {
				const schema = yield* s.schema(freshSchema)
				for (const statement of ddlOf(schema, lowering)) {
					yield* s.admin.query(statement, [])
				}
				const session = yield* s.session({ ...ownerSession(), label })
				return { label, lowering, schema, session } satisfies Seat<L>
			})
		)
	})

const predictedText = (model: Predicted): string =>
	model.kind === "committed"
		? "commit"
		: `refusal ${momentText(model.moment)} by any of ${Arr.join(
				Arr.dedupe(Arr.map(model.violations, (v) => v.constraint)),
				", "
			)}`

const attemptedText = (real: Attempted): string =>
	real.kind === "committed"
		? "commit"
		: `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`

/** A transaction's SQL as a report prints it: the seat's DDL, then each statement, so a reader can replay it. */
const sqlText = <L extends string>(
	seat: Seat<L>,
	statements: ReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>
): string =>
	Arr.join(
		[
			...ddlOf(seat.schema, seat.lowering),
			"BEGIN ISOLATION LEVEL SERIALIZABLE",
			...Arr.map(statements, (rows) => insertSql(seat.schema, rows)),
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
 * One transaction of `statements`, each an INSERT, on a seat with no rows, judged against the model: the same verdict,
 * a refusal at the same moment with the SQLSTATE of a constraint the model allows there, and a committed state that
 * reads back as written. A committed case clears its rows.
 */
const judged = <L extends string>(
	seat: Seat<L>,
	statements: ReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>
): Effect.Effect<Judged, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const model = predicted(seat.lowering, statements)
		const real = yield* attempt(
			seat.session,
			Arr.map(statements, (rows) => insertSql(seat.schema, rows))
		)
		yield* seat.session.resetStatements
		const disagree = (why: string) =>
			Effect.fail(
				new Disagreed({
					message: `${seat.label}: ${why}; the model predicts ${predictedText(model)}, PostgreSQL gave ${attemptedText(real)}, for\n${sqlText(seat, statements)}`
				})
			)
		if (model.kind === "committed" && real.kind === "committed") {
			const values = yield* seat.session.values(readSql(seat.schema), [])
			yield* seat.session.query(clearSql(seat.schema), [])
			const read = rowsOfRead(values)
			if (!deepEquals(canonical(read), canonical(model.after))) {
				return yield* disagree(`the committed state reads back as ${Formatter.format(read)}`)
			}
			return { verdict: "committed", committed: true, moment: Option.none() }
		}
		if (model.kind === "refused" && real.kind === "refused") {
			if (!sameMoment(model.moment, real.moment)) {
				return yield* disagree("the moments differ")
			}
			const named = constraintNamed(real.fields.constraint)
			if (
				Option.isNone(named) ||
				!Arr.some(model.violations, (v) => v.constraint === named.value) ||
				real.fields.code !== sqlstateOf(named.value)
			) {
				return yield* disagree("PostgreSQL names a constraint or SQLSTATE the model does not allow")
			}
			return {
				verdict: `refused ${named.value}`,
				committed: false,
				moment: Option.some(real.moment)
			}
		}
		return yield* disagree("the verdicts differ")
	})

/** What a case reached, as a feature: each seat's verdict, the theorem's breach, each kill and each control's miss. */
type StateFeature =
	| `${Label} ${Verdict}`
	| `tree refused ${TreeBreach}`
	| "tree refused at commit"
	| "tree committed a forest of two trees"
	| "tree committed a root whose at is not 0"
	| `${Mutant} killed`
	| "without T0 commits a row under another tree"
	| "P3's counterexample refused by tree"
	| "P3's counterexample committed without T0"
	| `${Control} refuses a tree`
	| `${Control} commits a non-tree`

/** One seat's outcome of a case: whether it committed, and whether that disagrees with the theorem. */
interface SeatOutcome<L extends Label> {
	readonly label: L
	readonly committed: boolean
	readonly wrong: boolean
}

/**
 * Judges one case on every seat at once: each against the model; the RFC's seat against the theorem, where a
 * disagreement, with the model agreeing with PostgreSQL, is the theorem failing under the lowering, the finding this
 * proof exists for; each mutant noted killed where it disagrees with the theorem, T0's drop only ever by a row whose
 * parent has another root value; and each control noted where it refuses a tree or commits a non-tree. The theorem
 * judges a state: a commit must leave one, and a lawful state written in one INSERT must commit, while a lawful state
 * written over several may be refused at a statement that sends a row before a row it references, as the model says.
 */
const judgeCase = <L extends Label, F extends string>(
	seats: ReadonlyArray<Seat<L>>,
	statements: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>,
	c: Case<F | StateFeature>
): Effect.Effect<ReadonlyArray<SeatOutcome<L>>, SqlError | TransactionRolledBack | Disagreed> => {
	const rows = Arr.flatten(statements)
	const breach = breachOf(rows)
	const lawful = Option.isNone(breach)
	const whole = statements.length === 1
	/** Whether a verdict disagrees with the theorem: a commit of no forest, or a one-INSERT forest refused. */
	const wrong = (committed: boolean) => (committed ? !lawful : whole && lawful)
	const p3 = isP3(rows)
	const crossed = Arr.some(rows, (r) =>
		Arr.some(rows, (p) => p.id === r.parent && p.root !== r.root)
	)
	return Effect.forEach(
		seats,
		(seat) =>
			Effect.gen(function* () {
				const judgedAs = yield* judged(seat, statements)
				const label: Label = seat.label
				c.note(`${label} ${judgedAs.verdict}`)
				switch (label) {
					case "tree": {
						if (wrong(judgedAs.committed)) {
							return yield* new Disagreed({
								message: `the theorem fails: PostgreSQL ${judgedAs.verdict} a state ${Option.match(
									breach,
									{
										onNone: () => "that is one tree per root value with its pre-order intervals",
										onSome: (b) => `with ${b}`
									}
								)}, and the model agrees, for\n${sqlText(seat, statements)}`
							})
						}
						if (Option.isSome(breach)) {
							c.note(`tree refused ${breach.value}`)
						}
						if (Option.exists(judgedAs.moment, (m) => m.kind === "commit")) {
							c.note("tree refused at commit")
						}
						if (judgedAs.committed && Arr.dedupe(Arr.map(rows, (r) => r.root)).length > 1) {
							c.note("tree committed a forest of two trees")
						}
						if (judgedAs.committed && Arr.some(rows, (r) => r.parent === r.id && r.at !== 0)) {
							c.note("tree committed a root whose at is not 0")
						}
						if (p3 && !judgedAs.committed) {
							c.note("P3's counterexample refused by tree")
						}
						break
					}
					case "without T0":
					case "T3 without its check":
					case "T5 without end":
					case "without T6": {
						if (wrong(judgedAs.committed)) {
							c.note(`${label} killed`)
						}
						if (label === "without T0" && judgedAs.committed && !lawful) {
							if (!crossed) {
								return yield* new Disagreed({
									message: `T0's drop commits a non-tree whose every row shares its parent's root value, which T0 cannot be what refuses, for\n${sqlText(seat, statements)}`
								})
							}
							c.note("without T0 commits a row under another tree")
							if (p3) {
								c.note("P3's counterexample committed without T0")
							}
						}
						break
					}
					case "as written":
					case "targets every row": {
						if (whole && lawful && !judgedAs.committed) {
							c.note(`${label} refuses a tree`)
						}
						if (!lawful && judgedAs.committed) {
							c.note(`${label} commits a non-tree`)
						}
						break
					}
				}
				return {
					label: seat.label,
					committed: judgedAs.committed,
					wrong: wrong(judgedAs.committed)
				}
			}),
		{ concurrency: "unbounded" }
	)
}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))

/** What a write reached, beside its seats' verdicts. */
type WriteFeature =
	| "one insert in pre-order committed"
	| "one insert with a child before its parent committed"
	| "one insert with a sibling before its predecessor committed"
	| "a pre-order split committed"
	| `a reverse pre-order split ${"committed" | "refused"}`

/** Whether some row of one INSERT is sent before a row it references. */
const sentBefore = (
	rows: ReadonlyArray<TreeRow>,
	references: (row: TreeRow, later: TreeRow) => boolean
): boolean =>
	Arr.some(rows, (row, i) => Arr.some(rows.slice(i + 1), (later) => references(row, later)))

/** What a mutation reached: its kind's verdict on the RFC's seat, and each mutant it killed. */
type MutationFeature =
	| `${MutationKind} ${"committed" | "refused"}`
	| `${Mutant} killed by ${MutationKind}`

/** One transaction that writes `rows` in one statement, as the planner writes a tree, and must commit. */
const loaded = (
	session: RawSession,
	schema: string,
	rows: ReadonlyArray<TreeRow>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(batchInsertSql(schema), batchParams(rows))
		yield* session.commit
		yield* session.resetStatements
	})

const THEOREM_ORACLE: Oracle = {
	kind: "specification",
	name: "trees.md §2's theorem as a checker, per root value: one tree rooted at its self-parented row, every row reached through its own value's rows, its slots gapless, its copies its parent's, and [start, end) a naive depth-first walk's pre-order intervals; beside it, the model of each constraint's moment (tree.ts predicted)"
}

/** The EXPLAIN options of the plan readings: no WAL, no SERIALIZE. */
const planned: ExplainOptions = { wal: false, serialize: { kind: "off" } }

/** The plan readings' load: one tree of 20,000 rows, each with up to four children. */
const planLoad = { rows: 20_000, fanout: 4 } as const

/**
 * The cost reading's load and rounds: one tree of 10,000 rows in one INSERT, fifteen rounds with the lowerings
 * interleaved, each after a TRUNCATE and a CHECKPOINT. Its figures are recorded and gate nothing; the minimum beside the
 * median reads the work a row costs on a machine other sessions load.
 */
const costLoad = { rows: 10_000, fanout: 4, rounds: 15 } as const

/** A plan's indexes, its sorts, its sequential scans, and the rows it reads from stored relations. */
const planFacts = (plan: PlanNode) => ({
	indexes: Arr.dedupe(Arr.map(indexAccesses(plan), (a) => a.index)),
	sorts: findNodes(plan, "Sort").length,
	seqScans: findNodes(plan, "Seq Scan").length,
	read: rowsRead(plan)
})

/** A subtree whose descendants a plan reading scans: the root's first child, a subtree under 100 rows, and a leaf. */
type Subtree = "a quarter of the tree" | "a subtree under 100 rows" | "a leaf"

/** A plan reading: the export, or one subtree's descendants, planned custom or generic. */
type PlanProbe =
	| { readonly read: "the export"; readonly mode: PlanMode }
	| {
			readonly read: `the descendants of ${Subtree}`
			readonly subtree: Subtree
			readonly mode: PlanMode
	  }

type PlanFeature = `${PlanProbe["read"]}, ${PlanMode} plan`

/** Every plan reading: the export and each subtree's descendants, each as a custom and as a generic plan. */
const PLAN_PROBES: Arr.NonEmptyReadonlyArray<PlanProbe> = Arr.flatMap(
	["custom", "generic"] as const,
	(mode): Arr.NonEmptyReadonlyArray<PlanProbe> => [
		{ read: "the export", mode },
		...Arr.map(
			["a quarter of the tree", "a subtree under 100 rows", "a leaf"] as const,
			(subtree): PlanProbe => ({ read: `the descendants of ${subtree}`, subtree, mode })
		)
	]
)

/** A transaction's execute and commit time, from the bench harness's phase clock. */
const totalMs = (m: TransactionMeasure): number =>
	defined(m.phases.executeMs) + defined(m.phases.commitMs)

layer(Substrate.layer)("trees.md's theorem on PostgreSQL 19rc1", (it) => {
	it.effect(
		"commit exactly the forests of trees among every state of at most two rows, every field over its range and one past it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(loweringsOf(["tree", ...MUTANTS, ...CONTROLS]))
					const shapes = nonEmpty(shapesBetween(1, 2, upToTwoRoots, 2), "a box holds a shape")
					return yield* exhaust(
						{
							suite: "substrate/tree-states",
							generator: fullGen(shapes),
							literal: Formatter.format,
							limit: fullCases(shapes),
							box: "every state of one or two rows: every shape with at most two self-parented rows, every assignment of two root values up to swapping them, each row's at, children and start over [0, N] and end over [0, N + 1], the copies the host's",
							oracle: THEOREM_ORACLE,
							coverage: requiredInSpace<StateFeature>([
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
								"tree refused an interval",
								"without T0 killed",
								"T3 without its check killed",
								"T5 without end killed",
								"without T6 killed",
								"as written refuses a tree",
								"targets every row refuses a tree",
								"targets every row commits a non-tree"
							]),
							caseHang
						},
						(rows, c) => Effect.asVoid(judgeCase(seats, [rows], c))
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
					const seats = yield* seatsOf(loweringsOf(["tree", ...MUTANTS]))
					const shapes = nonEmpty(shapesBetween(1, 3, upToTwoRoots, 2), "a box holds a shape")
					return yield* exhaust(
						{
							suite: "substrate/tree-shapes",
							generator: shapeGen(shapes),
							literal: Formatter.format,
							limit: shapeCases(shapes),
							box: "every forest shape of one to three rows with at most two self-parented rows and every assignment of two root values, up to relabelling and swapping the values, with each row's start in [0, N) and end in [1, N], the family and copies the host's",
							oracle: THEOREM_ORACLE,
							coverage: requiredInSpace<StateFeature>([
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
								"tree refused an interval",
								"without T0 killed",
								"T3 without its check killed",
								"T5 without end killed",
								"without T6 killed"
							]),
							caseHang
						},
						(rows, c) => Effect.asVoid(judgeCase(seats, [rows], c))
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
					const seats = yield* seatsOf(loweringsOf(["tree", ...MUTANTS]))
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
							suite: "substrate/tree-checked",
							generator: checkedGen(placements),
							literal: Formatter.format,
							limit: Arr.reduce(placements, 0, (sum, p) => sum + checkedCases(p)),
							box: "every shape of four and five rows with one or two self-parented rows and every assignment of two root values, and of six rows with one root and one value, up to relabelling, the family and copies the host's, with every start and end its rows' checks pass: T1's starts apart per value, T2's roots at 0, T3's first children one past their parents, a leaf's end its start + 1 and any other in (start, N]",
							oracle: THEOREM_ORACLE,
							coverage: requiredInSpace<StateFeature>([
								"tree committed",
								"tree committed a forest of two trees",
								"tree refused copy",
								"tree refused closure",
								"tree refused last",
								"tree refused at commit",
								"tree refused a cycle",
								"tree refused a row under another tree",
								"tree refused an interval",
								"without T0 killed",
								"without T0 commits a row under another tree",
								"P3's counterexample refused by tree",
								"P3's counterexample committed without T0",
								"T5 without end killed"
							]),
							caseHang
						},
						(rows, c) => Effect.asVoid(judgeCase(seats, [rows], c))
					)
				})
			)
	)

	it.effect(
		"refuse every single mutation of every tree and two-tree forest of at most six rows that leaves no forest of trees, at the moment and by a constraint the model allows",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(loweringsOf(["tree", ...MUTANTS]))
					const cases = nonEmpty(
						Arr.flatMap(forestsOf(forestBox.rows), mutationsOf),
						"a forest has a mutation"
					)
					return yield* exhaust(
						{
							suite: "substrate/tree-mutations",
							generator: element(cases),
							literal: Formatter.format,
							limit: cases.length,
							box: "every single mutation of every tree, and of every forest of two trees, of one to six rows in all, each named",
							oracle: THEOREM_ORACLE,
							coverage: requiredInSpace<StateFeature | MutationFeature>([
								"a root's at committed",
								...Arr.map(MUTATION_KINDS, (k): MutationFeature => `${k} refused`),
								"tree refused copy",
								"tree refused at commit",
								"tree refused two roots",
								"tree refused a cycle",
								"tree refused a row under another tree",
								"without T0 killed by a row in another tree",
								"T3 without its check killed by a gap",
								"T5 without end killed by a wrong end",
								"without T6 killed"
							]),
							caseHang
						},
						(mutation, c) =>
							Effect.gen(function* () {
								const outcomes = yield* judgeCase(seats, [mutation.rows], c)
								for (const outcome of outcomes) {
									const label: Label = outcome.label
									switch (label) {
										case "tree":
											c.note(`${mutation.kind} ${outcome.committed ? "committed" : "refused"}`)
											break
										case "without T0":
										case "T3 without its check":
										case "T5 without end":
										case "without T6":
											if (outcome.wrong) {
												c.note(`${label} killed by ${mutation.kind}`)
											}
											break
									}
								}
							})
					)
				})
			)
	)

	it.effect(
		"commit every tree and two-tree forest of at most six rows from one INSERT in every row order and from its pre-order in every split, and judge every split of its reverse pre-order by each constraint's moment",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(loweringsOf(["tree", ...CONTROLS]))
					const forests = forestsOf(forestBox.rows)
					return yield* exhaust(
						{
							suite: "substrate/tree-writes",
							generator: writeGen(forests),
							literal: Formatter.format,
							limit: Arr.reduce(
								forests,
								0,
								(sum, f) => sum + factorial(f.length) + 2 * 2 ** (f.length - 1)
							),
							box: "every tree and every forest of two trees of one to six rows in all, every order of its rows within one INSERT, and every split of its pre-order and its reverse pre-order into consecutive INSERTs",
							oracle: THEOREM_ORACLE,
							coverage: requiredInSpace<StateFeature | WriteFeature>([
								"one insert in pre-order committed",
								"one insert with a child before its parent committed",
								"one insert with a sibling before its predecessor committed",
								"a pre-order split committed",
								"a reverse pre-order split committed",
								"a reverse pre-order split refused",
								"tree committed a forest of two trees",
								"as written refuses a tree",
								"targets every row refuses a tree"
							]),
							caseHang
						},
						(write, c) =>
							Effect.gen(function* () {
								const statements = statementsOf(write)
								const outcomes = yield* judgeCase(seats, statements, c)
								const committed = Arr.some(outcomes, (o) => o.label === "tree" && o.committed)
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
					)
				})
			)
	)

	it.effect(
		"read a tree of 20,000 rows in document order by one scan of T1's index with no sort, and each subtree's descendants by a range scan of it that reads exactly them",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const [seat] = yield* Effect.map(seatsOf(loweringsOf(["tree"])), nonEmpty)
					const rows = loadTree(planLoad.rows, planLoad.fanout)
					yield* loaded(seat.session, seat.schema, rows)
					const node = qualified(seat.schema, "node")
					yield* s.admin.query(`ANALYZE ${node}`, [])
					const subtreeOf = (subtree: Subtree): TreeRow => {
						switch (subtree) {
							case "a quarter of the tree":
								return defined(rows[1])
							case "a subtree under 100 rows":
								return Option.getOrThrow(
									Arr.findFirst(rows, (r) => r.end - r.start > 1 && r.end - r.start < 100)
								)
							case "a leaf":
								return Option.getOrThrow(Arr.findFirst(rows, (r) => r.children === 0))
						}
					}
					return yield* exhaust(
						{
							suite: "substrate/tree-plans",
							generator: element(PLAN_PROBES),
							literal: Formatter.format,
							limit: PLAN_PROBES.length,
							coverage: requiredInSpace<PlanFeature>(
								nonEmpty(Arr.map(PLAN_PROBES, (p): PlanFeature => `${p.read}, ${p.mode} plan`))
							),
							caseHang
						},
						(probe, c) =>
							Effect.gen(function* () {
								const sql =
									probe.read === "the export"
										? `SELECT * FROM ${node} WHERE root = $1::int4 ORDER BY start`
										: `SELECT * FROM ${node} WHERE root = $1::int4 AND start > $2::int8 AND start < $3::int8`
								const n =
									probe.read === "the export"
										? Option.none()
										: Option.some(subtreeOf(probe.subtree))
								const params = Option.match(n, {
									onNone: () => ["0"],
									onSome: (r) => ["0", String(r.start), String(r.end)]
								})
								const e =
									probe.mode === "custom"
										? yield* explain(seat.session, sql, params, planned)
										: yield* explainServerStatement(seat.session, sql, params, "generic", planned)
								const facts = planFacts(e.plan)
								const name: PlanFeature = `${probe.read}, ${probe.mode} plan`
								const record = `${name}: ${Formatter.format({
									...facts,
									nodes: Arr.map(
										findNodes(e.plan, () => true),
										(p) => p.nodeType
									)
								})}`
								yield* Effect.promise(() => ctx.annotate(record))
								assert.deepEqual(facts.indexes, ["node_order"], `${name} reads T1's index alone`)
								assert.equal(facts.seqScans, 0, `${name} scans nothing sequentially`)
								Option.match(n, {
									onNone: () => {
										assert.equal(facts.sorts, 0, `${name} sorts nothing`)
										assert.equal(facts.read, planLoad.rows, `${name} reads each row once`)
									},
									onSome: (r) =>
										assert.equal(facts.read, r.end - r.start - 1, `${name} reads exactly them`)
								})
								c.note(name)
							})
					)
				})
			)
	)

	it.effect(
		"measure what T0 to T6 cost a row of one 10,000-row INSERT over the family's own constraints, and that they add no foreign key and no immediate trigger",
		(ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const seats = yield* seatsOf<string>([
					["the family", { ...RFC, laws: [] }],
					["the family and T0", { ...RFC, laws: ["T0"] }],
					["the tree", RFC]
				])
				const rows = loadTree(costLoad.rows, costLoad.fanout)
				const measured = (seat: Seat<string>, explained: boolean) =>
					measureTransaction(seat.session, {
						readOnly: false,
						statements: [
							{
								label: "insert",
								sql: batchInsertSql(seat.schema),
								params: batchParams(rows),
								explain: explained
							}
						],
						end: explained ? "rollback" : "plain",
						deferredEvents: false,
						wal: !explained
					})
				const samples: Array<readonly [string, TransactionMeasure]> = []
				for (const round of indices(costLoad.rounds)) {
					for (const seat of round % 2 === 0 ? seats : Arr.reverse(seats)) {
						yield* seat.session.query(truncateSql(seat.schema), [])
						yield* s.superuser("CHECKPOINT")
						const m = yield* measured(seat, false)
						assert.equal(m.outcome.kind, "committed", `${seat.label}'s load commits`)
						samples.push([seat.label, m])
						yield* seat.session.resetStatements
					}
				}
				const records: Array<string> = []
				const medians: Array<number> = []
				const minima: Array<number> = []
				const foreignKeys: Array<string> = []
				const triggerCalls: Array<number> = []
				for (const seat of seats) {
					const ms = Arr.map(
						Arr.filter(samples, ([label]) => label === seat.label),
						([, m]) => m
					)
					const execute = summarize(Arr.map(ms, (m) => defined(m.phases.executeMs)))
					const commit = summarize(Arr.map(ms, (m) => defined(m.phases.commitMs)))
					const total = summarize(Arr.map(ms, totalMs))
					const wal = summarize(
						Arr.map(ms, (m) => (m.wal.kind === "observed" ? m.wal.value.backend.bytes : 0))
					)
					medians.push(total.p50)
					minima.push(total.min)
					const node = quoteString(qualified(seat.schema, "node"))
					const constraints = yield* s.admin.queryValues(
						`SELECT c.contype::text, count(*)::int4 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = ${node}::regclass GROUP BY 1 ORDER BY 1`,
						[]
					)
					foreignKeys.push(
						Formatter.format(Arr.filter(constraints, ([contype]) => contype === "f"))
					)
					const indexes = yield* s.admin.queryValues(
						`SELECT count(*)::int4, sum(pg_catalog.pg_relation_size(i.indexrelid))::int8::text FROM pg_catalog.pg_index AS i WHERE i.indrelid = ${node}::regclass`,
						[]
					)
					yield* seat.session.query(truncateSql(seat.schema), [])
					const explained = yield* measured(seat, true)
					const plan = defined(explained.statements[0]).explained
					const triggers = plan.kind === "observed" ? plan.value.triggers : []
					triggerCalls.push(Arr.reduce(triggers, 0, (sum, t) => sum + t.calls))
					yield* seat.session.resetStatements
					records.push(
						`${seat.label}: execute ${Formatter.format(execute)} ms; commit ${Formatter.format(commit)} ms; total p50 ${total.p50} ms, ${Math.round((total.p50 * 1e6) / costLoad.rows) / 1000} µs a row, min ${total.min} ms; backend WAL p50 ${wal.p50} bytes, ${Math.round(wal.p50 / costLoad.rows)} a row; constraints by type ${Formatter.format(constraints)}; indexes (count, bytes) ${Formatter.format(indexes)}; immediate triggers ${Formatter.format(
							Arr.map(
								triggers,
								(t) => `${Option.getOrElse(t.constraint, () => t.name)} × ${t.calls}`
							)
						)}`
					)
				}
				const perRow = (a: number | undefined, b: number | undefined) =>
					`${Math.round(((defined(a) - defined(b)) * 1e6) / costLoad.rows) / 1000} µs a row`
				const over = (at: string, [family, withT0, tree]: ReadonlyArray<number>) =>
					`at the ${at} over ${costLoad.rounds} rounds of ${costLoad.rows} rows: T0 to T6 over the family ${perRow(tree, family)}; T0 alone ${perRow(withT0, family)}; T1 to T6 over the family and T0 ${perRow(tree, withT0)}`
				records.push(over("medians", medians), over("minima", minima))
				yield* Effect.forEach(records, (record) => Effect.promise(() => ctx.annotate(record)))
				assert.equal(Arr.dedupe(foreignKeys).length, 1, "T0 to T6 add no foreign key")
				assert.equal(
					Arr.dedupe(triggerCalls).length,
					1,
					"T0 to T6 fire no immediate trigger the family does not"
				)
			})
	)
})
