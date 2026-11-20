/** What the property of fact-sets.test.ts reads: its fixture, its space and its model. */

import { element, type Gen, option } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema } from "#compiler/public/schema.ts"
import { floatBits } from "#compiler/scalar/compute/float.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A parameter relation is a set of facts by their identity (scalar/values/identity.ts canonicalText), a float's -0 and
 * +0 two of them, and a ChangeSet member's rows are the facts it writes, so a write stores each float its caller states
 * with the bits it was written with, wherever the write reads the relation and however many times. The fixture's
 * relations, each of a double precision `value`:
 *
 * - Proj, keyed by (s, variable): a member that reads `given` and drops its `field`, so two facts of `given` can project
 *   onto one row, the merge a write's own set makes (check/merge.ts, write/insert/input.ts inputSet);
 * - Rec, keyed by (s, variable, field), of no float: the header that reads `given` beside its arm, as edullm's
 *   SnapshotRecord header reads `recordFloat` beside SnapshotRecordFloat;
 * - U, keyed by (s, variable): a member that is the union of two rules each reading `given` as Proj does, whose arms
 *   meet (the write placement's root union, lower/optimize/dedup/policy.ts);
 * - I, immutable, keyed by (s, variable): a put of Proj's member, which the DELETE-then-insert pair reads twice, so the
 *   write carries it (write/carriers/carriers.ts memberRows);
 * - Arm, mutable, keyed by (s, variable, field): a deletion of `gone` beside an insert of `given` in one stratum, which
 *   the deletion reads as D EXCEPT A (write/delete/exact.ts).
 */
const Proj = relation(
	"Proj",
	{ s: pg.bigint, variable: pg.bigint, value: pg["double precision"] },
	["s", "variable"]
)

const Rec = relation(
	"Rec",
	{ s: pg.bigint, variable: pg.bigint, field: pg.bigint, base: pg.bigint },
	["s", "variable", "field"]
)

const U = relation("U", { s: pg.bigint, variable: pg.bigint, value: pg["double precision"] }, [
	"s",
	"variable"
])

const I = relation("I", { s: pg.bigint, variable: pg.bigint, value: pg["double precision"] }, [
	"s",
	"variable"
])

const Arm = relation(
	"Arm",
	{ s: pg.bigint, variable: pg.bigint, field: pg.bigint, value: pg["double precision"] },
	["s", "variable", "field"]
)

export const Facts = schema("Facts", [Proj, Rec, U, I, Arm], [mutable(Arm)])

/** A parameter relation's facts whole, each at the call's snapshot: `gone`'s, a deletion's member. */
const goneFacts = query(Facts).rule((r) => {
	const gone = r.relation("gone", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(gone, "gone")
	return r
		.match(gone, { variable, field, value })
		.find({ s: r.param("s", pg.bigint), variable, field, value })
})

/** `given`'s facts whole, each at the call's snapshot: an insert's member beside `gone`'s deletion. */
const givenFacts = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(given, "given")
	return r
		.match(given, { variable, field, value })
		.find({ s: r.param("s", pg.bigint), variable, field, value })
})

/** `given` with its field dropped: each fact's value under its variable. */
const projected = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(given, "given")
	return r
		.match(given, { variable, field, value })
		.find({ s: r.param("s", pg.bigint), variable, value })
})

/** The union of two rules, each `given` with its field dropped. */
const unioned = query(Facts)
	.rule((r) => {
		const given = r.relation("given", {
			variable: pg.bigint,
			field: pg.bigint,
			value: pg["double precision"]
		})
		const { variable, field, value } = v(given, "first")
		return r
			.match(given, { variable, field, value })
			.find({ s: r.param("s", pg.bigint), variable, value })
	})
	.rule((r) => {
		const given = r.relation("given", {
			variable: pg.bigint,
			field: pg.bigint,
			value: pg["double precision"]
		})
		const { variable, field, value } = v(given, "second")
		return r
			.match(given, { variable, field, value })
			.find({ s: r.param("s", pg.bigint), variable, value })
	})

/** Each fact of `given`'s header: its variable and field, its value dropped. */
const header = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(given, "given")
	return r
		.match(given, { variable, field, value })
		.find({ s: r.param("s", pg.bigint), variable, field, base: 1n })
})

/** The writes, each under its name in the workload, beside the load of Arm's stored fact. */
const programs = Object.freeze({
	load: ChangeSet.empty(Facts).insert(Arm, []),
	once: ChangeSet.empty(Facts).insert(Proj, projected),
	twice: ChangeSet.empty(Facts).insert(Proj, projected).insert(Rec, header),
	thrice: ChangeSet.empty(Facts).insert(U, unioned).insert(Rec, header),
	carried: ChangeSet.empty(Facts).put(I, projected),
	swap: ChangeSet.empty(Facts).delete(Arm, goneFacts).insert(Arm, givenFacts)
})

/** The writes a case makes, by how they read `given`: once, twice (the arm and its header), three times (a union's two
 * rules and the header), carried by a put, and beside a deletion of `gone` in its stratum. */
const writes = ["once", "twice", "thrice", "carried", "swap"] as const satisfies ReadonlyArray<
	keyof typeof programs
>
export type Write = (typeof writes)[number]

/**
 * The doubles a case writes: both zeros, NaN, the least subnormal of each sign, the least normal and a plain value, so
 * every class of PostgreSQL's equality a zero's sign splits meets one it does not.
 */
const values: Arr.NonEmptyReadonlyArray<number> = [
	-0,
	0,
	Number.NaN,
	-5e-324,
	5e-324,
	2.2250738585072014e-308,
	1.5
]

/** A case: a write, the value of `given`'s first fact, and its second fact's, at another field of the same variable. */
export interface Sketch {
	readonly write: Write
	readonly first: number
	readonly second: Option.Option<number>
}

export const sketchGen: Gen<Sketch> = (source) => ({
	write: source.draw(element(writes)),
	first: source.draw(element(values)),
	second: source.draw(option(element(values)))
})

/** Where a case writes: its snapshot and its variable. */
export const at = { s: 7n, variable: 1n } as const

/** `given`'s facts: the first at field 1, the second, if any, at field 2. */
export const givenOf = (
	s: Sketch
): ReadonlyArray<{ variable: bigint; field: bigint; value: number }> => [
	{ variable: at.variable, field: 1n, value: s.first },
	...Option.match(s.second, {
		onNone: () => [],
		onSome: (value) => [{ variable: at.variable, field: 2n, value }]
	})
]

/** One fact as its identity reads it: Object.is, NaN being NaN. */
const sameFact = (a: number, b: number): boolean => Object.is(a, b)

/** What a write answers, and the bits each float it stored holds, by relation, as float8send gives them. */
export interface Answer {
	readonly outcome: "accepted" | "unchanged" | "refused" | "outsideWorld"
	readonly stored: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
}

/** A double's IEEE 754 bits, as float8send gives them, in hex: every NaN in PostgreSQL's one form. */
export const bitsOf = (value: number): string =>
	Str.padStart(16, "0")(BigInt.asUintN(64, floatBits(value)).toString(16))

/**
 * The fact identity's answer. A projection of `given` onto (s, variable, value) holds each fact's value as written, one
 * fact for two of one identity and two facts at one key, refused, for two whose values differ, if only in a zero's sign.
 * The swap's deletion of `gone`, the stored fact, beside the insert of `given`'s first fact deletes it unless the two are
 * one fact, which the stratum's addition keeps; either way Arm then holds the fact written.
 */
export const expected = (s: Sketch): Answer => {
	if (s.write === "swap") {
		return {
			outcome: sameFact(s.first, gone(s)) ? "unchanged" : "accepted",
			stored: [["Arm", [bitsOf(s.first)]]]
		}
	}
	const second = Option.getOrUndefined(s.second)
	const projectedValues =
		second === undefined || sameFact(s.first, second) ? [s.first] : [s.first, second]
	if (projectedValues.length > 1) {
		return { outcome: "refused", stored: storedBy(s.write, []) }
	}
	return { outcome: "accepted", stored: storedBy(s.write, [bitsOf(s.first)]) }
}

/** The value the swap's stored fact and its deletion hold: the second value, or the first's other zero, or the first. */
export const gone = (s: Sketch): number =>
	Option.getOrElse(s.second, () => (s.first === 0 ? (Object.is(s.first, -0) ? 0 : -0) : s.first))

/** The relations a write stores a float in, each with its stored bits. */
const storedBy = (
	write: Exclude<Write, "swap">,
	bits: ReadonlyArray<string>
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
	switch (write) {
		case "once":
		case "twice":
			return [["Proj", bits]]
		case "thrice":
			return [["U", bits]]
		case "carried":
			return [["I", bits]]
	}
}

/** The bits each stored row's `value` holds, as float8send gives them, in hex, in their order. */
export const storedBits = (
	installed: Installed,
	name: string
): Effect.Effect<ReadonlyArray<string>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const column = quoteIdent(installed.names.column(name, "value"))
		const rows = yield* s.admin.queryValues(
			`SELECT pg_catalog.encode(pg_catalog.float8send(${column}), 'hex') FROM ${printObjectName(installed.names.relation(name))} ORDER BY 1`,
			[]
		)
		return Arr.map(rows, (row) => String(row[0]))
	})

/** The writes that read `given` as a projection, each case's facts one of the three counts `featureOf` tells apart. */
type Projecting = Exclude<Write, "swap">

/** The features a case reaches: a projecting write of one fact, of one fact stated twice, of two facts at one key; the
 * swap of the stored fact, of its other zero, of another fact. */
export type Feature =
	| `${Projecting} of one fact`
	| `${Projecting} of one fact twice`
	| `${Projecting} of two facts at one key`
	| "swap of the stored fact"
	| "swap of its other zero"
	| "swap of another fact"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	...Arr.flatMap(
		["once", "twice", "thrice", "carried"] as const,
		(w) => [`${w} of one fact`, `${w} of one fact twice`, `${w} of two facts at one key`] as const
	),
	"swap of the stored fact",
	"swap of its other zero",
	"swap of another fact"
]

/** The feature a case reaches. */
export const featureOf = (s: Sketch): Feature => {
	const write = s.write
	if (write === "swap") {
		const stored = gone(s)
		return sameFact(s.first, stored)
			? "swap of the stored fact"
			: s.first === stored
				? "swap of its other zero"
				: "swap of another fact"
	}
	return Option.match(s.second, {
		onNone: (): Feature => `${write} of one fact`,
		onSome: (second): Feature =>
			sameFact(s.first, second) ? `${write} of one fact twice` : `${write} of two facts at one key`
	})
}

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const factsInstall = Object.freeze({ label: "fact_sets", programs })

/** Facts installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const factsTemplate = fixtureTemplate(import.meta, Facts, factsInstall)
