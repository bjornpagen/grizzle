/** What the properties of generated-source.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { Type } from "#compiler/public/compute.ts"
import { closedId, date, generated, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, key, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { bareRecord } from "#test/support/assert.ts"

const tiers = ["low", "mid", "high"] as const

type TierHandle = (typeof tiers)[number]

/** Each tier's rate, as Rate holds it: high holds none, so a high row's rate has no value. */
const rates: Readonly<Record<TierHandle, number | undefined>> = { low: 1, mid: 2, high: undefined }

const Tier = closed.ordered("Tier", tiers)

const Rate = closed.relation(
	"Rate",
	{ tier: closedId(Tier), rate: pg.integer },
	["tier"],
	[
		{ tier: "low", rate: 1 },
		{ tier: "mid", rate: 2 }
	]
)

const NumeralText = str.regex("^[0-9]{1,6}$", "u")

/** Days of 2024 whose text is a date's in every month: the 10th to the 19th of January to September. */
const DayText = str.regex("^2024-0[1-9]-1[0-9]$", "u")

const written = Object.freeze({
	id: pg.integer,
	v: pg.bigint,
	tier: closedId(Tier),
	k: NumeralText,
	day: DayText
})

const Item = relation.generated("Item", written, ["id"], (r) => ({
	copy: generated(pg.bigint, r.v),
	rate: generated(pg.integer, Rate.at("rate", r.tier)),
	parsed: generated(pg.bigint, Type.cast(r.k, pg.bigint)),
	when: generated(date, Type.cast(r.day, date))
}))

const Spot = relation.generated("Spot", written, ["id"], (r) => ({
	copy: generated(pg.bigint, r.v),
	rate: generated(pg.integer, Rate.at("rate", r.tier)),
	parsed: generated(pg.bigint, Type.cast(r.k, pg.bigint)),
	when: generated(date, Type.cast(r.day, date))
}))

const itemNumeral = key(on(Item, "k"))

const spotNumeral = key(on(Spot, "k"))

export const Items = schema(
	"Items",
	[Tier, Rate, Item, Spot],
	[itemNumeral, spotNumeral, mutable(Spot)]
)

/**
 * The full world's workload: each relation's rows as grizzle reads them, generated fields included; each relation's
 * seed, an insert of each call's rows; and the case's write, an insert or a put of each relation from a query over the
 * relation parameter `rows`, delivered as they are.
 */
const programs = Object.freeze({
	itemRows: query(Items).rule((r) => {
		const { id, v: value, tier, k, day, copy, rate, parsed, when } = v(Item, "item")
		return r
			.match(Item, { id, v: value, tier, k, day, copy, rate, parsed, when })
			.find({ id, v: value, tier, k, day, copy, rate, parsed, when })
	}),
	spotRows: query(Items).rule((r) => {
		const { id, v: value, tier, k, day, copy, rate, parsed, when } = v(Spot, "spot")
		return r
			.match(Spot, { id, v: value, tier, k, day, copy, rate, parsed, when })
			.find({ id, v: value, tier, k, day, copy, rate, parsed, when })
	}),
	seedItem: ChangeSet.empty(Items).insert(Item, []),
	seedSpot: ChangeSet.empty(Items).insert(Spot, []),
	insertItem: ChangeSet.empty(Items).insert(
		Item,
		query(Items).rule((r) => {
			const rows = r.relation("rows", written)
			const row = v(rows, "row")
			return r.match(rows, row).find(row)
		})
	),
	putItem: ChangeSet.empty(Items).put(
		Item,
		query(Items).rule((r) => {
			const rows = r.relation("rows", written)
			const row = v(rows, "row")
			return r.match(rows, row).find(row)
		})
	),
	insertSpot: ChangeSet.empty(Items).insert(
		Spot,
		query(Items).rule((r) => {
			const rows = r.relation("rows", written)
			const row = v(rows, "row")
			return r.match(rows, row).find(row)
		})
	),
	putSpot: ChangeSet.empty(Items).put(
		Spot,
		query(Items).rule((r) => {
			const rows = r.relation("rows", written)
			const row = v(rows, "row")
			return r.match(rows, row).find(row)
		})
	)
})

/** A row as a case states it. */
export interface Row {
	readonly id: number
	readonly v: bigint
	readonly tier: TierHandle
	readonly k: Numeral
}

/** The numerals a row draws, so rows often share one. */
const numerals = ["0", "1", "2"] as const

type Numeral = (typeof numerals)[number]

/** Each numeral's day: a row's day text is its numeral's, so the day adds no dimension to the space. */
const dayOf = {
	"0": "2024-01-10",
	"1": "2024-02-11",
	"2": "2024-09-19"
} as const satisfies Readonly<Record<Numeral, string>>

/** A row as its relation stores its written fields, its day its numeral's. */
export const writtenOf = (row: Row) => ({ ...row, day: dayOf[row.k] })

export type Target = "Item" | "Spot"

export interface Case {
	readonly target: Target
	readonly op: "insert" | "put"
	/** The rows stored before the write: lawful, at distinct keys and numerals, of tiers Rate holds. */
	readonly stored: ReadonlyArray<Row>
	/** The rows the write's query delivers. */
	readonly source: Arr.NonEmptyReadonlyArray<Row>
}

const rowGen =
	(tierGen: Gen<TierHandle>): Gen<Row> =>
	(source) => ({
		id: source.draw(int(1, 3)),
		v: BigInt(source.draw(int(0, 2))),
		tier: source.draw(tierGen),
		k: source.draw(element(numerals))
	})

/**
 * Stored rows at distinct keys and numerals by construction, of tiers Rate holds: the keys drawn as a sequence of
 * distinct ids, and as many distinct numerals, paired in order.
 */
const storedGen: Gen<ReadonlyArray<Row>> = (source) => {
	const ids = source.draw(shuffled([1, 2, 3], { min: 0, max: 3 }))
	const ks = source.draw(shuffled(numerals, { min: ids.length, max: ids.length }))
	return Arr.zipWith(ids, ks, (id, k) => ({
		id,
		v: BigInt(source.draw(int(0, 2))),
		tier: source.draw(element(["low", "mid"] as const)),
		k
	}))
}

export const caseGen: Gen<Case> = (source) => {
	const target = source.draw(element(["Item", "Spot"] as const))
	const op = source.draw(element(["insert", "put"] as const))
	const stored = source.draw(storedGen)
	/** A source row: a fresh one, or, half the time, a repeat of a stored one. */
	const row: Gen<Row> = Arr.isReadonlyArrayNonEmpty(stored)
		? oneOf([rowGen(element(tiers)), element(stored)])
		: rowGen(element(tiers))
	const first = source.draw(row)
	const more = source.draw(array(row, { min: 0, max: 2 }))
	return { target, op, stored, source: [first, ...more] }
}

/** A row's facts as Items stores them: its written fields and each generated field's value. */
export const factOf = (row: Row): Readonly<Record<string, unknown>> =>
	bareRecord({
		id: row.id,
		v: row.v,
		tier: row.tier,
		k: row.k,
		day: dayOf[row.k],
		copy: row.v,
		rate: rates[row.tier],
		parsed: BigInt(row.k),
		when: dayOf[row.k]
	})

const sameRow = (a: Row, b: Row): boolean =>
	a.id === b.id && a.v === b.v && a.tier === b.tier && a.k === b.k

/** What the oracle says of a case: the laws a refusal may name, or the rows stored after it and whether any changed. */
type Expected =
	| { readonly kind: "refused"; readonly laws: Arr.NonEmptyReadonlyArray<Law["kind"]> }
	| { readonly kind: "applied"; readonly rows: ReadonlyArray<Row>; readonly changed: boolean }

export const expectedOf = (c: Case): Expected => {
	const source = Arr.dedupeWith(c.source, sameRow)
	const laws: Array<Law["kind"]> = []
	if (Arr.some(source, (a) => Arr.some(source, (b) => a.id === b.id && !sameRow(a, b)))) {
		laws.push("primaryKey")
	}
	if (Arr.some(source, (r) => rates[r.tier] === undefined)) {
		laws.push("generated")
	}
	if (
		c.op === "insert" &&
		Arr.some(source, (r) => Arr.some(c.stored, (s) => s.id === r.id && !sameRow(r, s)))
	) {
		laws.push("primaryKey")
	}
	const after = [
		...Arr.filter(c.stored, (s) => !Arr.some(source, (r) => r.id === s.id)),
		...Arr.map(source, (r) =>
			c.op === "insert"
				? Option.getOrElse(
						Arr.findFirst(c.stored, (s) => s.id === r.id),
						() => r
					)
				: r
		)
	]
	const shareNumeral = (rows: ReadonlyArray<Row>): boolean =>
		Arr.some(rows, (a) => Arr.some(rows, (b) => a.k === b.k && a.id !== b.id))
	if (shareNumeral(source) || shareNumeral(after)) {
		laws.push("key")
	}
	if (Arr.isReadonlyArrayNonEmpty(laws)) {
		return { kind: "refused", laws }
	}
	const changed = !Arr.every(source, (r) => Arr.some(c.stored, (s) => sameRow(r, s)))
	return { kind: "applied", rows: after, changed }
}

export type Feature =
	| `${Target} ${"insert" | "put"} applied`
	| `refused by ${"primaryKey" | "generated" | "key"}`
	| "an unchanged write"

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const genqueryInstall = Object.freeze({ label: "genquery", programs })

/** Items installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const genqueryTemplate = fixtureTemplate(import.meta, Items, genqueryInstall)
