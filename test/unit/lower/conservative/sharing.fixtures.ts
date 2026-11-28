/** What the properties of sharing.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Record as Rec } from "effect"
import { isList, isRecord } from "#compiler/core/record.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { type ScalarExpr, storedColumn } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { succeeded } from "#test/support/assert.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import {
	auditStatementViolations,
	auditTextViolations,
	guardedTermsOf
} from "#test/support/oracle/verify/sql.ts"
import { Edge, plainRegion, Q, T } from "#test/support/unit/lower/conservative/fixtures.ts"

export type Placement = "uncorrelated" | "correlated to a parent row" | "correlated to its region"

export const placements: Arr.NonEmptyReadonlyArray<Placement> = [
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
export const placed = (placement: Placement, depth: number): LogicalQuery => {
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
			const start = q.b.expr(storedColumn(outer, "x", T.int4))
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
export const loweredSize = (query: LogicalQuery, at: string): number => {
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
		assert.deepEqual(auditTextViolations(statement.sql.text, guardedTermsOf(statement.ast)), [], at)
		return n + nodes(statement.ast)
	})
}
