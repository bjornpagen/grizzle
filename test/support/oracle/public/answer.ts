import { type Equivalence, exact, multiset, ordered, type Side } from "@grizzle/testing/oracle"
import { Array as Arr, Formatter, Option, Record, Result } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { VectorText } from "#compiler/ir/carriers.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import { defined } from "#test/support/assert.ts"
import { indices } from "#test/support/oracle/pick.ts"
import type {
	Column,
	MixedRoot,
	ParentColumn,
	Query,
	StatedDelivery
} from "#test/support/oracle/public/program.ts"
import { Declined, type Value, valueKey } from "#test/support/oracle/reference/values.ts"

/** The columns and attachments a delivered row carries, each attachment in its stated delivery. */
export interface Shape {
	readonly columns: ReadonlyArray<Column>
	readonly attachments: ReadonlyArray<{
		readonly name: string
		readonly shape: Shape
		readonly delivery: StatedDelivery
	}>
}

export const shapeOf = (q: Query<ParentColumn>): Shape => ({
	columns: q.heading,
	attachments: Arr.map(q.attachments, (a) => ({
		name: a.name,
		shape: shapeOf(a.child),
		delivery: a.delivery
	}))
})

/** The shape of each heading group of a mixed root: its columns, nothing attached. */
export const mixedShapes = (root: MixedRoot): ReadonlyArray<Shape> =>
	Arr.map(root.groups, (columns) => ({ columns, attachments: [] }))

/**
 * The shape a ChangeSet's read-back of a query of `shape` delivers: inside the write transaction an attachment stated
 * as the one child or an arm reads back as an Option, which immediate evidence alone proves and the handle does not
 * narrow (types/query ReadBack); an Option and an array read back as stated.
 */
export const readBackShape = (shape: Shape): Shape => ({
	columns: shape.columns,
	attachments: Arr.map(shape.attachments, (a) => ({
		name: a.name,
		shape: readBackShape(a.shape),
		delivery: a.delivery.kind === "array" ? a.delivery : { kind: "option" }
	}))
})

export interface Nested {
	readonly values: ReadonlyArray<Value>
	readonly attachments: ReadonlyArray<ReadonlyArray<Nested>>
}

/**
 * What a read answers, in one representation for every side: the reference's per-parent delivery and grizzle's decoded
 * nested records alike.
 *
 * Rule: a delivered row is its head values in heading order and, for each attachment in order, the rows of its child.
 * Values are the reference's exact carriers (reference/values.ts), each in its one form: an integer a bigint, numeric a
 * Decimal with no display scale, a float a double with one zero, a handle its name. The contract fixes exactly this
 * much of an answer:
 *
 * - a set is a multiset with each row once, compared as a multiset; an ordered root is compared in order;
 * - a column's values are compared exactly: equal values are identical (1.0 and 1.00 are one Decimal, NaN is NaN, a
 *   float's zero is 0), so a delivered value that is equal but not identical, a -0 among them, is a difference;
 * - an attachment's children are a set per parent, compared as a multiset with exact multiplicities: a child missing
 *   from one parent, repeated, or given to another parent is a difference;
 * - get's Option is the set of its one row or none.
 *
 * A public record is read into this form strictly: a missing or extra key, a value of another host type, or an
 * attachment delivered in any other shape than the one it states (an array; an Option; the one child; an arm's Some
 * exactly where the parent row's field holds its handle and None elsewhere) is a difference of its own, never a value
 * read leniently.
 *
 * A side's answer: the delivered rows, or what it failed with instead.
 */
export type Answer = Result.Result<ReadonlyArray<Nested>, string>

export const showValue = (v: Value): string => {
	if (typeof v === "bigint") {
		return `${v}n`
	}
	if (typeof v === "string") {
		return JSON.stringify(v)
	}
	if (typeof v === "number") {
		return Object.is(v, -0) ? "-0" : String(v)
	}
	if (typeof v === "boolean") {
		return String(v)
	}
	if (v instanceof Decimal) {
		return `${v.toString()}d`
	}
	if (v instanceof Money) {
		return `$${v.minorUnits}`
	}
	if ("start" in v && "end" in v) {
		return `[${v.start},${v.end})`
	}
	if (v instanceof Declined) {
		return "a declined value"
	}
	return `vector ${Formatter.format(v.vector)}`
}

const printNested = (shape: Shape, n: Nested): string => {
	const values = Arr.map(shape.columns, (c, i) => {
		const v = n.values[i]
		return `${c.name}: ${v === undefined ? "missing" : showValue(v)}`
	})
	const attachments = Arr.map(shape.attachments, (a, i) => {
		const rows = n.attachments[i] ?? []
		return `${a.name}: [${Arr.join(
			Arr.map(rows, (r) => printNested(a.shape, r)),
			", "
		)}]`
	})
	return `{ ${Arr.join([...values, ...attachments], ", ")} }`
}

const printAnswer =
	(shape: Shape) =>
	(answer: Answer): string =>
		Result.isFailure(answer)
			? `failed: ${answer.failure}`
			: answer.success.length === 0
				? "no row"
				: Arr.join(
						Arr.map(answer.success, (n) => `\n  ${printNested(shape, n)}`),
						""
					)

/** A disagreement between answers of one shape: the difference, then each side's answer as printAnswer prints it. */
export const answersReport = (
	shape: Shape,
	difference: string,
	sides: ReadonlyArray<Side<Answer>>
): string =>
	Arr.join(
		[difference, ...Arr.map(sides, ([name, answer]) => `${name}: ${printAnswer(shape)(answer)}`)],
		"\n"
	)

/**
 * Whether two values are one exactly: a double by Object.is, so a delivered -0 is no 0, and every other value by its
 * canonical text (reference/values.ts valueKey): a Decimal by its one text, as `equals` compares it, Money by its minor
 * units, a span by its endpoints, a vector by its components, a declined value by its identity.
 */
const sameValue = (a: Value, b: Value, type: ScalarType): boolean =>
	typeof a === "number" && typeof b === "number"
		? Object.is(a, b)
		: valueKey(a, type) === valueKey(b, type)

const value =
	(column: Column): Equivalence<Value> =>
	(a, b) =>
		sameValue(a, b, column.type)
			? Option.none()
			: Option.some(`${column.name}: ${showValue(a)} is not ${showValue(b)}`)

/** The columns of a shape, at every depth, that an answer's rows declined at least once (a reference's Declined). */
interface Declines {
	readonly columns: ReadonlySet<number>
	readonly attachments: ReadonlyArray<Declines>
}

const declinesOf = (shape: Shape, rows: ReadonlyArray<Nested>): Declines => ({
	columns: new Set(
		Arr.filter(indices(shape.columns.length), (i) =>
			Arr.some(rows, (r) => r.values[i] instanceof Declined)
		)
	),
	attachments: Arr.map(shape.attachments, (a, i) =>
		declinesOf(
			a.shape,
			Arr.flatMap(rows, (r) => r.attachments[i] ?? [])
		)
	)
})

/**
 * The columns two answers compare by type alone: those exactly one of them declines, a reference's term PostgreSQL alone
 * computes against a delivery, which states every value. A column both decline is compared by the declined values'
 * identities, and every other column exactly.
 */
const unstated = (left: Declines, right: Declines): Declines => ({
	columns: new Set([
		...Arr.filter([...left.columns], (i) => !right.columns.has(i)),
		...Arr.filter([...right.columns], (i) => !left.columns.has(i))
	]),
	attachments: Arr.map(left.attachments, (a, i) =>
		unstated(a, defined(right.attachments[i], `the declines of attachment ${i}`))
	)
})

/**
 * Two rows of one shape, exactly: every column's value one value (sameValue), but for the columns `skip` holds, and
 * every attachment's children as a multiset. Every side delivers each value in its one form, so equal is identical,
 * and anything a plan, a storage order or a stored spelling could change is a difference.
 */
const nestedEquivalence = (shape: Shape, skip: Declines): Equivalence<Nested> => {
	const columns = Arr.map(shape.columns, value)
	const children = Arr.map(shape.attachments, (a, i) => ({
		name: a.name,
		rows: multiset(
			nestedEquivalence(a.shape, defined(skip.attachments[i], `the declines of ${a.name}`))
		)
	}))
	return (a, b) => {
		for (const [i, equal] of columns.entries()) {
			const x = a.values[i]
			const y = b.values[i]
			if (x === undefined || y === undefined) {
				return Option.some(`column ${i} is missing`)
			}
			if (skip.columns.has(i)) {
				continue
			}
			const difference = equal(x, y)
			if (Option.isSome(difference)) {
				return difference
			}
		}
		for (const [i, child] of children.entries()) {
			const difference = child.rows(a.attachments[i] ?? [], b.attachments[i] ?? [])
			if (Option.isSome(difference)) {
				return Option.some(`${child.name}: ${difference.value}`)
			}
		}
		return Option.none()
	}
}

/** A success or a failure: two successes by `success`, two failures by `failure`, and never a success and a failure. */
const result =
	<A, F>(success: Equivalence<A>, failure: Equivalence<F>): Equivalence<Result.Result<A, F>> =>
	(left, right) => {
		if (Result.isSuccess(left) && Result.isSuccess(right)) {
			return success(left.success, right.success)
		}
		if (Result.isFailure(left) && Result.isFailure(right)) {
			return failure(left.failure, right.failure)
		}
		return Option.some(
			Result.isSuccess(left) ? "a success is not a failure" : "a failure is not a success"
		)
	}

/**
 * The equivalence of a read's answers: its rows as a multiset, or in order where the root is ordered, every column
 * exactly but those one answer declines and the other states (unstated), which no reference judges: there the sides
 * judge each other (pg/oracle/public/run.ts, against itself).
 */
export const answerEquivalence =
	(shape: Shape, inOrder: boolean): Equivalence<Answer> =>
	(left, right) => {
		const skip =
			Result.isSuccess(left) && Result.isSuccess(right)
				? unstated(declinesOf(shape, left.success), declinesOf(shape, right.success))
				: declinesOf(shape, [])
		const rows = nestedEquivalence(shape, skip)
		return result(inOrder ? ordered(rows) : multiset(rows), exact)(left, right)
	}

const endpoint = (x: unknown): bigint | undefined =>
	typeof x === "bigint"
		? x
		: typeof x === "number" && Number.isSafeInteger(x)
			? BigInt(x)
			: undefined

/** A decoded host value as the reference's carrier of `type`, or the difference that it is none. */
const carrierValue = (type: ScalarType, host: unknown): Result.Result<Value, string> => {
	const wrong = (): Result.Result<Value, string> =>
		Result.fail(`a ${type.carrier} column delivered ${typeof host} ${String(host)}`)
	switch (type.carrier) {
		case "int2":
		case "int4":
			return typeof host === "number" && Number.isSafeInteger(host)
				? Result.succeed(BigInt(host))
				: wrong()
		case "int8":
		case "exactInteger":
			return typeof host === "bigint" ? Result.succeed(host) : wrong()
		case "numeric":
			return host instanceof Decimal ? Result.succeed(host) : wrong()
		case "float4":
		case "float8":
			return typeof host === "number" ? Result.succeed(host) : wrong()
		case "money":
		case "exactMoney":
			return host instanceof Money ? Result.succeed(host) : wrong()
		case "bool":
			return typeof host === "boolean" ? Result.succeed(host) : wrong()
		case "uuid":
		case "text":
		case "enum":
			return typeof host === "string" ? Result.succeed(host) : wrong()
		case "range4":
		case "range8": {
			if (!isRecord(host)) {
				return wrong()
			}
			const { start, end } = host
			const s = endpoint(start)
			const e = endpoint(end)
			return s === undefined || e === undefined ? wrong() : Result.succeed({ start: s, end: e })
		}
		case "vector": {
			if (!isVector(host) || Arr.some(Array.from(host), (x) => Object.is(x, -0))) {
				return wrong()
			}
			const read = VectorText.of(host)
			return read.ok ? Result.succeed({ vector: read.value }) : wrong()
		}
	}
}

/**
 * The children an attachment delivered in its stated delivery, read strictly from the row `row` holds it in, or the
 * difference that it is delivered otherwise: an array as is, an Option as its value or none, the one child as itself,
 * and an arm as Some exactly where the row's field holds the arm's handle and None elsewhere.
 */
const children = (
	delivery: StatedDelivery,
	row: { readonly [key: string]: unknown },
	delivered: unknown
): Result.Result<ReadonlyArray<unknown>, string> => {
	const option = (): Result.Result<ReadonlyArray<unknown>, string> =>
		Option.isOption(delivered)
			? Result.succeed(Option.isSome(delivered) ? [delivered.value] : [])
			: Result.fail(`a ${delivery.kind} delivered as no Option`)
	switch (delivery.kind) {
		case "array":
			return Arr.isArray(delivered)
				? Result.succeed(delivered)
				: Result.fail("an array delivered as no array")
		case "option":
			return option()
		case "one":
			return isRecord(delivered) && !Option.isOption(delivered) && !Arr.isArray(delivered)
				? Result.succeed([delivered])
				: Result.fail("the one child delivered as no record")
		case "arm": {
			const selected = row[delivery.field.name] === delivery.handle
			if (!Option.isOption(delivered) || Option.isSome(delivered) !== selected) {
				return Result.fail(
					`the arm of ${delivery.handle} over ${delivery.field.name} delivered ${Option.isOption(delivered) ? (Option.isSome(delivered) ? "Some" : "None") : "no Option"} where the row holds ${String(row[delivery.field.name])}`
				)
			}
			return option()
		}
	}
}

/** A public record of `shape`, read strictly. */
const fromPublic = (shape: Shape, row: unknown): Result.Result<Nested, string> => {
	if (!isRecord(row)) {
		return Result.fail(`a row that is no record: ${String(row)}`)
	}
	const expected = [
		...Arr.map(shape.columns, (c) => c.name),
		...Arr.map(shape.attachments, (a) => a.name)
	]
	const keys = Record.keys(row)
	const extra = Arr.filter(keys, (k) => !expected.includes(k))
	const missing = Arr.filter(expected, (k) => !Record.has(row, k))
	if (extra.length > 0 || missing.length > 0) {
		return Result.fail(`a row with keys ${JSON.stringify(keys)}, not ${JSON.stringify(expected)}`)
	}
	const values: Array<Value> = []
	for (const c of shape.columns) {
		const v = carrierValue(c.type, row[c.name])
		if (Result.isFailure(v)) {
			return Result.fail(`${c.name}: ${v.failure}`)
		}
		values.push(v.success)
	}
	const attachments: Array<ReadonlyArray<Nested>> = []
	for (const a of shape.attachments) {
		const delivered = children(a.delivery, row, row[a.name])
		if (Result.isFailure(delivered)) {
			return Result.fail(`${a.name}: ${delivered.failure}`)
		}
		const rows = Result.all(
			Arr.map(delivered.success, (child) =>
				Result.mapError(fromPublic(a.shape, child), (refusal) => `${a.name}: ${refusal}`)
			)
		)
		if (Result.isFailure(rows)) {
			return Result.fail(rows.failure)
		}
		attachments.push(rows.success)
	}
	return Result.succeed({ values, attachments })
}

/**
 * A mixed root's public rows, each read strictly as a row of the heading group whose columns are exactly its keys, per
 * group: a row whose keys are no group's is a difference.
 */
export const mixedRows = (
	root: MixedRoot,
	rows: ReadonlyArray<unknown>
): Result.Result<ReadonlyArray<ReadonlyArray<Nested>>, string> => {
	const shapes = mixedShapes(root)
	const out: Array<Array<Nested>> = Arr.map(shapes, () => [])
	/** Each heading group's shape with the rows read as its, in out's order. */
	const groups = Arr.zip(shapes, out)
	for (const row of rows) {
		if (!isRecord(row)) {
			return Result.fail(`a row that is no record: ${String(row)}`)
		}
		const keys = Record.keys(row)
		const found = Arr.findFirst(
			groups,
			([s]) =>
				s.columns.length === keys.length && Arr.every(s.columns, (c) => Record.has(row, c.name))
		)
		if (Option.isNone(found)) {
			return Result.fail(`a row with keys ${Arr.join(keys, ", ")}, of no heading group`)
		}
		const [shape, group] = found.value
		const n = fromPublic(shape, row)
		if (Result.isFailure(n)) {
			return Result.fail(n.failure)
		}
		group.push(n.success)
	}
	return Result.succeed(out)
}

/** Public rows of `shape`, read strictly. */
export const publicRows = (shape: Shape, rows: ReadonlyArray<unknown>): Answer => {
	const out: Array<Nested> = []
	for (const row of rows) {
		const n = fromPublic(shape, row)
		if (Result.isFailure(n)) {
			return Result.fail(n.failure)
		}
		out.push(n.success)
	}
	return Result.succeed(out)
}
