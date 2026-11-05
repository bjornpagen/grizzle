import { Array as Arr, Formatter, Order, String as Str } from "effect"
import { analyzePhysical, type PhysicalEnv } from "#compiler/analysis/physical/analyze.ts"
import type { FixedFacts } from "#compiler/analysis/physical/props.ts"
import { ExprId, type NodeId, ParamId } from "#compiler/core/ids.ts"
import { rebuildDag, relNode, topoOrder, unchangedEdges } from "#compiler/ir/dag.ts"
import { builtExpr, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { RelDag, Roots, ValidDag } from "#compiler/ir/rel.ts"
import { analyzeLogical, queryEvidence } from "#compiler/logical/annotate.ts"
import { conjuncts, type Fixed, type NamedValue } from "#compiler/logical/props.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { andOp } from "#test/support/oracle/gen/ops.ts"
import { provedKeys } from "#test/unit/analysis/physical/support.ts"

/**
 * The order of a filter's conjuncts is no part of what it means, so neither analysis may read it: a column two
 * conjuncts fix is fixed to both values, whichever is written first. reversedConjuncts writes a DAG's every filter in
 * the other order, and claimsOf states what both analyses claim of each node, by its label, as text, without the
 * justifications and derivations, which name the conjunct a claim was found by.
 */

/** A conjunction with its operands in the other order, at every depth, each under its own label. */
const reversedAnd = (e: ScalarExpr): ScalarExpr => {
	if (e.kind !== "op" || nativeOp(e.op)?.fn !== "and") {
		return e
	}
	const { pgType: _lowered, ...spec } = e
	return builtExpr({ ...spec, args: Arr.reverse(Arr.map(e.args, reversedAnd)) }, e.id)
}

/** The DAG with every filter's conjuncts in the other order, every node above one rebuilt under its own label. */
export const reversedConjuncts = <R extends Roots>(dag: ValidDag<R>): ValidDag<R> =>
	rebuildDag(dag, (node, inputs) => {
		if (inputs.kind === "Filter") {
			return relNode(node.id, { ...inputs, pred: reversedAnd(inputs.pred) })
		}
		return unchangedEdges(node, inputs) ? node : relNode(node.id, inputs)
	})

/** Whether an expression reads no column of `input`: a value fixed per evaluation of a filter over it. */
const fixedOver = (e: ScalarExpr, input: NodeId): boolean => !e.deps.nodes.includes(input)

/**
 * The twin of a filter's equality between a column of its input and a value fixed per evaluation: the column equated
 * with a parameter of its type of its own as well, labelled apart, so the filter fixes the column to two values.
 */
const twinOf = (c: ScalarExpr, input: NodeId): ReadonlyArray<ScalarExpr> => {
	if (c.kind !== "op" || nativeOp(c.op)?.fn !== "eq") {
		return []
	}
	const [a, b] = c.args
	const column =
		a?.kind === "column" && b !== undefined && fixedOver(b, input)
			? a
			: b?.kind === "column" && a !== undefined && fixedOver(a, input)
				? b
				: undefined
	if (column === undefined || column.column.node !== input) {
		return []
	}
	const twin = builtExpr(
		{
			kind: "param",
			param: ParamId(`${c.id} twin`),
			role: "compare",
			args: [],
			type: column.type,
			nonNull: "codec"
		},
		ExprId(`${c.id} twin value`)
	)
	const { pgType: _lowered, ...spec } = c
	return [builtExpr({ ...spec, args: [column, twin] }, ExprId(`${c.id} twin`))]
}

/**
 * The DAG with every filter's equality of a column to a value fixed per evaluation doubled by its twin (twinOf), the
 * filter's predicate the conjunction of its own and the twins, so each such column is fixed to two values.
 */
export const twiceFixed = <R extends Roots>(dag: ValidDag<R>): ValidDag<R> =>
	rebuildDag(dag, (node, inputs) => {
		const twins =
			inputs.kind === "Filter"
				? Arr.flatMap(conjuncts(inputs.pred), (c) => twinOf(c, inputs.input.id))
				: []
		if (inputs.kind !== "Filter" || twins.length === 0) {
			return unchangedEdges(node, inputs) ? node : relNode(node.id, inputs)
		}
		const pred = builtExpr(
			{
				kind: "op",
				op: andOp,
				args: [inputs.pred, ...twins],
				type: inputs.pred.type,
				nonNull: "strict",
				volatility: "immutable"
			},
			ExprId(`${inputs.pred.id} twins`)
		)
		return relNode(node.id, { ...inputs, pred })
	})

/** Whether some filter of the DAG has two conjuncts, the order reversedConjuncts turns. */
export const hasTwoConjuncts = (dag: RelDag): boolean =>
	Arr.some(topoOrder(dag), (n) => n.kind === "Filter" && conjuncts(n.pred).length > 1)

/** A value a column is fixed to, as text: a literal by its equality key, a parameter, an outer column, a computation. */
const valueText = (f: Fixed): string => {
	switch (f.kind) {
		case "literal":
			return `literal ${f.key}`
		case "param":
			return `param ${f.param}`
		case "outer":
			return `outer ${f.node}.${f.column}`
		case "expr":
			return "computed"
	}
}

const sortedText = (items: ReadonlyArray<string>): string =>
	Arr.join(Arr.sort(items, Str.Order), "; ")

const keysText = (keys: ReadonlyArray<ReadonlyArray<string>>): string =>
	sortedText(Arr.map(keys, (k) => Arr.join(Arr.sort(k, Str.Order), ",")))

const fixedText = <F>(
	fixed: ReadonlyMap<string, ReadonlyArray<F>>,
	value: (f: F) => string
): string =>
	sortedText(
		Arr.map([...fixed], ([column, values]) => `${column} = ${sortedText(Arr.map(values, value))}`)
	)

/** What the physical analysis claims of each node: its keys, its fixed columns' values, its bound and uniqueness. */
const physicalClaims = (dag: RelDag, env: PhysicalEnv): ReadonlyArray<string> => {
	const analysis = analyzePhysical(dag, env)
	return Arr.map(analysis.order, (node) => {
		const p = analysis.of(node).props
		const fixed: ReadonlyMap<string, FixedFacts> = p.fixed
		return `physical ${node.id} ${node.kind}: keys [${keysText(provedKeys(p))}], fixed [${fixedText(fixed, (f) => valueText(f.fixed))}], at most ${Formatter.format(
			p.maxCard
		)}, ${p.uniqueness.kind}, ${p.realization}`
	})
}

/** What the logical analysis claims of each node: its keys, its cardinality and its fixed columns' names. */
const logicalClaims = <R extends Roots>(dag: ValidDag<R>): ReadonlyArray<string> => {
	const analysis = analyzeLogical(dag, queryEvidence)
	if (!analysis.ok) {
		return [`logical refusal: ${analysis.error.message}`]
	}
	return Arr.map(topoOrder(dag), (node) => {
		const p = analysis.value.of(node).props
		return `logical ${node.id} ${node.kind}: keys [${keysText(
			Arr.map(p.keys, (k) => k.key)
		)}], ${p.card}, fixed [${fixedText(p.fixed, (v: NamedValue) => valueText(v.name))}]`
	})
}

/** Every claim both analyses make of the DAG's nodes, in label order. */
export const claimsOf = <R extends Roots>(
	dag: ValidDag<R>,
	env: PhysicalEnv
): ReadonlyArray<string> =>
	Arr.sort([...physicalClaims(dag, env), ...logicalClaims(dag)], Order.String)

/** Whether a node of the DAG holds a column the physical analysis fixes to two values. */
export const fixedTwice = (dag: RelDag, env: PhysicalEnv): boolean => {
	const analysis = analyzePhysical(dag, env)
	return Arr.some(analysis.order, (node) =>
		Arr.some([...analysis.of(node).props.fixed.values()], (facts) => facts.length > 1)
	)
}
