import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
/**
 * Generated query cases: the conservative-oracle gate's case population.
 *
 * Every case is valid by construction: the schema decodes as a Description, the facts satisfy every declared key and
 * containment under native equality, the DAG validates and is normalized, and every parameter it reads has a value.
 * Ownership accepts every schema, so every key is representable. The perCase spelling rule holds on every stored value
 * a query can output, and spelling.test.ts checks it at every merge the reference makes. A configuration that leaves
 * forms out draws none of them. Which forms the population reaches is the gate's own required features
 * (test/pg/oracle/conservative.test.ts), never a share measured here.
 *
 * Normalized: identifiers by first occurrence from the root (dag.ts normalizeDag).
 *
 * The edges of an acyclic closure pass a strict order filter: src < dst.
 */

import { Array as Arr, Duration, Effect, Formatter, Option, Order, Record } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { type TypedLiteral, literalProblem } from "#compiler/ir/expr.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { assert, defined, lacks } from "#test/support/assert.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import { literalRowKey, literalEqualityKey } from "#test/support/oracle/gen/domain.ts"
import { printLiteral } from "#test/support/oracle/gen/print-dag.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { allKeys, keyIndices, relationNamed, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { ownedInput } from "#test/support/policy.ts"

const nodes = (c: QueryCase): ReadonlyArray<RelNode> => topoOrder(c.query.dag)

/**
 * Every stored value a query can output, with its type: facts, closed payloads, relation-parameter rows, and the
 * literals projections emit.
 */
const storedValues = (c: QueryCase): ReadonlyArray<readonly [ScalarType, TypedLiteral]> => {
	const out: Array<readonly [ScalarType, TypedLiteral]> = []
	const push = (
		row: ReadonlyArray<TypedLiteral>,
		columns: ReadonlyArray<{ readonly type: ScalarType }>
	) => {
		for (const [i, value] of row.entries()) {
			out.push([defined(columns[i]).type, value])
		}
	}
	for (const r of c.schema.relations) {
		for (const row of defined(c.facts[r.name], `the facts of ${r.name}`)) {
			push(row, r.columns)
		}
	}
	for (const k of c.schema.closed) {
		for (const row of k.rows) {
			push(row.slice(1), k.payload)
		}
	}
	for (const p of Record.values(c.query.params)) {
		if (p.kind !== "relation") {
			continue
		}
		for (const row of p.rows) {
			push(row, p.heading)
		}
	}
	for (const n of nodes(c)) {
		if (n.kind !== "ProjectSet") {
			continue
		}
		out.push(
			...Arr.flatMap(n.out, (o) =>
				o.expr.kind === "literal" ? [[o.expr.type, o.expr.value] as const] : []
			)
		)
	}
	return out
}

/** The literal as it is written into SQL, so -0 and a numeric display scale are kept. */
const spellingOf = (type: ScalarType, l: TypedLiteral): string => printLiteral(l, type)

/** Fails with the printed case, rendered only when the check fails. */
const holds = (condition: boolean, what: string, c: QueryCase): void => {
	if (!condition) {
		throw new Error(`${what}\n${printQueryCase(c)}`)
	}
}

const fits = (
	row: ReadonlyArray<TypedLiteral>,
	columns: ReadonlyArray<{ readonly type: ScalarType }>
): boolean =>
	row.length === columns.length &&
	Arr.every(row, (v, i) => {
		const column = columns[i]
		return column !== undefined && literalProblem(v, column.type) === undefined
	})

describe("generated query cases", () => {
	it.effect(
		"are valid: Description, facts under the laws, a normalized valid DAG, bound parameters",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-gen/query-valid",
						draw: drawn(queryCaseGen(defaultGenConfig)),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(c) =>
						Effect.sync(() => {
							holds(
								decodeDesc("schema", schemaDesc(c.schema)).ok,
								"the schema Description decodes",
								c
							)
							/** An admissible schema: ownership accepts it, every key representable. */
							const owned = ownedInput(schemaDesc(c.schema))
							if (!owned.ok) {
								holds(false, `ownership: ${owned.error.message}`, c)
							}
							validateDag(c.query.dag)
							assert.deepEqual(c.query.dag.roots, [c.query.dag.roots[0]])
							const root = c.query.dag.roots[0]
							assert.equal(root.id, NodeId("n#0"))
							assert.deepEqual(
								Arr.sort(Record.keys(c.query.params), Order.String),
								Arr.sort(root.meta.paramDeps, Order.String)
							)
							for (const p of Record.values(c.query.params)) {
								holds(
									p.kind === "scalar"
										? literalProblem(p.value, p.type) === undefined
										: Arr.every(p.rows, (row) => fits(row, p.heading)),
									"every parameter value fits its type",
									c
								)
							}
							for (const r of c.schema.relations) {
								const rows = defined(c.facts[r.name], `the facts of ${r.name}`)
								holds(
									Arr.every(rows, (row) => fits(row, r.columns)),
									`every fact of ${r.name} fits its columns`,
									c
								)
								for (const key of allKeys(r)) {
									const cols = keyIndices(r, key)
									holds(
										new Set(Arr.map(rows, (row) => literalRowKey(row, cols))).size === rows.length,
										`${r.name} key ${Arr.join(key, ",")}`,
										c
									)
								}
							}
							for (const k of c.schema.containments) {
								const from = relationNamed(c.schema, k.from.relation)
								const to = relationNamed(c.schema, k.to.relation)
								const targets = new Set(
									Arr.map(defined(c.facts[to.name], `the facts of ${to.name}`), (row) =>
										literalRowKey(row, keyIndices(to, k.to.fields))
									)
								)
								for (const row of defined(c.facts[from.name], `the facts of ${from.name}`)) {
									holds(
										targets.has(literalRowKey(row, keyIndices(from, k.from.fields))),
										`${from.name} is contained`,
										c
									)
								}
							}
						})
				)
			)
	)

	it.effect("spell every outputable stored value once per class in a case (perCase)", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/oracle-gen/query-spelling",
					draw: drawn(queryCaseGen(defaultGenConfig)),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				(c) =>
					Effect.sync(() => {
						const seen: Array<{ type: ScalarType; key: string; spelling: string }> = []
						for (const [type, literal] of storedValues(c)) {
							const key = literalEqualityKey(literal)
							const spelling = spellingOf(type, literal)
							const prior = Arr.findFirst(
								seen,
								(s) => s.key === key && sameScalarType(s.type, type)
							)
							if (Option.isSome(prior)) {
								holds(
									prior.value.spelling === spelling,
									`${spelling} is spelled ${prior.value.spelling} elsewhere`,
									c
								)
							} else {
								seen.push({ type, key, spelling })
							}
						}
					})
			)
		)
	)

	it.effect("honor a configuration that leaves forms out", (ctx) =>
		Effect.gen(function* () {
			const plain: GenConfig = {
				...defaultGenConfig,
				query: {
					...defaultGenConfig.query,
					params: false,
					inputSets: false,
					closure: "acyclic",
					weights: {
						...defaultGenConfig.query.weights,
						closure: 0,
						intersect: 0,
						difference: 0,
						take: 0
					},
					roots: {
						...defaultGenConfig.query.roots,
						attach: 0,
						hetero: 0
					}
				}
			}
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-gen/query-plain",
						draw: drawn(queryCaseGen(plain)),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(c) =>
						Effect.sync(() => {
							for (const n of nodes(c)) {
								lacks(
									["Recursive", "Intersect", "Difference", "Take", "Attach", "InputSet"],
									n.kind
								)
							}
							assert.equal(Record.size(c.query.params), 0)
						})
				)
			)
			const acyclic: GenConfig = {
				...defaultGenConfig,
				query: {
					...defaultGenConfig.query,
					closure: "acyclic",
					weights: {
						...defaultGenConfig.query.weights,
						closure: 6
					}
				}
			}
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-gen/query-acyclic",
						draw: drawn(queryCaseGen(acyclic)),
						literal: Formatter.format,
						features: features<"closure">(["closure"]),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(c, reached) =>
						Effect.sync(() => {
							for (const n of nodes(c)) {
								if (n.kind !== "Recursive") {
									continue
								}
								reached.note("closure")
								const edges = n.base
								if (edges.kind !== "ProjectSet") {
									assert.fail(`a closure's edges are a ${edges.kind}, not a ProjectSet`)
								}
								assert.equal(edges.input.kind, "Filter")
							}
						})
				)
			)
		})
	)
})
