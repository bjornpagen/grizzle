/**
 * The printed SQL on PostgreSQL 19 (packages/engine/src/sql): the text means what the AST says. Every statement this
 * file sends is one the audit accepts, the printer's output, never hand-edited.
 *
 * - Catalog reads: a catalog read of drawn arms is the set union of their rows, a row two arms share once.
 * - Relational: generated CROSS JOINs, IN and NOT IN over a subquery, and windows over drawn ROWS frames evaluate as
 *   the host computes them (test/pg/sql/evaluated.ts).
 * - Default privileges: a reset of PUBLIC's default privilege, in one schema and in the global form, of each kind
 *   PostgreSQL grants PUBLIC by default, leaves PUBLIC its privilege on a new function or type under the schema's form
 *   and takes it under the global one.
 * - Expressions: generated expressions of bigint, boolean and text evaluate as the host evaluates them, so the
 *   printer's parentheses are PostgreSQL's precedence.
 * - Set trees: generated set-operation trees, arms and whole levels parenthesized with their own ORDER BY and LIMIT,
 *   evaluate as SQL's set semantics say.
 * - Aggregates: generated aggregates keep their DISTINCT, their own ORDER BY and count(*)'s FILTER, group by group.
 * - RAISE: a generated RAISE, with any subset of its USING options, raises its SQLSTATE, message and DETAIL.
 * - Literals: every drawn typed literal arrives exactly: text of every plane, a text domain's, numerics as spelled
 *   (negative zero as zero), doubles and reals bit for bit, booleans, int4 ranges, and integers of every type at any
 *   value, its bounds among them, each of the type it is printed as.
 *
 * Oracle: the host's evaluation (evaluated.ts) for expressions, relational reads, set trees and aggregates; SQL's
 * specification of a catalog read, a RAISE and a literal; PostgreSQL itself for the default privileges.
 *
 * Plants: sql-print-catalog-union-all (a catalog read's arms joined by UNION ALL), sql-print-frame-range (a window
 * frame printed as RANGE), sql-print-default-privileges-scope-dropped (IN SCHEMA dropped from a reset),
 * sql-print-right-operand-unwrapped (a right operand of equal precedence printed bare), sql-print-nested-select-bare (a
 * nested set-operation level printed without its parentheses), sql-print-count-filter-dropped (count(*)'s FILTER
 * dropped), sql-print-raise-detail-dropped (a RAISE's DETAIL dropped), sql-print-float-fifteen-digits (a double
 * literal printed to fifteen significant digits), sql-print-negative-int4-bare (a negative int4 literal printed
 * without its cast, so the least one reads as a bigint).
 *
 * Features: the relational reads' joins, subqueries and frames; the expressions' types and a collated BETWEEN bound;
 * the catalog read's shared and apart arms; each privilege outcome; and a literal at an integer type's bound.
 */
import { drawn, exhaust, explore, sketched } from "@bjornpagen/testing/explore"
import { noCoverage, required, requiredInSpace } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import type { Source } from "@bjornpagen/testing/source"
import { bigint, double, float } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import type {
	AlterDefaultPrivileges,
	Expr,
	PlFunction,
	RaiseOption,
	SqlStatement,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	cast,
	cUtf8Collation,
	lit,
	namedType,
	objectName,
	provedSelect,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import * as C from "#compiler/sql/catalog.ts"
import { emitCatalog } from "#compiler/sql/emit.ts"
import { printExpr, printStatement, quoteIdent } from "#compiler/sql/print.ts"
import {
	aggregateCaseGen,
	type Evaluated,
	evaluatedGen,
	type RelationalFeature,
	relationalSketchGen,
	resolveRelational,
	setCaseGen
} from "#test/pg/sql/evaluated.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { auditStatementViolations, auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { freshSchema, roleSession, Substrate } from "#test/support/substrate/substrate.ts"

const sql = (statement: SqlStatement): string => {
	assert.deepEqual(auditStatementViolations(statement), [])
	const text = printStatement(statement)
	assert.deepEqual(auditTextViolations(text), [])
	return text
}

const run = (statements: ReadonlyArray<SqlStatement>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		for (const statement of statements) {
			yield* admin.query(sql(statement), [])
		}
	})

/** A function `<schema>.<name>()` returning boolean, its body `body` then RETURN true. */
const booleanFunction = (
	schema: string,
	name: string,
	body: PlFunction["body"]["body"]
): PlFunction => ({
	kind: "createFunction",
	language: "plpgsql",
	name: objectName(schema, name),
	params: [],
	returns: "boolean",
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	body: { declare: [], body }
})

/** Where a default-privilege reset applies: one schema, or the global form, every schema of the database. */
const resetScopes = ["schema", "global"] as const

/** The kinds of object PostgreSQL grants PUBLIC a privilege on by default: EXECUTE on a function, USAGE on a type. */
const publicDefaults: Arr.NonEmptyReadonlyArray<AlterDefaultPrivileges["on"]> = [
	"FUNCTIONS",
	"TYPES"
]

/** What a reset left of PUBLIC's default privilege. */
type PrivilegeFeature = "PUBLIC kept by a schema's reset" | "PUBLIC revoked by the global reset"

/**
 * A RAISE with any subset of ERRCODE, DETAIL and HINT, and the SQLSTATE and DETAIL PostgreSQL reports for it: P0001
 * when no ERRCODE is given.
 */
const raiseGen = (source: Source) => ({
	message: source.draw(
		element(["refused", "it's refused", "\u00dcn\u00efc\u00f6d\u00e9 refusal", 'a "quoted" one'])
	),
	code: source.draw(map(option(element(["23514", "22023", "40001"])), Option.getOrUndefined)),
	detail: source.draw(map(option(element(["a detail", '{"law": 1}'])), Option.getOrUndefined)),
	hint: source.draw(map(option(constant("a hint")), Option.getOrUndefined))
})

/** A code point PostgreSQL stores as it is: any Unicode scalar value but NUL, as a binary string draws them. */
const storedCodePoint: Gen<string> = oneOf([codePoint(0x01, 0xd7ff), codePoint(0xe000, 0x10_ffff)])

/**
 * A grapheme a person writes: printable ASCII, a Latin letter, a letter with a combining mark, or an emoji, a joined
 * family and a flag among them.
 */
const grapheme: Gen<string> = oneOf([
	codePoint(0x20, 0x7e),
	codePoint(0xa0, 0x24f),
	(source) => `${source.draw(codePoint(0x61, 0x7a))}${source.draw(codePoint(0x300, 0x36f))}`,
	element([
		"\u{1f600}",
		"\u{1f44d}\u{1f3fd}",
		"\u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
		"\u{1f1eb}\u{1f1f7}"
	])
])

/** Texts PostgreSQL stores as they are, well-formed and without NUL: up to twelve graphemes, or code points. */
const textGen: Gen<string> = oneOf([
	string(grapheme, { min: 0, max: 12 }),
	string(storedCodePoint, { min: 0, max: 12 })
])

/** A numeric's text: a sign, a whole part up to 10^30 and, or not, a fraction of 1 to 12 digits. */
const decimalGen: Gen<string> = (source) => {
	const negative = source.draw(boolean)
	const whole = source.draw(bigint(0n, 10n ** 30n))
	const fraction = source.draw(
		map(option(string(codePoint(0x30, 0x39), { min: 1, max: 12 })), Option.getOrUndefined)
	)
	return `${negative ? "-" : ""}${whole}${fraction === undefined ? "" : `.${fraction}`}`
}

/** Every double, NaN and the infinities among them. */
const anyDouble: Gen<number> = weighted([
	[17, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, constant(Number.NaN)],
	[1, constant(Number.POSITIVE_INFINITY)],
	[1, constant(Number.NEGATIVE_INFINITY)]
])

/** The largest finite 32-bit float. */
const maxReal = 3.4028234663852886e38

/** Every 32-bit float, NaN and the infinities among them. */
const anyReal: Gen<number> = weighted([
	[17, float(-maxReal, maxReal)],
	[1, constant(Number.NaN)],
	[1, constant(Number.POSITIVE_INFINITY)],
	[1, constant(Number.NEGATIVE_INFINITY)]
])

/** A numeric literal spelled `text`, built as the AST holds it: lit.decimal spells only a value's parts. */
const decimalSpelled = (text: string): Expr => ({
	kind: "literal",
	value: { kind: "decimal", value: text },
	type: types.numeric
})

/** Numeric spellings a printed literal trips on: the special values, negative zeros, display scale, a long negative. */
const edgeDecimals = [
	"NaN",
	"Infinity",
	"-Infinity",
	"-0",
	"-0.000",
	"0.10",
	"-170141183460469231731687303715884105728"
] as const

/** Doubles a printed literal trips on: the signed zeros, NaN, the infinities, the least and the greatest. */
const edgeDoubles = [
	-0,
	0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	5e-324,
	1.7976931348623157e308
] as const
/** Texts a printed literal trips on: empty, a quote, non-ASCII, a double quote, astral, a backslash, NULL's spelling. */
const edgeTexts = [
	"",
	"it's",
	"\u00dcn\u00efc\u00f6d\u00e9",
	'a"b',
	"\u{1f600}",
	"\\",
	"NULL"
] as const

/** An integer type a literal is printed as, PostgreSQL's name of it, and its least and greatest values. */
interface IntType {
	readonly type: TypeRef
	readonly name: string
	readonly least: bigint
	readonly greatest: bigint
}

/** The integer types an integer literal is printed as; numeric's bounds are a wide range, numeric has none. */
const intTypes: Arr.NonEmptyReadonlyArray<IntType> = [
	{ type: types.smallint, name: "smallint", least: -(2n ** 15n), greatest: 2n ** 15n - 1n },
	{ type: types.integer, name: "integer", least: -(2n ** 31n), greatest: 2n ** 31n - 1n },
	{ type: types.bigint, name: "bigint", least: -(2n ** 63n), greatest: 2n ** 63n - 1n },
	{ type: types.numeric, name: "numeric", least: -(2n ** 127n), greatest: 2n ** 127n }
]

/** An integer literal: a type, and a value of it, its bounds, zero and minus one weighted beside any value. */
const intLiteralGen: Gen<readonly [IntType, bigint]> = (source) => {
	const t = source.draw(element(intTypes))
	return [
		t,
		source.draw(
			weighted([
				[3, bigint(t.least, t.greatest)],
				[1, element([t.least, t.greatest, 0n, -1n])]
			])
		)
	] as const
}

/** An int4 span's text: a lower bound and a greater upper one, half-open, its canonical form. */
const spanTextGen: Gen<string> = (source) => {
	const lower = source.draw(bigint(-(2n ** 31n), 2n ** 31n - 2n))
	const upper = lower + 1n + source.draw(bigint(0n, 2n ** 31n - 1n - (lower + 1n)))
	return `[${lower},${upper})`
}

/** A drawn sample of every typed literal, each list one SELECT, the dictionaries' edges weighted beside the rest. */
const literalsGen = (source: Source) => ({
	texts: source.draw(
		array(
			weighted<string>([
				[1, element(edgeTexts)],
				[6, textGen]
			]),
			{ min: 1, max: 24 }
		)
	),
	labels: source.draw(array(textGen, { min: 1, max: 8 })),
	decimals: source.draw(
		array(
			weighted<string>([
				[1, element(edgeDecimals)],
				[6, decimalGen]
			]),
			{ min: 1, max: 24 }
		)
	),
	doubles: source.draw(
		array(
			weighted<number>([
				[1, element(edgeDoubles)],
				[6, anyDouble]
			]),
			{ min: 1, max: 24 }
		)
	),
	reals: source.draw(array(anyReal, { min: 1, max: 24 })),
	ints: source.draw(array(intLiteralGen, { min: 1, max: 24 })),
	bools: source.draw(array(boolean, { min: 1, max: 4 })),
	spans: source.draw(array(spanTextGen, { min: 1, max: 4 }))
})

const casesPerTest = 60

/** A text literal. */
const textLit = (value: string): Expr => lit.text(value, types.text)

/** The texts a catalog read's arm selects: two, so the arms of a read often share one. */
const armTexts = ["a", "b"] as const

/** A catalog read's arms: two to four, each selecting one of armTexts. */
const catalogArmsGen = array(element(armTexts), { min: 2, max: 4 })

layer(Substrate.layer)("printed SQL on PostgreSQL 19", (it) => {
	it.effect(
		"reads a catalog read of several arms as the set union of their rows, a row two arms share once",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "a catalog read is a set (sql/catalog.ts CatalogSelect)"
							},
							suite: "pg/sql/catalog-union",
							draw: drawn(catalogArmsGen),
							literal: Formatter.format,
							coverage: required<"a row two arms share" | "arms apart">(
								["a row two arms share", "arms apart"],
								{ cases: casesPerTest, sense: notesOnly }
							),
							kept: [],
							runs: casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(texts, c) =>
							Effect.gen(function* () {
								const read = C.union(
									nonEmpty(
										Arr.map(texts, (text) => C.core([C.text(text)], [], undefined)),
										"a read's arms"
									)
								)
								const rows = yield* s.admin.queryValues(emitCatalog(read), [])
								assert.deepEqual(
									Arr.sort(
										Arr.map(rows, (row) => String(row[0])),
										Order.String
									),
									Arr.sort(Arr.dedupe(texts), Order.String),
									"the read's rows, each once"
								)
								c.note(
									Arr.dedupe(texts).length < texts.length ? "a row two arms share" : "arms apart"
								)
							})
					)
				})
			)
	)

	it.effect(
		"evaluates generated CROSS JOINs, IN and NOT IN over a subquery, and windows over drawn ROWS frames as the host does",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the host's evaluation of the relational read (evaluated.ts)"
							},
							suite: "pg/sql/relational",
							draw: sketched(relationalSketchGen, resolveRelational),
							literal: Formatter.format,
							kept: [],
							runs: 2 * casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							coverage: required<RelationalFeature>(
								[
									"cross join",
									"in",
									"not in",
									"empty subquery",
									"frame unboundedPreceding to currentRow",
									"frame currentRow to unboundedFollowing",
									"frame offset to offset",
									"partitioned window",
									"descending window",
									"empty frame"
								],
								{ cases: 2 * casesPerTest, sense: notesOnly }
							)
						},
						(c, notes) =>
							Effect.gen(function* () {
								const text = sql(c.statement)
								const rows = yield* s.admin.queryValues(text, [])
								const got: ReadonlyArray<ReadonlyArray<string | null>> = Arr.map(rows, (row) =>
									Arr.map(row, (cell) =>
										cell === null ? null : typeof cell === "string" ? cell : Formatter.format(cell)
									)
								)
								assert.deepEqual(got, c.rows, text)
								notes.noteAll(c.reached)
							})
					)
				})
			)
	)

	it.effect("resets PUBLIC's defaults on functions and types only in the global form", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const q = quoteIdent(schema)
				return yield* exhaust(
					{
						suite: "pg/sql/default-privileges",
						generator: (source) =>
							[source.draw(element(resetScopes)), source.draw(element(publicDefaults))] as const,
						literal: Formatter.format,
						box: "a reset in one schema and in the global form, of each kind PostgreSQL grants PUBLIC by default",
						oracle: {
							kind: "postgresql",
							name: "PUBLIC's privilege on an object the role creates after the reset"
						},
						coverage: requiredInSpace<PrivilegeFeature>([
							"PUBLIC kept by a schema's reset",
							"PUBLIC revoked by the global reset"
						]),
						caseHang,
						concurrency: 1
					},
					([scope, on], c) =>
						Effect.scoped(
							Effect.gen(function* () {
								/** A role, a function and a type of each case's own, named by its case, so no case meets another's defaults. */
								const own = `${scope}_${Str.toLowerCase(on)}`
								const maker = yield* s.role(schema, `maker_${own}`)
								yield* s.admin.query(
									`GRANT USAGE, CREATE ON SCHEMA ${q} TO ${quoteIdent(maker.role)}`,
									[]
								)
								const m = yield* s.session({ ...roleSession(maker) })
								yield* run([
									{
										kind: "alterDefaultPrivileges",
										forRole: maker.role,
										inSchema: scope === "schema" ? schema : undefined,
										privileges: ["ALL"],
										on,
										from: [{ kind: "PUBLIC" }]
									}
								])
								const created = `__made_${own}`
								yield* m.query(
									sql(
										on === "FUNCTIONS"
											? booleanFunction(schema, created, [
													{ kind: "return", value: lit.bool(true) }
												])
											: {
													kind: "createDomain",
													name: objectName(schema, created),
													base: types.smallint,
													collation: undefined,
													constraints: []
												}
									),
									[]
								)
								const held = yield* s.admin.queryValues(
									on === "FUNCTIONS"
										? "SELECT has_function_privilege('public'::name, $1::text, 'EXECUTE'::text)"
										: "SELECT has_type_privilege('public'::name, $1::text, 'USAGE'::text)",
									[
										on === "FUNCTIONS"
											? `${q}.${quoteIdent(created)}()`
											: `${q}.${quoteIdent(created)}`
									]
								)
								assert.deepEqual(held, [[scope === "schema"]], `${scope} reset of ${on}`)
								c.note(
									scope === "schema"
										? "PUBLIC kept by a schema's reset"
										: "PUBLIC revoked by the global reset"
								)
							})
						)
				)
			})
		)
	)

	it.effect(
		"evaluates generated expressions as the host does, so the printer's parentheses are PostgreSQL's",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the host's evaluation of each expression (evaluated.ts)"
							},
							suite: "pg/sql/evaluated",
							draw: drawn(array(evaluatedGen, { min: 1, max: 40 })),
							literal: Formatter.format,
							coverage: required<Evaluated["type"] | "collated between bound">(
								["int", "bool", "text", "collated between bound"],
								{ cases: casesPerTest, sense: notesOnly }
							),
							kept: [],
							runs: casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(cases, c) =>
							Effect.gen(function* () {
								const [row] = yield* s.admin.queryValues(
									`SELECT ${Arr.join(
										Arr.map(cases, (entry) => printExpr(entry.item.expr)),
										", "
									)}`,
									[]
								)
								const cells = defined(row, "the SELECT's one row")
								for (const [i, entry] of cases.entries()) {
									const item = entry.item
									const got = cells[i]
									const expected = item.type === "int" ? item.value.toString() : item.value
									assert.deepEqual(
										{ expr: printExpr(item.expr), value: item.type === "int" ? String(got) : got },
										{ expr: printExpr(item.expr), value: expected }
									)
									c.note(item.type)
									c.noteAll(entry.reached)
								}
							})
					)
				})
			)
	)

	it.effect(
		"evaluates generated set-operation trees as SQL's set semantics do, levels nested and parenthesized",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "SQL's set semantics over the tree's arms (evaluated.ts)"
							},
							suite: "pg/sql/set-trees",
							draw: drawn(setCaseGen),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 3 * casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c) =>
							Effect.gen(function* () {
								const text = sql(c.statement)
								const rows = yield* s.admin.queryValues(text, [])
								const got: ReadonlyArray<number> = Arr.sort(
									Arr.map(rows, (row) => Number(row[0])),
									Order.Number
								)
								assert.deepEqual(got, c.rows, text)
							})
					)
				})
			)
	)

	it.effect(
		"evaluates generated aggregates with DISTINCT, their own ORDER BY and FILTER, group by group",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the host's aggregation group by group (evaluated.ts)"
							},
							suite: "pg/sql/aggregates",
							draw: drawn(aggregateCaseGen),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 2 * casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c) =>
							Effect.gen(function* () {
								const text = sql(c.statement)
								const rows = yield* s.admin.queryValues(text, [])
								const got: ReadonlyArray<ReadonlyArray<string>> = Arr.map(rows, (row) =>
									Arr.map(row, String)
								)
								assert.deepEqual(got, c.rows, text)
							})
					)
				})
			)
	)

	it.effect(
		"raises every generated RAISE with the SQLSTATE, message and DETAIL its USING options give",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					let made = 0
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "RAISE ... USING: the SQLSTATE of ERRCODE or P0001, the message and DETAIL given"
							},
							suite: "pg/sql/raise",
							draw: drawn(raiseGen),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ message, code, detail, hint }) =>
							Effect.gen(function* () {
								const using: ReadonlyArray<RaiseOption> = [
									...(code === undefined
										? []
										: [{ option: "ERRCODE" as const, value: textLit(code) }]),
									...(detail === undefined
										? []
										: [{ option: "DETAIL" as const, value: textLit(detail) }]),
									...(hint === undefined ? [] : [{ option: "HINT" as const, value: textLit(hint) }])
								]
								made++
								const name = `__raise_${made}`
								yield* run([
									booleanFunction(schema, name, [
										{ kind: "raise", message, using },
										{ kind: "return", value: lit.bool(true) }
									])
								])
								const invoke = provedSelect(
									"oneRow",
									[
										targetAs(
											{
												kind: "call",
												fn: { kind: "qualified", schema, name },
												args: [],
												star: false,
												distinct: false,
												orderBy: [],
												withinGroup: [],
												over: undefined
											},
											"c1"
										)
									],
									[],
									undefined
								)
								const raised = yield* expectSqlstate(
									s.admin.query(sql(invoke), []),
									code ?? "P0001"
								)
								assert.equal(raised.message, message)
								assert.deepEqual(raised.detail, Option.fromUndefinedOr(detail))
							})
					)
				})
			)
	)

	it.effect("delivers every typed literal exactly", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				yield* run([
					{
						kind: "createDomain",
						name: { schema, name: "label" },
						base: types.text,
						collation: cUtf8Collation,
						constraints: []
					}
				])
				const label = namedType(testTypeSchema(schema), "label", [])
				const asText = (e: Expr) => printExpr(cast(e, types.text))
				const values = (exprs: ReadonlyArray<string>) =>
					Effect.map(
						s.admin.queryValues(`SELECT ${Arr.join(exprs, ", ")}`, []),
						([row]): ReadonlyArray<string> => Arr.map(defined(row, "the SELECT's one row"), String)
					)
				const zero = (d: string) =>
					Arr.every(Arr.fromIterable(d), (c) => c === "0" || c === "-" || c === ".")
				return yield* explore(
					{
						oracle: {
							kind: "specification",
							name: "each literal's own value, read back as text, and the type it is printed as"
						},
						suite: "pg/sql/literals",
						draw: drawn(literalsGen),
						literal: Formatter.format,
						coverage: required<"an integer type's bound">(["an integer type's bound"], {
							cases: casesPerTest,
							sense: notesOnly
						}),
						kept: [],
						runs: casesPerTest,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sample, c) =>
						Effect.gen(function* () {
							const texts = yield* values(
								Arr.map(sample.texts, (x) => printExpr(lit.text(x, types.text)))
							)
							assert.deepEqual(texts, sample.texts)
							const labels = yield* values(
								Arr.map(sample.labels, (l) => asText(lit.text(l, label)))
							)
							assert.deepEqual(labels, sample.labels)
							const decimals = yield* values(
								Arr.map(sample.decimals, (d) => asText(decimalSpelled(d)))
							)
							assert.deepEqual(
								decimals,
								Arr.map(sample.decimals, (d) =>
									zero(d) && Str.startsWith("-")(d) ? Str.slice(1)(d) : d
								)
							)
							const doubles = yield* values(
								Arr.map(sample.doubles, (d) => asText(lit.float(d, types.double)))
							)
							for (const [i, d] of sample.doubles.entries()) {
								assert.ok(
									Object.is(Number(doubles[i]), d),
									`${Formatter.format(d)} came back as ${doubles[i]}`
								)
							}
							const reals = yield* values(
								Arr.map(sample.reals, (r) => asText(cast(lit.float(r, types.real), types.double)))
							)
							for (const [i, r] of sample.reals.entries()) {
								assert.ok(
									Object.is(Number(reals[i]), r),
									`${Formatter.format(r)} came back as ${reals[i]}`
								)
							}
							const ints = yield* values(
								Arr.flatMap(sample.ints, ([t, n]) => {
									const printed = printExpr(lit.int(n, t.type))
									return [asText(lit.int(n, t.type)), `pg_typeof(${printed})::text`]
								})
							)
							assert.deepEqual(
								ints,
								Arr.flatMap(sample.ints, ([t, n]) => [n.toString(), t.name])
							)
							if (Arr.some(sample.ints, ([t, n]) => n === t.least || n === t.greatest)) {
								c.note("an integer type's bound")
							}
							const others = yield* values(
								Arr.appendAll(
									Arr.map(sample.bools, (b) => asText(lit.bool(b))),
									Arr.map(sample.spans, (span) => asText(lit.text(span, types.int4range)))
								)
							)
							assert.deepEqual(others, Arr.appendAll(Arr.map(sample.bools, String), sample.spans))
						})
				)
			})
		)
	)
})
