/** What the properties of total.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { relNode, rooted, groupHeadings } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { CompletedOrder, OrderKey } from "#compiler/ir/rel.ts"
import { numericTypmodOf, sameScalarType, textOf } from "#compiler/ir/scalar.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { PageArtifact } from "#compiler/lower/shapes/page/compile.ts"
import { statementOutput } from "#compiler/runtime/lower/tree.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { hasCapability } from "#compiler/scalar/registry.ts"
import { isPlainCarrier } from "#test/support/fixtures/ir/scalar.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase
} from "#test/support/oracle/gen/case.ts"
import {
	genParamDecls,
	queryGenerators,
	type QuerySketch,
	type RootSketch
} from "#test/support/oracle/gen/query.ts"
import { rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"

/** What a page case reached; a case no ordered read stands for, or whose query a lowering refuses, holds no page to judge
 * and is noted as such: the lowerings' refusals are their own suites'. */
export type TotalFeature =
	| "heading groups"
	| "attachments"
	| "per-execution form"
	| "a case no ordered read stands for"
	| "a query a lowering refuses"

interface OrderedCase {
	readonly c: QueryCase
	readonly rotate: number
	readonly dirs: ReadonlyArray<boolean>
	readonly stated: number
}

/** The generated roots: heterogeneous unions weighted up beside plain and attached roots. */
const totalConfig: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		roots: {
			...defaultGenConfig.query.roots,
			plain: 2,
			attach: 2,
			hetero: 4
		}
	}
}

/** A query case as drawn: a sketch the property resolves, or a case drawn whole. */
type CaseDraw =
	| { readonly kind: "sketch"; readonly sketch: QueryCaseSketch }
	| { readonly kind: "case"; readonly c: QueryCase }

/** An ordered case as drawn: its query case, and the order over its result heading. */
export interface OrderedSketch {
	readonly c: CaseDraw
	readonly rotate: number
	readonly dirs: ReadonlyArray<boolean>
	readonly stated: number
}

const sub = queryGenerators(defaultGenConfig.query).query

/** An aggregate-only group over a generated query one operator deep: one row. */
const oneRow: Gen<QuerySketch> = (source) => ({
	tag: "group",
	input: source.draw(sub(1)),
	full: false,
	boundMask: source.draw(int(0, 63)),
	keyMask: 0,
	aggs: source.draw(
		array((source) => ({ fn: source.draw(int(0, 15)), column: source.draw(int(0, 7)) }), {
			min: 1,
			max: 2
		})
	)
})

/** A generated query one operator deep projected onto no column: at most one row, the empty one. */
const noColumns: Gen<QuerySketch> = (source) => ({
	tag: "project",
	input: source.draw(sub(1)),
	out: []
})

type HeadingGroupSketch = Extract<RootSketch, { tag: "hetero" }>["groups"][number]

/** A heading group of one arm, projected onto one to three of its columns beside the group's tag. */
const headingGroup =
	(arm: Gen<QuerySketch>): Gen<HeadingGroupSketch> =>
	(source) => ({
		arms: [source.draw(arm)],
		width: source.draw(int(1, 3)),
		picks: source.draw(array(int(0, 7), { min: 1, max: 4 }))
	})

/**
 * A heterogeneous union whose heading groups are one arm of at most one row each, so the tag every group carries is a
 * key of the common fields heading groups page by: an aggregate-only group's columns, then no column, so the two
 * headings differ, then maybe a third group of either.
 */
const headingGroupsRoot: Gen<RootSketch> = (source) => ({
	tag: "hetero",
	groups: [
		source.draw(headingGroup(oneRow)),
		source.draw(headingGroup(noColumns)),
		...source.draw(
			array(
				headingGroup(
					weighted([
						[1, oneRow],
						[1, noColumns]
					])
				),
				{ min: 0, max: 1 }
			)
		)
	]
})

export const orderedSketchGen: Gen<OrderedSketch> = (source) => ({
	/**
	 * Heading groups whose tag is a common key are drawn beside the generated roots: most generated hetero roots are
	 * thinned away by the case's swarm or have no common key.
	 */
	c: source.draw(
		weighted<CaseDraw>([
			[6, map(queryCaseSketchGen(totalConfig), (sketch): CaseDraw => ({ kind: "sketch", sketch }))],
			[
				1,
				map(rootedCaseGen(headingGroupsRoot, defaultGenConfig), (c): CaseDraw => ({
					kind: "case",
					c
				}))
			]
		])
	),
	rotate: source.draw(int(0, 7)),
	dirs: source.draw(array(boolean, { min: 8, max: 8 })),
	stated: source.draw(int(0, 8))
})

/** The ordered case a sketch resolves to, a query case's sketch resolved on the case's own decisions. */
export const resolveOrdered =
	(sketch: OrderedSketch): Gen<OrderedCase> =>
	(source) => ({
		...sketch,
		c:
			sketch.c.kind === "sketch"
				? source.draw(resolveQueryCase(sketch.c.sketch, totalConfig))
				: sketch.c.c
	})

interface OrderedQuery {
	readonly query: LogicalQuery
	readonly stated: ReadonlyArray<OrderKey>
}

/**
 * The case's query under an ordered result: the stated keys, then the rest of the heading ascending in heading order,
 * as the checker completes an orderBy; undefined when a column has no admitted order.
 */
export const orderedQuery = (o: OrderedCase): OrderedQuery | undefined => {
	const top = o.c.query.dag.roots[0]
	if (
		Arr.some(
			top.heading,
			(col) => !hasCapability(col.type, "ordering") || !hasCapability(col.type, "equality")
		)
	) {
		return undefined
	}
	const names = Arr.map(top.heading, (col) => col.name)
	const rotated = Arr.map(indices(names.length), (i) =>
		defined(names[(i + o.rotate) % names.length], "a heading column")
	)
	const stated: ReadonlyArray<OrderKey> = Arr.map(rotated.slice(0, o.stated), (column, i) => ({
		column,
		dir: o.dirs[i % o.dirs.length] === true ? "desc" : "asc"
	}))
	const named = new Set(Arr.map(stated, (k) => k.column))
	const order: CompletedOrder = {
		keys: [
			...stated,
			...Arr.map(
				Arr.filter(names, (column) => !named.has(column)),
				(column) => ({ column, dir: "asc" as const })
			)
		]
	}
	const node = relNode(NodeId("ordered"), {
		kind: "OrderedResult",
		input: top,
		orders: Arr.map(groupHeadings(top), () => order),
		heading: top.heading,
		meta: top.meta,
		loc: undefined
	})
	return {
		query: {
			dag: rooted([node]),
			params: genParamDecls(o.c.query)
		},
		stated
	}
}

/**
 * The registry's rule on every relation a page's statements deliver: a plain-carrier, contract-free, non-serial,
 * typmod-free column is its carrier's plain type, and a contract-free wildcard text the wildcard text
 * (scalar/compute/types.ts).
 */
export const registryTypes = (artifacts: ReadonlyArray<PageArtifact>): void => {
	for (const artifact of artifacts) {
		for (const parts of Arr.map(Rec.values(artifact.requests), (request) =>
			flight(request.program.roots)
		)) {
			for (const part of parts) {
				for (const column of statementOutput(part.role, part.heading, part.fused).heading) {
					const t = column.type
					if (
						isPlainCarrier(t.carrier) &&
						t.contract === undefined &&
						numericTypmodOf(t) === undefined
					) {
						assert.ok(
							sameScalarType(t, plainType(t.carrier)),
							`${column.name}: the registry's ${t.carrier}`
						)
					}
					if (textOf(t) === "wildcard" && t.contract === undefined) {
						assert.ok(
							sameScalarType(t, wildcardText),
							`${column.name}: the registry's wildcard text`
						)
					}
				}
			}
		}
	}
}
