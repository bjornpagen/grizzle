import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record } from "effect"
import { type CompareOp, type ComputeFn, computeFns } from "#compiler/ir/desc.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { nativeOps } from "#compiler/scalar/compute/registry.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

/** Whether a lowered program counts by FILTER: a count(*) with a FILTER clause in any statement. */
const countsByFilter = (statements: ReadonlyArray<{ readonly ast: SqlStatement }>): boolean => {
	let filtered = false
	for (const { ast } of statements) {
		transformStatement(ast, {
			...identityHooks,
			expr: (e) => {
				if (e.kind === "call" && e.star && e.filter !== undefined) {
					filtered = true
				}
				return e
			}
		})
	}
	return filtered
}

describe("R24 conditional aggregates", () => {
	const Line = relation("Line", { id: uuid, flag: pg.boolean, qty: pg.integer }, ["id"])
	const Lines = schema("Lines", { Line }, [])

	/** The head term a shape makes of a conditional: its sum, or the conditional itself. A count takes no argument. */
	type Shape = "sum" | "bare"
	/**
	 * A branch: an integer literal, the integer column qty, or a numeric(5,1) literal, whose display scale count(*) does
	 * not have. A conditional's two branches are of one type, so the leaves pair within theirs.
	 */
	type Leaf =
		| "integer 0"
		| "integer 1"
		| "integer 2"
		| "qty"
		| "numeric(5,1) 1.0"
		| "numeric(5,1) 0"
	const integerOf = (leaf: Leaf): number =>
		leaf === "integer 2" ? 2 : leaf === "integer 1" ? 1 : 0
	const numericOf = (leaf: Leaf) =>
		Compute.literal(pg.numeric(5, 1), leaf === "numeric(5,1) 1.0" ? "1.0" : "0")
	/** A query of the shape over integer branches, and one over numeric(5,1) branches. */
	const integerQuery = (shape: Shape, then: Leaf, otherwise: Leaf): unknown =>
		query(Lines).rule((r) => {
			const { id, flag, qty } = v(Line)
			const other = otherwise === "qty" ? qty : Compute.literal(pg.integer, integerOf(otherwise))
			const conditional =
				then === "qty"
					? Compute.cond(flag, qty, other)
					: Compute.cond(flag, Compute.literal(pg.integer, integerOf(then)), other)
			return r
				.match(Line, { id, flag, qty })
				.find({ n: shape === "sum" ? r.sum(conditional) : conditional })
		})
	const numericQuery = (shape: Shape, then: Leaf, otherwise: Leaf): unknown =>
		query(Lines).rule((r) => {
			const { id, flag, qty } = v(Line)
			const conditional = Compute.cond(flag, numericOf(then), numericOf(otherwise))
			return r
				.match(Line, { id, flag, qty })
				.find({ n: shape === "sum" ? r.sum(conditional) : conditional })
		})
	const queryOf = (shape: Shape, then: Leaf, otherwise: Leaf): unknown =>
		then === "numeric(5,1) 1.0" || then === "numeric(5,1) 0"
			? numericQuery(shape, then, otherwise)
			: integerQuery(shape, then, otherwise)

	it.effect(
		"counts by FILTER exactly sum(cond(p, 1, 0)) over integer literals, and leaves every other shape composed",
		(ctx) =>
			Effect.gen(function* () {
				const shapes = element<Shape>(["sum", "bare"])
				const integerLeaves = element<Leaf>(["integer 0", "integer 1", "integer 2", "qty"])
				const numericLeaves = element<Leaf>(["numeric(5,1) 1.0", "numeric(5,1) 0"])
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/compute/conditional-aggregate",
							generator: oneOf([
								(source) =>
									[
										source.draw(shapes),
										source.draw(integerLeaves),
										source.draw(integerLeaves)
									] as const,
								(source) =>
									[
										source.draw(shapes),
										source.draw(numericLeaves),
										source.draw(numericLeaves)
									] as const
							]),
							literal: Formatter.format,
							/** The space: 2 shapes over 4 × 4 integer branches and 2 × 2 numeric ones. */
							limit: 40,
							features: features<"counted by FILTER" | "left composed">([
								"counted by FILTER",
								"left composed"
							]),
							caseHang: Duration.minutes(2)
						},
						([shape, then, otherwise], c) =>
							Effect.sync(() => {
								const counts = shape === "sum" && then === "integer 1" && otherwise === "integer 0"
								c.note(counts ? "counted by FILTER" : "left composed")
								const template = succeeded(
									compileTemplate(queryOf(shape, then, otherwise), undefined, testCompile)
								)
								const { optimized, conservative } = template.programs
								assert.equal(
									countsByFilter(flight(optimized.roots)),
									counts,
									`${shape}(cond(p, ${then}, ${otherwise}))`
								)
								if (!counts) {
									assert.equal(countsByFilter(flight(conservative.roots)), false)
								}
							})
					)
				)
			})
	)
})

/**
 * The description vocabulary the registry must cover (ir/desc.ts): every Compute function but the one that composes
 * other operators, every comparison, the boolean connectives and a cast, each naming a registry node. (One OpId per
 * node is the registry's own load-time invariant.)
 */
type VocabularyWord =
	| { readonly kind: "function"; readonly fn: ComputeFn }
	| { readonly kind: "comparison"; readonly fn: CompareOp | "between" | "in" }
	| { readonly kind: "connective"; readonly fn: "and" | "or" | "not" }
	| { readonly kind: "cast"; readonly fn: "cast" }

/** Every comparison a description states, complete by its type. */
const comparisons: { readonly [W in CompareOp | "between" | "in"]: W } = {
	eq: "eq",
	ne: "ne",
	lt: "lt",
	le: "le",
	gt: "gt",
	ge: "ge",
	between: "between",
	in: "in"
}

describe("the overload registry", () => {
	it.effect("names a node for every word of the description vocabulary", (ctx) =>
		Effect.gen(function* () {
			/** The Compute function that composes other operators rather than name one of its own. */
			const compositions: ReadonlySet<ComputeFn> = new Set<ComputeFn>(["width"])
			const words = oneOf<VocabularyWord>([
				map(
					element(
						nonEmpty(
							Arr.filter(computeFns, (fn) => !compositions.has(fn)),
							"the functions that name a node"
						)
					),
					(fn): VocabularyWord => ({
						kind: "function",
						fn
					})
				),
				map(
					element(nonEmpty(Record.values(comparisons), "the comparisons")),
					(fn): VocabularyWord => ({
						kind: "comparison",
						fn
					})
				),
				map(element(["and", "or", "not"] as const), (fn): VocabularyWord => ({
					kind: "connective",
					fn
				})),
				element<VocabularyWord>([{ kind: "cast", fn: "cast" }])
			])
			const fns: ReadonlySet<string> = new Set(Arr.map(nativeOps, (op) => op.fn))
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/compute/registry-vocabulary",
						generator: words,
						literal: Formatter.format,
						/** The space is the vocabulary, each word once. */
						limit: computeFns.length + Record.values(comparisons).length + 4,
						features: features<`word ${VocabularyWord["kind"]}`>([
							"word function",
							"word comparison",
							"word connective",
							"word cast"
						]),
						caseHang: Duration.minutes(2)
					},
					(word, c) =>
						Effect.sync(() => {
							c.note(`word ${word.kind}`)
							assert.ok(fns.has(word.fn), `the registry names no node for ${word.kind} ${word.fn}`)
						})
				)
			)
		})
	)
})
