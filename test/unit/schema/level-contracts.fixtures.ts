/**
 * The programs level-contracts.test.ts exhausts: a schema, and a schema.extend over it where the case needs one, whose
 * relations declare fields of contracts and of a variant at each place a field holds one: a root relation's field, a
 * base's under an extension that declares none, an extension's, both levels' alike, another contract's base, a span's
 * endpoint and a variant's arm's field. And what each level's content holds of its contracts and its variants beside
 * what its ownership holds.
 */

import { defined } from "@bjornpagen/testing/assert"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { contract, pg, span, variant } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { levelOf } from "#compiler/schema/level.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"

/** Where a program's relations declare a field of a contract and of a variant. */
export type ContractPlace =
	| "a root relation's field"
	| "a base's relation's field, under an extension"
	| "an extension's relation's field"
	| "both levels' fields alike"
	| "another contract's base"
	| "a span's endpoint"
	| "a variant's arm's field"

const placeGen: Gen<ContractPlace> = element([
	"a root relation's field",
	"a base's relation's field, under an extension",
	"an extension's relation's field",
	"both levels' fields alike",
	"another contract's base",
	"a span's endpoint",
	"a variant's arm's field"
] as const)

export const places = finite(placeGen)

const outerKey = Symbol("Outer")
const scoreKey = Symbol("Score")
const tickKey = Symbol("Tick")
/** A program of the place, built fresh: its schema values, root first. */
const programOf = (place: ContractPlace): Arr.NonEmptyReadonlyArray<AnySchema> => {
	const Score = contract<typeof scoreKey>()("Score", pg.integer, undefined, undefined)
	const Tick = contract<typeof tickKey>()("Tick", pg.bigint, undefined, undefined)
	const Outer = contract<typeof outerKey>()("Outer", Score, undefined, undefined)
	const Side = closed.unordered("Side", ["least", "most"])
	/** A variant of an arm's check, qti-pie's QtiValue's shape: a level's content holds it with its check. */
	const Mark = variant(
		"Mark",
		Side,
		{ least: { low: pg.integer, high: pg.integer }, most: { flag: pg.boolean } },
		{ least: (a) => a.le(a.low, a.high) }
	)
	/** A variant whose arm's field is a contract, which a level's content holds beside the variant. */
	const Scored = variant("Scored", Side, { least: { score: Score }, most: {} })
	switch (place) {
		case "a root relation's field":
			return [
				schema(
					"ContractRoot",
					[Side, relation("Unit", { id: pg.integer, score: Score, mark: Mark }, ["id"])],
					[]
				)
			]
		case "a base's relation's field, under an extension": {
			const Base = schema(
				"ContractBase",
				[Side, relation("Unit", { id: pg.integer, score: Score, mark: Mark }, ["id"])],
				[]
			)
			return [
				Base,
				schema.extend([Base], "ContractTop", [relation("Extra", { id: pg.integer }, ["id"])], [])
			]
		}
		case "an extension's relation's field": {
			const Base = schema("ContractBase", [Side, relation("Unit", { id: pg.integer }, ["id"])], [])
			return [
				Base,
				schema.extend(
					[Base],
					"ContractTop",
					[relation("Extra", { id: pg.integer, score: Score, mark: Mark }, ["id"])],
					[]
				)
			]
		}
		case "both levels' fields alike": {
			const Base = schema(
				"ContractBase",
				[Side, relation("Unit", { id: pg.integer, score: Score, mark: Mark }, ["id"])],
				[]
			)
			return [
				Base,
				schema.extend(
					[Base],
					"ContractTop",
					[relation("Extra", { id: pg.integer, score: Score, mark: Mark }, ["id"])],
					[]
				)
			]
		}
		case "another contract's base":
			return [
				schema("ContractNested", [relation("Unit", { id: pg.integer, outer: Outer }, ["id"])], [])
			]
		case "a span's endpoint":
			return [
				schema(
					"ContractSpan",
					[relation("Unit", { id: pg.integer, during: span(Tick, undefined) }, ["id"])],
					[]
				)
			]
		case "a variant's arm's field":
			return [
				schema(
					"ContractVariant",
					[Side, relation("Unit", { id: pg.integer, scored: Scored }, ["id"])],
					[]
				)
			]
	}
}

/** Declarations by name, in name order, each with its descriptor. */
const byName = <D>(
	declarations: Iterable<readonly [string, D]>
): ReadonlyArray<readonly [string, D]> =>
	Arr.sort(
		[...declarations],
		Order.mapInput(Order.String, ([name]: readonly [string, unknown]) => name)
	)

/**
 * Each schema value of the place's program, root first: the contracts and the variants its content holds from its build
 * (levels.ts SchemaContent contracts and variants) and those its ownership holds (own.ts Owned contracts and
 * variants), each by name with its descriptor.
 */
export const declarationsOf = (place: ContractPlace) =>
	Arr.map(programOf(place), (value, at) => {
		const level = defined(levelOf(value), `schema ${String(at)}, a built level`)
		if (level.kind !== "schema") {
			throw new Error(`schema ${String(at)} is a schema's level`)
		}
		const owned = succeeded(level.content.owned(), `schema ${String(at)}'s Owned`)
		return {
			held: {
				contracts: byName(level.content.contracts),
				variants: byName(level.content.variants)
			},
			owned: {
				contracts: byName(Arr.map(Rec.values(owned.contracts), (c) => [c.name, c.desc] as const)),
				variants: byName(Arr.map(Rec.values(owned.variants), (c) => [c.name, c.desc] as const))
			}
		}
	})
