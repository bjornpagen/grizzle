/**
 * The compile benchmark's generated schema (bench/compile/main.ts), shaped as a downstream grammar is (qti-pie's Qti),
 * its parts by scale, and the schema assembled whole (generatedSchema): what the benchmark times part by part and the
 * startup scaling property (test/unit/startup/scaling.test.ts) compiles at half, one and twice a scale.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Record as Rec } from "effect"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	check,
	contained,
	key,
	on,
	schema,
	select,
	type Statement
} from "#compiler/public/schema.ts"
import { closedBuilder, closedRelation, relationBuilder } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The size of a generated schema: the handles of each roster, the ordinary relations, the rows of each closed relation,
 * and the regex domains. The rosters and the closed relations over them are a fixed set, so their sizes are what grows.
 */
export interface Scale {
	readonly handles: number
	readonly relations: number
	readonly rows: number
	readonly patterns: number
}

/** The rosters a generated schema holds; each closed relation is over two neighbouring ones. */
const rosterCount = 8

/** The handles of a roster of `count` handles, each `prefix` and its position. */
const handles = (prefix: string, count: number): readonly [string, ...Array<string>] => [
	`${prefix}0`,
	...upTo(count - 1, (i) => `${prefix}${i + 1}`)
]

/** A roster of the generated schema: its handles, and the first, which the statements compare with. */
const rosterOf = (k: number, scale: Scale) => {
	const members = handles(`h${k}_`, scale.handles)
	return { roster: closedBuilder(`Ros${k}`, members, "ordered", []), first: members[0] }
}

export type GeneratedRoster = ReturnType<typeof rosterOf>

/** The member of `items` at position `i`, counting around: how the generated schema assigns its parts. */
const around = <A>(items: Arr.NonEmptyReadonlyArray<A>, i: number): A =>
	defined(items[i % items.length], "a position counted around a nonempty list is in it")

/**
 * The closed relation over the rosters at `k` and the next one: its first `rows` pairs of their handles, in row-major
 * order, each with a weight.
 */
const closedOf = (rosters: Arr.NonEmptyReadonlyArray<GeneratedRoster>, k: number, scale: Scale) => {
	const a = around(rosters, k).roster
	const b = around(rosters, k + 1).roster
	const facts = upTo(scale.rows, (i) => ({
		a: `h${k % rosters.length}_${Math.floor(i / scale.handles)}`,
		b: `h${(k + 1) % rosters.length}_${i % scale.handles}`,
		w: i % 1_000
	}))
	return closedRelation(
		`Pairs${k}`,
		{ a: closedId(a), b: closedId(b), w: pg.integer },
		["a", "b"],
		facts,
		[]
	)
}

/** A regex domain of the generated schema: a pattern of its own, so each is a text analyzed once. */
export const domainOf = (i: number) => regexField<string>(`^d${i}_[a-z0-9_]{1,48}$`, ["u"])

/** One ordinary relation of the generated schema: two texts of its domains, two closed ids and a weight. */
export const ordinaryOf = (
	i: number,
	domains: Arr.NonEmptyReadonlyArray<ReturnType<typeof domainOf>>,
	rosters: Arr.NonEmptyReadonlyArray<GeneratedRoster>
) =>
	relationBuilder(
		`R${i}`,
		{
			id: around(domains, i),
			parent: around(domains, i + 1),
			kind: closedId(around(rosters, i).roster),
			mode: closedId(around(rosters, i + 1).roster),
			weight: pg.integer
		},
		["id"],
		[]
	)

/** One ordinary relation of the generated schema. */
export type Generated = ReturnType<typeof ordinaryOf>

/**
 * The statements over the ordinary relation at `i`: a key, a row check over its weight and one over its kind, its
 * facts of one mode contained in the closed relation over its rosters, and, but for the first, its parents contained
 * in the ids of the one before it.
 */
export const statementsOf = (
	r: Generated,
	i: number,
	below: Generated | undefined,
	rosters: Arr.NonEmptyReadonlyArray<GeneratedRoster>,
	pairs: Arr.NonEmptyReadonlyArray<ReturnType<typeof closedOf>>
): ReadonlyArray<Statement> => [
	key(on(r, "parent", "kind")),
	check(`Weighed${i}`, r, (row) => row.ge(row.weight, 0)),
	check(`Kinded${i}`, r, (row) => row.ne(row.kind, around(rosters, i).first)),
	contained(
		on(
			select(r, (row) => row.eq(row.mode, around(rosters, i + 1).first)),
			"kind",
			"mode"
		),
		on(around(pairs, i), "a", "b")
	),
	...(below === undefined ? [] : [contained(on(r, "parent"), on(below, "id"))])
]

/** The schema of the generated parts, each by its name: the rosters, the closed relations over them and the ordinary relations, under `statements`. */
export const assembledSchema = (
	rosters: ReadonlyArray<GeneratedRoster>,
	pairs: ReadonlyArray<ReturnType<typeof closedOf>>,
	ordinary: ReadonlyArray<Generated>,
	statements: ReadonlyArray<Statement>
): AnySchema => {
	const declared: Record<string, AnyRelation | AnyClosed> = {}
	for (const { roster } of rosters) {
		declared[roster.name] = roster
	}
	for (const r of [...pairs, ...ordinary]) {
		declared[r.name] = r
	}
	return schema("Bench", Rec.values(declared), statements)
}

/** The generated schema's rosters at `scale`. */
export const rostersAt = (scale: Scale): Arr.NonEmptyReadonlyArray<GeneratedRoster> =>
	Arr.makeBy(rosterCount, (k) => rosterOf(k, scale))

/** The generated schema's closed relations at `scale`, each over two neighbouring rosters of `rosters`. */
export const pairsAt = (
	rosters: Arr.NonEmptyReadonlyArray<GeneratedRoster>,
	scale: Scale
): Arr.NonEmptyReadonlyArray<ReturnType<typeof closedOf>> =>
	Arr.makeBy(rosterCount, (k) => closedOf(rosters, k, scale))

/** The generated schema at `scale`, its parts built in the benchmark's order. */
export const generatedSchema = (scale: Scale): AnySchema => {
	const rosters = rostersAt(scale)
	const pairs = pairsAt(rosters, scale)
	const domains = nonEmpty(upTo(scale.patterns, domainOf), "a scale holds one pattern at least")
	const ordinary = upTo(scale.relations, (i) => ordinaryOf(i, domains, rosters))
	const statements = Arr.flatMap(ordinary, (r, i) =>
		statementsOf(r, i, i === 0 ? undefined : ordinary[i - 1], rosters, pairs)
	)
	return assembledSchema(rosters, pairs, ordinary, statements)
}
