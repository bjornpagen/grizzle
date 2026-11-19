/** What the properties of tree.test.ts read: the RFC's seat, the boxes and the judging of a case. */

import { deepEquals, nonEmpty } from "@bjornpagen/testing/assert"
import type { Case, Kill, Oracle } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Exit, Formatter, Option } from "effect"
import {
	type TreeBreach,
	breachOf,
	canonical,
	type NodeConstraint,
	constraintNamed,
	ddlOf,
	forestBox,
	forestsOf,
	insertSql,
	isP3,
	type Lowering,
	type MutationKind,
	placementsOf,
	type Predicted,
	predicted,
	RFC,
	readSql,
	rowsOfRead,
	shapesBetween,
	sqlstateOf,
	type TreeRow,
	upToTwoRoots
} from "#test/pg/substrate/tree.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	attempt,
	type Attempted,
	momentText,
	qualified,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { clearRows, fixtureGroup, type ResetGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import {
	installTemplate,
	ownerSession,
	Substrate,
	type SubstrateCase
} from "#test/support/substrate/substrate.ts"

/** A lowering's verdict on one transaction, as a feature: committed, or refused naming the constraint PostgreSQL named. */
export type Verdict = "committed" | `refused ${NodeConstraint}`

/** PostgreSQL's disagreement with the model or with the theorem, with both sides and the SQL spelt out. */
export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** A lowering installed in a schema of its own, with every table of it and the session its transactions run on. */
export interface Seat {
	readonly lowering: Lowering
	readonly schema: string
	readonly tables: ResetGroup
	readonly session: RawSession
}

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
const sqlText = (
	seat: Seat,
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
 * reads back as written. It leaves its seat with no rows however it ends: a committed case clears its rows once it has
 * read them, and a case that ends with no verdict, its model disagreeing or a failing sibling seat interrupting it, may
 * have committed rows it never read, so it clears its seat. The next case on the seat, a shrink candidate among them,
 * never meets them (a duplicate key, 23505 on node_identity, in place of the failure being shrunk).
 */
const judged = (
	seat: Seat,
	statements: ReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>
): Effect.Effect<Judged, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.onExitIf(verdictOf(seat, statements), Exit.isFailure, () =>
		clearRows(seat.session, seat.tables)
	)

/** judged's verdict, its committed rows cleared once read (see judged). */
const verdictOf = (
	seat: Seat,
	statements: ReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>
): Effect.Effect<Judged, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const model = predicted(seat.lowering, statements)
		const real = yield* attempt(
			seat.session,
			Arr.map(statements, (rows) => insertSql(seat.schema, rows))
		)
		const disagree = (why: string) =>
			Effect.fail(
				new Disagreed({
					message: `tree: ${why}; the model predicts ${predictedText(model)}, PostgreSQL gave ${attemptedText(real)}, for\n${sqlText(seat, statements)}`
				})
			)
		if (model.kind === "committed" && real.kind === "committed") {
			const values = yield* seat.session.values(readSql(seat.schema), [])
			yield* clearRows(seat.session, seat.tables)
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

/** What a case reached, as a feature: the seat's verdict and the theorem's breach. */
export type StateFeature =
	| `tree ${Verdict}`
	| `tree refused ${TreeBreach}`
	| "tree refused at commit"
	| "tree committed a forest of two trees"
	| "tree committed a root whose at is not 0"
	| "P3's counterexample refused by tree"

/**
 * Judges one case on the seat: against the model, and against the theorem, where a disagreement, with the model
 * agreeing with PostgreSQL, is the theorem failing under the lowering, the finding this proof exists for. The theorem
 * judges a state: a commit must leave one, and a lawful state written in one INSERT must commit, while a lawful state
 * written over several may be refused at a statement that sends a row before a row it references, as the model says.
 * Whether the seat committed.
 */
export const judgeCase = <F extends string>(
	seat: Seat,
	statements: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>,
	c: Case<F | StateFeature>
): Effect.Effect<boolean, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const rows = Arr.flatten(statements)
		const breach = breachOf(rows)
		const lawful = Option.isNone(breach)
		const whole = statements.length === 1
		const judgedAs = yield* judged(seat, statements)
		c.note(`tree ${judgedAs.verdict}`)
		if (judgedAs.committed ? !lawful : whole && lawful) {
			return yield* new Disagreed({
				message: `the theorem fails: PostgreSQL ${judgedAs.verdict} a state ${Option.match(breach, {
					onNone: () => "that is one tree per root value with its pre-order intervals",
					onSome: (b) => `with ${b}`
				})}, and the model agrees, for\n${sqlText(seat, statements)}`
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
		if (isP3(rows) && !judgedAs.committed) {
			c.note("P3's counterexample refused by tree")
		}
		return judgedAs.committed
	})

/** What a write reached, beside its seats' verdicts. */
export type WriteFeature =
	| "one insert in pre-order committed"
	| "one insert with a child before its parent committed"
	| "one insert with a sibling before its predecessor committed"
	| "a pre-order split committed"
	| `a reverse pre-order split ${"committed" | "refused"}`

/** Whether some row of one INSERT is sent before a row it references. */
export const sentBefore = (
	rows: ReadonlyArray<TreeRow>,
	references: (row: TreeRow, later: TreeRow) => boolean
): boolean =>
	Arr.some(rows, (row, i) => Arr.some(rows.slice(i + 1), (later) => references(row, later)))

/** What a mutation reached: its kind's verdict on the RFC's seat. */
export type MutationFeature = `${MutationKind} ${"committed" | "refused"}`

export const THEOREM_ORACLE: Oracle = {
	kind: "specification",
	name: "trees.md §2's theorem as a checker, per root value: one tree rooted at its self-parented row, every row reached through its own value's rows, its slots gapless, its copies its parent's, and [start, end) a naive depth-first walk's pre-order intervals; beside it, the model of each constraint's moment (tree.ts predicted)"
}

/**
 * The RFC's lowering installed in a schema of its own once per member (substrate.ts installTemplate), where each search
 * installed a pool of seats of it beside its mutants and controls before its cases; each case's seat the schema in the
 * worker's clone with an owner session of its own, its node table emptied after the case.
 */
export const treeTemplate = installTemplate({
	declaredIn: import.meta,
	name: "trees rfc",
	content: { lowering: "rfc" },
	plan: (names) => Effect.succeed(names.schema),
	install: () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema({ create: true, label: "install" })
			for (const statement of ddlOf(schema, RFC)) {
				yield* s.admin.query(statement, [])
			}
		}),
	bind: (schema) => ({ schema, tables: fixtureGroup([qualified(schema, "node")]) }),
	reset: (installed) => installed.tables
})

/** The seat of a case over its clone of the template: the RFC's lowering and an owner session of its own. */
export const seatIn = (
	taken: SubstrateCase<{ readonly schema: string; readonly tables: ResetGroup }>
) =>
	Effect.map(taken.substrate.session({ ...ownerSession(), label: "tree" }), (session): Seat => ({
		lowering: RFC,
		schema: taken.value.schema,
		tables: taken.value.tables,
		session
	}))

/** The boxes' shapes and placements, every one a box holds. */
export const stateShapes = nonEmpty(shapesBetween(1, 2, upToTwoRoots, 2), "a box holds a shape")
export const intervalShapes = nonEmpty(shapesBetween(1, 3, upToTwoRoots, 2), "a box holds a shape")
export const checkedPlacements = nonEmpty(
	Arr.flatMap(
		[...shapesBetween(4, 5, { min: 1, max: 2 }, 2), ...shapesBetween(6, 6, { min: 1, max: 1 }, 1)],
		placementsOf
	),
	"a box holds a placement"
)
export const forests = forestsOf(forestBox.rows)

/** The laws the RFC's lowering holds (tree.ts LAWS), as that line spells them. */
const laws = ["T0", "T1", "T2", "T3 copy", "T3 check", "T4", "T5", "T6"] as const

const lawsLine = (held: ReadonlyArray<string>): string =>
	`const LAWS: ReadonlyArray<Law> = [${Arr.join(
		Arr.map(held, (law) => `"${law}"`),
		", "
	)}]`

/** The RFC's lowering with `law` dropped (tree.ts LAWS): a kill of every box whose states the law alone refuses. */
const lawDropped = (law: (typeof laws)[number], why: string): Kill => ({
	file: "test/pg/substrate/tree.ts",
	original: lawsLine(laws),
	replacement: lawsLine(Arr.filter(laws, (held) => held !== law)),
	why
})

export const withoutT0 = lawDropped(
	"T0",
	"T0 dropped from the parent copy: a row whose parent is in another tree commits, a state no forest of trees holds."
)
export const withoutT3Check = lawDropped(
	"T3 check",
	"T3's check dropped: a gap in a row's children commits, a state the theorem refuses."
)
export const withoutT5 = lawDropped(
	"T5",
	"T5's end dropped from the last slot: a row whose end is not its last child's commits, an interval the theorem refuses."
)
export const withoutT6 = lawDropped(
	"T6",
	"T6 dropped: a state whose intervals the theorem refuses commits."
)
