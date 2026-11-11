/**
 * A fact guard over a contract on PostgreSQL 19: Compute.nonzero, Compute.nonnegative, Compute.positive and
 * Compute.isFinite over a term of a contract drawn over a numeric of every typmod, its precision and its scale both
 * drawn, and over the integers, the contract's predicate one that keeps zero out, one that lets it in, or none, in each
 * position a guard stands: a query's predicate over a column, Compute.when's guard over a column, and Compute.when's
 * guard over a parameter.
 *
 * The oracle: compilation admits the guard exactly where the types do (the compute population's verdict,
 * test/support/agreement/compute.ts: isFinite over numeric, the others over every number), whatever constant the
 * contract's domain holds; and over a batch of the domain's own values, NaN among them where the domain admits it,
 * PostgreSQL's answer to the SQL compiled for the case, its subject a value of the domain, is the host evaluator's,
 * value by value: a NaN that isFinite keeps out included, since a typmod keeps out an infinity but never NaN.
 *
 * Planted bug: the guard's constant adopts the subject's contract (lower.ts guardPredicate's compareTo over
 * subject.nominal), so Compute.when over isFinite of a contract of a typmod'd numeric is refused for an infinity its
 * domain cannot hold, and over nonzero of one that keeps zero out is ContractLiteral.
 *
 * Plants: compute-fact-guard-adopts-contract (the planted bug above, as a patch).
 *
 * Features: each guard in each position over each contract predicate's relation to zero.
 */
import { layer } from "@effect/vitest"
import { type Case as Search, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { int2Max, int2Min, int4Max, int4Min, int8Max, int8Min } from "#compiler/core/limits.ts"
import { numericMaxPrecision, numericMaxScale, numericMinScale } from "#compiler/ir/carriers.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { contractOf } from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { compareAnswers, type EvalCase, type PgAnswer } from "#test/pg/compute/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LoweredTable,
	lowerWith,
	param,
	plainRender,
	renderSql,
	spelledExpr,
	type TestField,
	testContract,
	testPg,
	v
} from "#test/unit/compute/support.ts"

type GuardName = "nonzero" | "nonnegative" | "positive" | "isFinite"

type Position =
	| "a query's predicate"
	| "when's guard over a column"
	| "when's guard over a parameter"

/** What a contract's predicate keeps of its base: every value, or the ones a comparison with zero holds of. */
type Keeps = "every value" | "ne" | "gt" | "ge" | "lt" | "le"

/** A contract's base: a numeric of a drawn typmod, or an integer type. */
type Base =
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "integer"; readonly sql: "smallint" | "integer" | "bigint" }

/** A drawn value of a base: an exact one, units · 10^exponent, or NaN. */
type Value =
	| { readonly kind: "exact"; readonly units: bigint; readonly exponent: number }
	| { readonly kind: "nan" }

interface Case {
	readonly base: Base
	readonly keeps: Keeps
	readonly guard: GuardName
	readonly position: Position
	readonly values: ReadonlyArray<Value>
}

type Feature =
	| Position
	| "a guard whose constant the domain keeps out"
	| "a NaN tested"
	| "refused where the types refuse"

/** The integer types' ranges. */
const integerRanges = {
	smallint: [BigInt(int2Min.value), BigInt(int2Max.value)],
	integer: [BigInt(int4Min.value), BigInt(int4Max.value)],
	bigint: [int8Min.value, int8Max.value]
} as const

/** A numeric typmod: mostly a small precision and a scale within it, sometimes either anywhere PostgreSQL allows. */
const numericBase: Gen<Base> = (source) => {
	const precision = source.draw(oneOf([int(1, 12), int(1, numericMaxPrecision.value)]))
	const scale = source.draw(
		oneOf([int(0, Math.min(precision, 12)), int(numericMinScale.value, numericMaxScale.value)])
	)
	return { kind: "numeric", precision, scale }
}

const baseGen: Gen<Base> = weighted([
	[3, numericBase],
	[
		1,
		(source) => ({
			kind: "integer",
			sql: source.draw(element(["smallint", "integer", "bigint"] as const))
		})
	]
])

/** A value of a base: zero, a small or a widest one of either sign, or, over numeric, NaN. */
const valueGen =
	(base: Base): Gen<Value> =>
	(source) => {
		if (base.kind === "integer") {
			const [lo, hi] = integerRanges[base.sql]
			return {
				kind: "exact",
				units: source.draw(oneOf([bigint(-3n, 3n), bigint(lo, hi)])),
				exponent: 0
			}
		}
		const widest = 10n ** BigInt(base.precision) - 1n
		return source.draw(
			weighted<Value>([
				[1, () => ({ kind: "nan" })],
				[
					4,
					(inner) => ({
						kind: "exact",
						units: inner.draw(oneOf([bigint(-3n, 3n), bigint(-widest, widest)])),
						exponent: -base.scale
					})
				]
			])
		)
	}

/** Whether a contract's predicate holds of a value, as PostgreSQL orders NaN, above every number. */
const kept = (keeps: Keeps, value: Value): boolean => {
	if (value.kind === "nan") {
		return keeps === "every value" || keeps === "ne" || keeps === "gt" || keeps === "ge"
	}
	const sign = value.units < 0n ? -1 : value.units > 0n ? 1 : 0
	switch (keeps) {
		case "every value":
			return true
		case "ne":
			return sign !== 0
		case "gt":
			return sign > 0
		case "ge":
			return sign >= 0
		case "lt":
			return sign < 0
		case "le":
			return sign <= 0
	}
}

const caseGen: Gen<Case> = (source) => {
	const base = source.draw(baseGen)
	const keeps = source.draw(element(["every value", "ne", "gt", "ge", "lt", "le"] as const))
	const values = Arr.filter(source.draw(array(valueGen(base), { min: 1, max: 8 })), (x) =>
		kept(keeps, x)
	)
	return {
		base,
		keeps,
		guard: source.draw(element(["nonzero", "nonnegative", "positive", "isFinite"] as const)),
		position: source.draw(
			element([
				"a query's predicate",
				"when's guard over a column",
				"when's guard over a parameter"
			] as const)
		),
		values
	}
}

/**
 * The case a witness runs, aimed at a refusal while no witness has reached one (Case.steering): half its cases, by a
 * draw of their own, isFinite over a contract of an integer, which the types refuse; a rotating case runs as drawn.
 */
const aimed = (c: Case, k: Search<Feature>): Case =>
	Option.exists(k.steering, (pending) => pending.has("refused where the types refuse")) &&
	k.draw(boolean)
		? {
				...c,
				base: { kind: "integer", sql: k.draw(element(["smallint", "integer", "bigint"] as const)) },
				guard: "isFinite",
				values: []
			}
		: c

/** A base's test field. */
const baseField = (base: Base): TestField => {
	if (base.kind === "numeric") {
		return testPg.numericOf(base.precision, base.scale)
	}
	switch (base.sql) {
		case "smallint":
			return testPg.smallint
		case "integer":
			return testPg.integer
		case "bigint":
			return testPg.bigint
	}
}

/** A base's SQL type. */
const baseSql = (base: Base): string =>
	base.kind === "numeric" ? `numeric(${base.precision}, ${base.scale})` : base.sql

/** Zero as a literal of a base: a JavaScript integer for smallint and integer, a bigint otherwise. */
const zeroOf = (base: Base): LiteralDesc =>
	base.kind === "integer" && base.sql !== "bigint" ? 0 : 0n

/** The contract a case draws, over its base, its predicate the case's comparison with zero. */
const contractOver = (base: Base, keeps: Keeps): TestField => {
	const zero = zeroOf(base)
	const field = baseField(base)
	switch (keeps) {
		case "every value":
			return testContract("Guarded", field, undefined)
		case "ne":
			return testContract("Guarded", field, (x) => x.ne(zero))
		case "gt":
			return testContract("Guarded", field, (x) => x.gt(zero))
		case "ge":
			return testContract("Guarded", field, (x) => x.ge(zero))
		case "lt":
			return testContract("Guarded", field, (x) => x.lt(zero))
		case "le":
			return testContract("Guarded", field, (x) => x.le(zero))
	}
}

/** The guard of a case over its subject. */
const guardOver = (guard: GuardName, x: ScalarTerm): { readonly expr: OpenExpr } => {
	switch (guard) {
		case "nonzero":
			return Compute.nonzero(x)
		case "nonnegative":
			return Compute.nonnegative(x)
		case "positive":
			return Compute.positive(x)
		case "isFinite":
			return Compute.isFinite(x)
	}
}

/**
 * Compute.when over a case's guard, its branch the operation that needs what the guard proves of the subject's
 * value: a quotient by it for nonzero and positive, a square root for nonnegative, its least scale for isFinite.
 */
const whenOver = (guard: GuardName, base: Base, x: ScalarTerm): { readonly expr: OpenExpr } => {
	switch (guard) {
		case "nonzero":
		case "positive":
			return Compute.when(guardOver(guard, x), (y: ScalarTerm) => Compute.div(y, y), 0n)
		case "nonnegative":
			return Compute.when(
				guardOver(guard, x),
				(y: ScalarTerm) =>
					Compute.sqrt(base.kind === "numeric" ? Compute.base(y) : Compute.numeric(y)),
				0n
			)
		case "isFinite":
			return Compute.when(guardOver(guard, x), (y: ScalarTerm) => Compute.minScale(y), 0)
	}
}

/** What a builder threw where it refused its operands. */
class BuilderThrew extends Data.TaggedError("BuilderThrew")<{ readonly cause: unknown }> {}

/**
 * A case's guard compiled as a query compiles it, over a column or a parameter of its contract: a builder's refusal,
 * thrown where the call is written, or the lowering's.
 */
const compiled = (
	c: Case,
	field: TestField
): Effect.Effect<LoweredTable, BuilderThrew | CompileError> => {
	const subject = c.position === "when's guard over a parameter" ? param("p", field) : v("x", field)
	return Effect.flatMap(
		Effect.try({
			try: () =>
				spelledExpr(
					(c.position === "a query's predicate"
						? guardOver(c.guard, subject)
						: whenOver(c.guard, c.base, subject)
					).expr
				),
			catch: (cause) => new BuilderThrew({ cause })
		}),
		(expr) => {
			const lowered = lowerWith(
				"query",
				expr,
				{ x: { kind: "column", type: field.scalar } },
				c.position === "a query's predicate",
				baseParams
			)
			return lowered.ok ? Effect.succeed(lowered.value) : Effect.fail(lowered.error)
		}
	)
}

/** Where the types admit a guard: isFinite over numeric (InexactSql), the others over every number (NumericSql). */
const typesAdmit = (c: Case): boolean => c.guard !== "isFinite" || c.base.kind === "numeric"

/** Whether the guard's constant is no value of the case's domain: an infinity of a typmod's, or a zero it keeps out. */
const constantKeptOut = (c: Case): boolean =>
	c.guard === "isFinite"
		? c.base.kind === "numeric"
		: !kept(c.keeps, { kind: "exact", units: 0n, exponent: 0 })

/** A value's text, as PostgreSQL's numeric and integer input functions read it. */
const valueText = (value: Value): string =>
	value.kind === "nan"
		? "NaN"
		: value.exponent === 0
			? String(value.units)
			: `${value.units}e${value.exponent}`

/** A value as the host evaluator carries a base's value: a Decimal over numeric, a bigint over the integers. */
const carried = (base: Base, value: Value): CarrierValue =>
	base.kind === "numeric" ? Decimal.of(valueText(value)) : value.kind === "exact" ? value.units : 0n

layer(Substrate.layer)("a fact guard over a contract on PostgreSQL 19", (it) => {
	it.effect(
		"is admitted wherever the types admit it, and tests every value of the domain as the host does",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session, schema } = yield* Substrate
					const db = yield* session(ownerSession())
					const s = yield* schema(freshSchema)
					let statement = 0
					return yield* explore(
						{
							suite: "pg/compute/fact-guards",
							oracle: {
								kind: "second-implementation",
								name: "the types' verdict and the reference evaluator"
							},
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"a query's predicate",
									"when's guard over a column",
									"when's guard over a parameter",
									"a guard whose constant the domain keeps out",
									"a NaN tested",
									"refused where the types refuse"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnCase, k) =>
							Effect.gen(function* () {
								const c = aimed(drawnCase, k)
								const field = contractOver(c.base, c.keeps)
								const lowered = yield* Effect.result(compiled(c, field))
								if (!typesAdmit(c)) {
									const refusal = Result.isFailure(lowered)
										? lowered.failure instanceof BuilderThrew
											? lowered.failure.cause
											: lowered.failure
										: undefined
									assert.ok(
										refusal instanceof CompileError &&
											refusal.reason._tag === "MalformedDescription",
										"compilation refuses what the types refuse, as a malformed description"
									)
									k.note("refused where the types refuse")
									return
								}
								assert.ok(
									Result.isSuccess(lowered),
									`the guard is admitted: ${Formatter.format(lowered)}`
								)
								const root = lowered.success.root
								k.note(c.position)
								if (constantKeptOut(c)) {
									k.note("a guard whose constant the domain keeps out")
								}
								statement += 1
								const domain = `"${s}"."guarded_${statement}"`
								const predicate = contractOf(field.scalar)?.predicate
								yield* db.query(
									predicate === undefined
										? `CREATE DOMAIN ${domain} AS ${baseSql(c.base)}`
										: `CREATE DOMAIN ${domain} AS ${baseSql(c.base)} CHECK ((${renderSql(succeeded(predicateTree(predicate)), plainRender)}) IS TRUE)`,
									[]
								)
								const sql = renderSql(root.expr, plainRender)
								const name = `fact_guard_${statement}`
								yield* db.query(
									c.position === "when's guard over a parameter"
										? `PREPARE ${name}(${domain}) AS SELECT (${sql})::text, pg_typeof(${sql})::text`
										: `PREPARE ${name}(${domain}) AS SELECT (${sql})::text, pg_typeof(${sql})::text FROM (SELECT $1 AS x) AS r0`,
									[]
								)
								const answers: Array<PgAnswer> = []
								for (const value of c.values) {
									if (value.kind === "nan") {
										k.note("a NaN tested")
									}
									const ran = yield* Effect.result(
										db.values(`EXECUTE ${name}('${valueText(value)}')`, [])
									)
									if (Result.isFailure(ran)) {
										const reason = ran.failure.reason
										answers.push({
											kind: "error",
											sqlstate: reason._tag === "ServerError" ? reason.fields.code : reason._tag
										})
										continue
									}
									const [text, type] = ran.success[0] ?? []
									answers.push(
										typeof text === "string" && typeof type === "string"
											? { kind: "value", text, type }
											: { kind: "null", type: String(type) }
									)
								}
								yield* db.query(`DEALLOCATE ${name}`, [])
								const cases: ReadonlyArray<EvalCase> = Arr.map(c.values, (value, ord) => {
									const host = carried(c.base, value)
									return {
										ord,
										label: `${c.guard} over ${valueText(value)}`,
										sql,
										valueSql: valueText(value),
										type: root.actual,
										host: evaluate(root.expr, {
											kind: "row",
											column: () => host,
											param: () => host,
											regexMember: patternMember
										})
									}
								})
								assert.deepEqual(compareAnswers(cases, answers).mismatches, [])
							})
					)
				})
			)
	)
})
