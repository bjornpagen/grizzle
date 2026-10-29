import { Array as Arr, Effect, Formatter, Option, pipe, String as Str } from "effect"
import { describeOp, exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import {
	castOf,
	concreteTypeName,
	type FailureCode,
	nativeOp
} from "#compiler/scalar/compute/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { jsonText } from "#test/support/json.ts"
import { type CatalogResult, declinedOps } from "#test/support/oracle/evaluate/catalog.ts"
import { indices } from "#test/support/oracle/pick.ts"
import type { RawQueryResult, SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A text cell of a row: every column the tests' catalog queries read is cast to text. */
export const textCell = (row: ReadonlyArray<unknown>, i: number): string => {
	const v = row[i]
	assert.ok(typeof v === "string", `column ${i} is text`)
	return v
}

/**
 * Shared PostgreSQL helpers for test/pg/compute: an evaluation function that runs a scalar expression and reports its
 * text and pg_typeof, or its SQLSTATE, so thousands of expressions run in one round trip without aborting on the
 * first error; and the comparison of the oracle's evaluation with PostgreSQL's answer, three ways: checked by value or
 * failure, declined by the oracle by design (a node it leaves to PostgreSQL, oracle/evaluate/catalog.ts declinedOps),
 * and checked by type alone.
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
	readonly allowed: ReadonlySet<FailureCode>
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

/** The failures an expression tree can raise: its native nodes' and casts' SQLSTATEs, and 23514 for a domain cast. */
export const allowedFailures = (root: ScalarExpr): ReadonlySet<FailureCode> => {
	const out = new Set<FailureCode>()
	for (const e of exprClosure([root])) {
		if (e.kind === "op") {
			for (const f of defined(nativeOp(e.op), `the native op ${describeOp(e.op)}`).failures) {
				out.add(f)
			}
		}
		if (e.kind === "cast" && e.checked) {
			const from = baseOf(e.args[0].type).carrier
			const to = baseOf(e.type).carrier
			for (const f of defined(castOf(from, to), `the cast ${from}->${to}`).failures) {
				out.add(f)
			}
		}
		if (e.kind === "domainCast") {
			out.add("23514")
		}
	}
	return out
}

/**
 * Whether PostgreSQL's text is the host value, exactly as PostgreSQL prints it: integers and booleans by text, numeric
 * with its display scale, floats by value (PostgreSQL's shortest text and JavaScript's differ in exponent spelling).
 */
const sameValue = (value: CarrierValue, text: string, type: ScalarType): boolean => {
	const c = baseOf(type).carrier
	switch (c) {
		case "int2":
		case "int4":
		case "int8":
			return typeof value === "bigint" && value.toString() === text
		case "numeric":
			return value instanceof Decimal && value.toString() === text
		case "float4":
		case "float8": {
			/** A real prints as the shortest text that reads back as the binary32 value, so it is read back as one. */
			const pgValue = c === "float4" ? Math.fround(Number(text)) : Number(text)
			return (
				typeof value === "number" &&
				(Object.is(pgValue, value) || (Number.isNaN(pgValue) && Number.isNaN(value)))
			)
		}
		case "money":
			return (
				value instanceof Money &&
				succeeded(
					Decimal.fromParts(
						value.minorUnits < 0n,
						value.minorUnits < 0n ? -value.minorUnits : value.minorUnits,
						2
					)
				).toString() === text
			)
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
		case "failure":
			return `failure ${host.failure.code}`
		case "unsupported":
			return `unsupported (${host.failure.what})`
		case "declined":
			return `declined ${describeOp(host.failure.op)} (${host.failure.what})`
	}
}

export interface Comparison {
	readonly mismatches: ReadonlyArray<Mismatch>
	readonly values: number
	/** The failures the host and PostgreSQL agreed on, by label and SQLSTATE. */
	readonly failures: ReadonlyMap<string, number>
	/**
	 * The failures PostgreSQL raised for a case the host declined by design, by label and SQLSTATE: each among the
	 * expression's listed failures.
	 */
	readonly declinedFailures: ReadonlyMap<string, number>
	/** The cases the host declined by design, whose answer PostgreSQL alone computed. */
	readonly declined: number
	readonly typedOnly: number
	readonly typedOnlyLabels: ReadonlySet<string>
}

const count = (into: Map<string, number>, key: string) => into.set(key, (into.get(key) ?? 0) + 1)

/**
 * Compares host evaluations with PostgreSQL's answers: equal values and pg_typeof the host's result type, equal
 * failure SQLSTATEs (NULL as the "null" failure), and every PostgreSQL error one the registry lists for the
 * expression. A host decline by design (its declined stop for a node in declinedOps) checks the type and the listed
 * failures, and is counted as declined; a host "unsupported" checks the same, and is counted as typed-only. A
 * PostgreSQL failure is counted as agreed when the host raised it too, and as declined when the host declined the case
 * by design.
 */
export const compareAnswers = (
	cases: ReadonlyArray<EvalCase>,
	answers: ReadonlyArray<PgAnswer>
): Comparison => {
	const mismatches: Array<Mismatch> = []
	const failures = new Map<string, number>()
	const declinedFailures = new Map<string, number>()
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
		if (pg.kind === "error" && v === "failure") {
			count(failures, `${c.label}:${pg.sqlstate}`)
		}
		if (pg.kind === "error" && v === "declined") {
			count(declinedFailures, `${c.label}:${pg.sqlstate}`)
		}
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
			case "failure":
				break
		}
	}
	return { mismatches, values, failures, declinedFailures, declined, typedOnly, typedOnlyLabels }
}

/**
 * The verdict on one case: agreement on a value or a failure, a decline by design, a typed-only agreement, or a
 * mismatch. A declined stop for a node outside declinedOps is a mismatch: the host declines only what the oracle leaves
 * to PostgreSQL.
 */
const verdict = (c: EvalCase, pg: PgAnswer): "value" | "failure" | "declined" | "typed" | "bad" => {
	const hostFails = (code: string) =>
		c.host._tag === "Failure" && c.host.failure.kind === "failure" && c.host.failure.code === code
	const stopped = (): "declined" | "typed" | "bad" => {
		if (c.host._tag === "Success") {
			return "bad"
		}
		switch (c.host.failure.kind) {
			case "declined":
				return declinedOps.has(c.host.failure.op) ? "declined" : "bad"
			case "unsupported":
				return "typed"
			case "failure":
				return "bad"
		}
	}
	if (pg.kind === "error") {
		const allowed: ReadonlySet<string> = c.allowed
		if (!allowed.has(pg.sqlstate)) {
			return "bad"
		}
		if (hostFails(pg.sqlstate)) {
			return "failure"
		}
		return stopped()
	}
	if (pg.type !== concreteTypeName[baseOf(c.type).carrier]) {
		return "bad"
	}
	if (pg.kind === "null") {
		return hostFails("null") ? "failure" : "bad"
	}
	if (c.host._tag === "Failure") {
		return stopped()
	}
	return sameValue(c.host.success, pg.text, c.type) ? "value" : "bad"
}
