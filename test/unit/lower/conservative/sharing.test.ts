/**
 * The conservative lowering lowers a node its statement reads more than once once (lower/conservative/dispatch.ts
 * sharedOf): a DAG whose paths double at every level, each level a region matching the level below it twice, lowers to
 * statements that grow at most linearly with its depth. Each statement passes both SQL audits, and the statements are
 * counted as AST nodes (a structural property, never printed text): one more level costs no more at depth 2d than at
 * depth d, where a lowering that unfolds the DAG into its paths pays 2^d for a level at depth d. Exhausted over where
 * the levels read their values from, and over d:
 *
 * - nothing outside them: each level is a CTE of the statement;
 * - a parent row, the levels being an attachment's child: each is a CTE of the child, evaluated per parent row;
 * - the region they are a source of, the levels reading its first occurrence: each is a CTE of the source the region
 *   reads LATERAL, evaluated per row of that occurrence.
 *
 * Oracle: at most linear growth stated as a checker (a specification): a level's marginal cost does not grow with the
 * depth it is added at. Features: each placement.
 *
 * Plant, failing the search: a lowering that shares no node (sharing-unfold).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { isList, isRecord } from "#compiler/core/record.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { auditStatementViolations, auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { Edge, plainRegion, Q, T } from "#test/unit/lower/conservative/fixtures.ts"

type Placement = "uncorrelated" | "correlated to a parent row" | "correlated to its region"

const placements: Arr.NonEmptyReadonlyArray<Placement> = [
	"uncorrelated",
	"correlated to a parent row",
	"correlated to its region"
]

const names = productionNames("Ledger", { kind: "declared" }, localVectorSchema, emptyCodebook)

/**
 * The paths of `depth` levels over edges: the bottom level the edges, each starting at `start` when it is given, and
 * each level above it the paths through two of the level below, which one region matches twice.
 */
const doubling = (q: Q, depth: number, start: ScalarExpr | undefined): RelNode => {
	let level = q.region([
		{
			source: q.base(Edge, conservativeMeta),
			bind: { src: "a", dst: "b" },
			constants: start === undefined ? {} : { src: start }
		}
	])
	for (let i = 0; i < depth; i++) {
		level = q.project(
			q.region([
				{ source: level, bind: { a: "a", b: "m" }, constants: {} },
				{ source: level, bind: { a: "m", b: "b" }, constants: {} }
			]),
			[
				["a", "a"],
				["b", "b"]
			],
			conservativeMeta
		)
	}
	return level
}

/** The doubling DAG of `depth` levels, placed as `placement` says. */
const placed = (placement: Placement, depth: number): LogicalQuery => {
	const q = new Q()
	switch (placement) {
		case "uncorrelated":
			return q.build(doubling(q, depth, undefined))
		case "correlated to a parent row": {
			const parent = q.region([
				{ source: q.base(Edge, conservativeMeta), bind: { src: "p", dst: "q" }, constants: {} }
			])
			const child = doubling(q, depth, q.col(parent, "p"))
			return q.build(q.attach(parent, child, "paths", [["p", "a"]], "array", undefined))
		}
		case "correlated to its region": {
			const outer = q.b.reserve()
			const start = q.b.expr({
				kind: "column",
				column: { node: outer, name: "x" },
				args: [],
				type: T.int4,
				nonNull: "storage"
			})
			return q.build(
				q.regionWith(
					[
						{ source: q.base(Edge, conservativeMeta), bind: { src: "x", dst: "y" }, constants: {} },
						{ source: doubling(q, depth, start), bind: { a: "x", b: "z" }, constants: {} }
					],
					{ ...plainRegion, id: { kind: "reserved", id: outer } }
				)
			)
		}
	}
}

/** The nodes of a statement's AST: each object, list and scalar one, and an absent clause none. */
const nodes = (v: unknown): number =>
	v === undefined
		? 0
		: isList(v)
			? Arr.reduce(v, 1, (n, x) => n + nodes(x))
			: isRecord(v)
				? Arr.reduce(Rec.values(v), 1, (n, x) => n + nodes(x))
				: 1

/** The AST nodes of the statements the conservative lowering emits for `query`, each audited. */
const loweredSize = (query: LogicalQuery, at: string): number => {
	const program = succeeded(
		lowerConservative(conservativeInput(query), {
			names,
			params: query.params,
			subject: { kind: "query" }
		}),
		at
	)
	return Arr.reduce(flight(program.roots), 0, (n, statement) => {
		assert.deepEqual(auditStatementViolations(statement.ast), [], at)
		assert.deepEqual(auditTextViolations(statement.sql.text), [], at)
		return n + nodes(statement.ast)
	})
}

describe("shared nodes", () => {
	it.effect(
		"a DAG of 2^d paths lowers to statements that grow at most linearly with d, wherever its shared levels read from",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "each of three placements, a level added at depth 3 or 4 and at twice that depth",
						oracle: {
							kind: "specification",
							name: "at most linear growth: one more level costs no more AST nodes at depth 2d than at depth d"
						},
						suite: "unit/lower/conservative/sharing",
						generator: (source) =>
							[source.draw(element(placements)), source.draw(int(3, 4))] as const,
						literal: Formatter.format,
						limit: placements.length * 2,
						coverage: requiredInSpace<Placement>(placements),
						caseHang
					},
					([placement, depth], c) =>
						Effect.sync(() => {
							const at = `${placement}, a level at depth ${depth} against one at ${2 * depth}`
							const levelCost = (level: number) =>
								loweredSize(placed(placement, level + 1), at) -
								loweredSize(placed(placement, level), at)
							const shallow = levelCost(depth)
							const deep = levelCost(2 * depth)
							assert.ok(
								deep <= shallow,
								`${at}: a level costs ${shallow} AST nodes at depth ${depth} and ${deep} at depth ${2 * depth}`
							)
							c.note(placement)
						})
				)
			)
	)
})
