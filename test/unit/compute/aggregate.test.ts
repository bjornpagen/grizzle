/**
 * Aggregates over generated inputs. min and max, LEAST and GREATEST return one of their inputs, so what a head delivers
 * keeps the contract that input has, over a contract drawn over each type they are defined on: a column of the contract
 * and a parameter of it, which a rule reads as its base, deliver the contract, and Compute.base of a column the plain
 * value. The oracle is the compiled heading's type.
 *
 * - Conditional counts: sum(cond(p, 1, 0)) over literals of one carrier counts by FILTER, and every other shape stays
 *   composed, over every shape of the box. Oracle: the specification of R24's rewrite.
 * - Vocabulary: the registry lists a node for every word of the description vocabulary. Oracle: the registry's own list.
 * - Returning input: min, max, LEAST and GREATEST deliver the contract of the input they return. Oracle: the compiled
 *   heading's type.
 * - Mean bound: a numeric mean's result bound holds the mean of its argument's greatest value, and that mean reaches its
 *   integer digits. Oracle: the reference evaluator's numeric_avg.
 *
 * Features: counted by FILTER and left composed; each word kind; each function over each reading; each way a mean
 * rounds.
 *
 * Plants: compute-conditional-count-two (the rewrite counts cond(p, 2, 0) and leaves cond(p, 1, 0)),
 * compute-registry-between-unlisted (the registry lists no BETWEEN node), compute-minmax-drops-contract (min and max
 * deliver their argument's base), compute-mean-no-carry-digit (a mean rounding past its argument loses the digit it
 * carries).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type CompareOp, type ComputeFn, computeFns } from "#compiler/ir/desc.ts"
import { contractOf, type NumericBound, numericBoundOf } from "#compiler/ir/scalar.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { aggregateOverload } from "#compiler/scalar/aggregate.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { computeNodes, type NativeFn, nativeOps } from "#compiler/scalar/compute/registry.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { strictRead } from "#test/support/kernel/strict.ts"
import { caseHang } from "#test/support/limits.ts"
import { aggregate } from "#test/support/oracle/reference/aggregate.ts"
import { asDecimal } from "#test/support/oracle/reference/values.ts"

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
	const Lines = schema("Lines", [Line], [])

	/** The head term a shape makes of a conditional: its sum, or the conditional itself. A count takes no argument. */
	type Shape = "sum" | "bare"
	/**
	 * A branch: an integer literal, the integer column qty, or a numeric(5,1) literal, whose value is all a sum reads, so
	 * 1.0 is the integer 1 count(*) cast to numeric delivers. A conditional's two branches are of one type, so the leaves
	 * pair within theirs.
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
			const { id, flag, qty } = v(Line, "line")
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
			const { id, flag, qty } = v(Line, "line")
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
		"counts by FILTER exactly sum(cond(p, 1, 0)) over literals of one carrier, and leaves every other shape composed",
		(ctx) =>
			Effect.gen(function* () {
				const shapes = element<Shape>(["sum", "bare"])
				const integerLeaves = element<Leaf>(["integer 0", "integer 1", "integer 2", "qty"])
				const numericLeaves = element<Leaf>(["numeric(5,1) 1.0", "numeric(5,1) 0"])
				yield* searched(
					ctx,
					exhaust(
						{
							box: "sum or bare cond(p, a, b) over every pair of integer branches and of numeric(5,1) branches",
							oracle: {
								kind: "specification",
								name: "R24: sum(cond(p, 1, 0)) over literals of one carrier is a count with a FILTER"
							},
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
							coverage: requiredInSpace<"counted by FILTER" | "left composed">([
								"counted by FILTER",
								"left composed"
							]),
							caseHang
						},
						([shape, then, otherwise], c) =>
							Effect.sync(() => {
								const counts =
									shape === "sum" &&
									((then === "integer 1" && otherwise === "integer 0") ||
										(then === "numeric(5,1) 1.0" && otherwise === "numeric(5,1) 0"))
								c.note(counts ? "counted by FILTER" : "left composed")
								const template = succeeded(
									compileTemplate(queryOf(shape, then, otherwise), undefined, testCompile)
								)
								const { optimized, conservative } = template.programs
								assert.equal(
									countsByFilter(Arr.map(programAsts(optimized), (ast) => ({ ast }))),
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
 * The description vocabulary the registry must cover: each node a Compute function lowers to (registry.ts
 * computeNodes), every comparison, the boolean connectives and a cast, each naming a registry node. (One OpId per node
 * is the registry's own load-time invariant.)
 */
type VocabularyWord =
	| { readonly kind: "function"; readonly fn: ComputeFn; readonly node: NativeFn }
	| { readonly kind: "comparison"; readonly node: CompareOp | "between" | "in" }
	| { readonly kind: "connective"; readonly node: "and" | "or" | "not" }
	| { readonly kind: "cast"; readonly node: "cast" }

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

/** Each Compute function beside each node it lowers to. */
const functionWords = nonEmpty(
	Arr.flatMap(computeFns, (fn) =>
		Arr.map(computeNodes[fn], (node): VocabularyWord => ({ kind: "function", fn, node }))
	),
	"the nodes the Compute functions lower to"
)

describe("the overload registry", () => {
	it.effect("names a node for every word of the description vocabulary", (ctx) =>
		Effect.gen(function* () {
			const words = oneOf<VocabularyWord>([
				element(functionWords),
				map(
					element(nonEmpty(Record.values(comparisons), "the comparisons")),
					(node): VocabularyWord => ({
						kind: "comparison",
						node
					})
				),
				map(element(["and", "or", "not"] as const), (node): VocabularyWord => ({
					kind: "connective",
					node
				})),
				element<VocabularyWord>([{ kind: "cast", node: "cast" }])
			])
			const listed: ReadonlySet<NativeFn> = new Set(Arr.map(nativeOps, (op) => op.fn))
			yield* searched(
				ctx,
				exhaust(
					{
						box: "each node every Compute function lowers to, every comparison, every connective and the cast",
						oracle: {
							kind: "specification",
							name: "the registry lists a node of every function it names"
						},
						suite: "unit/compute/registry-vocabulary",
						generator: words,
						literal: Formatter.format,
						coverage: requiredInSpace<`word ${VocabularyWord["kind"]}`>([
							"word function",
							"word comparison",
							"word connective",
							"word cast"
						]),
						caseHang
					},
					(word, c) =>
						Effect.sync(() => {
							c.note(`word ${word.kind}`)
							assert.ok(
								listed.has(word.node),
								`the registry lists no ${word.node} node for ${Formatter.format(word)}`
							)
						})
				)
			)
		})
	)
})

describe("min, max, LEAST and GREATEST", () => {
	/** A contract over each type min, max, LEAST and GREATEST are defined on. */
	const kept = [
		contract("Kept_smallint", pg.smallint),
		contract("Kept_integer", pg.integer),
		contract("Kept_bigint", pg.bigint),
		contract("Kept_numeric", pg.numeric(7, 2)),
		contract("Kept_real", pg.real),
		contract("Kept_double", pg["double precision"]),
		contract("Kept_money", pg.money),
		contract("Kept_boolean", pg.boolean),
		contract("Kept_text", str.regex("^.*$", "su"))
	] as const
	type Kept = (typeof kept)[number]
	/** What returns its input: an aggregate or a function of two operands. */
	type Returning = "min" | "max" | "least" | "greatest"
	/** How the head reads the contract's term: its column, a parameter of it, or the column's plain value. */
	type Reading = "column" | "parameter" | "base"
	const returnings: Arr.NonEmptyReadonlyArray<Returning> = ["min", "max", "least", "greatest"]
	const readings: Arr.NonEmptyReadonlyArray<Reading> = ["column", "parameter", "base"]

	/** The head over `x`, Held's variables, reading the contract's term as `reading` says. */
	const headOf = (
		r: RuleValue,
		x: Readonly<Record<string, unknown>>,
		k: Kept,
		returning: Returning,
		reading: Reading
	): unknown => {
		const first =
			reading === "column"
				? x["a"]
				: reading === "parameter"
					? r.param("p", k)
					: computeCore.base(x["a"])
		const second = reading === "base" ? computeCore.base(x["b"]) : x["b"]
		switch (returning) {
			case "min":
				return r.min(first)
			case "max":
				return r.max(first)
			case "least":
				return computeCore.least(first, second)
			case "greatest":
				return computeCore.greatest(first, second)
		}
	}

	it.effect("deliver the contract of the input they return", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: "every contract min, max, LEAST and GREATEST are defined on, under each, read each way",
					oracle: {
						kind: "specification",
						name: "the compiled heading's type: the input's contract, none for its base"
					},
					suite: "unit/compute/returns-input",
					generator: (source) =>
						[
							source.draw(element(kept)),
							source.draw(element(returnings)),
							source.draw(element(readings))
						] as const,
					literal: Formatter.format,
					coverage: requiredInSpace<`${Returning} over a ${Reading}`>(
						nonEmpty(
							Arr.flatMap(returnings, (f) => Arr.map(readings, (g) => `${f} over a ${g}` as const)),
							"each function over each reading"
						)
					),
					caseHang
				},
				([k, returning, reading], c) =>
					Effect.sync(() => {
						c.note(`${returning} over a ${reading}`)
						const Held = relation("Held", { id: uuid, a: k, b: k }, ["id"])
						const held = queryOver(schema("Held", [Held], [])).rule((r: RuleValue) => {
							const x = varsOver(Held, "held")
							return r
								.match(Held, { id: x["id"], a: x["a"], b: x["b"] })
								.find({ out: headOf(r, x, k, returning, reading) })
						})
						const template = succeeded(compileTemplate(held, undefined, testCompile))
						const out = defined(
							Option.getOrUndefined(
								Arr.findFirst(template.heading, (column) => column.name === "out")
							),
							"the head's column"
						)
						const delivered = contractOf(out.type)
						assert.equal(
							delivered === undefined ? undefined : String(delivered.name),
							reading === "base" ? undefined : k.name,
							`${returning} over a ${reading} of ${k.name}`
						)
					})
			)
		)
	)
})

/** What the mean of an argument's greatest value is: that value, the value rounded up past it, or zero. */
type MeanFeature =
	| "kept at its argument's scale"
	| "rounded up into a new integer digit"
	| "rounded to zero"
	| "an argument holding zero alone"

/**
 * An argument's bound: integer digits within two of 0 or of -1000, the digits of the unit a mean rounds to at numeric's
 * display scale, and a scale within two of 0 or of that display scale, 1000.
 */
const argumentBoundGen: Gen<NumericBound> = (source) => ({
	digits: source.draw(oneOf([int(-1002, -998), int(-2, 2)])),
	scale: source.draw(oneOf([int(0, 2), int(998, 1002)]))
})

/** The integer digits of a nonzero finite value: the least d with |value| below 10^d. */
const integerDigits = (coefficient: bigint, minScale: number): number =>
	coefficient.toString().length - minScale

describe("a numeric mean's result bound", () => {
	it.effect(
		"holds the mean of its argument's greatest value, PostgreSQL's numeric_avg, and that mean reaches its integer digits",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/compute/mean-bound",
						generator: argumentBoundGen,
						literal: Formatter.format,
						box: "a computed numeric argument of integer digits -1002 to -998 or -2 to 2 and scale 0 to 2 or 998 to 1002",
						oracle: {
							kind: "second-implementation",
							name: "the reference evaluator's numeric_avg, written from numeric.c (test/support/oracle/reference/aggregate.ts numericMean), read back by the strict reader"
						},
						coverage: requiredInSpace<MeanFeature>([
							"kept at its argument's scale",
							"rounded up into a new integer digit",
							"rounded to zero",
							"an argument holding zero alone"
						]),
						caseHang
					},
					(bound, c) =>
						Effect.sync(() => {
							const argType = numericValue(bound)
							const result = succeeded(
								aggregateOverload({ name: "mean", arg: argType }, SourceLoc("test", [])),
								"the mean's overload"
							).result
							const greatest = succeeded(
								N.fromUnits(
									10n ** BigInt(Math.max(bound.digits + bound.scale, 0)) - 1n,
									bound.scale
								),
								"the argument's greatest value"
							)
							const mean = asDecimal(aggregate("avg", [greatest], argType))
							succeeded(strictRead(result, mean.text), "the mean within its bound")
							const p = mean.parts
							if (p.kind !== "finite" || p.coefficient === 0n) {
								c.note(greatest.isZero() ? "an argument holding zero alone" : "rounded to zero")
								return
							}
							c.note(
								mean.equals(greatest)
									? "kept at its argument's scale"
									: "rounded up into a new integer digit"
							)
							assert.equal(
								integerDigits(p.coefficient, p.minScale),
								defined(numericBoundOf(result), "the mean's bound").digits,
								"the mean reaches its bound's integer digits"
							)
						})
				)
			)
	)
})
