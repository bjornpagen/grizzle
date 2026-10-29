import { layer } from "@effect/vitest"
import { drawn, explore, sketched } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	filter,
	type Gen,
	map,
	oneOf,
	option,
	string,
	unicodeScalar,
	weighted
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint, double, float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import type {
	AlterDefaultPrivileges,
	Expr,
	PlFunction,
	RaiseOption,
	SqlStatement
} from "#compiler/sql/ast.ts"

import {
	cast,
	lit,
	namedType,
	objectName,
	simpleSelect,
	targetAs,
	types
} from "#compiler/sql/build.ts"
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
import { assert, defined } from "#test/support/assert.ts"
import { auditStatementViolations, auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { freshSchema, roleSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The printed SQL on PostgreSQL 19 (packages/engine/src/sql): the text means what the AST says.
 *
 * Generated expressions of bigint, boolean and text evaluate as the host evaluates them, so the printer's parentheses
 * are PostgreSQL's precedence; generated set-operation trees, arms and whole levels parenthesized with their own
 * ORDER BY and LIMIT, evaluate as SQL's set semantics say; generated aggregates keep their DISTINCT, their own ORDER BY
 * and count(*)'s FILTER; a generated RAISE, with any subset of its USING options, raises its SQLSTATE, message and
 * DETAIL; typed literals arrive exactly; and generated CROSS JOINs, IN and NOT IN over a subquery and windows over
 * drawn ROWS frames evaluate as the host computes them. The generators are test/pg/sql/evaluated.ts. Beside them, the
 * default-privilege resets leave new functions and types to no one.
 *
 * Every statement this file sends is one the audit accepts: the printer's output, never hand-edited.
 */
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
	searchPath: ["pg_catalog", "pg_temp"],
	planCacheMode: "force_custom_plan",
	body: { declare: [], body }
})

/** The function whose EXECUTE privilege the default-privilege resets decide. */
const probe = (schema: string, version: 1 | 2): PlFunction =>
	booleanFunction(schema, `__probe_v${version}`, [{ kind: "return", value: lit.bool(true) }])

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
const storedCodePoint: Gen<string> = filter(unicodeScalar, (c) => c !== "\u0000", 2)

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

const literalsGen = (source: Source) => ({
	texts: source.draw(array(textGen, { min: 0, max: 24 })),
	decimals: source.draw(array(decimalGen, { min: 0, max: 24 })),
	doubles: source.draw(array(anyDouble, { min: 0, max: 24 })),
	reals: source.draw(array(anyReal, { min: 1, max: 24 }))
})

/** The edge values every case carries besides its drawn ones. */
const edgeDecimals = [
	"NaN",
	"Infinity",
	"-Infinity",
	"-0",
	"-0.000",
	"0.10",
	"-170141183460469231731687303715884105728"
]

const edgeDoubles = [
	-0,
	0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	5e-324,
	1.7976931348623157e308
]
const edgeTexts = ["", "it's", "\u00dcn\u00efc\u00f6d\u00e9", 'a"b', "\u{1f600}", "\\", "NULL"]

const casesPerTest = 60

/** A text literal. */
const textLit = (value: string): Expr => lit.text(value, types.text)

layer(Substrate.layer)("printed SQL on PostgreSQL 19", (it) => {
	it.effect(
		"evaluates generated CROSS JOINs, IN and NOT IN over a subquery, and windows over drawn ROWS frames as the host does",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							suite: "pg/sql/relational",
							draw: sketched(relationalSketchGen, resolveRelational),
							literal: Formatter.format,
							/**
							 * Planted: windows over an offset frame that leaves a row's frame empty, and over the remaining
							 * frame, which the drawn frames reach a few times a run.
							 */
							kept: [
								{
									note: "an offset frame leaving a row's frame empty",
									sketch: {
										r1: [{ value: 0, group: 0 }],
										r2: [0, 0, 0, 0],
										form: {
											kind: "window",
											bounds: [
												{ kind: "offset", offset: 1n, direction: "FOLLOWING" },
												{ kind: "offset", offset: 2n, direction: "FOLLOWING" }
											],
											partitioned: false,
											descending: false
										}
									},
									draws: "",
									reaches: ["frame offset to offset", "empty frame"]
								},
								{
									note: "the remaining frame",
									sketch: {
										r1: [{ value: 0, group: 0 }],
										r2: [0, 0, 0, 0],
										form: {
											kind: "window",
											bounds: [{ kind: "currentRow" }, { kind: "unboundedFollowing" }],
											partitioned: false,
											descending: false
										}
									},
									draws: "",
									reaches: ["frame currentRow to unboundedFollowing"]
								}
							],
							runs: 2 * casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2),
							features: features<RelationalFeature>([
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
							])
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

	it.effect("resets PUBLIC's defaults on functions and types only in the global form", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema(freshSchema)
			const q = quoteIdent(schema)
			const maker = yield* s.role(schema, "maker")
			yield* s.admin.query(`GRANT USAGE, CREATE ON SCHEMA ${q} TO ${quoteIdent(maker.role)}`, [])
			const m = yield* s.session({ ...roleSession(maker) })
			/** Default privileges reset in one schema, or in the global form. */
			const reset = (
				on: AlterDefaultPrivileges["on"],
				scope: { readonly kind: "schema"; readonly name: string } | { readonly kind: "global" }
			): AlterDefaultPrivileges => ({
				kind: "alterDefaultPrivileges",
				forRole: maker.role,
				inSchema: scope.kind === "schema" ? scope.name : undefined,
				privileges: ["ALL"],
				on,
				from: [{ kind: "PUBLIC" }]
			})
			const publicCan = (version: 1 | 2, type: string) =>
				s.admin.queryValues(
					"SELECT has_function_privilege('public'::name, $1::text, 'EXECUTE'::text), has_type_privilege('public'::name, $2::text, 'USAGE'::text)",
					[`${q}."__probe_v${version}"()`, `${q}.${quoteIdent(type)}`]
				)

			yield* run([
				reset("FUNCTIONS", { kind: "schema", name: schema }),
				reset("TYPES", { kind: "schema", name: schema })
			])
			yield* m.query(sql(probe(schema, 1)), [])
			yield* m.query(
				sql({
					kind: "createEnum",
					name: objectName(schema, "kind"),
					labels: ["Automatic", "Manual"]
				}),
				[]
			)
			assert.deepEqual(yield* publicCan(1, "kind"), [[true, true]])

			yield* run([reset("FUNCTIONS", { kind: "global" }), reset("TYPES", { kind: "global" })])
			yield* m.query(sql(probe(schema, 2)), [])
			yield* m.query(
				sql({ kind: "createEnum", name: objectName(schema, "state"), labels: ["Open"] }),
				[]
			)
			assert.deepEqual(yield* publicCan(2, "state"), [[false, false]])
		})
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
							suite: "pg/sql/evaluated",
							draw: drawn(array(evaluatedGen, { min: 1, max: 40 })),
							literal: Formatter.format,
							features: features<Evaluated["type"] | "collated between bound">([
								"int",
								"bool",
								"text",
								"collated between bound"
							]),
							kept: [],
							runs: casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
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
							suite: "pg/sql/set-trees",
							draw: drawn(setCaseGen),
							literal: Formatter.format,
							features: noFeatures,
							kept: [],
							runs: 3 * casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(c) =>
							Effect.gen(function* () {
								const text = sql(c.statement)
								const got: ReadonlyArray<number> = Arr.sort(
									Arr.map(yield* s.admin.queryValues(text, []), (row) => Number(row[0])),
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
							suite: "pg/sql/aggregates",
							draw: drawn(aggregateCaseGen),
							literal: Formatter.format,
							features: noFeatures,
							kept: [],
							runs: 2 * casesPerTest,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
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
							suite: "pg/sql/raise",
							draw: drawn(raiseGen),
							literal: Formatter.format,
							features: noFeatures,
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
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
								const invoke = simpleSelect(
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
				const labels = ["it's", "\u00dcn\u00efc\u00f6d\u00e9", 'a"b', "\u{1f600}"]
				yield* run([{ kind: "createEnum", name: { schema, name: "label" }, labels }])
				const asText = (e: Expr) => printExpr(cast(e, types.text))
				const values = (exprs: ReadonlyArray<string>) =>
					Effect.map(s.admin.queryValues(`SELECT ${Arr.join(exprs, ", ")}`, []), ([row]) =>
						Arr.map(defined(row, "the SELECT's one row"), String)
					)

				assert.deepEqual(
					yield* values(
						Arr.map(labels, (l) => asText(lit.text(l, namedType(schema, "label", []))))
					),
					labels
				)
				const ints: ReadonlyArray<readonly [bigint, typeof types.smallint]> = [
					[-32768n, types.smallint],
					[32767n, types.smallint],
					[-2147483648n, types.integer],
					[2147483647n, types.integer],
					[-9223372036854775808n, types.bigint],
					[9223372036854775807n, types.bigint],
					[0n, types.numeric],
					[-170141183460469231731687303715884105728n, types.numeric]
				]
				assert.deepEqual(
					yield* values(Arr.map(ints, ([n, type]) => asText(lit.int(n, type)))),
					Arr.map(ints, ([n]) => n.toString())
				)
				assert.deepEqual(
					yield* values([`pg_typeof(${printExpr(lit.int(-2147483648n, types.integer))})::text`]),
					["integer"]
				)
				assert.deepEqual(
					yield* values([
						asText(lit.bool(true)),
						asText(lit.bool(false)),
						asText(lit.text("[1,5)", types.int4range))
					]),
					["true", "false", "[1,5)"]
				)

				const zero = (d: string) =>
					Arr.every(Arr.fromIterable(d), (c) => c === "0" || c === "-" || c === ".")
				return yield* explore(
					{
						suite: "pg/sql/literals",
						draw: drawn(literalsGen),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: casesPerTest,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(sample) =>
						Effect.gen(function* () {
							const texts = [...edgeTexts, ...sample.texts]
							assert.deepEqual(
								yield* values(Arr.map(texts, (x) => printExpr(lit.text(x, types.text)))),
								texts
							)
							const decimals = [...edgeDecimals, ...sample.decimals]
							assert.deepEqual(
								yield* values(Arr.map(decimals, (d) => asText(lit.decimal(d, types.numeric)))),
								Arr.map(decimals, (d) => (zero(d) && Str.startsWith("-")(d) ? Str.slice(1)(d) : d))
							)
							const doubles = [...edgeDoubles, ...sample.doubles]
							const doubleTexts = yield* values(
								Arr.map(doubles, (d) => asText(lit.float(d, types.double)))
							)
							for (const [i, d] of doubles.entries()) {
								assert.ok(
									Object.is(Number(doubleTexts[i]), d),
									`${Formatter.format(d)} came back as ${doubleTexts[i]}`
								)
							}
							const realTexts = yield* values(
								Arr.map(sample.reals, (r) => asText(cast(lit.float(r, types.real), types.double)))
							)
							for (const [i, r] of sample.reals.entries()) {
								assert.ok(
									Object.is(Number(realTexts[i]), r),
									`${Formatter.format(r)} came back as ${realTexts[i]}`
								)
							}
						})
				)
			})
		)
	)
})
