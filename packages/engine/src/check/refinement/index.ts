import type { RefinementPlugin } from "#compiler/check/context.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure, type TypedLiteral } from "#compiler/ir/expr.ts"
import { exprsOf, type RelDag } from "#compiler/ir/rel.ts"
import {
	baseOf,
	contractOf,
	numericTypmodOf,
	type ScalarType,
	sameScalarType
} from "#compiler/ir/scalar.ts"

import {
	commonType,
	compatible,
	plainType,
	sameRegex,
	wildcardText,
	withoutSerial
} from "#compiler/scalar/compute/types.ts"

/**
 * Whether every value of type `a` is proved to be a value of type `b`: one carrier and nominal identity, the contract
 * chain included (compatible: within one checked schema a contract name names one domain), one numeric typmod,
 * and, for text, `b`'s pattern the canonical wildcard or proved equal to `a`'s. The serial generation flag is not a
 * value domain and does not enter. Containment between two different languages is never claimed.
 */
export const guarantees = (a: ScalarType, b: ScalarType): boolean => {
	if (!compatible(a, b)) {
		return false
	}
	const ba = baseOf(a)
	const bb = baseOf(b)
	if (ba.carrier === "numeric") {
		const tb = numericTypmodOf(bb)
		if (
			tb !== undefined &&
			(ba.typmod?.precision !== tb.precision || ba.typmod.scale !== tb.scale)
		) {
			return false
		}
	}
	if (ba.carrier === "text" && bb.carrier === "text") {
		return bb.text.regex === "wildcard" || sameRegex(ba.text.regex, bb.text.regex)
	}
	return true
}

/** Whether two types make the same guarantees in both directions. */
const sameGuarantees = (a: ScalarType, b: ScalarType): boolean =>
	guarantees(a, b) && guarantees(b, a)

/**
 * The common type of two compatible arm types.
 *
 * One contract identity, which compatible arms share: the contract's domain guarantees both arms' values.
 */
const combine = (a: ScalarType, b: ScalarType): ScalarType => {
	const x = withoutSerial(a)
	const y = withoutSerial(b)
	if (sameScalarType(x, y)) {
		return x
	}
	if (contractOf(x) !== undefined) {
		return x
	}
	if (x.carrier === "text" && y.carrier === "text") {
		return sameRegex(x.text.regex, y.text.regex) ? x : wildcardText
	}
	if (x.carrier === "numeric") {
		return sameGuarantees(x, y) ? x : plainType("numeric")
	}
	return commonType(x, y)
}

/**
 * Refinement propagation and the refinement validation sites.
 *
 * Every text value in the checked IR carries a specific pattern or the canonical wildcard, and every contract value its
 * contract. This module owns what the checker cannot decide locally about those guarantees:
 *
 * - Propagation. An unchanged projection, match, import, DISTINCT, and text min and max keep their input's
 *   guarantees, because the checker gives them the input column's own type. A computed value carries the Compute
 *   catalogue's result type, a plain native type or the canonical wildcard (scalar/compute). A column that several arms
 *   of one union deliver keeps only the guarantees common to every arm (`refinement.common` below): the arms' type when
 *   they agree, the arms' pattern when the arms' patterns are proved to recognize one language (the canonical
 *   pattern key of text/refinement.ts, the proof domain sharing uses), and otherwise the canonical
 *   wildcard or unconstrained numeric, PostgreSQL's own common-type rule. No other regex containment, disjointness, or
 *   inferred-type assignability is claimed.
 * - Validation sites. A value written into a refined column is validated by the column's domain in the apply
 *   transaction; its refusal names the domain's constraint; the adapter classifies it by the domain PostgreSQL reports
 *   as the violation's data type. A refined output is cast to its domain in the delivered output list
 *   (lower/shapes/refined). A comparison parameter is bound as the base and is never validated. Closed payloads with
 *   nontrivial refinements are validated by PostgreSQL at installation: `refinedConstants` lists them, and
 *   lower/shapes/refined builds the statement that casts each to its domain and the installer extension that runs it
 *   in the Publish phase. No path validates a query's own refined literals (`queryConstants` lists them), so the
 *   delivery relies on no base-typed constant's membership and casts it where it is delivered.
 *
 * The host never validates application data: the canonical pattern keys come from the text package's bounded automaton
 * construction over declarations, never from a matcher run over values.
 */
export const refinement: RefinementPlugin = {
	common: (types) => {
		const [first, ...rest] = types
		return rest.reduce((a, b) => combine(a, b), withoutSerial(first))
	}
}

/**
 * Whether a value of `t` needs PostgreSQL's validation where it enters a refined position: a contract whose domain, or
 * whose base's domain, carries a CHECK, or text with a specific pattern. A brand-only contract over an unrefined base
 * has no constraint to evaluate.
 */
export const hasConstraint = (t: ScalarType): boolean => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		return contract.predicate !== undefined || hasConstraint(contract.base)
	}
	return t.carrier === "text" && t.text.regex !== "wildcard"
}

/**
 * A refined constant the compiler relies on: a closed relation's payload value, or a literal in a query, of a type
 * whose domain carries a CHECK. PostgreSQL validates it at installation or admission.
 */
export interface RefinedConstant {
	readonly literal: TypedLiteral
	readonly type: ScalarType
	/** Where the constant is declared, for diagnostics: `closed Tier.label of Pro`, `query literal e#3`. */
	readonly site: string
}

/** The closed payload values whose fields carry a nontrivial refinement, in relation, roster and heading order. */
export const refinedConstants = (schema: SchemaReading): ReadonlyArray<RefinedConstant> =>
	[...schema.closed.values()].flatMap((info) =>
		info.rows.flatMap((row) =>
			info.heading.flatMap((column, i): ReadonlyArray<RefinedConstant> => {
				const literal = row[i]
				return i === 0 || literal === undefined || !hasConstraint(column.type)
					? []
					: [
							{
								literal,
								type: column.type,
								site: `closed ${info.name}.${column.name} of ${row[0].handle}`
							}
						]
			})
		)
	)

/**
 * The literals of a checked query DAG whose type carries a nontrivial refinement: a literal bound opposite a refined
 * field, or a `Compute.literal` of a refined type, in the DAG's order: its nodes inputs first (ir/dag.ts topoOrder),
 * each node's expressions and then their arguments (ir/expr.ts exprClosure).
 */
export const queryConstants = (dag: RelDag): ReadonlyArray<RefinedConstant> => {
	const out: Array<RefinedConstant> = []
	for (const expr of exprClosure(topoOrder(dag).flatMap((node) => exprsOf(node)))) {
		if (expr.kind === "literal" && hasConstraint(expr.type)) {
			out.push({ literal: expr.value, type: expr.type, site: `query literal ${expr.id}` })
		}
	}
	return out
}
