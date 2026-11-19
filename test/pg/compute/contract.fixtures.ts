import { assert, nonEmpty } from "@bjornpagen/testing/assert"
/** What the properties of contract.test.ts read: its contracts, their values and each contract's property. */
import type { Reached } from "@bjornpagen/testing/features"
import {
	array,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	type Steered,
	steered,
	weighted
} from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint, double } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Formatter, Option, pipe, String as Str } from "effect"
import type { CompileReason } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import { type Carrier, numericTypmodOf } from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	carrierText,
	installEvaluator,
	type PgAnswer,
	parseAnswer
} from "#test/pg/compute/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { type CatalogResult, constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	adoptedLiteral,
	baseParams,
	testContract,
	lowerWith,
	testPg,
	plainRender,
	renderSql,
	spelledExpr,
	type TestField,
	v
} from "#test/unit/compute/support.ts"
import { numericText } from "#test/unit/values/support.ts"

/**
 * One contract under test: its field, its base, the edge values its predicate turns on, a dictionary its batches draw
 * from beside the generated values, and the generated values, a case drawing a batch of up to `batch`.
 */
interface Fixture {
	readonly name: string
	readonly field: TestField
	readonly base: TestField
	readonly edges: ReadonlyArray<LiteralDesc>
	readonly values: Gen<LiteralDesc>
	readonly batch: number
}

/**
 * Compilation's verdict on a literal's domain cast: refused before any SQL, with the SQLSTATE of the PostgreSQL refusal
 * its reason is (refusalState), or admitted, with the host evaluator's result.
 */
type Verdict =
	| { readonly kind: "refused"; readonly state: string | undefined; readonly why: string }
	| { readonly kind: "admitted"; readonly host: CatalogResult }

/**
 * The SQLSTATE of PostgreSQL's refusal of a domain cast that a compilation refusal of the literal's cast is, or none: a
 * literal the contract's predicate refuses (ContractLiteral) is the domain's check violation, 23514, and one its base's
 * typmod cannot hold, which nothing proves fits it (PartialOperation of `fits`), numeric's field overflow, 22003.
 */
const refusalState = (reason: CompileReason): string | undefined =>
	reason._tag === "ContractLiteral"
		? "23514"
		: reason._tag === "PartialOperation" && reason.precondition === "fits"
			? "22003"
			: undefined

/**
 * A value the sides disagree on: its domain cast, PostgreSQL's answer, compilation's verdict, and whether the
 * ContractLiteral check admits the value as a literal of the contract.
 */
interface Problem {
	readonly sql: string
	readonly answer: PgAnswer
	readonly verdict: string
	readonly admitted: boolean
}

/** What a case of a contract's search reached: a value the domain admits, and one it refuses. */
type DomainFeature = "admitted" | "refused"

/**
 * The cases of each contract's search: the rotating 2 batches of up to `batch` values and the floor's 1, about the
 * generated sample each contract sent before the search.
 */
export const domainRuns = 2

const int8Edges = Object.freeze([
	-(2n ** 63n),
	2n ** 63n - 1n,
	-1n,
	0n,
	1n,
	9999n,
	10000n,
	10001n,
	49n,
	50n,
	51n,
	52n,
	48n
])

const bigints: Gen<bigint> = oneOf([bigint(-20000n, 20000n), bigint(-(2n ** 63n), 2n ** 63n - 1n)])

export const fixtures = (): ReadonlyArray<Fixture> => {
	const Cents = testContract("Cents", testPg.bigint, (x) => Compute.ge(x, 0n))
	/** Arithmetic at the int8 limits: exact once cast to numeric, so nothing overflows. */
	const Shares = testContract("Shares", testPg.bigint, (x) =>
		Compute.and(
			Compute.le(Compute.div(Compute.mul(x, 3n), 7n), 4000n),
			Compute.ne(Compute.mod(x, 5n), 1n),
			Compute.ge(Compute.abs(Compute.sub(x, 50n)), 2n),
			Compute.or(Compute.eq(Compute.sign(x), 1n), Compute.lt(Compute.add(x, x), -100n))
		)
	)
	const Basis = testContract("Basis", testPg.integer, (x) =>
		Compute.or(Compute.between(x, 0, 10000), Compute.in(x, [-5, -7]))
	)
	const Rate = testContract("Rate", testPg.numericOf(7, 6), (x) => Compute.between(x, 0n, 1n))
	/** Integer division truncates toward zero once widened: div(x, 2) = 3 admits 6 and 7, and -6 and -7 over -2. */
	const Halves = testContract("Halves", testPg.bigint, (x) =>
		Compute.or(Compute.eq(Compute.div(x, 2n), 3n), Compute.eq(Compute.div(x, -2n), 3n))
	)
	/** A typmod bounds the operand's integer digits, so this arithmetic can never pass numeric's limit. */
	const Grade = testContract("Grade", testPg.numericOf(40, 10), (x) =>
		Compute.and(Compute.gt(Compute.mul(x, "2.5"), "-10"), Compute.le(Compute.div(x, "0.3"), 100n))
	)
	/** A lower bound alone admits NaN and +Infinity; a finite upper bound excludes both. */
	const NonNegative = testContract("NonNegative", testPg.double, (x) => Compute.ge(x, 0))
	const Unit = testContract("Unit", testPg.double, (x) =>
		Compute.and(Compute.between(x, 0, 1), Compute.ne(Compute.abs(x), 0.5))
	)
	const Short = testContract("Short", testPg.text, (x) => Compute.le(Compute.charLength(x), 3))
	/**
	 * Effect Schema's isMaxLength(3) and isMinLength(3) over a string, which count UTF-16 code units: utf16Length under
	 * the guard of the text's bytes that README states, three bytes a unit, so a text past 9 bytes is past 3 units and
	 * one of at least 9 bytes holds at least 3, and the regex reads only a bounded text.
	 */
	const Units = testContract("Units", testPg.text, (x) =>
		Compute.le(
			Compute.when(Compute.within(Compute.octetLength(x), 0, 9), () => Compute.utf16Length(x), 4),
			3
		)
	)
	const ThreeUnits = testContract("ThreeUnits", testPg.text, (x) =>
		Compute.ge(
			Compute.when(Compute.within(Compute.octetLength(x), 0, 8), () => Compute.utf16Length(x), 3),
			3
		)
	)
	const numericEdges = Arr.map(
		[
			"NaN",
			"0.0000005",
			"0.0000004",
			"1.0000004",
			"1.0000005",
			"-0.0000005",
			"40",
			"-4",
			"30.0000001"
		],
		(t) => Decimal.of(t)
	)
	const numerics: Gen<LiteralDesc> = map(numericText, (t) => Decimal.of(t))
	const doubleEdges: ReadonlyArray<LiteralDesc> = [
		0,
		0.5,
		-0.5,
		1,
		{ float: "NaN" },
		{ float: "Infinity" },
		{ float: "-Infinity" }
	]
	const doubles: Gen<LiteralDesc> = map(
		oneOf([double(-Number.MAX_VALUE, Number.MAX_VALUE), double(-2, 2)]),
		(x) => (x === 0 ? 0 : x)
	)
	const textEdges = ["", "abc", "abcd", "😀😀😀", "😀😀😀😀", "é"]
	/**
	 * The texts three UTF-16 units turns on: two and three and four units of one, two and three bytes each, an emoji
	 * that is two units, and three code points of nine bytes past U+FFFF's edge, U+FFFF itself.
	 */
	const unitEdges = [
		"",
		"ab",
		"abc",
		"abcd",
		"😀",
		"😀a",
		"a😀",
		"😀😀",
		"ééé",
		"éééé",
		"\uffff\uffff",
		"\uffff\uffff\uffff",
		"\uffff\uffff\uffffa",
		"\u{10000}\u{10ffff}"
	]
	/**
	 * Texts of up to five characters, each well-formed and never NUL: printable ASCII, the rest of the BMP outside the
	 * surrogates, and the supplementary planes, where a character is two UTF-16 units but one code point.
	 */
	const texts: Gen<LiteralDesc> = string(
		weighted([
			[3, codePoint(0x20, 0x7e)],
			[2, codePoint(0xa0, 0xd7ff)],
			[1, codePoint(0xe000, 0xfffd)],
			[2, codePoint(0x1_00_00, 0x10_ff_ff)]
		]),
		{ min: 0, max: 5 }
	)
	const int4s: Gen<LiteralDesc> = oneOf([int(-20000, 20000), int(-2147483648, 2147483647)])
	return [
		{
			name: "cents",
			field: Cents,
			base: testPg.bigint,
			edges: int8Edges,
			values: bigints,
			batch: 400
		},
		{
			name: "shares",
			field: Shares,
			base: testPg.bigint,
			edges: int8Edges,
			values: bigints,
			batch: 400
		},
		{
			name: "halves",
			field: Halves,
			base: testPg.bigint,
			edges: [...int8Edges, 5n, 6n, 7n, 8n, -5n, -6n, -7n, -8n],
			values: bigints,
			batch: 400
		},
		{
			name: "basis",
			field: Basis,
			base: testPg.integer,
			edges: [
				...Arr.map(
					Arr.filter(int8Edges, (x) => x >= -2147483648n && x <= 2147483647n),
					Number
				),
				-5,
				-7,
				-6
			],
			values: int4s,
			batch: 400
		},
		{
			name: "rate",
			field: Rate,
			base: testPg.numeric,
			edges: numericEdges,
			values: numerics,
			batch: 300
		},
		{
			name: "grade",
			field: Grade,
			base: testPg.numeric,
			edges: numericEdges,
			values: numerics,
			batch: 300
		},
		{
			name: "nonnegative",
			field: NonNegative,
			base: testPg.double,
			edges: doubleEdges,
			values: doubles,
			batch: 300
		},
		{
			name: "unit",
			field: Unit,
			base: testPg.double,
			edges: doubleEdges,
			values: doubles,
			batch: 300
		},
		{ name: "short", field: Short, base: testPg.text, edges: textEdges, values: texts, batch: 200 },
		{ name: "units", field: Units, base: testPg.text, edges: unitEdges, values: texts, batch: 200 },
		{
			name: "three-units",
			field: ThreeUnits,
			base: testPg.text,
			edges: unitEdges,
			values: texts,
			batch: 200
		}
	]
}

/**
 * The values a case checks, as the generator draws them: a drawn batch of the contract's values, its edges weighted
 * among them, or, while a value the domain admits or one it refuses is pending (Steered), every edge of the contract and
 * then the drawn batch, so a contract that admits few values (halves admits four of all the int8 values) meets one; the
 * drawn batch is checked whole either way. A rotating case is drawn unaimed.
 */
const batchGen = (f: Fixture): Steered<ReadonlyArray<LiteralDesc>, DomainFeature> =>
	steered((steering) => (source) => {
		const drawnBatch = source.draw(
			array(
				weighted<LiteralDesc>([
					[1, element(nonEmpty(f.edges, "a contract's edges"))],
					[8, f.values]
				]),
				{ min: 1, max: f.batch }
			)
		)
		return Option.exists(
			steering,
			(pending) => pending.names("admitted") || pending.names("refused")
		)
			? [...f.edges, ...drawnBatch]
			: drawnBatch
	})

/** A schema with the evaluator installed: the session a contract's domain checks run on. */
export const evaluatorSchema = Effect.gen(function* () {
	const { session, schema } = yield* Substrate
	const db = yield* session(ownerSession())
	const s = yield* schema(freshSchema)
	yield* installEvaluator(db, s)
	return { db, s }
})

/**
 * One contract's property: each case's domain created as PostgreSQL's in a schema of its own on the worker's clone
 * (Substrate.installing), and a batch of the contract's values checked on both sides.
 *
 * Its pre-conversion budget: runs 2, coverage cases 2 (test/pg/compute/contract.test.ts at c568eb123), domainRuns.
 */
export const contractProperty = (f: Fixture) =>
	property.explore(batchGen(f), {
		needs: { substrate: Substrate.installing },
		situations: ["admitted", "refused"] satisfies ReadonlyArray<Reached<DomainFeature>>,
		check:
			({ substrate }, c: Case<DomainFeature>) =>
			(batch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const { db, s } = yield* evaluatorSchema
						const type = f.field.scalar
						const predicate = type.contract?.predicate
						if (predicate === undefined) {
							return yield* Effect.die(new Error(`${f.name}: no predicate table`))
						}
						const check = renderSql(succeeded(predicateTree(predicate)), plainRender)
						const collate = type.carrier === "text" ? " COLLATE pg_catalog.pg_c_utf8" : ""
						const typmod = numericTypmodOf(type)
						const baseTypes: { readonly [C in Carrier]?: string } = {
							int8: "bigint",
							int4: "integer",
							numeric:
								typmod === undefined ? "numeric" : `numeric(${typmod.precision}, ${typmod.scale})`,
							float8: "double precision",
							text: "text"
						}
						const baseType = baseTypes[type.carrier]
						yield* db.query(
							`CREATE DOMAIN "${s}"."${Str.toLowerCase(f.name)}" AS ${baseType}${collate} CONSTRAINT "${f.name}_check" CHECK ((${check}) IS TRUE)`,
							[]
						)
						/**
						 * The domain cast of each value from the base's value type, on both sides: PostgreSQL's CAST into the domain over
						 * the value's literal, and compilation's, which judges a literal cast into a contract before any SQL and, where it
						 * admits it, the host evaluator's. PostgreSQL admits a value exactly where compilation admits its cast, the host
						 * delivers a value and the literal adopts the contract; it refuses one exactly where compilation refuses the cast
						 * for the reason PostgreSQL's SQLSTATE names and the literal is no value of the contract.
						 */
						const cast = spelledExpr(Compute.cast(v("x", f.base), f.field).expr)
						const operand = spelledExpr(v("x", f.base).expr)
						const target = `"${s}"."${Str.toLowerCase(f.name)}"`
						const cases = Arr.map(batch, (value) => {
							const bindings = { x: { kind: "literal", field: f.base, value } } as const
							const lowered = lowerWith("query", cast, bindings, false, baseParams)
							const literal = succeeded(lowerWith("query", operand, bindings, false, baseParams))
							const verdict: Verdict = lowered.ok
								? { kind: "admitted", host: evaluate(lowered.value.root.expr, constantEnv) }
								: {
										kind: "refused",
										state: refusalState(lowered.error.reason),
										why: lowered.error.message
									}
							return {
								sql: `CAST((${renderSql(literal.root.expr, plainRender)}) AS ${target})`,
								verdict,
								admitted: adoptedLiteral(value, f.field.scalar).ok
							}
						})
						const rows = yield* db.values(
							`SELECT "${s}".try_eval(c.q, c.q) FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, q text) ORDER BY c.ord`,
							[jsonText(Arr.map(cases, (k, ord) => ({ ord, q: k.sql })))]
						)
						const problems = Arr.flatMap(cases, (k, i): ReadonlyArray<Problem> => {
							const answer = parseAnswer(String(rows[i]?.[0]))
							const { verdict } = k
							const problem: Problem = {
								sql: k.sql,
								answer,
								verdict:
									verdict.kind === "refused"
										? `refused at compilation: ${verdict.why}`
										: verdict.host._tag === "Success"
											? carrierText(verdict.host.success)
											: Formatter.format(verdict.host.failure),
								admitted: k.admitted
							}
							if (answer.kind === "error") {
								c.note("refused")
								return verdict.kind === "refused" &&
									verdict.state === answer.sqlstate &&
									!k.admitted
									? []
									: [problem]
							}
							c.note("admitted")
							return verdict.kind === "admitted" && verdict.host._tag === "Success" && k.admitted
								? []
								: [problem]
						})
						assert.deepEqual(problems, [])
					}),
					Substrate,
					substrate
				),
		oracle: { kind: "postgresql", name: "the domain cast of each value" },
		budget: { runs: domainRuns, steered: domainRuns },
		kept: [],
		kills: []
	})

/** The contract the rounding property casts into: a rate of numeric(7, 6) within [0, 1]. */
export const Rate = testContract("Rate", testPg.numericOf(7, 6), (x) => Compute.between(x, 0n, 1n))

/** Rate's rounding edges: values a half-unit of its scale either side of its bounds, and a few beyond its typmod. */
const roundingEdges = [
	"0.0000005",
	"0.0000004",
	"-0.0000004",
	"-0.0000005",
	"0.9999994",
	"0.9999995",
	"0.99999949",
	"1.0000004",
	"1.0000005",
	"1.00000049999",
	"0.0625",
	"1.5",
	"9.9999995",
	"10",
	"NaN"
] as const

/** A literal of eight fraction digits about Rate's bounds. */
const roundingLiteral: Gen<string> = (source) =>
	`${source.draw(int(-1, 1))}.${pipe(String(source.draw(int(0, 99999999))), Str.padStart(8, "0"))}`

/** A batch of literals cast into Rate: its edges weighted among the drawn ones. */
export const roundingBatch: Gen<ReadonlyArray<string>> = array(
	weighted<string>([
		[1, element(roundingEdges)],
		[8, roundingLiteral]
	]),
	{ min: 1, max: 300 }
)
