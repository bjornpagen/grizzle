import { Array as Arr, Effect, Formatter, Option, pipe, Result, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { describeOp } from "#compiler/ir/expr.ts"
import { baseOf, type Carrier, type ScalarType } from "#compiler/ir/scalar.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { catalogTypeName } from "#compiler/scalar/compute/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert } from "#test/support/assert.ts"
import { strictRead } from "#test/support/kernel/strict.ts"
import { type CatalogResult, declinedOps } from "#test/support/oracle/evaluate/catalog.ts"
import type { RawQueryResult, SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A text cell of a row: every column the tests' catalog queries read is cast to text. */
export const textCell = (row: ReadonlyArray<unknown>, i: number): string => {
	const v = row[i]
	assert.ok(typeof v === "string", `column ${i} is text`)
	return v
}

/** The concrete PostgreSQL type of a carrier, as a cast or pg_typeof names it. */
export const concreteTypeName: { readonly [C in Carrier]: string } = {
	...catalogTypeName,
	enum: "enum",
	range4: "int4range",
	range8: "int8range"
}

/**
 * Shared PostgreSQL helpers for test/pg/compute: an evaluation function that runs a scalar expression and reports its
 * text and pg_typeof, or its SQLSTATE, so thousands of expressions run in one round trip without aborting on the
 * first error; and the comparison of the oracle's evaluation with PostgreSQL's answer, three ways: checked by value,
 * declined by the oracle by design (a node it leaves to PostgreSQL, oracle/evaluate/catalog.ts declinedOps), and
 * checked by type alone. No admitted expression raises (scalar/compute/registry.ts Totality), so every PostgreSQL error
 * is a mismatch, and so is a host evaluation that meets an operation where its precondition fails.
 */
export const installEvaluator = (
	db: RawSession,
	schema: string
): Effect.Effect<RawQueryResult, SqlError> =>
	db.query(
		`CREATE FUNCTION "${schema}".try_eval(v text, t text) RETURNS text LANGUAGE plpgsql AS $body$
DECLARE r text; ty text;
BEGIN
	EXECUTE 'SELECT (' || v || ')::text' INTO r;
	EXECUTE 'SELECT pg_typeof(' || t || ')::text' INTO ty;
	RETURN format('V:%L|%s', r, ty);
EXCEPTION WHEN OTHERS THEN
	RETURN 'E:' || SQLSTATE;
END $body$`,
		[]
	)

export type PgAnswer =
	| { readonly kind: "value"; readonly text: string; readonly type: string }
	| { readonly kind: "null"; readonly type: string }
	| { readonly kind: "error"; readonly sqlstate: string }

export const parseAnswer = (raw: string): PgAnswer => {
	if (Str.startsWith("E:")(raw)) {
		return { kind: "error", sqlstate: Str.slice(2)(raw) }
	}
	const bar = Option.getOrThrowWith(
		Str.lastIndexOf("|")(raw),
		() => new Error(`no type in the answer ${raw}`)
	)
	const value = Str.slice(2, bar)(raw)
	const type = Str.slice(bar + 1)(raw)
	if (value === "NULL") {
		return { kind: "null", type }
	}
	return { kind: "value", text: pipe(Str.slice(1, -1)(value), Str.replaceAll("''", "'")), type }
}

export interface EvalCase {
	readonly ord: number
	readonly label: string
	readonly sql: string
	readonly valueSql: string
	readonly type: ScalarType
	readonly host: CatalogResult
}

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
	Arr.map(indices(Math.ceil(items.length / size)), (i) => items.slice(i * size, (i + 1) * size))

/** The cases one try_eval round trip carries. */
export const caseChunk = 1500

/** Runs every case through try_eval, in chunks of `size` cases, and returns the answers in case order. */
export const runCases = (
	db: RawSession,
	schema: string,
	cases: ReadonlyArray<EvalCase>,
	size: number
): Effect.Effect<ReadonlyArray<PgAnswer>, SqlError> =>
	Effect.gen(function* () {
		const answers: Array<PgAnswer> = []
		for (const part of chunk(cases, size)) {
			const rows = yield* db.values(
				`SELECT c.ord::text, "${schema}".try_eval(c.v, c.t) FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text, t text) ORDER BY c.ord`,
				[jsonText(Arr.map(part, (c) => ({ ord: c.ord, v: c.valueSql, t: c.sql })))]
			)
			for (const row of rows) {
				answers.push(parseAnswer(String(row[1])))
			}
		}
		return answers
	})

/**
 * Whether PostgreSQL's text is the host value: integers and booleans by text, numeric and money by the value the strict
 * reader reads (the one form, whatever display scale PostgreSQL prints), floats by value with the one zero, the value
 * grizzle delivers (PostgreSQL's shortest text and JavaScript's differ in exponent spelling, and PostgreSQL prints -0).
 */
const sameValue = (value: CarrierValue, text: string, type: ScalarType): boolean => {
	const c = baseOf(type).carrier
	switch (c) {
		case "int2":
		case "int4":
		case "int8":
			return typeof value === "bigint" && value.toString() === text
		case "exactInteger": {
			const read = strictRead(type, text)
			return typeof value === "bigint" && Result.isSuccess(read) && read.success === value
		}
		case "numeric": {
			const read = strictRead(type, text)
			return (
				value instanceof Decimal &&
				Result.isSuccess(read) &&
				read.success instanceof Decimal &&
				read.success.equals(value)
			)
		}
		case "float4":
		case "float8": {
			/** A real prints as the shortest text that reads back as the binary32 value, so it is read back as one. */
			const pgValue = canonicalZero(c === "float4" ? Math.fround(Number(text)) : Number(text))
			return (
				typeof value === "number" &&
				(Object.is(pgValue, value) || (Number.isNaN(pgValue) && Number.isNaN(value)))
			)
		}
		case "money":
		case "exactMoney": {
			const read = strictRead(type, text)
			return (
				value instanceof Money &&
				Result.isSuccess(read) &&
				read.success instanceof Money &&
				read.success.minorUnits === value.minorUnits
			)
		}
		case "bool":
			return typeof value === "boolean" && String(value) === text
		case "enum":
		case "range4":
		case "range8":
		case "text":
		case "uuid":
		case "vector":
			return typeof value === "string" && value === text
	}
}

/** A carrier value as a report names it: a span or a vector by Formatter, any other value by its own text. */
export const carrierText = (value: CarrierValue): string =>
	typeof value === "object" && !(value instanceof Decimal) && !(value instanceof Money)
		? Formatter.format(value)
		: String(value)

export interface Mismatch {
	readonly label: string
	readonly sql: string
	readonly host: string
	readonly pg: PgAnswer
}

const describeHost = (host: CatalogResult): string => {
	if (host._tag === "Success") {
		return `value ${carrierText(host.success)}`
	}
	switch (host.failure.kind) {
		case "undefined":
			return `undefined (${host.failure.what})`
		case "unsupported":
			return `unsupported (${host.failure.what})`
		case "declined":
			return `declined ${describeOp(host.failure.op)} (${host.failure.what})`
	}
}

export interface Comparison {
	readonly mismatches: ReadonlyArray<Mismatch>
	readonly values: number
	/** The cases the host declined by design, whose answer PostgreSQL alone computed. */
	readonly declined: number
	readonly typedOnly: number
	readonly typedOnlyLabels: ReadonlySet<string>
	/** Whether each case, in order, agreed on a value. */
	readonly agreed: ReadonlyArray<boolean>
}

/**
 * Compares host evaluations with PostgreSQL's answers: equal values and pg_typeof the host's result type. A
 * PostgreSQL error or NULL is a mismatch, and so is a host evaluation that meets an operation outside its
 * precondition. A host decline by design (its declined stop for a node in declinedOps) checks the type, and is counted
 * as declined; a host "unsupported" checks the same, and is counted as typed-only.
 */
export const compareAnswers = (
	cases: ReadonlyArray<EvalCase>,
	answers: ReadonlyArray<PgAnswer>
): Comparison => {
	const mismatches: Array<Mismatch> = []
	const agreed: Array<boolean> = []
	let values = 0
	let declined = 0
	let typedOnly = 0
	const typedOnlyLabels = new Set<string>()
	for (const [i, c] of cases.entries()) {
		const pg = answers[i]
		if (pg === undefined) {
			throw new Error(`no answer for case ${i}`)
		}
		const v = verdict(c, pg)
		agreed.push(v === "value")
		switch (v) {
			case "bad":
				mismatches.push({ label: c.label, sql: c.sql, host: describeHost(c.host), pg })
				break
			case "declined":
				declined++
				break
			case "typed":
				typedOnly++
				typedOnlyLabels.add(c.label)
				break
			case "value":
				values++
				break
		}
	}
	return { mismatches, values, declined, typedOnly, typedOnlyLabels, agreed }
}

/**
 * The name pg_typeof gives a result of `type`: its carrier's, an exact integer's bigint while its digit bound is at
 * most 18 digits and numeric past it (ir/physical.ts).
 */
const typeName = (type: ScalarType): string => {
	const b = baseOf(type)
	return b.carrier === "exactInteger"
		? b.digits <= 18
			? "bigint"
			: "numeric"
		: concreteTypeName[b.carrier]
}

/**
 * The verdict on one case: agreement on a value, a decline by design, a typed-only agreement, or a mismatch. A
 * declined stop for a node outside declinedOps is a mismatch: the host declines only what the oracle leaves to
 * PostgreSQL.
 */
const verdict = (c: EvalCase, pg: PgAnswer): "value" | "declined" | "typed" | "bad" => {
	if (pg.kind !== "value" || pg.type !== typeName(c.type)) {
		return "bad"
	}
	if (c.host._tag === "Success") {
		return sameValue(c.host.success, pg.text, c.type) ? "value" : "bad"
	}
	switch (c.host.failure.kind) {
		case "declined":
			return declinedOps.has(c.host.failure.op) ? "declined" : "bad"
		case "unsupported":
			return "typed"
		case "undefined":
			return "bad"
	}
}
