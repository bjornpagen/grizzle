/**
 * Compute.parseDouble on PostgreSQL 19rc1: over drawn decimal texts of doubles (test/support/lexical.ts doubleTextGen),
 * weighted at every point binary64's rounding turns on (the greatest finite double and the overflow threshold past it,
 * the least normal, subnormals, half the least subnormal, midpoints between neighbouring doubles, each exactly, cut
 * short and one digit past), digits of up to 40 places and past 700 near either threshold and far past both, signed
 * zeros, the special spellings, and every spelling the form admits, three implementations agree to the bit, -0 apart
 * from +0 and any NaN with any:
 *
 * - IEEE 754-2019's conversion from decimal character sequences written from its definition in exact rational
 *   arithmetic (test/support/oracle/evaluate/double-text.ts), apart from the engine, ECMAScript and PostgreSQL;
 * - grizzle's host evaluator (scalar/compute/evaluate.ts) over the parse as a check lowers it;
 * - the value PostgreSQL stores in an installed relation's generated field `parseDouble(key)`, its key typed by
 *   doubleText, read by float8send: the installer's own DDL, so the parse's SQL is held IMMUTABLE and raising on no
 *   member as a generation expression, every drawn row inserted.
 *
 * The oracle is the reference conversion. Bound: up to 48 texts a case, each case one installation in a transaction
 * rolled back.
 *
 * Plants: compute-parse-double-inf (the host reads INF as no number).
 *
 * Features: each rounding point and spelling the form admits.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import * as Engine from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { doubleText } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { regexField } from "#compiler/text/field.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { doubleTextGen } from "#test/support/lexical.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	bitsOfNumber,
	type Conversion,
	decimalTextOf,
	referenceConversion,
	sameDouble
} from "#test/support/oracle/evaluate/double-text.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { baseParams, lowerWith, spelledExpr, testPg, v } from "#test/unit/compute/support.ts"

type Feature =
	| "a special spelling"
	| "an overflow to an infinity"
	| "an underflow to a zero"
	| "a negative zero"
	| "a subnormal"
	| "the greatest finite double"
	| "a tie"
	| "more than 15 significant digits"
	| "more than 17 significant digits"
	| "an exponent past 400 in magnitude"
	| "a leading plus"
	| "a bare fraction"
	| "a trailing point"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a special spelling",
	"an overflow to an infinity",
	"an underflow to a zero",
	"a negative zero",
	"a subnormal",
	"the greatest finite double",
	"a tie",
	"more than 15 significant digits",
	"more than 17 significant digits",
	"an exponent past 400 in magnitude",
	"a leading plus",
	"a bare fraction",
	"a trailing point"
]

const signBit = 1n << 63n
const infinityBits = 0x7ff0000000000000n
const greatestFiniteBits = 0x7fefffffffffffffn
const leastNormalBits = 1n << 52n

/** A text's characters up to its exponent, and the exponent it writes, zero where it writes none. */
const splitExponent = (text: string): { readonly mantissa: string; readonly exponent: bigint } => {
	const characters = Arr.fromIterable(text)
	const at = Arr.findFirstIndex(characters, (ch) => ch === "e" || ch === "E")
	return Option.match(at, {
		onNone: () => ({ mantissa: text, exponent: 0n }),
		onSome: (e) => ({
			mantissa: Str.slice(0, e)(text),
			exponent: BigInt(Str.slice(e + 1)(text))
		})
	})
}

/** The digits of a whole number's text before its trailing zeros. */
const significantDigits = (digits: string): number => {
	const characters = Arr.fromIterable(digits)
	const last = Arr.findLastIndex(characters, (ch) => ch !== "0")
	return Option.match(last, { onNone: () => 0, onSome: (i) => i + 1 })
}

/** The situations a text and its conversion reach, read from the text's own parts and the reference's encoding. */
const featuresOf = (text: string, conversion: Conversion): ReadonlyArray<Feature> => {
	const read = decimalTextOf(text)
	if (read?.kind !== "finite") {
		return ["a special spelling"]
	}
	const magnitude = conversion.bits & ~signBit
	const significant = significantDigits(read.value.digits.toString())
	const { mantissa, exponent } = splitExponent(text)
	const unsigned =
		Str.startsWith("+")(mantissa) || Str.startsWith("-")(mantissa)
			? Str.slice(1)(mantissa)
			: mantissa
	const facts: ReadonlyArray<readonly [Feature, boolean]> = [
		["an overflow to an infinity", magnitude === infinityBits],
		["an underflow to a zero", magnitude === 0n && read.value.digits !== 0n],
		["a negative zero", conversion.bits === signBit],
		["a subnormal", magnitude > 0n && magnitude < leastNormalBits],
		["the greatest finite double", magnitude === greatestFiniteBits],
		["a tie", conversion.tie],
		["more than 15 significant digits", significant > 15],
		["more than 17 significant digits", significant > 17],
		["an exponent past 400 in magnitude", exponent > 400n || exponent < -400n],
		["a leading plus", Str.startsWith("+")(text)],
		["a bare fraction", Str.startsWith(".")(unsigned)],
		["a trailing point", Str.endsWith(".")(mantissa)]
	]
	return Arr.map(
		Arr.filter(facts, ([, holds]) => holds),
		([feature]) => feature
	)
}

/** The host evaluator's parse of a text: the evaluation, as a generated field's check lowers it, of parseDouble(v). */
const keyField = testPg.regex(doubleText.source, "u")
const lowered = succeeded(
	lowerWith(
		"check",
		spelledExpr(computeCore.parseDouble(v("v", keyField)).expr),
		{ v: { kind: "column", type: keyField.scalar } },
		false,
		baseParams
	)
).root.expr
const table = predicateTable(lowered)
const patterns = ProgramPatterns.of(tablePatterns(table))

const hostBits = (text: string): bigint => {
	const value = succeeded(
		Engine.mapError(
			evaluateTable(
				table.exprs,
				table.root,
				{ value: undefined, column: () => text, closed: () => undefined },
				patterns
			),
			(stop) => new Error(Formatter.format(stop))
		),
		"the host evaluates it"
	)
	return typeof value === "number"
		? bitsOfNumber(value)
		: assert.fail(`a double, not ${Formatter.format(value)}`)
}

const Keys = relation.generated(
	"Keys",
	{ id: pg.integer, key: regexField<string>(doubleText.source, []) },
	["id"],
	(r) => ({ value: generated(pg["double precision"], Compute.parseDouble(r.key)) })
)
const parsed = schema("ParseDouble", { Keys }, [])

const installationOf = Effect.gen(function* () {
	const substrate = yield* Substrate
	const schemaName = yield* substrate.schema({ create: false, label: "parse_double" })
	const owned = owning(parsed)
	const real = compileInstallation(owned, {
		...installOptions(owned, substrate.owner.role),
		levels: [identity.schema(parsedSchemaName(schemaName))]
	})
	return real.ok ? real.value : yield* Effect.die(new Error(`compile ${real.error.message}`))
})

/** Installs the relation on the pinned session in a transaction, stores `texts`, reads each value's bits, rolls back. */
const storedBits = (
	pinned: PgConnection,
	database: string,
	installation: Installation,
	texts: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<bigint>, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			const names = installationNamesOf(installation)
			yield* pinned.query("BEGIN", [])
			for (const statement of installationSql(installation, database)) {
				yield* pinned.query(statement, [])
			}
			yield* pinned.query(
				`INSERT INTO ${names.table(Keys)} (${names.column(Keys, "id")}, ${names.column(Keys, "key")}) SELECT r.ord, r.v FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v text)`,
				[jsonText(Arr.map(texts, (text, ord) => ({ ord, v: text })))]
			)
			const rows = yield* pinned.queryValues(
				`SELECT pg_catalog.float8send(${names.column(Keys, "value")})::text FROM ${names.table(Keys)} ORDER BY ${names.column(Keys, "id")}`,
				[]
			)
			return Arr.map(rows, (row) => BigInt(`0x${Str.slice(2)(String(defined(row[0])))}`))
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

layer(Substrate.layer)("Compute.parseDouble on PostgreSQL 19", (it) => {
	it.effect(
		"a stored parse, the host evaluator and IEEE 754's conversion agree to the bit on every double's text",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					return yield* explore(
						{
							suite: "pg/compute/parse-double",
							draw: drawn(array(doubleTextGen, { min: 1, max: 48 })),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "IEEE 754's decimal-to-binary64 conversion in exact rational arithmetic, against the host evaluator and a stored generated field"
							},
							coverage: required<Feature>(features, { cases: 40, sense: notesOnly }),
							kept: [
								{
									note: "qti-pie's xs:double map keys, each refused before by the cast's bounded form: past 15 digits, past the exponent bound, the greatest finite double, the least subnormal, and an overflow and an underflow",
									sketch: [
										"1e294",
										"1.2345678901234567",
										"1.7976931348623157e308",
										"5e-324",
										"1e400",
										"1e-400"
									],
									draws: "",
									reaches: [
										"more than 15 significant digits",
										"the greatest finite double",
										"a subnormal",
										"an overflow to an infinity",
										"an underflow to a zero"
									]
								}
							],
							runs: 100,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(texts, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const installation = yield* installationOf
									const pinned = yield* substrate.admin.pin
									const stored = yield* storedBits(pinned, substrate.database, installation, texts)
									assert.equal(stored.length, texts.length, "a row per text")
									for (const [i, text] of texts.entries()) {
										const reference = defined(referenceConversion(text), "a member of the form")
										const host = hostBits(text)
										const database = defined(stored[i], "its stored value")
										const label = `${Formatter.format(text)}: reference ${reference.bits.toString(16)}`
										assert.ok(
											sameDouble(host, reference.bits),
											`${label}, host ${host.toString(16)}`
										)
										assert.ok(
											sameDouble(database, reference.bits),
											`${label}, PostgreSQL ${database.toString(16)}`
										)
										c.noteAll(featuresOf(text, reference))
									}
								})
							)
					)
				})
			)
	)
})
