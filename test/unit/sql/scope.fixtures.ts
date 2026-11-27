/**
 * What the property of scope.test.ts reads: statements every name of which is bound where it is read, grown along each
 * dimension a resolution that searched the scopes around a reference, or undid a frame by a search of every name,
 * would pay for again at each reference or frame: subqueries correlated to the outermost query, LATERAL FROM items
 * reading the first, a join chain's ONs reading its first source, and CTEs each reading the one before it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect } from "effect"
import type { Cte, FromItem, OperandSelect, Select } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	core,
	cteRefAs,
	derived,
	distinctCore,
	eq,
	exists,
	operandSelect,
	select,
	table,
	target,
	targetAs
} from "#compiler/sql/build.ts"
import { scopeEscapes } from "#compiler/sql/scope.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"

/** A dimension a statement grows along, each item of it one more reference across the scopes it opens. */
export type Dimension = "nesting" | "width" | "chain" | "ctes"

/** The relation every statement reads, under the generated alias of its place. */
const read = (alias: string): FromItem => table("s", "t", alias)

/** The outermost query's column every grown item reads. */
const outer = col("r1", "a")

/** A query over r1 whose WHERE is `where`, delivering r1's column. */
const over = (from: ReadonlyArray<FromItem>, where: Parameters<typeof core>[2]): Select =>
	select(distinctCore([target(outer)], from, where))

/** `n` subqueries, each in the WHERE of the one before it, each reading its own relation and r1. */
const nesting = (n: number): Select => {
	const level = (i: number): OperandSelect => {
		const own = col(`r${i}`, "a")
		const here = eq(own, outer)
		return operandSelect(
			core([], [read(`r${i}`)], i < n + 1 ? and([here, exists(level(i + 1))]) : here)
		)
	}
	return over([read("r1")], exists(level(2)))
}

/** `n` LATERAL derived tables after r1, each reading r1. */
const width = (n: number): Select =>
	over(
		[
			read("r1"),
			...Array.from({ length: n }, (_, i) =>
				derived(operandSelect(core([targetAs(outer, "c1")], [], undefined)), `r${i + 2}`, true)
			)
		],
		undefined
	)

/** A join chain of r1 and `n` sources after it, each joined on its own column and r1's. */
const chain = (n: number): Select => {
	const steps = Array.from({ length: n }, (_, i) => ({
		kind: "on" as const,
		source: table("s", "t", `r${i + 2}`),
		on: eq(col(`r${i + 2}`, "a"), outer)
	}))
	const [first, ...rest] = steps
	return over(
		first === undefined
			? [read("r1")]
			: [{ kind: "joins", first: table("s", "t", "r1"), steps: [first, ...rest] }],
		undefined
	)
}

/** `n` CTEs, each reading the one before it, the first r1, and the statement reading the last. */
const ctes = (n: number): Select => {
	const defined: Array<Cte> = []
	for (let i = 0; i < n; i += 1) {
		const alias = `r${n + 2 + i}`
		const from = i === 0 ? read(alias) : cteRefAs(`r${i + 1}`, alias)
		defined.push({
			name: `r${i + 2}`,
			materialized: "MATERIALIZED",
			query: operandSelect(
				core([targetAs(col(alias, i === 0 ? "a" : "c1"), "c1")], [from], undefined)
			)
		})
	}
	const [first, ...rest] = defined
	const body = select(
		distinctCore([target(col("r1", "c1"))], [cteRefAs(`r${n + 1}`, "r1")], undefined)
	)
	return first === undefined
		? body
		: { ...body, with: { recursive: false, ctes: [first, ...rest] } }
}

/** The statement of `n` items along `dimension`. */
const grown = (dimension: Dimension, n: number): Select => {
	switch (dimension) {
		case "nesting":
			return nesting(n)
		case "width":
			return width(n)
		case "chain":
			return chain(n)
		case "ctes":
			return ctes(n)
	}
}

/** The module whose calls the property counts: the scope check's. */
const checked = "packages/engine/src/sql/scope.ts"

/**
 * The calls the scope check makes over the statement of `n` items along `dimension`, every function of its module
 * counted (kernel/calls.ts everyCallCount), the statement built before counting; and that it finds the statement in
 * scope.
 */
export const callsAt = (dimension: Dimension, n: number) =>
	Effect.gen(function* () {
		const statement = grown(dimension, n)
		const [escapes, counts] = yield* everyCallCount(
			Effect.sync(() => scopeEscapes(statement)),
			(file) => file === checked
		)
		assert.deepEqual(
			escapes,
			[],
			`the ${dimension} statement of ${n} items binds every name it reads`
		)
		return Arr.reduce([...counts.values()], 0, (sum, k) => sum + k)
	})
