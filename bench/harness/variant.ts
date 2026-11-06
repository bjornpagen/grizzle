import { type Equivalence, exact, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Data, Effect, Formatter, Option, type Ordering, Result } from "effect"
import { type Summary, summarizePhases } from "#bench/cold/stats.ts"
import {
	type Explained,
	type ExplainOptions,
	explain,
	explainServerStatement,
	type MalformedPlan,
	type PlanMode,
	type PlanSummary,
	summarizePlans
} from "#bench/harness/explain.ts"
import { PhaseClock, type StandardPhase } from "#bench/harness/phases.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { appendAll } from "#compiler/core/array.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import type { SqlError } from "#test/support/pg.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"

/**
 * Generated against handwritten SQL: the generated and handwritten baselines use the same dataset, laws and result
 * equality, every transaction SERIALIZABLE, their EXPLAIN plans are inspected, and planning and execution are timed
 * apart from transport and client work.
 *
 * A variant is one way to compute one answer, by its role: the statements grizzle generated, a PostgreSQL expert's
 * handwritten statements for the same schema and workload, the conservative lowering, or a rejected rewrite kept as a
 * counterexample. Measuring a variant runs it on one session:
 * - warm-up executions, then `samples` timed executions, each timing executeMs over the variant's round trips, plus
 *   beginMs and commitMs when its statements share a snapshot transaction (several statements read one snapshot,
 *   SERIALIZABLE READ ONLY, as the runtime reads them), and decodeMs when it has a decoder;
 * - `explainSamples` EXPLAIN ANALYZE captures of each statement (explain.ts), and its generic and custom plans as a server statement
 *   as asked;
 * - the result of the first execution as its sorted rows, digested, with its repeated rows counted, since set
 *   semantics forbid a repeated row in a delivered answer.
 * A variant is a read: it is executed repeatedly and explained, and EXPLAIN ANALYZE executes what it explains, so a
 * write is timed as a transaction (transaction.ts), whose COMMIT is timed apart from its statements.
 *
 * Every statement casts its output columns to text, so a row is read once, where the session delivers it, as text
 * cells (`textRows`): a cell that is neither text nor NULL is MalformedRows. Two variants compute the same answer when
 * they deliver one set of rows (`rowsAgree`), cell by cell as text, neither repeating a row.
 */
export type VariantRole =
	| "generated"
	| "conservative"
	| "handwritten"
	| { readonly counterexample: string }

/** The transaction a variant's statements run in: each alone, or all in one snapshot. */
export type VariantTransaction =
	| { readonly kind: "autocommit" }
	| { readonly kind: "snapshot"; readonly readOnly: boolean }

/** A row as the session delivered it: every cell text, or NULL. */
export type TextRow = ReadonlyArray<string | null>

/** Decodes one statement's rows as the runtime does, timed as decodeMs. */
export type VariantDecode =
	| { readonly kind: "none" }
	| {
			readonly kind: "decode"
			readonly run: (rows: ReadonlyArray<TextRow>, statement: number) => void
	  }

export interface VariantStatement {
	readonly sql: string
	/** Text parameters, cast by the statement. */
	readonly params: ReadonlyArray<string>
}

export interface VariantSpec {
	readonly role: VariantRole
	/** For display: what the variant is. */
	readonly label: string
	readonly statements: Arr.NonEmptyReadonlyArray<VariantStatement>
	readonly transaction: VariantTransaction
	readonly decode: VariantDecode
	/** Phase timings taken outside the executions, such as compileMs and encodeMs: recorded beside them. */
	readonly outside: Readonly<Record<string, Summary>>
}

export interface VariantOptions {
	readonly samples: number
	readonly warmup: number
	readonly explainSamples: number
	readonly explain: ExplainOptions
	/** The server statement plan modes to capture each statement in beside its custom EXPLAIN. */
	readonly serverPlans: ReadonlyArray<PlanMode>
}

export class MalformedRows extends Data.TaggedError("MalformedRows")<{
	readonly statement: number
	readonly row: number
	readonly column: number
}> {}

/**
 * One statement's rows as text rows: every cell must be text or NULL, since every statement casts its outputs to text.
 */
export const textRows = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>,
	statement: number
): Result.Result<ReadonlyArray<TextRow>, MalformedRows> => {
	const out: Array<TextRow> = []
	for (const [row, cells] of rows.entries()) {
		const text: Array<string | null> = []
		for (const [column, cell] of cells.entries()) {
			if (typeof cell !== "string" && cell !== null) {
				return Result.fail(new MalformedRows({ statement, row, column }))
			}
			text.push(cell)
		}
		out.push(text)
	}
	return Result.succeed(out)
}

/**
 * Rows in a total order: cell by cell, NULL before any text, texts by UTF-16 code unit, and of two rows that agree on
 * the shorter one's cells, the shorter first.
 */
const compareTextRows = (a: TextRow, b: TextRow): Ordering.Ordering => {
	for (const [x, y] of Arr.zip(a, b)) {
		if (x === y) {
			continue
		}
		if (x === null) {
			return -1
		}
		if (y === null) {
			return 1
		}
		return x < y ? -1 : 1
	}
	return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/**
 * Two row lists agree when they are one set of rows: neither repeats a row, since a delivered answer is a set and a
 * repeat is a difference on either side, and sorted, they are equal in order. Sorting keeps it linear after the sort,
 * and result sets here reach about 90 000 rows, so a repeat is two equal neighbours.
 */
export const rowsAgree: Equivalence<ReadonlyArray<TextRow>> = (left, right) => {
	const sorted = (rows: ReadonlyArray<TextRow>) => Arr.sort(rows, compareTextRows)
	const repeatIn = (rows: ReadonlyArray<TextRow>) =>
		Arr.findFirst(rows, (row, i) => {
			const previous = rows[i - 1]
			return previous !== undefined && compareTextRows(previous, row) === 0
		})
	const l = sorted(left)
	const r = sorted(right)
	const repeated = Option.orElse(repeatIn(l), () => repeatIn(r))
	return Option.isSome(repeated)
		? Option.some(
				`a delivered answer repeats ${Formatter.format(repeated.value)}, and an answer is a set`
			)
		: ordered(ordered(exact))(l, r)
}

export interface ResultSet {
	readonly rows: number
	readonly distinct: number
	/** Rows beyond the first of each distinct row: zero for a set. */
	readonly repeated: number
	/**
	 * SHA-256 over the sorted rows, duplicates kept, each row as its cell count and a colon, then each cell as N (NULL) or
	 * S<length>:<text>: an encoding no two row lists share, so equal digests are equal sorted row lists.
	 */
	readonly digest: string
}

export const resultSet = (rows: ReadonlyArray<TextRow>): ResultSet => {
	const sorted = Arr.sort(rows, compareTextRows)
	const encoded: Array<string> = []
	let distinct = 0
	for (const [i, row] of sorted.entries()) {
		const previous = sorted[i - 1]
		if (previous === undefined || compareTextRows(previous, row) !== 0) {
			distinct++
		}
		encoded.push(`${row.length}:`)
		for (const cell of row) {
			encoded.push(cell === null ? "N" : `S${cell.length}:${cell}`)
		}
	}
	const digest = sha256Hex(Arr.join(encoded, ""))
	return { rows: rows.length, distinct, repeated: rows.length - distinct, digest }
}

export interface VariantMeasure {
	readonly role: VariantRole
	readonly label: string
	readonly statements: ReadonlyArray<string>
	readonly parameters: ReadonlyArray<ReadonlyArray<string>>
	readonly transaction: VariantTransaction
	readonly samples: number
	readonly firstMs: number
	readonly phases: Readonly<Record<string, Summary>>
	readonly result: ResultSet
	/** One summary per statement. */
	readonly plans: ReadonlyArray<PlanSummary>
	/** One entry per server statement plan mode asked for, each with one summary per statement. */
	readonly serverPlans: ReadonlyArray<{
		readonly mode: PlanMode
		readonly plans: ReadonlyArray<PlanSummary>
	}>
}

/** The rows of every statement, concatenated in statement order. */
const execute = Effect.fn("execute")(function* (
	session: BenchSession,
	spec: VariantSpec,
	clock: PhaseClock
): Effect.fn.Return<ReadonlyArray<TextRow>, SqlError | MalformedRows> {
	const transaction = spec.transaction
	const out: Array<TextRow> = []
	const executed = Effect.gen(function* () {
		for (const [i, s] of spec.statements.entries()) {
			const timed = yield* clock.time("executeMs", session.values(s.sql, s.params))
			const rows = yield* Effect.fromResult(textRows(timed, i))
			const decode = spec.decode
			if (decode.kind === "decode") {
				clock.timeCall("decodeMs", () => decode.run(rows, i))
			}
			appendAll(out, rows)
		}
	})
	switch (transaction.kind) {
		case "autocommit":
			yield* executed
			return out
		case "snapshot":
			yield* clock.time(
				"beginMs",
				session.values(`${beginSerializable}${transaction.readOnly ? " READ ONLY" : ""}`, [])
			)
			yield* Effect.onError(executed, () => Effect.orDie(session.values("ROLLBACK", []))).pipe(
				Effect.andThen(clock.time("commitMs", session.values("COMMIT", [])))
			)
			return out
	}
})

/** `n` captures of one statement, summarized. */
const captures = <E>(
	n: number,
	capture: Effect.Effect<Explained, E>
): Effect.Effect<PlanSummary, E> =>
	Effect.map(
		Effect.forEach(Array.from({ length: n }), () => capture),
		summarizePlans
	)

/** Measures `spec` on `session` (see the head of this file). The session must be outside a transaction block. */
export const measureVariant = Effect.fn("measureVariant")(function* (
	session: BenchSession,
	spec: VariantSpec,
	options: VariantOptions
): Effect.fn.Return<VariantMeasure, SqlError | MalformedPlan | MalformedRows> {
	if (!Number.isInteger(options.samples) || options.samples < 1) {
		return yield* Effect.die(new RangeError(`variant ${spec.label}: ${options.samples} samples`))
	}
	const firstClock = new PhaseClock()
	const firstStart = performance.now()
	const firstRows = yield* execute(session, spec, firstClock)
	const firstMs = Math.round((performance.now() - firstStart) * 1000) / 1000
	for (let i = 0; i < options.warmup; i++) {
		yield* execute(session, spec, new PhaseClock())
	}
	const samples: Array<Readonly<Partial<Record<StandardPhase, number>>>> = []
	for (let i = 0; i < options.samples; i++) {
		const clock = new PhaseClock()
		yield* execute(session, spec, clock)
		samples.push(clock.take())
	}
	const plans: Array<PlanSummary> = []
	for (const s of spec.statements) {
		const captured = yield* captures(
			options.explainSamples,
			explain(session, s.sql, s.params, options.explain)
		)
		plans.push(captured)
	}
	const serverPlans: Array<{
		readonly mode: PlanMode
		readonly plans: ReadonlyArray<PlanSummary>
	}> = []
	for (const mode of options.serverPlans) {
		const perStatement: Array<PlanSummary> = []
		for (const s of spec.statements) {
			const captured = yield* captures(
				options.explainSamples,
				explainServerStatement(session, s.sql, s.params, mode, options.explain)
			)
			perStatement.push(captured)
		}
		serverPlans.push({ mode, plans: perStatement })
	}
	return {
		role: spec.role,
		label: spec.label,
		statements: Arr.map(spec.statements, (s) => s.sql),
		parameters: Arr.map(spec.statements, (s) => s.params),
		transaction: spec.transaction,
		samples: options.samples,
		firstMs,
		phases: { ...spec.outside, ...summarizePhases(samples) },
		result: resultSet(firstRows),
		plans,
		serverPlans
	} satisfies VariantMeasure
})

export interface VariantComparison {
	readonly left: string
	readonly right: string
	/** One set of rows, neither repeating one: the two variants compute the same answer. */
	readonly sameResult: boolean
	/** Ratios left / right of the p50s: information, never a verdict (this machine's timings are noisy). */
	readonly executeP50Ratio: number
	readonly planningP50Ratio: number
	readonly executionP50Ratio: number
	readonly rowsReadRatio: number
	readonly statements: { readonly left: number; readonly right: number }
}

const ratio = (a: number, b: number): number =>
	b === 0 ? (a === 0 ? 1 : Number.POSITIVE_INFINITY) : a / b

const sumP50 = (plans: ReadonlyArray<PlanSummary>, f: (p: PlanSummary) => Summary): number =>
	Arr.reduce(plans, 0, (sum, p) => sum + f(p).p50)

/** Every variant measureVariant returns times executeMs, its samples being at least one. */
const executeP50 = (m: VariantMeasure): number => {
	const executeMs = m.phases["executeMs"]
	if (executeMs === undefined) {
		throw new Error(`variant ${m.label} recorded no executeMs`)
	}
	return executeMs.p50
}

const round = (x: number): number => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x)

export const compareVariants = (
	left: VariantMeasure,
	right: VariantMeasure
): VariantComparison => ({
	left: left.label,
	right: right.label,
	sameResult: left.result.digest === right.result.digest,
	executeP50Ratio: round(ratio(executeP50(left), executeP50(right))),
	planningP50Ratio: round(
		ratio(
			sumP50(left.plans, (p) => p.planningMs),
			sumP50(right.plans, (p) => p.planningMs)
		)
	),
	executionP50Ratio: round(
		ratio(
			sumP50(left.plans, (p) => p.executionMs),
			sumP50(right.plans, (p) => p.executionMs)
		)
	),
	rowsReadRatio: round(
		ratio(
			sumP50(left.plans, (p) => p.rowsRead),
			sumP50(right.plans, (p) => p.rowsRead)
		)
	),
	statements: { left: left.statements.length, right: right.statements.length }
})
