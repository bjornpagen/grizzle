/**
 * Compute.parseDecimal on PostgreSQL 19rc1: over drawn pairs of decimal texts (test/support/lexical.ts decimalTextGen),
 * each part's count of digits at an edge the parse turns on (256 integer and 255 fraction digits, the widest
 * numeric(p, s) form's, and the form's own 16,384 bytes, numeric's 16,383 fraction digits among them), leading and
 * trailing zeros, signs, bare fractions, trailing points and zeros, the second of a pair the first's value spelled
 * again, one unit either side in its last place, negated, moved a place, or drawn apart, three implementations agree
 * exactly:
 *
 * - XML Schema 1.1's decimal lexical and canonical mappings written from their definition in BigInt
 *   (test/support/oracle/evaluate/decimal-text.ts), apart from the engine and PostgreSQL;
 * - grizzle's host evaluator (scalar/compute/evaluate.ts) over the parse as a check lowers it;
 * - PostgreSQL: the parse's SQL as a check lowers it, over every text, read by numeric_out; and an installed relation of
 *   the downstream's range shape, its two texts typed str.bytes(16384, str.regex(decimalText)), whose generated fields
 *   store whether the first's value is below the second's and whether they are one value, and the first's value itself
 *   where a guard bounds its text within 500 bytes, cast into numeric(1000, 499), which that bound proves it fits.
 *
 * The oracle is the reference mapping. Bound: up to 24 pairs a case, each case one installation in a transaction rolled
 * back.
 *
 *
 * Plants: compute-parse-decimal-scale (the host's decimal text reads one place too far right).
 *
 * Features: each digit-count edge and each relation of a pair's second text to its first.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { numericMaxFractionDigits } from "#compiler/ir/scalar.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { decimalText, decimalTextMaxBytes, str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { decimalTextGen } from "#test/support/lexical.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	canonicalDecimal,
	decimalOrder,
	type DecimalValue,
	referenceDecimal,
	significantDigits
} from "#test/support/oracle/evaluate/decimal-text.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	field,
	lowerWith,
	plainRender,
	renderSql,
	spelledExpr,
	v
} from "#test/unit/compute/support.ts"

type Feature =
	| "past 256 integer digits"
	| "past 255 fraction digits"
	| "the form's last byte"
	| "numeric's most fraction digits"
	| "a negative zero"
	| "leading zeros"
	| "trailing zeros"
	| "a bare fraction"
	| "a trailing point"
	| "a leading plus"
	| "one value spelled twice"
	| "a pair out of order"
	| "a value stored"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"past 256 integer digits",
	"past 255 fraction digits",
	"the form's last byte",
	"numeric's most fraction digits",
	"a negative zero",
	"leading zeros",
	"trailing zeros",
	"a bare fraction",
	"a trailing point",
	"a leading plus",
	"one value spelled twice",
	"a pair out of order",
	"a value stored"
]

/** A pair of decimal texts, the downstream's range: a low end and a high end. */
interface Pair {
	readonly low: string
	readonly high: string
}

/** The most bytes of a low end whose value the relation stores, and the numeric(p, s) that holds every such value. */
const storedBytes = 500
const Stored = pg.numeric(storedBytes * 2, storedBytes - 1)

/** A text's value by the reference mapping: every drawn text is a member of the grammar. */
const valueOf = (text: string): DecimalValue =>
	defined(referenceDecimal(text), `${text} names a value`)

/** A value plus `step` units in its last place, its sign following the sum. */
const stepped = (value: DecimalValue, step: bigint): DecimalValue => {
	const signed = (value.negative ? -value.digits : value.digits) + step
	return { negative: signed < 0n, digits: signed < 0n ? -signed : signed, scale: value.scale }
}

/** A value moved a place: ten times it, or a tenth of it, exactly. */
const shifted = (value: DecimalValue, up: boolean): DecimalValue =>
	up ? { ...value, digits: value.digits * 10n } : { ...value, scale: value.scale + 1n }

/**
 * The high end of a pair beside its low end's value: the value again in its canonical spelling, with zeros before it or
 * after its point, or a plus sign; one unit either side in its last place; its negation; a place either way; or a text
 * drawn apart. Only spellings within the form's bytes are drawn.
 */
const highGen =
	(low: string): Gen<string> =>
	(source) => {
		const value = valueOf(low)
		const canonical = canonicalDecimal(value)
		const magnitude = canonicalDecimal({ ...value, negative: false })
		const neighbours = [
			canonical,
			`${value.negative ? "-" : ""}00${magnitude}`,
			`${canonical}${value.scale === 0n ? "." : ""}000`,
			value.negative ? canonical : `+${canonical}`,
			canonicalDecimal(stepped(value, 1n)),
			canonicalDecimal(stepped(value, -1n)),
			canonicalDecimal({ ...value, negative: !value.negative }),
			canonicalDecimal(shifted(value, true)),
			canonicalDecimal(shifted(value, false)),
			low
		]
		const within = Arr.filter(neighbours, (text) => text.length <= decimalTextMaxBytes.value)
		return source.draw(
			weighted([
				[4, element(nonEmpty(within, "the low end itself is within the form"))],
				[1, decimalTextGen]
			])
		)
	}

const pairGen: Gen<Pair> = (source) => {
	const low = source.draw(decimalTextGen)
	return { low, high: source.draw(highGen(low)) }
}

/** The situations a text reaches, read from its own spelling and the reference's value. */
const textFeatures = (text: string): ReadonlyArray<Feature> => {
	const value = valueOf(text)
	const significant = significantDigits(value)
	const unsigned =
		Str.startsWith("+")(text) || Str.startsWith("-")(text) ? Str.slice(1)(text) : text
	const [integer, fraction] = Str.split(".")(unsigned)
	const facts: ReadonlyArray<readonly [Feature, boolean]> = [
		["past 256 integer digits", significant.integer > 256],
		["past 255 fraction digits", significant.fraction > 255],
		["the form's last byte", text.length === decimalTextMaxBytes.value],
		["numeric's most fraction digits", significant.fraction === numericMaxFractionDigits.value],
		["a negative zero", Str.startsWith("-")(text) && value.digits === 0n],
		["leading zeros", Str.startsWith("0")(integer) && integer.length > 1],
		["trailing zeros", fraction !== undefined && Str.endsWith("0")(fraction)],
		["a bare fraction", integer.length === 0],
		["a trailing point", fraction === ""],
		["a leading plus", Str.startsWith("+")(text)]
	]
	return Arr.map(
		Arr.filter(facts, ([, holds]) => holds),
		([feature]) => feature
	)
}

/** A decimal text the parse reads total: the form's pattern within its bytes. */
const KeyText = str.bytes(decimalTextMaxBytes.value, regexField<string>(decimalText.source, []))

/** The host evaluator's parse of a text: the evaluation, as a check lowers it, of parseDecimal(v). */
const keyField = field(describeFieldOrThrow(KeyText, SourceLoc("KeyText", [])).desc, "text")
const lowered = succeeded(
	lowerWith(
		"check",
		spelledExpr(computeCore.parseDecimal(v("v", keyField)).expr),
		{ v: { kind: "column", type: keyField.scalar } },
		false,
		baseParams
	)
).root.expr
const table = predicateTable(lowered)
const patterns = ProgramPatterns.of(tablePatterns(table))
const parseSql = renderSql(lowered, plainRender)

const hostValue = (text: string): DecimalValue => {
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
	return value instanceof Decimal
		? valueOf(value.toString())
		: assert.fail(`a Decimal, not ${Formatter.format(value)}`)
}

/**
 * The downstream's range: two decimal texts, whose generated fields store whether the low end's value is below the high
 * end's and whether the two are one value, and the low end's value where a guard bounds its text within storedBytes.
 */
const holds = (predicate: unknown): unknown =>
	computeCore.cond(
		predicate,
		computeCore.literal(pg.boolean, true),
		computeCore.literal(pg.boolean, false)
	)

const Ranges = relation.generated(
	"Ranges",
	{ id: pg.integer, low: KeyText, high: KeyText },
	["id"],
	(r) => ({
		below: generatedField(
			pg.boolean,
			holds(computeCore.lt(computeCore.parseDecimal(r.low), computeCore.parseDecimal(r.high))),
			[]
		),
		same: generatedField(
			pg.boolean,
			holds(computeCore.eq(computeCore.parseDecimal(r.low), computeCore.parseDecimal(r.high))),
			[]
		),
		stored: generatedField(
			Stored,
			computeCore.when(
				computeCore.within(computeCore.octetLength(r.low), 0, storedBytes),
				() => computeCore.cast(computeCore.parseDecimal(r.low), Stored),
				computeCore.literal(Stored, "0")
			),
			[]
		)
	})
)
const parsed = schema("ParseDecimal", { Ranges }, [])

const installationOf = Effect.gen(function* () {
	const substrate = yield* Substrate
	const schemaName = yield* substrate.schema({ create: false, label: "parse_decimal" })
	const owned = owning(parsed)
	const real = compileInstallation(owned, {
		...installOptions(owned, substrate.owner.role),
		levels: [identity.schema(parsedSchemaName(schemaName))]
	})
	return real.ok ? real.value : yield* Effect.die(new Error(`compile ${real.error.message}`))
})

/** One stored row: its generated fields as PostgreSQL's text prints them. */
interface StoredRow {
	readonly below: string
	readonly same: string
	readonly stored: string
}

/** Installs the relation on the pinned session in a transaction, stores `pairs`, reads each row back, rolls back. */
const storedRows = (
	pinned: PgConnection,
	installation: Installation,
	pairs: ReadonlyArray<Pair>
): Effect.Effect<ReadonlyArray<StoredRow>, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			const names = installationNamesOf(installation)
			const column = (name: "id" | "low" | "high" | "below" | "same" | "stored") =>
				names.column(Ranges, name)
			yield* pinned.query("BEGIN", [])
			for (const statement of installationSql(installation)) {
				yield* pinned.query(statement, [])
			}
			yield* pinned.query(
				`INSERT INTO ${names.table(Ranges)} (${column("id")}, ${column("low")}, ${column("high")}) SELECT r.ord, r.low, r.high FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, low text, high text)`,
				[jsonText(Arr.map(pairs, (pair, ord) => ({ ord, low: pair.low, high: pair.high })))]
			)
			const rows = yield* pinned.queryValues(
				`SELECT ${column("below")}::text, ${column("same")}::text, ${column("stored")}::text FROM ${names.table(Ranges)} ORDER BY ${column("id")}`,
				[]
			)
			return Arr.map(rows, (row) => ({
				below: String(row[0]),
				same: String(row[1]),
				stored: String(row[2])
			}))
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

/** The value PostgreSQL's numeric_out text names, by the reference mapping. */
const printed = (text: unknown): DecimalValue =>
	typeof text === "string"
		? valueOf(text)
		: assert.fail(`numeric_out text, not ${Formatter.format(text)}`)

/** Whether two values are one, by their canonical texts. */
const sameValue = (a: DecimalValue, b: DecimalValue): boolean =>
	canonicalDecimal(a) === canonicalDecimal(b)

/** A value of 257 integer digits, one past the widest numeric(p, s) form's. */
const pastEdge = `1${Str.repeat(256)("0")}`

layer(Substrate.layer)("Compute.parseDecimal on PostgreSQL 19", (it) => {
	it.effect(
		"the parse's SQL, a stored range, the host evaluator and XML Schema's decimal mapping agree exactly on every decimal text",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const db = yield* substrate.session(ownerSession())
					return yield* explore(
						{
							suite: "pg/compute/parse-decimal",
							draw: drawn(array(pairGen, { min: 1, max: 24 })),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "XML Schema 1.1's decimal lexical mapping in BigInt, against the host evaluator, the parse's SQL and a stored range's generated fields"
							},
							coverage: required<Feature>(features, { cases: 40, sense: notesOnly }),
							kept: [
								{
									note: "the downstream's ARIA value range past numeric(511, 255)'s form, whose texts read as an infinity of their sign and passed the range rule: a low end above its high end past 256 integer digits either side of zero, past 255 fraction digits, and one value spelled twice",
									sketch: [
										{ low: `2${Str.slice(1)(pastEdge)}`, high: pastEdge },
										{ low: `-${pastEdge}`, high: `-2${Str.slice(1)(pastEdge)}` },
										{
											low: `0.${Str.repeat(255)("0")}2`,
											high: `0.${Str.repeat(255)("0")}1`
										},
										{ low: pastEdge, high: `+${pastEdge}.000` }
									],
									draws: "",
									reaches: [
										"past 256 integer digits",
										"past 255 fraction digits",
										"one value spelled twice",
										"a pair out of order",
										"a value stored"
									]
								}
							],
							runs: 100,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(pairs, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const texts = Arr.flatMap(pairs, (pair) => [pair.low, pair.high])
									const computed = yield* db.values(
										`SELECT (${parseSql})::text FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`,
										[jsonText(Arr.map(texts, (text, ord) => ({ ord, v: text })))]
									)
									assert.equal(computed.length, texts.length, "a value per text")
									for (const [i, text] of texts.entries()) {
										const reference = valueOf(text)
										const label = `${Formatter.format(text)}: reference ${canonicalDecimal(reference)}`
										const host = hostValue(text)
										const database = printed(defined(computed[i], "its row")[0])
										assert.ok(
											sameValue(host, reference),
											`${label}, host ${canonicalDecimal(host)}`
										)
										assert.ok(
											sameValue(database, reference),
											`${label}, PostgreSQL ${canonicalDecimal(database)}`
										)
										c.noteAll(textFeatures(text))
									}
									const installation = yield* installationOf
									const pinned = yield* substrate.admin.pin
									const rows = yield* storedRows(pinned, installation, pairs)
									assert.equal(rows.length, pairs.length, "a row per pair")
									for (const [i, pair] of pairs.entries()) {
										const row = defined(rows[i], "its stored row")
										const order = decimalOrder(valueOf(pair.low), valueOf(pair.high))
										const label = `${Formatter.format(pair)}: order ${order}`
										assert.equal(row.below, order < 0 ? "true" : "false", `${label}, below`)
										assert.equal(row.same, order === 0 ? "true" : "false", `${label}, same`)
										if (pair.low.length <= storedBytes) {
											assert.ok(
												sameValue(printed(row.stored), valueOf(pair.low)),
												`${label}, stored ${row.stored}`
											)
											c.note("a value stored")
										}
										if (order === 0 && pair.low !== pair.high) {
											c.note("one value spelled twice")
										}
										if (order > 0) {
											c.note("a pair out of order")
										}
									}
								})
							)
					)
				})
			)
	)
})
