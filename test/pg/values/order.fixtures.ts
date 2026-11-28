/** What the properties of order.test.ts read: the carriers' cases, a case's batch and PostgreSQL's order of it. */
import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import {
	type CalendarDate,
	dateOfDayNumber,
	dayNumber,
	lastCalendarDate
} from "#compiler/ir/date.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { type CarrierSpec, type HostValue, parseValue } from "#compiler/scalar/values/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import { closedIdTypeOf, scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	cases as codecCases,
	kindRosterCodes,
	setupIn
} from "#test/support/pg/codec/scalar.fixtures.ts"
import { type SqlNames, wireSql } from "#test/support/pg/codec/support.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { codecOf } from "#test/support/unit/codec/support.ts"

/**
 * The handles of an unordered roster, Mark, declared in no code order: the evaluator holds them in their canonical
 * order (ir/scalar.ts handlesInOrder), "Mu" < "alpha" < "zeta", while their codes, a hole among them, are zeta 0,
 * alpha 2, Mu 3, so the stored ids' order is neither.
 */
export const markHandles = ["zeta", "alpha", "Mu"] as const

/** The codebook of every roster a case reads: the round trip's rosters and Mark. */
export const orderCodes: Codebook = {
	rosters: new Map([
		...kindRosterCodes.rosters,
		[
			parsedName("Mark"),
			rosterCodec(parsedName("Mark"), [
				{ kind: "live", handle: "zeta" },
				{ kind: "hole" },
				{ kind: "live", handle: "alpha" },
				{ kind: "live", handle: "Mu" }
			])
		]
	]),
	spellings: noSpellings
}

/** Every date's day number, the first's 0. */
const lastDay = dayNumber(lastCalendarDate)

/** A date of the descriptor's range, its edges among them. */
const dateGen: Gen<CalendarDate> = (source) =>
	dateOfDayNumber(
		BigInt(source.draw(oneOf([int(0, lastDay), element([0, 1, lastDay - 1, lastDay])])))
	)

/** A date span: two distinct dates, the earlier its start. */
const dateSpanGen: Gen<Readonly<{ start: CalendarDate; end: CalendarDate }>> = (source) => {
	const a = dayNumber(source.draw(dateGen))
	const drawn = dayNumber(source.draw(dateGen))
	const b = drawn === a ? (a === lastDay ? a - 1 : a + 1) : drawn
	return {
		start: dateOfDayNumber(BigInt(Math.min(a, b))),
		end: dateOfDayNumber(BigInt(Math.max(a, b)))
	}
}

/**
 * A bytes value of up to six bytes, any byte or the few that make prefixes and their extensions common, so the order
 * of a value and its prefix, and of 0x00 against 0xff, is drawn often.
 */
const bytesGen: Gen<Uint8Array> = (source) =>
	Uint8Array.from(
		source.draw(
			oneOf([
				array(int(0, 255), { min: 0, max: 6 }),
				array(element([0, 1, 127, 128, 255]), { min: 0, max: 4 })
			])
		)
	)

/** A carrier's case: its label, its type, and its values as a caller writes them. */
interface OrderCase {
	readonly label: string
	readonly type: ScalarType
	readonly values: Gen<unknown>
	/**
	 * Whether the type's values have an order of the language: every carrier's but an unordered roster's closed ids,
	 * which the evaluator reads only the equality of, PostgreSQL's order of the stored ids being their codes'.
	 */
	readonly ordered: "ordered" | "equality"
}

/**
 * The cases: every carrier the codec round trip sends (scalar.fixtures.ts cases), a closed id of an ordered roster
 * with holes among them, and a date, a date span, a bytes value and a closed id of the unordered Mark.
 */
export const orderCases: Arr.NonEmptyReadonlyArray<OrderCase> = [
	...Arr.map(codecCases, (c): OrderCase => ({ ...c, ordered: "ordered" })),
	{ label: "date", type: plainType("date"), values: dateGen, ordered: "ordered" },
	{
		label: "daterange",
		type: scalarOf({ kind: "span", endpoint: { kind: "pg", type: "date" }, width: undefined }, {}),
		values: dateSpanGen,
		ordered: "ordered"
	},
	{ label: "bytea", type: scalarOf({ kind: "bytes" }, {}), values: bytesGen, ordered: "ordered" },
	{
		label: "unordered closed id",
		type: closedIdTypeOf("Mark", "unordered", nonEmpty([...markHandles])),
		values: element(markHandles),
		ordered: "equality"
	}
]

/** The case of `label`. */
export const orderCaseOf = (label: string): OrderCase =>
	Option.getOrThrowWith(
		Arr.findFirst(orderCases, (c) => c.label === label),
		() => new Error(`no carrier ${label}`)
	)

/** A carrier, by its case's label, and a batch of its values. */
interface Batch {
	readonly label: string
	readonly values: ReadonlyArray<unknown>
}

export const batchGen: Gen<Batch> = (source) => {
	const c = source.draw(element(orderCases))
	return { label: c.label, values: source.draw(array(c.values, { min: 1, max: 100 })) }
}

/** A carrier a case ordered, by its label. */
export type OrderFeature = `orders ${string}`

/** The codec's spec of a case's type, under the cases' codebook, whose closed ids rank by their codes. */
export const codecSpecOf = (type: ScalarType): CarrierSpec => carrierSpecOf(type, orderCodes)

/** The host value of a caller's value, the codec's admission of it (identity.ts parseValue), which every value drawn passes. */
export const hostValueOf = (type: ScalarType, value: unknown): HostValue =>
	succeeded(parseValue(codecSpecOf(type), value), "a drawn value is admitted")

/**
 * A value's text as the recordset sends it: the codec's parameter text, or a bytes value's hex escape, which bytea's
 * input reads, since a bytes value travels in binary and has no parameter text.
 */
const wireText = (type: ScalarType, value: unknown): string =>
	value instanceof Uint8Array
		? `\\x${Arr.join(
				Arr.map(Array.from(value), (b) => Str.padStart(2, "0")(b.toString(16))),
				""
			)}`
		: succeeded(codecOf(type, orderCodes).encode(value), "a drawn value encodes")

/**
 * The expression PostgreSQL orders a recordset's value by: the value at its wire type, a text under pg_c_utf8, the
 * collation every text column holds (codec/scalar.ts).
 */
export const orderedBy = (type: ScalarType, expr: string): string =>
	type.carrier === "text" ? `(${expr}) COLLATE pg_catalog.pg_c_utf8` : expr

/**
 * PostgreSQL's order of a batch: the positions of its values sent through jsonb_to_recordset at their wire type
 * (codec/support.ts wireSql), under ORDER BY of the value, ties by position.
 */
export const postgresOrder = (
	db: CaseSession,
	names: SqlNames,
	type: ScalarType,
	values: ReadonlyArray<unknown>
) =>
	Effect.map(
		db.values(
			`SELECT r.ord::text FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${wireSql(type, names)}) ORDER BY ${orderedBy(type, "r.v")}, r.ord`,
			[jsonText(Arr.map(values, (v, ord) => ({ ord, v: wireText(type, v) })))]
		),
		(rows): ReadonlyArray<number> => Arr.map(rows, (r) => Number(r[0]))
	)

/** A case's session made ready (scalar.fixtures.ts setupIn), its names reading the cases' codebook. */
export const orderSetup = (db: CaseSession, allocate: (label: string) => Effect.Effect<string>) =>
	Effect.map(setupIn(db, allocate), ({ names }) => ({ db, names: { ...names, codes: orderCodes } }))
