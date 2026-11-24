/**
 * What the property of conditions.test.ts reads: drawn query shapes, each a core whose FROM holds tables, derived
 * tables over a core of their own and join chains of on, left and cross steps, with or without a WHERE, and the query
 * of a shape built over numbered conditions, every condition `n` its own equality, or marked as a rewrite marks it.
 */

import { array, boolean, constant, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Expr, FromItem, FromSource, JoinStep, Select } from "#compiler/sql/ast.ts"
import {
	col,
	core,
	derived,
	distinctCore,
	eq,
	lit,
	operandSelect,
	select,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"

/** A source of a shape's FROM: a table, or a derived table over a core of its own. */
export type SourceShape =
	| { readonly kind: "table" }
	| { readonly kind: "derived"; readonly core: CoreShape }

/** A step of a join chain: its kind, and the source it joins. */
export interface StepShape {
	readonly kind: JoinStep["kind"]
	readonly source: SourceShape
}

/** An item of a shape's FROM: a source alone, or a join chain of at least one step. */
export type ItemShape =
	| { readonly kind: "source"; readonly source: SourceShape }
	| {
			readonly kind: "joins"
			readonly first: SourceShape
			readonly steps: Arr.NonEmptyReadonlyArray<StepShape>
	  }

/** A core's shape: its FROM's items, and whether it has a WHERE. */
export interface CoreShape {
	readonly where: boolean
	readonly from: ReadonlyArray<ItemShape>
}

const tableShape: Gen<SourceShape> = constant<SourceShape>({ kind: "table" })

const sourceGen = (depth: number): Gen<SourceShape> =>
	depth === 0
		? tableShape
		: oneOf([
				tableShape,
				(source): SourceShape => ({ kind: "derived", core: source.draw(coreGen(depth - 1)) })
			])

const stepGen =
	(depth: number): Gen<StepShape> =>
	(source) => ({
		kind: source.draw(element(["on", "left", "cross"] as const)),
		source: source.draw(sourceGen(depth))
	})

const itemGen = (depth: number): Gen<ItemShape> =>
	oneOf([
		(source): ItemShape => ({ kind: "source", source: source.draw(sourceGen(depth)) }),
		(source): ItemShape => {
			const first = source.draw(sourceGen(depth))
			const [head, ...rest] = source.draw(array(stepGen(depth), { min: 1, max: 3 }))
			return head === undefined
				? { kind: "source", source: first }
				: { kind: "joins", first, steps: [head, ...rest] }
		}
	])

/** A core's shape: one to three FROM items, a WHERE or none, and derived tables at most `depth` levels down. */
const coreGen =
	(depth: number): Gen<CoreShape> =>
	(source) => ({
		where: source.draw(boolean),
		from: source.draw(array(itemGen(depth), { min: 1, max: 3 }))
	})

/** A case: a query's shape, derived tables at most two levels down. */
export const caseGen: Gen<CoreShape> = (source) => source.draw(coreGen(source.draw(int(0, 2))))

/** What a case is about: the conditions and the FROM items its cores hold. */
export type ConditionFeature =
	| "a WHERE"
	| "an on join"
	| "a left join"
	| "a cross join"
	| "a join chain beside another item"
	| "a derived table's core with a condition"

export const conditionFeatures: ReadonlyArray<ConditionFeature> = [
	"a WHERE",
	"an on join",
	"a left join",
	"a cross join",
	"a join chain beside another item",
	"a derived table's core with a condition"
]

const sourceFeatures = (s: SourceShape): ReadonlyArray<ConditionFeature> =>
	s.kind === "table"
		? []
		: [
				...(conditionsIn(s.core) > 0 ? (["a derived table's core with a condition"] as const) : []),
				...featuresOf(s.core)
			]

/** The features of a shape, each once per place it holds. */
export const featuresOf = (c: CoreShape): ReadonlyArray<ConditionFeature> => [
	...(c.where ? (["a WHERE"] as const) : []),
	...Arr.flatMap(c.from, (item): ReadonlyArray<ConditionFeature> =>
		item.kind === "source"
			? sourceFeatures(item.source)
			: [
					...(c.from.length > 1 ? (["a join chain beside another item"] as const) : []),
					...sourceFeatures(item.first),
					...Arr.flatMap(item.steps, (s): ReadonlyArray<ConditionFeature> => [
						s.kind === "on" ? "an on join" : s.kind === "left" ? "a left join" : "a cross join",
						...sourceFeatures(s.source)
					])
				]
	)
]

const sourceConditions = (s: SourceShape): number => (s.kind === "table" ? 0 : conditionsIn(s.core))

/** How many conditions a shape holds, at every depth: each WHERE and each on or left join's ON. */
const conditionsIn = (c: CoreShape): number =>
	(c.where ? 1 : 0) +
	Arr.reduce(c.from, 0, (n, item) =>
		item.kind === "source"
			? n + sourceConditions(item.source)
			: n +
				sourceConditions(item.first) +
				Arr.reduce(
					item.steps,
					0,
					(m, s) => m + (s.kind === "cross" ? 0 : 1) + sourceConditions(s.source)
				)
	)

/** Condition `n`: the equality of a column to `n`, one text per number. */
export const condition = (n: number): Expr => eq(col("t", "c"), lit.int(n, types.integer))

/** A condition marked as read beside a FROM of `items` items: its equality to that count, one text per pair. */
export const marked = (e: Expr, items: number): Expr => eq(e, lit.int(items, types.integer))

/**
 * The query of shape `c`, its conditions numbered in one walk (item by item and step by step, a source's derived table
 * before its step's ON, then the core's WHERE) and condition `n` spelled by `spell(n, items)`, where `items` counts its
 * core's FROM items. The query's own core is DISTINCT, a set as a Select's body is, and a derived table's an operand
 * core.
 */
export const queryOf = (c: CoreShape, spell: (n: number, items: number) => Expr): Select => {
	let next = 0
	const one = target(lit.int(1, types.integer))
	const numbered = (items: number): Expr => spell(next++, items)
	const sourceOf = (s: SourceShape, alias: string): FromSource =>
		s.kind === "table"
			? table("s", "t", alias)
			: derived(namedQuery(operandSelect(core([one], ...partsOf(s.core))), ["c1"]), alias, false)
	const partsOf = (shape: CoreShape): readonly [ReadonlyArray<FromItem>, Expr | undefined] => {
		const items = shape.from.length
		const from = Arr.map(shape.from, (item, i): FromItem => {
			if (item.kind === "source") {
				return sourceOf(item.source, `a${i}`)
			}
			const first = sourceOf(item.first, `a${i}`)
			const steps = Arr.map(item.steps, (s, j): JoinStep => {
				const source = sourceOf(s.source, `a${i}_${j}`)
				return s.kind === "cross"
					? { kind: "cross", source }
					: { kind: s.kind, source, on: numbered(items) }
			})
			return { kind: "joins", first, steps }
		})
		const where = shape.where ? numbered(items) : undefined
		return [from, where]
	}
	const [from, where] = partsOf(c)
	return select(distinctCore([one], from, where))
}
