/** What the property of fact-sets.test.ts reads: its fixture, its space and its model. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { aimed, element, type Gen, option } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
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
 * - I, mutable, keyed by (s, variable): a put of Proj's member, a described put no proof updates in place, so the
 *   DELETE-then-insert pair (write/put/choose.ts unproved) reads it twice and the write carries it
 *   (write/carriers/carriers.ts memberRows);
 * - Arm, mutable, keyed by (s, variable, field): a deletion of `gone` beside an insert of `given` in one stratum, which
 *   the deletion reads as D EXCEPT A (write/delete/exact.ts);
 * - P, mutable, keyed by (s, variable): a put of Proj's member over a stored fact, read back as P's added and removed
 *   facts, which the conservative realization reads off its state snapshots' difference (write/carriers/carriers.ts
 *   factDifference).
 *
 * Proj's member is also read by a region that leaves `field` unbound (`dropped`), so two facts of `given` meet in the
 * region itself, on a member's fact spine (lower/conservative/context.ts factSpine); and every write runs by both
 * artifacts, the optimized one generate serves and the conservative realization, the write oracle's baseline. The
 * relations a write changes sit in the unit of their `s`.
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

const P = relation("P", { s: pg.bigint, variable: pg.bigint, value: pg["double precision"] }, [
	"s",
	"variable"
])

export const Facts = schema(
	"Facts",
	[Proj, Rec, U, I, Arm, P],
	[mutable(I), mutable(Arm), mutable(P), unit("Sample", { s: pg.bigint })]
)

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

/** `given` matched without its field, each fact's value under its variable: the region itself may meet two facts. */
const dropped = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, value } = v(given, "given")
	return r.match(given, { variable, value }).find({ s: r.param("s", pg.bigint), variable, value })
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

/** The writes, each under its name in the workload, beside the load of Arm's and P's stored facts. P's added and removed
 * facts are read back whole. */
const programs = Object.freeze({
	loadArm: ChangeSet.empty(Facts).insert(Arm, []),
	loadP: ChangeSet.empty(Facts).insert(P, []),
	once: ChangeSet.empty(Facts).insert(Proj, projected),
	dropped: ChangeSet.empty(Facts).insert(Proj, dropped),
	replaced: ChangeSet.empty(Facts)
		.put(P, projected)
		.read("added", (d) =>
			query(Facts).rule((r) => {
				const { s, variable, value } = v(d.added(P), "added")
				return r.match(d.added(P), { s, variable, value }).find({ s, variable, value })
			})
		)
		.read("removed", (d) =>
			query(Facts).rule((r) => {
				const { s, variable, value } = v(d.removed(P), "removed")
				return r.match(d.removed(P), { s, variable, value }).find({ s, variable, value })
			})
		),
	twice: ChangeSet.empty(Facts).insert(Proj, projected).insert(Rec, header),
	thrice: ChangeSet.empty(Facts).insert(U, unioned).insert(Rec, header),
	carried: ChangeSet.empty(Facts).put(I, projected),
	swap: ChangeSet.empty(Facts).delete(Arm, goneFacts).insert(Arm, givenFacts)
})

/** The writes a case makes, by how they read `given`: once, by a region without its field, twice (the arm and its
 * header), three times (a union's two rules and the header), carried by a put, beside a deletion of `gone` in its
 * stratum, and by a put over a stored fact of P, read back as P's changes. */
const writes = [
	"once",
	"dropped",
	"twice",
	"thrice",
	"carried",
	"swap",
	"replaced"
] as const satisfies ReadonlyArray<keyof typeof programs>
export type Write = (typeof writes)[number]

/** The artifact a case's write runs by: the optimized one generate serves, or the conservative realization
 * (test/support/served-db.ts conservativeServedJson). */
const artifacts = ["optimized", "conservative"] as const
export type Artifact = (typeof artifacts)[number]

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

/** A case: the artifact, a write, the value of `given`'s first fact, and its second fact's, at another field of the same
 * variable. The swap and the put over P write the first alone, beside a stored fact of the second's value (`gone`). */
export interface Sketch {
	readonly artifact: Artifact
	readonly write: Write
	readonly first: number
	readonly second: Option.Option<number>
}

const sketchGen: Gen<Sketch> = (source) => ({
	artifact: source.draw(element(artifacts)),
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

/** What a write answers, the bits each float it stored holds, by relation, as float8send gives them, and the bits of
 * each value its read-backs read, by read-back, in order. */
export interface Answer {
	readonly outcome: "accepted" | "unchanged" | "refused" | "outsideWorld"
	readonly stored: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
	readonly reads: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
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
			stored: [["Arm", [bitsOf(s.first)]]],
			reads: []
		}
	}
	if (s.write === "replaced") {
		const same = sameFact(s.first, gone(s))
		return {
			outcome: same ? "unchanged" : "accepted",
			stored: [["P", [bitsOf(s.first)]]],
			reads: [
				["added", same ? [] : [bitsOf(s.first)]],
				["removed", same ? [] : [bitsOf(gone(s))]]
			]
		}
	}
	const second = Option.getOrUndefined(s.second)
	const projectedValues =
		second === undefined || sameFact(s.first, second) ? [s.first] : [s.first, second]
	if (projectedValues.length > 1) {
		return { outcome: "refused", stored: storedBy(s.write, []), reads: [] }
	}
	return { outcome: "accepted", stored: storedBy(s.write, [bitsOf(s.first)]), reads: [] }
}

/** The value the swap's and the put's stored fact holds, and the swap's deletion: the second value, or the first's other
 * zero, or the first. */
export const gone = (s: Sketch): number =>
	Option.getOrElse(s.second, () => (s.first === 0 ? (Object.is(s.first, -0) ? 0 : -0) : s.first))

/** The relations a write stores a float in, each with its stored bits. */
const storedBy = (
	write: Projecting,
	bits: ReadonlyArray<string>
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
	switch (write) {
		case "once":
		case "dropped":
		case "twice":
			return [["Proj", bits]]
		case "thrice":
			return [["U", bits]]
		case "carried":
			return [["I", bits]]
	}
}

/** The bits of each value a read-back reads, in order. */
export const readBits = (rows: Iterable<{ readonly value: number }>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (row) => bitsOf(row.value)),
		Str.Order
	)

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
type Projecting = Exclude<Write, "swap" | "replaced">

/** The writes of the first fact alone over a stored fact. */
type OverStored = Extract<Write, "swap" | "replaced">

/** The features a case reaches, by each artifact: a projecting write of one fact, of one fact stated twice, of two facts
 * at one key; the swap and the put over P of the stored fact, of its other zero, of another fact. */
export type Feature = `${Artifact}: ${
	| `${Projecting} of one fact`
	| `${Projecting} of one fact twice`
	| `${Projecting} of -0 and +0 at one key`
	| `${Projecting} of two other facts at one key`
	| `${OverStored} of the stored fact`
	| `${OverStored} of its other zero`
	| `${OverStored} of another fact`}`

export const features: Arr.NonEmptyReadonlyArray<Feature> = Arr.flatMap(
	artifacts,
	(a) =>
		[
			...Arr.flatMap(
				["once", "dropped", "twice", "thrice", "carried"] as const,
				(w) =>
					[
						`${a}: ${w} of one fact`,
						`${a}: ${w} of one fact twice`,
						`${a}: ${w} of -0 and +0 at one key`,
						`${a}: ${w} of two other facts at one key`
					] as const
			),
			...Arr.flatMap(
				["swap", "replaced"] as const,
				(w) =>
					[
						`${a}: ${w} of the stored fact`,
						`${a}: ${w} of its other zero`,
						`${a}: ${w} of another fact`
					] as const
			)
		] as const
)

/** The feature a case reaches. */
export const featureOf = (s: Sketch): Feature => {
	const { artifact, write } = s
	if (write === "swap" || write === "replaced") {
		const stored = gone(s)
		return sameFact(s.first, stored)
			? `${artifact}: ${write} of the stored fact`
			: s.first === stored
				? `${artifact}: ${write} of its other zero`
				: `${artifact}: ${write} of another fact`
	}
	return Option.match(s.second, {
		onNone: (): Feature => `${artifact}: ${write} of one fact`,
		onSome: (second): Feature =>
			sameFact(s.first, second)
				? `${artifact}: ${write} of one fact twice`
				: s.first === second
					? `${artifact}: ${write} of -0 and +0 at one key`
					: `${artifact}: ${write} of two other facts at one key`
	})
}

/** The second values a case may hold: none, or each value. */
const seconds: ReadonlyArray<Option.Option<number>> = [
	Option.none(),
	...Arr.map(values, Option.some)
]

/**
 * A write's cases, each aimed at its situation: a case of the situation's artifact and write, its values drawn among
 * the pairs that reach it, so every situation is a witness's first draw and its values are any of the ones it holds.
 */
export const sketchSpace = aimed(
	sketchGen,
	Arr.map(features, (feature) => {
		const reaching = Arr.flatMap(artifacts, (artifact) =>
			Arr.flatMap(writes, (write) =>
				Arr.flatMap(values, (first) =>
					Arr.filter(
						Arr.map(seconds, (second): Sketch => ({ artifact, write, first, second })),
						(s) => featureOf(s) === feature
					)
				)
			)
		)
		const cases = element(nonEmpty(reaching, `a case of ${feature}`))
		const aim: Gen<Sketch> = (source) => source.draw(cases)
		return [feature, aim] as const
	})
)

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const factsInstall = Object.freeze({ label: "fact_sets", programs })

/** Facts installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const factsTemplate = fixtureTemplate(import.meta, Facts, factsInstall)

/** A read of `given` whole, each fact its variable, field and value. */
const readWhole = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(given, "given")
	return r.match(given, { variable, field, value }).find({ variable, field, value })
})

/** `given` filtered by its variable. */
const readFiltered = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(given, "given")
	return r
		.match(given, { variable, field, value })
		.where(r.eq(variable, r.param("variable", pg.bigint)))
		.find({ variable, field, value })
})

/** `given` joined to Rec's stored fact at its variable and field. */
const readJoined = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(given, "given")
	const { base } = v(Rec, "rec")
	return r
		.match(given, { variable, field, value })
		.match(Rec, { s: r.param("s", pg.bigint), variable, field, base })
		.find({ variable, field, value, base })
})

/** `given` with its field dropped: a merge, which takes each float's canonical zero. */
const readProjected = query(Facts).rule((r) => {
	const given = r.relation("given", {
		variable: pg.bigint,
		field: pg.bigint,
		value: pg["double precision"]
	})
	const { variable, field, value } = v(given, "given")
	return r.match(given, { variable, field, value }).find({ variable, value })
})

/** The reads of a parameter relation, by name: whole, filtered, joined to a stored fact, and projected. */
export const reads = Object.freeze({
	whole: readWhole,
	filtered: readFiltered,
	joined: readJoined,
	projected: readProjected
})
export type Read = keyof typeof reads
const readNames = [
	"whole",
	"filtered",
	"joined",
	"projected"
] as const satisfies ReadonlyArray<Read>

/** The lowering a read runs by: the optimized one generate serves, or the conservative baseline. */
const lowerings = ["optimized", "conservative"] as const
export type Lowering = (typeof lowerings)[number]

/** A read's case: its lowering, its read, and `given`'s two facts' values at one variable and one field. */
export interface ReadSketch {
	readonly lowering: Lowering
	readonly read: Read
	readonly first: number
	readonly second: Option.Option<number>
}

const readSketchGen: Gen<ReadSketch> = (source) => ({
	lowering: source.draw(element(lowerings)),
	read: source.draw(element(readNames)),
	first: source.draw(element(values)),
	second: source.draw(option(element(values)))
})

/** `given`'s facts of a read's case: one, or two at one variable and one field, which differ in their value alone. */
export const readGivenOf = (
	s: ReadSketch
): ReadonlyArray<{ variable: bigint; field: bigint; value: number }> => [
	{ variable: at.variable, field: 1n, value: s.first },
	...Option.match(s.second, {
		onNone: () => [],
		onSome: (value) => [{ variable: at.variable, field: 1n, value }]
	})
]

/** A float's canonical zero, the value a merge delivers for it: +0 for either zero, every other value itself. */
const canonical = (x: number): number => (x === 0 ? 0 : x)

/**
 * The fact identity's answer to a read, each delivered value's bits in order: the whole, filtered and joined reads
 * deliver each fact of `given`, -0 and +0 two of them, every NaN one; the projection is a merge, which delivers each
 * value's canonical zero, one row for -0 and +0.
 */
export const expectedRead = (s: ReadSketch): ReadonlyArray<string> => {
	const facts = Arr.dedupeWith(
		Arr.map(readGivenOf(s), (f) => f.value),
		sameFact
	)
	const delivered =
		s.read === "projected" ? Arr.dedupeWith(Arr.map(facts, canonical), sameFact) : facts
	return Arr.sort(Arr.map(delivered, bitsOf), Str.Order)
}

/** The features a read's case reaches: each read by each lowering of one fact, one fact stated twice, -0 and +0, and two
 * other facts. */
export type ReadFeature = `${Lowering}: ${Read} of ${
	| "one fact"
	| "one fact twice"
	| "-0 and +0"
	| "two other facts"}`

export const readFeatures: Arr.NonEmptyReadonlyArray<ReadFeature> = Arr.flatMap(lowerings, (l) =>
	Arr.flatMap(
		readNames,
		(r) =>
			[
				`${l}: ${r} of one fact`,
				`${l}: ${r} of one fact twice`,
				`${l}: ${r} of -0 and +0`,
				`${l}: ${r} of two other facts`
			] as const
	)
)

/** The feature a read's case reaches. */
export const readFeatureOf = (s: ReadSketch): ReadFeature =>
	Option.match(s.second, {
		onNone: (): ReadFeature => `${s.lowering}: ${s.read} of one fact`,
		onSome: (second): ReadFeature =>
			sameFact(s.first, second)
				? `${s.lowering}: ${s.read} of one fact twice`
				: s.first === second
					? `${s.lowering}: ${s.read} of -0 and +0`
					: `${s.lowering}: ${s.read} of two other facts`
	})

/**
 * A read's cases, each aimed at its situation: a case of the situation's lowering and read, its values drawn among the
 * pairs that reach it, so every situation is a witness's first draw and its values are any of the ones it holds.
 */
export const readSketchSpace = aimed(
	readSketchGen,
	Arr.map(readFeatures, (feature) => {
		const reaching = Arr.flatMap(lowerings, (lowering) =>
			Arr.flatMap(readNames, (read) =>
				Arr.flatMap(values, (first) =>
					Arr.filter(
						Arr.map(seconds, (second): ReadSketch => ({ lowering, read, first, second })),
						(s) => readFeatureOf(s) === feature
					)
				)
			)
		)
		const cases = element(nonEmpty(reaching, `a case of ${feature}`))
		const aim: Gen<ReadSketch> = (source) => source.draw(cases)
		return [feature, aim] as const
	})
)

/** Rec's stored fact the joined read meets, at the case's snapshot, variable and field 1. */
export const storeRec = (installed: Installed): Effect.Effect<void, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const column = (field: string) => quoteIdent(installed.names.column("Rec", field))
		yield* s.admin.queryValues(
			`INSERT INTO ${printObjectName(installed.names.relation("Rec"))} (${Arr.join(
				Arr.map(["s", "variable", "field", "base"], column),
				", "
			)}) VALUES (7, 1, 1, 1)`,
			[]
		)
	})
