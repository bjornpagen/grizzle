import { drawn } from "@grizzle/testing/explore"
import type { Gen } from "@grizzle/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { rebuildDag, relNode, unchangedEdges } from "#compiler/ir/dag.ts"
import type { NodeOver, RelNode, ValueRefs } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { type ConservativeProgram, conservativeInput } from "#compiler/lower/conservative/types.ts"
import type { OperandBody, OperandSelect, SelectCore } from "#compiler/sql/ast.ts"
import { setQueryOf } from "#compiler/sql/build.ts"
import { canonicalRows, rawRowKey, repeatsOn, rowMultiset } from "#test/support/oracle/compare.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	type RecursionMutation,
	type RecursiveCase,
	type RecursiveFeature,
	resolveRecursiveCase
} from "#test/support/oracle/gen/recursive.ts"
import type { RawRow } from "#test/support/oracle/install/capture.ts"
import {
	aliasOrigins,
	identityVisitor,
	rewriteOperand,
	rewriteProgram,
	rewriteSelect,
	topLevelContext
} from "#test/support/oracle/mutants/ast.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"

import {
	type CheckOptions,
	comparisonFailed,
	conservative,
	defaultRunOptions,
	type Lowering,
	oracleCheck,
	type OracleOutcome,
	runOracle,
	type RunnerSide
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every feature a recursion oracle suite notes: its generator's, and rows.
 *
 * Shared pieces of the recursion oracle suites.
 *
 * - recursiveEquivalence runs a left and a right side over seeded graph-shaped recursive cases (gen/recursive.ts) and
 *   requires every statement's raw text set to agree and the left side to repeat no row. The equivalence suite
 *   runs it with the conservative lowering against the reference evaluator, and the graph suite runs it with the
 *   optimized lowering on the left and the conservative lowering on the right, over the same seeds and population.
 * - atRoot lowers another root of a case's DAG: a fixed-length case carries its connected match through joins as the
 *   query root and the same answer through a recursive relation as its second root.
 * - The recursive counterexample mutants rewrite the conservative output the way an unsound optimizer would:
 *   feedbackUnionAll replaces recursive UNION with UNION ALL over plain seed and step SELECTs (the I8
 *   rewrite applied to every recursion, not only the generator's acyclic closure, in the V6 shape an optimizer emits);
 *   bagRecursion drops every DISTINCT inside the recursive term as well as the feedback deduplication, so the
 *   recursion believes each transition already unique; eraseEdgeIdentity folds edges by their endpoints rather than
 *   their edge id before an aggregate.
 * - The predicate-placement mutants (movedInside) lower the case rebuilt with a predicate on the completed recursion
 *   moved inside it (gen/recursive.ts RecursionMutation): an endpoint filter into the seed and a final
 *   inequality into every state, both unsound, and an origin filter into the seed, a valid pushdown of a bound root.
 */
export type RecursionOracleFeature = RecursiveFeature | "nonempty"

const deliveredRows = (o: OracleOutcome): boolean =>
	Arr.some(o.left.run.statements, (st) => st.rows.length > 0)

/**
 * Every case of `generator` agrees between `left` and `right`, as raw text sets, and `left` repeats no row: every
 * statement delivers a set, and recursive UNION collapses repeated complete states. Each case notes its generator's
 * features, and "nonempty" when a statement delivered a row.
 */
export const recursiveEquivalence = <C extends RecursiveCase>(
	generator: Gen<C>,
	left: CaseLowering<C>,
	right: RunnerSide,
	options: CheckOptions<C, RecursionOracleFeature>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "recursion" })
		return yield* oracleCheck(drawn(generator), options, (c, notes) =>
			Effect.gen(function* () {
				notes.noteAll(c.features)
				const outcome = yield* runOracle(c, forCase(left, c), right, {
					...defaultRunOptions,
					schema: { kind: "named", name: schema }
				})
				if (!outcome.comparison.equal) {
					return yield* comparisonFailed(outcome)
				}
				if (deliveredRows(outcome)) {
					notes.note("nonempty")
				}
			})
		)
	})

/** The conservative lowering of another root of the case's DAG. */
const atRoot = (name: string, root: (c: QueryCase) => RelNode): Lowering => ({
	name,
	lower: ({ case: c, names }) =>
		lowerConservative(
			{ dag: c.query.dag, root: root(c) },
			{
				names,
				params: genParamDecls(c.query),
				subject: { kind: "query" }
			}
		)
})

/** The second root of a fixed-length case: the same answer through a bounded recursive relation. */
export const recursiveForm: Lowering = atRoot("recursive CTE", (c) => {
	const root = c.query.dag.roots[1]
	if (root === undefined) {
		throw new Error("a fixed-length case carries its recursive form as the second root")
	}
	return root
})

interface MutatedProgram {
	readonly program: ConservativeProgram
	readonly sites: number
}

const dropDistinct = (core: SelectCore): SelectCore =>
	core.distinct === false ? core : { ...core, distinct: false, rows: "operand" }

/** A UNION made UNION ALL, an operand: a recursive CTE's rows may repeat where its readers deduplicate them. */
const feedbackAll = (body: OperandBody): OperandBody =>
	body.kind === "setOp" && body.op === "UNION"
		? { kind: "setOp", op: "UNION ALL", rows: "operand", arms: body.arms }
		: body

/**
 * A recursion's lowering (recursive/index.ts) with its feedback UNION made UNION ALL and, for `bag`, every DISTINCT
 * inside its recursive CTE removed; undefined when the query is not a recursion's lowering.
 */
const mutateRecursion = (query: OperandSelect, bag: boolean, count: () => void): OperandSelect => {
	const w = query.with
	if (w?.recursive !== true) {
		return query
	}
	const ctes = Arr.map(w.ctes, (cte) => {
		if (cte.query.kind !== "select") {
			return cte
		}
		const inner = bag
			? rewriteOperand(
					cte.query,
					new Map(),
					{ ...identityVisitor, core: dropDistinct },
					topLevelContext
				)
			: cte.query
		const body = feedbackAll(inner.body)
		if (body === cte.query.body && inner === cte.query) {
			return cte
		}
		count()
		return { ...cte, query: { ...inner, body } }
	})
	return { ...query, with: { ...w, ctes } }
}

const recursionMutant = (
	program: ConservativeProgram,
	bag: boolean
): Result.Result<MutatedProgram, CompileError> => {
	let sites = 0
	const count = () => {
		sites++
	}
	const rewritten = rewriteProgram(program, (statement) =>
		setQueryOf(
			mutateRecursion(
				rewriteSelect(
					statement.ast,
					aliasOrigins(statement),
					{ ...identityVisitor, derived: (query) => mutateRecursion(query, bag, count) },
					topLevelContext
				),
				bag,
				count
			),
			"a recursion mutant, which rewrites only a recursive CTE"
		)
	)
	return Result.map(rewritten, (p) => ({ program: p, sites }))
}

/**
 * The recursive feedback UNION replaced by UNION ALL in the shape an optimizer emits: recursive UNION with plain seed
 * and step SELECTs (V6, a valid rewrite), then its UNION made UNION ALL (the invalid rewrite, applied
 * to every recursion of a case): unique edge tables, an acyclic graph or a depth bound do not make it sound. The plain step matters: the conservative step keeps its own DISTINCT, which happens to collapse the two
 * routes through a diamond when they arrive in the same iteration, so UNION ALL over the conservative step alone is
 * only caught when equal states arrive in different iterations (acyclic closures).
 */
export const feedbackUnionAllMutant: Lowering = {
	name: "mutant feedback UNION ALL",
	lower: (input) =>
		Result.flatMap(conservative.lower(input), (p) =>
			Result.flatMap(mutants.V6.mutate(p, input.case), (plain) =>
				Result.map(recursionMutant(plain.program, false), (m) => m.program)
			)
		)
}

/**
 * feedbackUnionAll plus every DISTINCT inside the recursive term dropped: the recursion evaluated as a bag, as if each
 * transition were already unique because each edge relation has a key.
 */
export const bagRecursion: Lowering = {
	name: "mutant bag recursion",
	lower: (input) =>
		Result.flatMap(conservative.lower(input), (p) =>
			Result.map(recursionMutant(p, true), (m) => m.program)
		)
}

/**
 * IR mutant: an aggregate whose bound tuple binds the edge id folds the edge's endpoints instead, so parallel edges,
 * distinct facts whose endpoints agree, merge into one contribution.
 */
const eraseEdge = (node: RelNode, inputs: NodeOver<ValueRefs<RelNode>>): RelNode => {
	if (inputs.kind !== "Group" || !inputs.bound.columns.includes("edge")) {
		return unchangedEdges(node, inputs) ? node : relNode(node.id, inputs)
	}
	const bound = [...Arr.filter(inputs.bound.columns, (c) => c !== "edge"), "node", "next"]
	return relNode(node.id, { ...inputs, bound: { ...inputs.bound, columns: [...new Set(bound)] } })
}

export const eraseEdgeIdentity: Lowering = {
	name: "mutant erase edge identity",
	lower: ({ case: c, names }) => {
		/** The mutant changes a Group's bound alone, each node above it rebuilt over it. */
		const dag = rebuildDag(c.query.dag, eraseEdge)
		return lowerConservative(
			{ dag, root: dag.roots[0] },
			{
				names,
				params: genParamDecls(c.query),
				subject: { kind: "query" }
			}
		)
	}
}

/**
 * A lowering of a generated recursive case: one lowering for every case, or one made for each case from the case
 * itself, as a recursion mutant that rebuilds the case from what it was generated from.
 */
export type CaseLowering<C> = Lowering | ((c: C) => Lowering)

/** The lowering of `c`. */
export const forCase = <C>(lowering: CaseLowering<C>, c: C): Lowering =>
	typeof lowering === "function" ? lowering(c) : lowering

/**
 * IR mutants: the case rebuilt by its generator with a result predicate moved inside the recursion. The
 * rebuilt query names the case's parameters with the same values, so it runs against the case's own bindings. The
 * lowering is made for the generated case it lowers, so it reads the case's source.
 */
export const movedInside =
	(mutation: RecursionMutation) =>
	(c: RecursiveCase): Lowering => ({
		name: `mutant ${mutation}`,
		lower: ({ names }) => {
			const source = c.source
			if (source.kind === "fixedLength") {
				throw new Error(`${mutation} rebuilds a generated recursive case`)
			}
			const m = resolveRecursiveCase(source.sketch, source.limits, mutation)
			return lowerConservative(conservativeInput(m.query), {
				names,
				params: genParamDecls(m.query),
				subject: { kind: "query" }
			})
		}
	})

/** Whether the right run tells a mutant apart from the left: a differing set. */
export const told = (o: OracleOutcome): boolean => !o.comparison.equal

/**
 * The feedback UNION ALL counterexample shape: the same distinct rows on both sides, the right repeating some states and the
 * left none (a repeated endpoint state, never a changed value), rows compared as values (compare.ts canonicalRows).
 */
export const repeatsStates = (o: OracleOutcome): boolean => {
	if (
		o.comparison.structural.length > 0 ||
		repeatsOn(o.comparison, "left") > 0 ||
		repeatsOn(o.comparison, "right") === 0
	) {
		return false
	}
	return Arr.every(o.left.run.statements, (st, i) => {
		const other = o.right.run.statements[i]
		if (other === undefined) {
			return false
		}
		const a = rowMultiset(canonicalRows(st))
		const b = rowMultiset(canonicalRows(other))
		return a.size === b.size && Arr.every([...a.keys()], (k) => b.has(k))
	})
}

/**
 * The erased edge identity counterexample shape: the same groups, every differing count smaller on the right (parallel edges
 * merged), and no repeated row on either side, rows compared as values (compare.ts canonicalRows).
 */
export const undercounts = (o: OracleOutcome, countColumn: string): boolean => {
	if (o.comparison.structural.length > 0 || o.comparison.repeated.length > 0) {
		return false
	}
	return Arr.every(o.left.run.statements, (st, i) => {
		const other = o.right.run.statements[i]
		if (other === undefined) {
			return false
		}
		const at = st.columns.indexOf(countColumn)
		if (at < 0) {
			return false
		}
		const keyOf = (row: RawRow) => rawRowKey(row.toSpliced(at, 1))
		const left = canonicalRows(st)
		const right = new Map(Arr.map(canonicalRows(other), (row) => [keyOf(row), Number(row[at])]))
		return (
			right.size === left.length &&
			Arr.every(left, (row) => {
				const r = right.get(keyOf(row))
				return r !== undefined && r <= Number(row[at])
			})
		)
	})
}
