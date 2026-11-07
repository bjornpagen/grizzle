import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { canonicalEquals, everyProperty, isCanonicalizable } from "#compiler/core/canonical.ts"
import type * as Result from "#compiler/core/result.ts"
import { toTable } from "#compiler/ir/dag.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import { identicalExprTable, identicalScalarType } from "#compiler/ir/identical.ts"
import { decodeScalarType, exprTableShape } from "#compiler/ir/scalar-shape.ts"
import { decodeWith } from "#compiler/ir/shape.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { generatedDags } from "#test/unit/ir/population.ts"
import { scalarTypeGen } from "#test/unit/ir/types.ts"

/**
 * Structural identity (ir/identical.ts) against the equality of canonical text, the oracle it replaces: over a drawn
 * value and a one-leaf edit of it, both decoded, the two agree. An edit replaces one string, number, bigint or boolean
 * anywhere in the value, or drops one key, so a field the structural comparison misses is an edit it calls identical
 * while the canonical texts differ.
 */

type Segment = string | number

/** A one-leaf edit: where, and whether it replaces the leaf or drops the key that holds it. */
interface Edit {
	readonly path: ReadonlyArray<Segment>
	readonly drop: boolean
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

/** The paths to every leaf of a plain value; a canonical value (a decimal, money, a vector) is a leaf of its own. */
const leavesOf = (root: unknown): ReadonlyArray<ReadonlyArray<Segment>> => {
	const out: Array<ReadonlyArray<Segment>> = []
	const stack: Array<{ readonly value: unknown; readonly path: ReadonlyArray<Segment> }> = [
		{ value: root, path: [] }
	]
	for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
		const { value, path } = top
		if (Arr.isArray(value)) {
			for (const [i, item] of value.entries()) {
				stack.push({ value: item, path: [...path, i] })
			}
		} else if (isRecord(value) && !isCanonicalizable(value)) {
			for (const [key, item] of Rec.toEntries(value)) {
				stack.push({ value: item, path: [...path, key] })
			}
		} else {
			out.push(path)
		}
	}
	return out
}

/** Another value of a leaf's own kind: a string extended, a number or bigint stepped, a boolean flipped. */
const replaced = (leaf: unknown): unknown => {
	switch (typeof leaf) {
		case "string":
			return `${leaf}x`
		case "number":
			return leaf + 1
		case "bigint":
			return leaf + 1n
		case "boolean":
			return !leaf
		case "function":
		case "object":
		case "symbol":
		case "undefined":
			return leaf
	}
}

/** The value with the edit applied: each container on the path copied, every other part shared. */
const applied = (value: unknown, path: ReadonlyArray<Segment>, drop: boolean): unknown => {
	const [head, ...rest] = path
	if (head === undefined) {
		return replaced(value)
	}
	if (Arr.isArray(value) && typeof head === "number") {
		const items: Array<unknown> = [...value]
		if (rest.length === 0 && drop) {
			items.splice(head, 1)
		} else {
			items[head] = applied(items[head], rest, drop)
		}
		return items
	}
	if (isRecord(value) && typeof head === "string") {
		const entries = Arr.flatMap(
			Rec.toEntries(value),
			([key, item]): ReadonlyArray<[string, unknown]> =>
				key !== head
					? [[key, item]]
					: rest.length === 0 && drop
						? []
						: [[key, applied(item, rest, drop)]]
		)
		return Rec.fromEntries(entries)
	}
	return value
}

/** A drawn edit of `value`: one of its leaves, replaced or dropped. */
const editOf =
	(value: unknown): Gen<Edit | undefined> =>
	(source) => {
		const leaves = leavesOf(value)
		if (leaves.length === 0) {
			return undefined
		}
		const path = leaves[source.draw(int(0, leaves.length - 1))]
		return path === undefined ? undefined : { path, drop: source.draw(int(0, 3)) === 0 }
	}

type Population =
	| { readonly kind: "type"; readonly value: unknown; readonly edit: Edit | undefined }
	| { readonly kind: "table"; readonly value: unknown; readonly edit: Edit | undefined }

const typePopulation: Gen<Population> = (source) => {
	const value = source.draw(scalarTypeGen)
	return { kind: "type", value, edit: source.draw(editOf(value)) }
}

/** A generated DAG's expressions as one table, rooted at its first. */
const tablePopulation: Gen<Population> = (source) => {
	const table = toTable(source.draw(generatedDags))
	const first = table.ok ? Rec.keys(table.value.exprs)[0] : undefined
	const value = table.ok && first !== undefined ? { root: first, exprs: table.value.exprs } : {}
	return { kind: "table", value, edit: source.draw(editOf(value)) }
}

type Feature =
	| "types identical"
	| "types different"
	| "tables identical"
	| "tables different"
	| "an edit refused"

/** The two decoded values of a case, or none where either does not decode. */
const decodedPair = <A>(
	decode: (value: unknown) => Result.Result<A, unknown>,
	c: Population
): readonly [A, A] | undefined => {
	const original = decode(c.value)
	const other = decode(c.edit === undefined ? c.value : applied(c.value, c.edit.path, c.edit.drop))
	return original.ok && other.ok ? [original.value, other.value] : undefined
}

const decodeTable = (value: unknown): Result.Result<ExprTable, unknown> =>
	decodeWith(exprTableShape, value, "expression table")

describe("structural identity", () => {
	it.effect(
		"agrees with canonical text equality over every one-leaf edit of a decoded type or expression table",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/identical",
						literal: Formatter.format,
						draw: drawn(oneOf([typePopulation, tablePopulation])),
						runs: 400,
						shrink: completeShrink,
						coverage: required<Feature>(
							[
								"types identical",
								"types different",
								"tables identical",
								"tables different",
								"an edit refused"
							],
							{ cases: 800, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "second-implementation", name: "canonical text equality" }
					},
					(c, n) =>
						Effect.sync(() => {
							if (c.kind === "type") {
								const pair = decodedPair(decodeScalarType, c)
								if (pair === undefined) {
									n.note("an edit refused")
									return
								}
								const canonical = canonicalEquals(pair[0], pair[1], everyProperty)
								n.note(canonical ? "types identical" : "types different")
								assert.equal(identicalScalarType(pair[0], pair[1]), canonical)
								return
							}
							const pair = decodedPair(decodeTable, c)
							if (pair === undefined) {
								n.note("an edit refused")
								return
							}
							const canonical = canonicalEquals(pair[0], pair[1], everyProperty)
							n.note(canonical ? "tables identical" : "tables different")
							assert.equal(identicalExprTable(pair[0], pair[1]), canonical)
						})
				)
			)
	)
})
