/**
 * The page compiler and the page runtime template are total on generated ordered queries, without a database.
 *
 * Each oracle case (test/support/oracle/gen: plain, attached and heterogeneous-union roots) is ordered by a drawn prefix
 * of its result heading, rotated, each direction drawn, as the pg page suite orders it (test/pg/page/generated.ts). Its
 * page either compiles or is refused with a typed CompileError that is no MalformedDescription: the compiler built the
 * query itself, so a refusal of its own structure is a defect, and so is a throw. The same holds of the page runtime
 * template over the compiled page. The population must reach a page of heading groups, a page with attachments and a
 * page whose attachment takes its other form per execution. Every plain or wildcard-text column of every statement a
 * page compiles is the one type of its carrier the registry builds, never one built by hand, as
 * test/unit/lower/registry-types.test.ts states of the lowerings.
 *
 * Oracle: totality, a universal law: the compiler built the query, so every refusal is typed and none is of malformed
 * structure; the registry's own types for the columns. A case whose lowerings refuse it is no case of this property and
 * is given up.
 *
 * Features: a page of heading groups, a page with attachments, and a page whose attachment takes its other form per
 * execution; kept cases plant the first and the last.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): total-heading-groups-malformed (a page of heading groups refused as
 * malformed).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import { compiledPageRuntime } from "#adapter/served/forms.ts"
import { indices } from "#compiler/core/array.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { relNode, rooted } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { CompletedOrder, OrderKey } from "#compiler/ir/rel.ts"
import { contractOf, numericTypmodOf, sameScalarType, textOf } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import { compilePage, type PageArtifact } from "#compiler/lower/shapes/page/compile.ts"
import { statementOutput } from "#compiler/runtime/lower/tree.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { hasCapability } from "#compiler/scalar/registry.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { admitGenerated } from "#test/support/compile.ts"
import { conservativePage } from "#test/support/conservative.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { isPlainCarrier } from "#test/support/fixtures/ir/scalar.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	defaultGenConfig,
	fullCaseSwarms,
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
	type RootSketch,
	undrawn
} from "#test/support/oracle/gen/query.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"
import { checkedLowering } from "#test/support/oracle/verify/index.ts"
import { everyColumnCarried } from "#test/support/spine.ts"

/** What a page case reached; a case no ordered read stands for, or whose query a lowering refuses, holds no page to judge
 * and is noted as such: the lowerings' refusals are their own suites'. */
type TotalFeature =
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
interface OrderedSketch {
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

const orderedSketchGen: Gen<OrderedSketch> = (source) => ({
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
const resolveOrdered =
	(sketch: OrderedSketch): Gen<OrderedCase> =>
	(source) => ({
		...sketch,
		c:
			sketch.c.kind === "sketch"
				? source.draw(resolveQueryCase(sketch.c.sketch, totalConfig))
				: sketch.c.c
	})

/** The generator's smallest sketch of `root` over R0(a integer), under full swarms, which resolve drawing nothing. */
const ordered = (root: RootSketch): OrderedSketch => ({
	c: {
		kind: "sketch",
		sketch: {
			schema: {
				palette: [0],
				closed: [],
				relations: [
					{
						columns: [0],
						pkMask: 0,
						pure: false,
						keyMasks: [],
						mutable: false,
						fk: { enabled: false, target: 0, typed: false },
						spanKey: false
					}
				]
			},
			facts: [],
			root,
			paramNames: [],
			...fullCaseSwarms
		}
	},
	rotate: 0,
	dirs: Array.from({ length: 8 }, () => false),
	stated: 0
})

/**
 * Planted: the pages the drawn roots reach a few times a run, each from the generator's smallest sketch of its root
 * over R0(a integer), ordered by the completed heading alone:
 * - heading groups: the union of R0's row count and of nothing, each beside its tag literal, so the groups are told
 *   apart by the tag, their common key;
 * - an attachment of its other form per execution: R0's row count with the first row of a count of R0 attached,
 *   correlated on it.
 */
const plantedCases: ReadonlyArray<Kept<OrderedSketch, TotalFeature>> = (() => {
	const read: QuerySketch = {
		tag: "match",
		occurrences: [
			{
				source: { tag: "relation", pick: 0 },
				columns: [{ mode: 0, pick: 0, value: { cls: 0, sp: 0 } }]
			}
		],
		equalities: [],
		lateral: { kind: "none" }
	}
	const count: QuerySketch = {
		tag: "group",
		input: read,
		full: false,
		boundMask: 0,
		keyMask: 0,
		aggs: [{ fn: 0, column: 0 }]
	}
	return [
		{
			note: "a union of heading groups",
			sketch: ordered({
				tag: "hetero",
				groups: [
					{ arms: [count], width: 1, picks: [0] },
					{ arms: [{ tag: "project", input: read, out: [] }], width: 1, picks: [0] }
				]
			}),
			draws: "",
			reaches: ["heading groups"]
		},
		{
			note: "an attachment of a bounded child",
			sketch: ordered({
				tag: "attach",
				body: count,
				children: [
					{
						child: count,
						correlation: [0],
						take: { kind: "drawn", value: { rotate: 0, dirs: [], stated: undrawn, k: 0 } },
						nested: []
					}
				]
			}),
			draws: "",
			reaches: ["per-execution form"]
		}
	]
})()

interface OrderedQuery {
	readonly query: LogicalQuery
	readonly stated: ReadonlyArray<OrderKey>
}

/**
 * The case's query under an ordered result: the stated keys, then the rest of the heading ascending in heading order,
 * as the checker completes an orderBy; undefined when a column has no admitted order.
 */
const orderedQuery = (o: OrderedCase): OrderedQuery | undefined => {
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
		order,
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
const registryTypes = (artifacts: ReadonlyArray<PageArtifact>): void => {
	for (const artifact of artifacts) {
		for (const parts of [
			...Arr.map(Rec.values(artifact.requests), (request) => flight(request.program.roots)),
			...Arr.map(Rec.values(artifact.probes), (probe) => flight(probe.program.roots))
		]) {
			for (const part of parts) {
				for (const column of statementOutput(part.role, part.heading, part.fused).heading) {
					const t = column.type
					if (
						isPlainCarrier(t.carrier) &&
						contractOf(t) === undefined &&
						!("serial" in t) &&
						numericTypmodOf(t) === undefined
					) {
						assert.ok(
							sameScalarType(t, plainType(t.carrier)),
							`${column.name}: the registry's ${t.carrier}`
						)
					}
					if (textOf(t)?.regex === "wildcard" && contractOf(t) === undefined) {
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

describe("the page compiler and the page runtime template", () => {
	it.effect(
		"compile every generated ordered query, or refuse it with a typed CompileError of no malformed structure",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "totality: a page or a typed refusal of no malformed structure"
						},
						suite: "unit/page/runtime-total",
						draw: drawn(orderedSketchGen),
						literal: Formatter.format,
						coverage: required<TotalFeature>(
							["heading groups", "attachments", "per-execution form"],
							{ cases: 200, sense: notesOnly }
						),
						kept: plantedCases,
						/**
						 * The rotating stream's sample, each case a page compiled without a database: the attach roots are 2 of
						 * the generated roots' 8 weights, and most generated hetero roots are thinned away by the case's swarm or
						 * refused for want of a common key.
						 */
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							const o = c.draw(resolveOrdered(sketch))
							const orderedRead = orderedQuery(o)
							if (orderedRead === undefined) {
								c.note("a case no ordered read stands for")
								return
							}
							const query = orderedRead.query
							/** The case's names, under the codes its schema's installation holds. */
							const codes = schemaCodes(o.c.schema)
							const names = standInNames("Oracle", codes)
							/** The lowerings are not this property's subject: a case either of them refuses is noted as such. */
							const conservative = lowerConservative(conservativeInput(query), {
								names,
								params: query.params,
								subject: { kind: "query" }
							})
							if (!conservative.ok) {
								c.note("a query a lowering refuses")
								return
							}
							const catalog = genCatalog(o.c.schema)
							const admission = admitGenerated(query)
							const optimized = admission.ok
								? lowerOptimized(admission.value, {
										names,
										context: "snapshot",
										catalog,
										subject: { kind: "query" }
									})
								: admission
							if (!optimized.ok) {
								c.note("a query a lowering refuses")
								return
							}
							checkedLowering({
								optimized: optimized.value,
								alignment: { kind: "aligned", conservative: conservative.value },
								context: "snapshot",
								catalog
							})
							const pageInput = {
								checked: query,
								optimized: optimized.value,
								names,
								stated: { keys: orderedRead.stated, at: SourceLoc("generated orderBy", []) }
							}
							const page = compilePage(pageInput)
							if (!page.ok) {
								assert.ok(page.error.reason._tag !== "MalformedDescription", page.error.message)
								return
							}
							const template = page.value
							const baseline = succeeded(conservativePage(pageInput, template))
							registryTypes([template.artifact, baseline])
							if (baseline.requests.first.delivery.kind === "headingGroups") {
								c.note("heading groups")
							}
							const first = template.artifact.requests.first.program
							if (Arr.some(flight(first.roots), (s) => s.role.kind === "attachment")) {
								c.note("attachments")
							}
							if (first.statement.forms.kind === "chosen") {
								c.note("per-execution form")
							}
							const runtime = compiledPageRuntime({
								page: template,
								params: query.params,
								query: "unit/page/runtime-total",
								generation: { schema: "oracle", extensions: {} },
								spine: everyColumnCarried(query.dag),
								codes
							})
							if (Result.isFailure(runtime)) {
								assert.ok(
									runtime.failure.reason._tag !== "MalformedDescription",
									runtime.failure.message
								)
							}
						})
				)
			)
	)
})
