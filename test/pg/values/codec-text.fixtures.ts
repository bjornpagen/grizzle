/**
 * What the property of codec-text.test.ts reads: the carriers a value's text is of, the fields of every kind codecText
 * reads one through, a batch, the installations it is stored under, and PostgreSQL's reading of it there.
 */
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { codecText } from "#adapter/public/host.ts"
import { hostText } from "#compiler/codec/scalar.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { int8Max } from "#compiler/ir/carriers.ts"
import { type Codebook, declaredOrder, firstCodebook } from "#compiler/ir/codes.ts"
import { baseOf, type Carrier, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { TextedField } from "#compiler/program/text.ts"
import {
	accumulated,
	bits,
	closedId,
	contract,
	date,
	drawn,
	type Field,
	generated,
	natural,
	pg,
	slot,
	span
} from "#compiler/public/fields.ts"
import { closed, fin, relation } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { describeFieldOrThrow, type SqlTag } from "#compiler/scalar/registry.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import type { AccumulatedField, StoredOnlySql } from "#compiler/types/fields/field.ts"
import { kindHandles, setHandles, setWidths } from "#test/pg/codec/scalar.fixtures.ts"
import { type SqlNames, textOut, wireSql } from "#test/pg/codec/support.ts"
import {
	markHandles,
	orderCaseOf,
	orderCases,
	orderCodes,
	orderedBy
} from "#test/pg/values/order.fixtures.ts"
import { type AnyResult, succeeded } from "#test/support/assert.ts"
import { Id, idKey } from "#test/support/ids.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { codecOf } from "#test/unit/codec/support.ts"

/**
 * The kinds of field a relation holds, each of which has a text: a caller's, written by its caller, and each that
 * grizzle or PostgreSQL writes, drawn(natural), accumulated(type, start), generated(type, term), and a closed
 * relation's slot(type, fin).
 */
const fieldKinds = ["caller", "drawn", "accumulated", "generated", "slot"] as const

type FieldKind = (typeof fieldKinds)[number]

/** What a case reached: a carrier whose values it gave a text, by its label, or a kind of field it read one through. */
export type TextFeature = `texts ${string}` | `reads ${FieldKind}`

/**
 * What a case reads its values' texts by: a function of the value alone, a CodecFault for a value it does not admit, a
 * carrier's by the engine's hostText and a field's by the public codecText, which answers Effect's Result.
 */
type Texts = (value: unknown) => AnyResult<string, CodecFault>

/**
 * A case: its label, the type PostgreSQL judges its texts at, its values as a caller writes them, the situation it
 * reaches, and its texts, read over its batch.
 */
interface TextCase {
	readonly label: string
	readonly type: ScalarType
	readonly values: Gen<unknown>
	readonly feature: TextFeature
	/** Its texts, read once a batch: `first` is the batch's first value, which an accumulated field starts at. */
	readonly texts: (first: unknown) => Texts
}

/**
 * The carriers a value's text is of (codec/scalar.ts hostText): every case of order.fixtures.ts but bytea, a bytes
 * value being stored only, with no text, each read at its own type.
 */
const carrierCases: ReadonlyArray<TextCase> = Arr.flatMap(
	orderCases,
	(c): ReadonlyArray<TextCase> =>
		c.type.carrier === "bytes"
			? []
			: [
					{
						label: c.label,
						type: c.type,
						values: c.values,
						feature: `texts ${c.label}`,
						texts: () => hostText(c.type)
					}
				]
)

/** A field type with a text, a descriptor a builder made, of any host type. */
type Declared = Field<unknown, Exclude<SqlTag, StoredOnlySql>, unknown>

/**
 * A type a field is declared of: its label, its descriptor, its values as a caller writes them, and its accumulated
 * field starting at a value, a consumer's contract's under its key (types/fields MintKey).
 */
interface DeclaredCarrier {
	readonly label: string
	readonly type: Declared
	readonly values: Gen<unknown>
	readonly accumulate: (first: unknown) => AccumulatedField<Declared>
}

/** A declared type over the values of order.fixtures.ts's case of `label`, whose type is the descriptor's. */
const declaredOf = (label: string, type: Declared): DeclaredCarrier => ({
	label,
	type,
	values: orderCaseOf(label).values,
	accumulate: (first) => accumulated(type, first)
})

/** A consumer's contract over the values of order.fixtures.ts's case of `label`, accumulated under its key. */
const contractOf = (label: string, type: Declared, key: symbol): DeclaredCarrier => ({
	label,
	type,
	values: orderCaseOf(label).values,
	accumulate: (first) => accumulated(type, first, key)
})

/** The rosters of order.fixtures.ts's closed ids and sets, as a schema declares them, each under its name and handles. */
const Kind = closed.ordered("Kind", kindHandles)
const Mark = closed.unordered("Mark", markHandles)

/** natural, as a field of any declared type reads it. */
const naturalType: Declared = natural

/** natural, over naturals: bigints never below zero, their edges among them. */
const naturalCarrier: DeclaredCarrier = {
	label: "natural",
	type: naturalType,
	values: oneOf([bigint(0n, int8Max), element([0n, 1n, int8Max])]),
	accumulate: (first) => accumulated(naturalType, first)
}

/** boolean. */
const booleanCarrier = declaredOf("boolean", pg.boolean)

/** A closed id of Kind, a slot's type. */
const kindCarrier = declaredOf("closed id", closedId(Kind))

const centsKey = Symbol("Cents")
/**
 * Every type a field is declared of that has a text, by a builder, each over the values of its carrier's case: every
 * carrier of order.fixtures.ts that a field has (numeric and text at no typmod or pattern are no field's), a contract,
 * and natural.
 */
const declaredCarriers: Arr.NonEmptyReadonlyArray<DeclaredCarrier> = [
	declaredOf("smallint", pg.smallint),
	declaredOf("integer", pg.integer),
	declaredOf("bigint", pg.bigint),
	declaredOf("numeric(7,2)", pg.numeric(7, 2)),
	declaredOf("real", pg.real),
	declaredOf("double precision", pg["double precision"]),
	declaredOf("money", pg.money),
	booleanCarrier,
	contractOf("uuid", Id, idKey),
	declaredOf("text", str.regex("^.*$", "su")),
	kindCarrier,
	declaredOf("set", bits(Kind)),
	...Arr.map(setWidths, (w) =>
		declaredOf(`set over ${w} codes`, bits(closedBuilder(`Set${w}`, setHandles(w), "ordered", [])))
	),
	declaredOf("int4range", span(pg.integer, undefined)),
	declaredOf("int8range", span(pg.bigint, undefined)),
	declaredOf("vector(3)", pg.vector(3)),
	declaredOf("vector(16)", pg.vector(16)),
	contractOf(
		"contract Cents",
		contract<typeof centsKey>()("Cents", pg.bigint, undefined, undefined),
		centsKey
	),
	declaredOf("date", date),
	declaredOf("daterange", span(date, undefined)),
	declaredOf("unordered closed id", closedId(Mark)),
	naturalCarrier
]

/** The type a field of a declared type is judged at: the descriptor's own, as the registry reads it, its column's. */
const typeOf = (type: Declared): ScalarType =>
	describeFieldOrThrow(type, SourceLoc("a declared type", [])).scalar

/** The carriers of no accumulated field, whose value type is none of them: a span's and a vector's. */
const unaccumulable: ReadonlySet<Carrier> = new Set(["range4", "range8", "rangeDate", "vector"])

/**
 * The case of a field of `kind` declared of `carrier`: codecText of `field`, the field as a caller reads it off its
 * relation's value, judged at the declared type, which its column is of.
 */
const fieldCase = (
	kind: FieldKind,
	carrier: DeclaredCarrier,
	field: (first: unknown) => TextedField<unknown>
): TextCase => ({
	label: `${kind} ${carrier.label}`,
	type: typeOf(carrier.type),
	values: carrier.values,
	feature: `reads ${kind}`,
	texts: (first) => codecText(field(first))
})

/** The owner of a closed relation's slots, and its count of them: Kind's three handles. */
const Owner = closed.ordered("Owner", ["owner"])
const Slots = closed.relation(
	"Slots",
	{ owner: closedId(Owner), n: natural },
	["owner"],
	[{ owner: "owner", n: 3n }]
)

/**
 * The fields of every kind, each the one field of a relation of its own beside its key: a caller's of every declared
 * type; drawn(natural); an accumulated field of every value type, starting at its batch's first value; a generated
 * field of every declared type, its term the written field of that type; and a closed relation's
 * slot over Kind's closed id.
 */
const fieldCases: ReadonlyArray<TextCase> = [
	...Arr.map(declaredCarriers, (c) =>
		fieldCase("caller", c, () => relation("Texted", { id: Id, x: c.type }, ["id"]).fields.x)
	),
	fieldCase(
		"drawn",
		naturalCarrier,
		() => relation("Texted", { id: Id, x: drawn(natural) }, ["id"]).fields.x
	),
	...Arr.map(
		Arr.filter(declaredCarriers, (c) => !unaccumulable.has(typeOf(c.type).carrier)),
		(c) =>
			fieldCase(
				"accumulated",
				c,
				(first) => relation("Texted", { id: Id, x: c.accumulate(first) }, ["id"]).fields.x
			)
	),
	...Arr.map(declaredCarriers, (c) =>
		fieldCase(
			"generated",
			c,
			() =>
				relation.generated("Texted", { id: Id, w: c.type }, ["id"], (row) => ({
					x: generated(c.type, row.w)
				})).fields.x
		)
	),
	fieldCase(
		"slot",
		kindCarrier,
		() =>
			closed.relation(
				"Texted",
				{ owner: closedId(Owner), x: slot(closedId(Kind), fin(Slots, "n")) },
				["owner", "x"],
				[]
			).fields.x
	)
]

/**
 * The cases (program/text.ts codecText): every carrier read at its own type, and every kind of field read through
 * codecText over each type it is declared of.
 */
const textCases: Arr.NonEmptyReadonlyArray<TextCase> = nonEmpty([...carrierCases, ...fieldCases])

/** The case of `label`. */
export const textCaseOf = (label: string): TextCase =>
	Option.getOrThrowWith(
		Arr.findFirst(textCases, (c) => c.label === label),
		() => new Error(`no case ${label}`)
	)

/** The cases, by the situation each reaches: a carrier's one case, or every case of a kind of field. */
const casesBySituation = nonEmpty(
	Arr.map(Arr.dedupe(Arr.map(textCases, (c) => c.feature)), (feature) =>
		nonEmpty(Arr.filter(textCases, (c) => c.feature === feature))
	)
)

/** The situations the cases reach: each carrier's, and each kind of field's. */
export const textSituations: ReadonlyArray<TextFeature> = Arr.map(
	casesBySituation,
	(group) => group[0].feature
)

/** A case, by its label, and a batch of its values as a caller writes them. */
interface TextBatch {
	readonly label: string
	readonly values: ReadonlyArray<unknown>
}

/**
 * A situation, then a case of it, and a batch of up to 100 of its values, so every carrier and every kind of field is
 * drawn alike, and equal values and every carrier's edges meet in one batch.
 */
export const textBatchGen: Gen<TextBatch> = (source) => {
	const c = source.draw(element(source.draw(element(casesBySituation))))
	return { label: c.label, values: source.draw(array(c.values, { min: 1, max: 100 })) }
}

/**
 * The installations a batch is stored under, by their codes: a fresh one's, each handle coded by its position in its
 * roster's order (ir/codes.ts firstCodebook), and one migrated twice, its rosters' codes with holes (order.fixtures.ts
 * orderCodes), so a closed id's stored code is no function of its handle alone.
 */
export const installationsOf = (type: ScalarType): readonly [Codebook, Codebook] => [
	firstCodebook(((roster) => (roster === undefined ? [] : [roster]))(rosterOf(type))),
	orderCodes
]

/** The positions of a batch's values, grouped by equal text, each group in order, the groups by their first position. */
export const textClasses = (texts: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<number>> => {
	const byText = new Map<string, Array<number>>()
	for (const [ord, text] of texts.entries()) {
		const group = byText.get(text) ?? []
		group.push(ord)
		byText.set(text, group)
	}
	return [...byText.values()]
}

/** A value's text as the recordset sends it under an installation's codes: its codec's parameter text there. */
const wireText = (codes: Codebook, type: ScalarType, value: unknown): string =>
	succeeded(codecOf(type, codes).encode(value), "a drawn value encodes")

/** The recordset of a batch sent at the values' wire type under an installation's codes, each row its position. */
const recordsetOf = (codes: Codebook, type: ScalarType, values: ReadonlyArray<unknown>): string =>
	jsonText(Arr.map(values, (v, ord) => ({ ord, v: wireText(codes, type, v) })))

/**
 * The expressions PostgreSQL tells a batch's values apart by: its order's (order.fixtures.ts orderedBy), and after it,
 * for a float, its binary image (float4send, float8send), since its equality holds -0 and +0 equal and they are two
 * values (scalar/values/float.ts), whose binary images differ as those of no other two values its equality holds equal.
 */
const identifiedBy = (type: ScalarType, expr: string): string => {
	const { carrier } = baseOf(type)
	const ordered = orderedBy(type, expr)
	return carrier === "float4" || carrier === "float8"
		? `${ordered}, ${carrier}send(${expr})`
		: ordered
}

/**
 * PostgreSQL's classes of a batch's values, stored under an installation's codes, each class one value: the positions of
 * its values sent through jsonb_to_recordset at their wire type (codec/support.ts wireSql), grouped by their rank under
 * ORDER BY of the value, a text under pg_c_utf8, whose peers are the values its B-tree equality holds equal: the type's
 * default operator class, which an extension's type such as pgvector's has off the search path, where `=` is not found;
 * a float's two zeros apart (`identifiedBy`). Each group is in order, the groups by their first position.
 */
export const postgresClasses = (
	db: CaseSession,
	names: SqlNames,
	type: ScalarType,
	values: ReadonlyArray<unknown>
) =>
	Effect.map(
		db.values(
			`SELECT string_agg(c.ord::text, ',' ORDER BY c.ord) FROM (SELECT r.ord, dense_rank() OVER (ORDER BY ${identifiedBy(type, "r.v")}) AS k FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${wireSql(type, names)})) AS c GROUP BY c.k ORDER BY min(c.ord)`,
			[recordsetOf(names.codes, type, values)]
		),
		(rows): ReadonlyArray<ReadonlyArray<number>> =>
			Arr.map(rows, (r) => Arr.map(Str.split(String(r[0]), ","), Number))
	)

/**
 * The positions of a batch whose text PostgreSQL's input function of the type does not read as the value: each value
 * at its wire type, and its text read at that type, ranked together as `postgresClasses` ranks a batch, a position
 * whose two rank apart, NaN being equal to NaN there and a float's -0 read as +0 apart from it.
 */
export const postgresUnread = (
	db: CaseSession,
	names: SqlNames,
	type: ScalarType,
	texted: ReadonlyArray<{ readonly value: unknown; readonly text: string }>
) => {
	const wire = wireSql(type, names)
	return Effect.map(
		db.values(
			`WITH r AS (SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${wire}, t text)), both_sides AS (SELECT r.ord, r.v AS x FROM r UNION ALL SELECT r.ord, CAST(r.t AS ${wire}) FROM r), ranked AS (SELECT b.ord, dense_rank() OVER (ORDER BY ${identifiedBy(type, "b.x")}) AS k FROM both_sides AS b) SELECT ranked.ord::text FROM ranked GROUP BY ranked.ord HAVING min(ranked.k) <> max(ranked.k) ORDER BY ranked.ord`,
			[
				jsonText(
					Arr.map(texted, ({ value, text }, ord) => ({
						ord,
						v: wireText(names.codes, type, value),
						t: text
					}))
				)
			]
		),
		(rows): ReadonlyArray<number> => Arr.map(rows, (r) => Number(r[0]))
	)
}

/**
 * What an installation's names spell of a batch of closed ids or sets stored under its codes: each value as PostgreSQL
 * stores it, its output text read back through the installation's codec, which names each stored code by the handle it
 * holds there (codec/read.ts), a closed id's handle and a set's handles in its roster's declared order as a JSON array,
 * in the batch's order.
 */
export const postgresSpelled = (
	db: CaseSession,
	names: SqlNames,
	type: Extract<ScalarType, { readonly carrier: "code" | "bits" }>,
	values: ReadonlyArray<unknown>
) => {
	const codec = codecOf(type, names.codes)
	const rank = declaredOrder(defined(rosterOf(type), "a closed id's or a set's roster")).rank
	return Effect.map(
		db.values(
			`SELECT ${textOut(type, "r.v")} FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${wireSql(type, names)}) ORDER BY r.ord`,
			[recordsetOf(names.codes, type, values)]
		),
		(rows): ReadonlyArray<string> =>
			Arr.map(rows, (r) => {
				const stored = succeeded(codec.read(String(r[0])), "a stored value reads back")
				if (typeof stored === "string") {
					return stored
				}
				if (!(stored instanceof Set)) {
					return assert.fail("a closed id reads back as its handle and a set as its handles")
				}
				const rankOf = (handle: unknown): number =>
					defined(
						typeof handle === "string" ? rank.get(handle) : undefined,
						"a stored handle's rank"
					)
				return jsonText(Arr.sort([...stored], Order.mapInput(Order.Number, rankOf)))
			})
	)
}
