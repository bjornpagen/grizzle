/**
 * The parse on PostgreSQL 19rc2: for every candidate text (test/support/lexical.ts), the host and the database agree on
 * whether the text is a member of its target's lexical form and on the value it names.
 *
 * - **Membership:** PostgreSQL's verdict on the form's ARE, the translation the text analysis gives str.regex domains
 *   and Compute.matches (text/refinement.ts), and on its octet_length within the form's byte bound where it has one,
 *   equals the host scan's (scalar/lexical.ts lexicalValue), which the unit suite holds to the form's pattern and to
 *   the specification.
 * - **Value:** where PostgreSQL finds a member, the parse grizzle prints (the cast `t::T`, numeric's typmod included,
 *   plain numeric for a decimal text, and for a date make_date over the text's parts, sql/lexical.ts) reads to the
 *   host's value: an integer, a decimal by equality, a double exactly (PostgreSQL's float8in against the host's
 *   rational rounding, half to even), a boolean, and a date by its day number after 0001-01-01, so no DateStyle enters
 *   the comparison.
 * - **No DateStyle:** the session runs under DateStyle `SQL, DMY`, so a parse that read the session's date order
 *   (date_in, text::date) would read 2024-03-04 as another day; make_date reads none.
 * - **No raise:** every member parses without an error, which a raise would make the batch's statement fail; the
 *   parse runs only under its membership's CASE, as a guarded law column or Compute.when runs it.
 *
 * Oracle: PostgreSQL itself, the form's ARE and the printed parse. Bound: batches of up to 160 candidates of every
 * target, 300 batches a run.
 *
 * Plants: scalar-lexical-boolean-one (the host's boolean parse reads "1" as no member).
 *
 * Features: every candidate shape of test/support/lexical.ts.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { dayNumber, datePartSlices, toCalendarDate } from "#compiler/ir/date.ts"
import { parseDoubleForm } from "#compiler/lower/conservative/expr/parse-double.ts"
import { toFloat } from "#compiler/scalar/compute/cast.ts"
import {
	formOctets,
	formSource,
	type LexicalTarget,
	lexicalValue
} from "#compiler/scalar/lexical.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { convertDouble } from "#compiler/scalar/values/float.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import { binary, cast, lit, numericType, tableCol, types } from "#compiler/sql/build.ts"
import { dateOfText } from "#compiler/sql/lexical.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	type Candidate,
	candidateGen,
	type Shape,
	sameValue,
	shapes
} from "#test/support/lexical.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const roundDouble = (negative: boolean, num: bigint, den: bigint): number =>
	toFloat(negative, num, den, "float8")

/** The SQL type a target's cast names, numeric's typmod included. */
const targetType = (
	target: Exclude<LexicalTarget, { readonly kind: "date" | "doubleText" }>
): TypeRef => {
	switch (target.kind) {
		case "integer":
			return target.carrier === "int2"
				? types.smallint
				: target.carrier === "int4"
					? types.integer
					: types.bigint
		case "decimal":
			return numericType(target.typmod.precision, target.typmod.scale)
		case "double":
			return types.double
		case "boolean":
			return types.boolean
		case "decimalText":
			return types.numeric
	}
}

/**
 * The parse of the column `t` as grizzle prints it, as text: the cast, for a date its day number after 0001-01-01,
 * which reads no DateStyle, and for a double's text Compute.parseDouble's form.
 */
const parsedOf = (target: LexicalTarget, t: Expr): Expr => {
	switch (target.kind) {
		case "date":
			return binary(
				"-",
				dateOfText(t, datePartSlices),
				cast(lit.text("0001-01-01", types.text), types.date)
			)
		case "doubleText":
			return parseDoubleForm(t)
		case "integer":
		case "decimal":
		case "double":
		case "boolean":
		case "decimalText":
			return cast(t, targetType(target))
	}
}

const parseSql = (target: LexicalTarget): string =>
	printExpr(cast(parsedOf(target, tableCol("t")), types.text))

/** The ARE of a target's form, as the text analysis translates it for PostgreSQL. */
const areOf = (target: LexicalTarget): string =>
	succeeded(analyzeText([{ source: formSource(target), flags: "u" }], SourceLoc("lexicalForm", [])))
		.members[0].are

/** Whether PostgreSQL's text of a parsed value is the host's value of the member. */
const agrees = (target: LexicalTarget, text: string, value: unknown): boolean => {
	switch (target.kind) {
		case "integer":
			return typeof value === "bigint" && BigInt(text) === value
		case "decimal":
		case "decimalText":
			return value instanceof Decimal && Decimal.fromOutput(text).equals(value)
		case "double":
		case "doubleText":
			return sameValue(convertDouble(text), value)
		case "boolean":
			return value === (text === "true")
		case "date":
			return (
				typeof value === "string" && Number(text) === dayNumber(succeeded(toCalendarDate(value)))
			)
	}
}

/** PostgreSQL's membership of `t` in a target's form: a match of its ARE, `$2`, within its byte bound, if any. */
const memberSql = (target: LexicalTarget): string => {
	const match = "u.t COLLATE pg_catalog.pg_c_utf8 ~ $2::text"
	const octets = formOctets(target)
	return octets === undefined ? match : `(${match} AND pg_catalog.octet_length(u.t) <= ${octets})`
}

/** A target's key, which groups a batch's candidates into one statement per target. */
const targetKey = (target: LexicalTarget): string => Formatter.format(target)

layer(Substrate.layer)("lexical parse: the host and PostgreSQL 19 agree", (it) => {
	it.effect(
		"on every candidate's membership in its form and on the value its parse reads, under a foreign DateStyle",
		(ctx) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const db = yield* s.session(ownerSession())
				yield* db.query("SET DateStyle = 'SQL, DMY'", [])
				return yield* searched(
					ctx,
					explore(
						{
							suite: "pg/scalar/lexical-parse",
							draw: drawn(array(candidateGen, { min: 1, max: 160 })),
							literal: Formatter.format,
							coverage: required<Shape>(shapes, { cases: 300, sense: notesOnly }),
							kept: [],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang,
							oracle: {
								kind: "postgresql",
								name: "the form's ARE and the printed parse, run under DateStyle SQL, DMY"
							}
						},
						(batch, c) =>
							Effect.gen(function* () {
								const groups = Arr.groupBy(batch, (x) => targetKey(x.target))
								for (const group of Rec.values(groups)) {
									const target = defined(group[0], "a group's first candidate").target
									const rows = yield* db.values(
										`SELECT (${memberSql(target)})::text,
										        CASE WHEN ${memberSql(target)} THEN ${parseSql(target)} END
										 FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i) ORDER BY u.i`,
										[Arr.map(group, (x: Candidate) => x.text), areOf(target)]
									)
									assert.equal(rows.length, group.length, targetKey(target))
									for (const [i, row] of rows.entries()) {
										const x = defined(group[i], "a row's candidate")
										c.note(x.shape)
										const label = `${targetKey(target)} ${Formatter.format(x.text)}`
										const host = lexicalValue(target, x.text, roundDouble)
										const member = row[0] === "true"
										assert.equal(member, host !== undefined, `${label}: membership`)
										if (member) {
											const text = row[1]
											assert.ok(
												typeof text === "string" && agrees(target, text, host),
												`${label}: PostgreSQL read ${Formatter.format(text)}, the host ${Formatter.format(host)}`
											)
										}
									}
								}
							})
					)
				)
			})
	)
})
