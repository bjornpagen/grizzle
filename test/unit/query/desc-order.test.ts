import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"

/** The keys of every object reachable from `value`, in order, by path: the key order a Description has. */
const keyOrders = (value: unknown): ReadonlyArray<string> => {
	const out: Array<string> = []
	const pending: Array<readonly [string, unknown]> = [["", value]]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const [path, node] = at
		if (!isRecord(node)) {
			continue
		}
		out.push(`${path}: ${Arr.join(Rec.keys(node), ",")}`)
		for (const [key, child] of Rec.toEntries(node)) {
			pending.push([`${path}.${key}`, child])
		}
	}
	return out
}

/** Every container reachable from `value` that is not frozen, by path. */
const unfrozen = (value: unknown): ReadonlyArray<string> => {
	const out: Array<string> = []
	const pending: Array<readonly [string, unknown]> = [["", value]]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		const [path, node] = at
		if (!isRecord(node)) {
			continue
		}
		if (!Object.isFrozen(node)) {
			out.push(path)
		}
		for (const [key, child] of Rec.toEntries(node)) {
			pending.push([`${path}.${key}`, child])
		}
	}
	return out
}

/** The kind of every node a Description holds that names one: a stage's, a source's, an expression's or a term's. */
const kindsOf = (value: unknown): ReadonlySet<string> => {
	const out = new Set<string>()
	const pending: Array<unknown> = [value]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (!isRecord(node)) {
			continue
		}
		const kind = node["kind"]
		if (typeof kind === "string") {
			out.add(kind)
		}
		for (const child of Rec.values(node)) {
			pending.push(child)
		}
	}
	return out
}

type OrderFeature = "a query" | `a node of kind ${string}`

describe("a query's Description as its builder makes it", () => {
	it.effect(
		"is the Description its decoder gives for it, every object's keys in the decoder's order, and frozen throughout",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/query/desc-order",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the Description shapes' decode of the builder's Description (ir/desc.ts decodeDesc)"
						},
						coverage: required<OrderFeature>(
							[
								"a query",
								"a node of kind rules",
								"a node of kind relation",
								"a node of kind var",
								"a node of kind compare"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, k) =>
						Effect.sync(() => {
							const c = k.draw(resolveCase(sketch))
							const built = buildSchema(c.schema)
							for (const read of c.reads) {
								if (read.kind !== "query") {
									continue
								}
								const desc = succeeded(
									queryInput(buildRoot(built, built.schema, read.query)),
									"the builder admits a generated read"
								).desc
								k.note("a query")
								for (const kind of kindsOf(desc)) {
									k.note(`a node of kind ${kind}`)
								}
								const decoded = succeeded(
									decodeDesc("query", desc),
									"the decoder admits the builder's Description"
								)
								assert.notEqual(decoded, desc, "a decode is a fresh copy")
								assert.deepEqual(desc, decoded)
								assert.deepEqual(keyOrders(desc), keyOrders(decoded))
								assert.deepEqual(unfrozen(desc), [], "the Description is frozen throughout")
							}
						})
				)
			)
	)
})
