/** What the properties of print.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
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
import type { Source } from "@bjornpagen/testing/source"
import { bigint, double, float } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Option } from "effect"
import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	AlterDefaultPrivileges,
	Expr,
	PlFunction,
	SqlStatement,
	TypeRef
} from "#compiler/sql/ast.ts"
import { cast, lit, objectName, types } from "#compiler/sql/build.ts"
import { printCommands, printExpr } from "#compiler/sql/print.ts"
import {
	auditStatementViolations,
	auditTextViolations,
	guardedTermsOf
} from "#test/support/oracle/verify/sql.ts"
import type { PgConnection } from "#test/support/pg.ts"

/** `statement`'s commands as a driver sends them, one message each (sql/print.ts printCommands), each audited. */
export const commands = (statement: SqlStatement): ReadonlyArray<string> => {
	assert.deepEqual(auditStatementViolations(statement), [])
	return Arr.map(printCommands(statement), (text) => {
		assert.deepEqual(auditTextViolations(text, guardedTermsOf(statement)), [])
		return text
	})
}

/** The text of a statement of one command, as a driver sends it; a statement of several is the test's defect. */
export const sql = (statement: SqlStatement): string => {
	const [only, ...more] = commands(statement)
	assert.equal(more.length, 0, `${statement.kind} is one command`)
	return defined(only, "a statement's first command")
}

/** Each command of `statements` on `admin`, in order. */
export const run = (admin: PgConnection, statements: ReadonlyArray<SqlStatement>) =>
	Effect.gen(function* () {
		for (const statement of statements) {
			for (const command of commands(statement)) {
				yield* admin.query(command, [])
			}
		}
	})

/** A function `<schema>.<name>()` returning boolean, its body `body` then RETURN true. */
export const booleanFunction = (
	schema: string,
	name: string,
	body: PlFunction["body"]["body"]
): PlFunction => ({
	kind: "createFunction",
	advice: noAdvice,
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
export const resetScopes = ["schema", "global"] as const

/** The kinds of object PostgreSQL grants PUBLIC a privilege on by default: EXECUTE on a function, USAGE on a type. */
export const publicDefaults: Arr.NonEmptyReadonlyArray<AlterDefaultPrivileges["on"]> = [
	"FUNCTIONS",
	"TYPES"
]

/** What a reset left of PUBLIC's default privilege. */
export type PrivilegeFeature =
	| "PUBLIC kept by a schema's reset"
	| "PUBLIC revoked by the global reset"

/**
 * A RAISE with any subset of ERRCODE, DETAIL and HINT, and the SQLSTATE and DETAIL PostgreSQL reports for it: P0001
 * when no ERRCODE is given.
 */
export const raiseGen = (source: Source) => ({
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
export const decimalSpelled = (text: string): Expr => ({
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
export const literalsGen = (source: Source) => ({
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

/** A text literal. */
export const textLit = (value: string): Expr => lit.text(value, types.text)

/** The texts a catalog read's arm selects: two, so the arms of a read often share one. */
const armTexts = ["a", "b"] as const

/** A catalog read's arms: two to four, each selecting one of armTexts. */
export const catalogArmsGen = array(element(armTexts), { min: 2, max: 4 })

export const textOf = (e: Expr) => printExpr(cast(e, types.text))

export const zero = (d: string) =>
	Arr.every(Arr.fromIterable(d), (c) => c === "0" || c === "-" || c === ".")
