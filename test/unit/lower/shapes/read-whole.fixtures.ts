/**
 * What read-whole.test.ts reads: its schema, its box and the statements of a case's read.
 *
 * A closed relation, TierRank, read by one to three rules of a read, each a match of its own, so each read is a copy of
 * it, each rule beside grade's marks at its rows argument, `ranked`, and its own `at`, so each rule's call is an
 * evaluation of its own and each argument a copy of its own: the ranks of TierNone, a closed relation of no row, proved
 * empty; a constant row of a region of no occurrence; TierRank's, a closed derivation; every tag's, a projection the
 * call reads behind a DISTINCT; or the tag at the read's parameter, a row the read's values fix.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { Fn } from "#compiler/public/compute.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { closed, fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

const Tier = closed.ordered("Tier", ["low", "mid", "high"])

const TierRank = closed.relation(
	"TierRank",
	{ tier: closedId(Tier), rank: int4 },
	["tier"],
	[
		{ tier: "low", rank: 1 },
		{ tier: "mid", rank: 2 },
		{ tier: "high", rank: 3 }
	]
)

/** A closed relation of no row, which grade's argument reads where the case's argument is empty. */
const TierNone = closed.relation("TierNone", { tier: closedId(Tier), rank: int4 }, ["tier"], [])

const Item = relation("Item", { id: int4, tier: closedId(Tier), n: int4 }, ["id"])

/** Tags, each of a rank: many tags of one rank, so their ranks are a projection that repeats. */
const Tag = relation("Tag", { id: int4, rank: int4 }, ["id"])

const R = rows({ k: int4 })

/** grade: one rows argument of (k) and a value, and one row of one field of rows of (k). */
const grade = fn("grade", {
	calls: [],
	args: { ranked: R, at: int4 },
	returns: row(rows({ a0: R })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

const Whole = schema("ReadWhole", [Tier, TierRank, TierNone, Item, Tag, grade], [])

/**
 * What grade's argument reads: TierNone's ranks, proved empty; one constant rank, a row no relation holds; TierRank's, a
 * closed derivation; every tag's rank, a
 * projection the call observes the repeats of, so its placement realizes it behind a DISTINCT; or the rank of the tag at
 * the read's parameter, at most one row its values fix.
 */
export type Ranked = "empty" | "constant" | "closed" | "distinct" | "fixed"

/** A case: what grade's argument reads, how many rules read TierRank and call grade, and which lowering prints it. */
export interface Box {
	readonly ranked: Ranked
	readonly reads: 1 | 2 | 3
	readonly lowering: Lowering
}

export const boxGen: Gen<Box> = element<Box>(
	Arr.flatMap(["empty", "constant", "closed", "distinct", "fixed"] as const, (ranked) =>
		Arr.flatMap([1, 2, 3] as const, (reads) =>
			Arr.map(["optimized", "conservative"] as const, (lowering) => ({ ranked, reads, lowering }))
		)
	)
)

/** grade's rows argument in rule `r`, as `ranked` says: an import of its own, a copy at each rule. */
const rankedOf = (ranked: Ranked, r: Rule<typeof Whole>) => {
	switch (ranked) {
		case "empty":
			return query(Whole).rule((q) => {
				const { rank } = v(TierNone, "ranked")
				return q.match(TierNone, { rank }).find({ k: rank })
			})
		case "constant":
			return query(Whole).rule((q) => q.find({ k: 2 }))
		case "closed":
			return query(Whole).rule((q) => {
				const { rank } = v(TierRank, "ranked")
				return q.match(TierRank, { rank }).find({ k: rank })
			})
		case "distinct":
			return query(Whole).rule((q) => {
				const { rank } = v(Tag, "ranked")
				return q.match(Tag, { rank }).find({ k: rank })
			})
		case "fixed":
			return query(Whole)
				.rule((q) => {
					const { rank } = v(Tag, "ranked")
					return q.match(Tag, { id: q.param("tag", int4), rank }).find({ k: rank })
				})
				.bind({ tag: r.param("tag", int4) })
	}
}

/**
 * The read of `box`: rule i (1 to `reads`) each item of `n` i with its tier's rank, TierRank matched anew, a copy of its
 * own, among grade's marks at its argument and at i.
 */
const readOf = (box: Box) => {
	const rule = (n: number) => (r: Rule<typeof Whole>) => {
		const { id, tier } = v(Item, "item")
		const { rank } = v(TierRank, "rank")
		const run = Fn.row(grade, { ranked: rankedOf(box.ranked, r), at: n })
		return r
			.match(Item, { id, tier, n })
			.match(TierRank, { tier, rank })
			.match(run.a0, { k: rank })
			.find({ id, rank })
	}
	const first = query(Whole).rule(rule(1))
	const second = first.rule(rule(2))
	const third = second.rule(rule(3))
	return box.reads === 1 ? first : box.reads === 2 ? second : third
}

/** Which lowering's statements a case reads: the compiler's optimized one, or the conservative oracle's. */
export type Lowering = "optimized" | "conservative"

/** The statements of the case's read under `lowering`, their texts joined. */
export const statementsOf = (box: Box, lowering: Lowering): string => {
	const template = succeeded(
		compileTemplate(readOf(box), undefined, testCompile),
		"the case's read compiles"
	)
	return Arr.join(
		Arr.map(lowering === "optimized" ? template.optimized : template.conservative, (s) => s.sql),
		"\n"
	)
}

/** How many VALUES lists `sql` prints: TierRank's, the one closed relation it reads whole. */
export const valuesLists = (sql: string): number => Str.split("(VALUES ")(sql).length - 1

/** How many ARRAY arguments `sql` prints: grade's, one for each call whose rows argument is no proved-empty relation. */
export const arrayArguments = (sql: string): number => Str.split("ARRAY(")(sql).length - 1

/**
 * How many times `sql` prints the constant rank, grade's argument where it is a constant row: its one-row sub-query
 * printed pulled up into the ARRAY's query, which then reads no FROM item (sql/pull-up.ts, bcb057d552), where it read
 * `(SELECT 2 FROM (SELECT true) ...)`.
 */
export const constantRanks = (sql: string): number =>
	Str.split("ARRAY(SELECT ROW(2)::")(sql).length - 1

/** How many times `sql` scans Tag: once for each copy of grade's argument it prints where the argument reads Tag. */
export const tagScans = (sql: string): number => Str.split('"read_whole"."tag" AS')(sql).length - 1
