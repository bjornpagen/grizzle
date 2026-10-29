import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	codePoint,
	element,
	type Gen,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Schema, String as Str } from "effect"
import { SqlStatementSchema } from "#adapter/boundary/sql.ts"
import { decode, noRevivers } from "#compiler/core/canonical.ts"
import { writeJsonText } from "#compiler/deploy/snapshot/build.ts"
import { lit, simpleSelect, target, types } from "#compiler/sql/build.ts"
import { statementForm } from "#compiler/sql/form.ts"
import { lex } from "#compiler/sql/lexer.ts"
import { dollarQuoteTag, printStatement, quoteIdent } from "#compiler/sql/print.ts"
import { assert, succeeded } from "#test/support/assert.ts"

/**
 * The SQL printer. A dollar-quote tag and a quoted identifier are checked over generated bodies and names, each lexing
 * back as what was quoted, and a float literal over every double, which the snapshot reads back and the float input
 * function reads as that double. The DDL it prints is executed on PostgreSQL by the installation and migration suites,
 * and audited, statement and text, over every installation and drafted migration (test/unit/sql/audit.test.ts). What a printed query means is checked on
 * PostgreSQL (test/pg/sql: generated expressions, set-operation trees and aggregates evaluated against the host, every
 * generated statement planned), and the compiler's own SELECT forms run in the differential suites.
 *
 * The tag a body took: the plain one, the first named one, or a numbered one.
 */
type DollarTag = "$$" | "$gz$" | "$gzN$"

/** The fragments a body is built of: the tags themselves, parts of them, and text around them. */
const fragments = [
	"$$",
	"$gz$",
	"$gz1$",
	"$gz2$",
	"$g",
	"z$",
	"$",
	"gz",
	"1$",
	"BEGIN",
	" ",
	"\n",
	"'",
	"x"
] as const

describe("dollar quoting", () => {
	it.effect(
		"chooses a dollar-quote tag the body does not hold, so the body lexes back as one dollar string",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/dollar-tag",
						draw: drawn(array(element(fragments), { min: 0, max: 12 })),
						literal: Formatter.format,
						features: features<DollarTag>(["$$", "$gz$", "$gzN$"]),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(parts, c) =>
						Effect.sync(() => {
							const body = Arr.join(parts, "")
							const tag = dollarQuoteTag(body)
							assert.equal(Str.includes(tag)(body), false, `${tag} in ${body}`)
							assert.equal(dollarQuoteTag(body), tag, "the tag is a function of the body alone")
							const lexed = lex(`${tag}\n${body}\n${tag}`)
							assert.equal(lexed.tokens.length, 1)
							const [token] = lexed.tokens
							assert.equal(token?.kind === "dollar" && token.body, `\n${body}\n`)
							c.note(tag === "$$" ? "$$" : tag === "$gz$" ? "$gz$" : "$gzN$")
						})
				)
			)
	)
})

/** The class of double a float literal holds: the specials no persisted number held, and the rest. */
type FloatFeature = "NaN" | "infinity" | "negative zero" | "finite"

/**
 * One grapheme of a name, never NUL: printable ASCII most often, then a scalar of the rest of the Basic Multilingual
 * Plane, an astral scalar, or a grapheme of several code points.
 */
const grapheme: Gen<string> = weighted([
	[4, characterOf(['"', "'", "$", " ", "-", "/", "*", "a", "Z", "_", "0", "\\", ";"] as const)],
	[2, codePoint(0x20, 0x7e)],
	[2, oneOf([codePoint(0xa0, 0xd7ff), codePoint(0xe000, 0xfffd)])],
	[1, codePoint(0x1_0000, 0x10_ffff)],
	[
		1,
		element([
			"e\u0301",
			"\u{1f44d}\u{1f3fd}",
			"\u{1f1eb}\u{1f1f7}",
			"\u{1f469}\u200d\u{1f467}"
		] as const)
	]
])

/** A name: up to twelve graphemes, or a spelling SQL reads as something else unquoted. */
const nameGen: Gen<string> = oneOf([
	string(grapheme, { min: 1, max: 12 }),
	element([
		"select",
		"NULL",
		'a"b',
		'""',
		"Mixed Case",
		"is null",
		"--",
		"/*",
		"$$",
		"\u00fcml"
	] as const)
])

describe("identifiers, types and literals", () => {
	it.effect("quotes every identifier so that it lexes back as that one name", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/quote-ident",
					draw: drawn(nameGen),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				(name) =>
					Effect.sync(() => {
						const lexed = lex(quoteIdent(name))
						assert.deepEqual(
							Arr.map(lexed.tokens, (token) =>
								token.kind === "quotedIdent" ? token.text : token.kind
							),
							[name]
						)
					})
			)
		)
	)

	it.effect(
		"a float literal of every double survives the snapshot and spells the double for the float input function",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/float-literal",
						/**
						 * The finite doubles, every scale as likely, and the specials, which a finite draw never holds and -0 which it
						 * holds too rarely to reach in 300 cases, one case in four.
						 */
						draw: drawn(
							weighted([
								[3, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
								[
									1,
									element([
										Number.NaN,
										Number.POSITIVE_INFINITY,
										Number.NEGATIVE_INFINITY,
										-0
									] as const)
								]
							])
						),
						literal: Formatter.format,
						features: features<FloatFeature>(["NaN", "infinity", "negative zero", "finite"]),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(x, c) =>
						Effect.sync(() => {
							const s = simpleSelect([target(lit.float(x, types.double))], [], undefined)
							const written = succeeded(
								writeJsonText(statementForm(s)),
								"the snapshot writer writes a float literal"
							)
							const read = succeeded(
								Schema.decodeUnknownResult(SqlStatementSchema)(
									succeeded(decode(written, noRevivers))
								),
								"the snapshot reader reads its own float literal"
							)
							assert.deepEqual(read, s, "the snapshot's codec reads the literal back as itself")
							/** JavaScript's own reading of a number's text stands in for the float input function. */
							const text = printStatement(s)
							const [spelled, ...more] = Arr.flatMap(lex(text).tokens, (token) =>
								token.kind === "string" ? [token.text] : []
							)
							assert.ok(
								spelled !== undefined && more.length === 0,
								`${text} spells the double as one string`
							)
							assert.ok(
								Object.is(Number(spelled), x),
								`${text} spells another double than ${Formatter.format(x)}`
							)
							c.note(
								Number.isNaN(x)
									? "NaN"
									: !Number.isFinite(x)
										? "infinity"
										: Object.is(x, -0)
											? "negative zero"
											: "finite"
							)
						})
				)
			)
	)
})
