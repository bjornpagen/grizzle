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
import { toFloat } from "#compiler/scalar/compute/cast.ts"
import { formSource, type LexicalTarget, lexicalValue } from "#compiler/scalar/lexical.ts"
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

/**
 * The parse on PostgreSQL 19rc1: for every candidate text (test/support/lexical.ts), the host and the database agree on
 * whether the text is a member of its target's lexical form and on the value it names.
 *
 * - **Membership:** PostgreSQL's verdict on the form's ARE, the translation the text analysis gives str.regex domains
 *   and Compute.matches (text/refinement.ts), equals the host scan's (scalar/lexical.ts lexicalValue), which the unit
 *   suite holds to the form's pattern and to the specification.
 * - **Value:** where PostgreSQL finds a member, the parse grizzle prints (the cast `t::T`, numeric's typmod included,
 *   and for a date make_date over the text's parts, sql/lexical.ts) reads to the host's value: an integer, a decimal by
 *   equality, a double exactly (PostgreSQL's float8in against the host's rational rounding, half to even), a boolean,
 *   and a date by its day number after 0001-01-01, so no DateStyle enters the comparison.
 * - **No DateStyle:** the session runs under DateStyle `SQL, DMY`, so a parse that read the session's date order
 *   (date_in, text::date) would read 2024-03-04 as another day; make_date reads none.
 * - **No raise:** every member parses without an error, which a raise would make the batch's statement fail; the
 *   parse runs only under its membership's CASE, as a guarded law column or Compute.when runs it.
 *
 * The oracle is PostgreSQL. Bound: batches of up to 160 candidates of every target, 300 batches a run.
 */
const roundDouble = (negative: boolean, num: bigint, den: bigint): number =>
	toFloat(negative, num, den, "float8")

/** The SQL type a target's cast names, numeric's typmod included. */
const targetType = (target: Exclude<LexicalTarget, { readonly kind: "date" }>): TypeRef => {
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
	}
}

/**
 * The parse of the column `t` as grizzle prints it, as text: the cast, or for a date its day number after 0001-01-01,
 * which reads no DateStyle.
 */
const parseSql = (target: LexicalTarget): string => {
	const t = tableCol("t")
	const parsed: Expr =
		target.kind === "date"
			? binary(
					"-",
					dateOfText(t, datePartSlices),
					cast(lit.text("0001-01-01", types.text), types.date)
				)
			: cast(t, targetType(target))
	return printExpr(cast(parsed, types.text))
}

/** The ARE of a target's form, as the text analysis translates it for PostgreSQL. */
const areOf = (target: LexicalTarget): string =>
	succeeded(analyzeText(formSource(target), "u", SourceLoc("lexicalForm", []))).are

/** Whether PostgreSQL's text of a parsed value is the host's value of the member. */
const agrees = (target: LexicalTarget, text: string, value: unknown): boolean => {
	switch (target.kind) {
		case "integer":
			return typeof value === "bigint" && BigInt(text) === value
		case "decimal":
			return value instanceof Decimal && Decimal.fromOutput(text).equals(value)
		case "double":
			return sameValue(convertDouble(text), value)
		case "boolean":
			return value === (text === "true")
		case "date":
			return (
				typeof value === "string" && Number(text) === dayNumber(succeeded(toCalendarDate(value)))
			)
	}
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
										`SELECT (u.t COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text,
										        CASE WHEN u.t COLLATE pg_catalog.pg_c_utf8 ~ $2::text THEN ${parseSql(target)} END
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
