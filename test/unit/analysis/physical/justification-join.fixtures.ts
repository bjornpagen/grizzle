/** What the properties of justification-join.test.ts read: its space and its reference join. */

import { array, element, type Gen, oneOf, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { justify, structural, type Justification } from "#compiler/analysis/physical/fds.ts"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import type { CoercionIdentity, ElisionReason } from "#compiler/ir/certificate.ts"
import { evidenceContexts, type Premise, premiseText, strongest } from "#compiler/ir/evidence.ts"
import { OpId, sortedOps } from "#compiler/ir/expr.ts"

const premisePool: readonly [Premise, ...ReadonlyArray<Premise>] = [
	{ kind: "node", node: NodeId("n1") },
	{ kind: "node", node: NodeId("n2") },
	{ kind: "node", node: NodeId("n10") },
	{ kind: "param", param: ParamId("p") },
	{ kind: "param", param: ParamId("o") }
]

const reasonPool: readonly [ElisionReason, ...ReadonlyArray<ElisionReason>] = [
	"retainedPrimaryKey",
	"oneToOneJoin",
	"fixedKeyComponent",
	"atMostOneRow"
]

const opPool = [OpId("=(int4,int4)"), OpId("=(text,text)"), OpId("=(uuid,uuid)")] as const

const coercionPool: readonly [CoercionIdentity, ...ReadonlyArray<CoercionIdentity>] = [
	"type:int4",
	"type:text",
	"collation:pg_catalog.C"
]

const outerPool = [
	{ node: NodeId("n1"), column: "a" },
	{ node: NodeId("n1"), column: "b" },
	{ node: NodeId("n2"), column: "a" }
] as const

/** A justification resting on something: what `justify` makes of drawn grounds, repeats and any order among them. */
const heldGen: Gen<Justification> = (s) =>
	justify({
		premises: s.draw(array(element(premisePool), { min: 0, max: 3 })),
		context: s.draw(element(evidenceContexts)),
		reasons: s.draw(array(element(reasonPool), { min: 0, max: 3 })),
		equality: s.draw(subarray(opPool)),
		coercions: s.draw(array(element(coercionPool), { min: 0, max: 2 })),
		outer: s.draw(subarray(outerPool))
	})

/** A justification resting on nothing, as the analysis makes one: `structural`, or `justify` of no grounds. */
const nothingGen: Gen<Justification> = (s) =>
	s.draw(element([structural, justify({}), justify({ premises: [], reasons: [] })]))

/** A justification of no grounds but its context, which rests on something exactly when that context is demanding. */
const contextGen: Gen<Justification> = (s) =>
	justify({ context: s.draw(element(evidenceContexts)) })

/** The justifications a join meets: up to five, each resting on something, on a context alone, or on nothing. */
export const joinedGen: Gen<ReadonlyArray<Justification>> = (s) =>
	s.draw(array(oneOf([heldGen, contextGen, nothingGen]), { min: 0, max: 5 }))

/** Whether a justification has no grounds but a demanding context. */
export const contextAlone = (j: Justification): boolean =>
	j.context !== "queryLocal" &&
	j.premises.length === 0 &&
	j.reasons.length === 0 &&
	j.equality.length === 0 &&
	j.coercions.length === 0 &&
	j.outer.length === 0

/** Whether a justification rests on nothing: no grounds of any kind, in the least demanding context. */
export const restsOnNothing = (j: Justification): boolean =>
	j.context === "queryLocal" &&
	j.premises.length === 0 &&
	j.reasons.length === 0 &&
	j.equality.length === 0 &&
	j.coercions.length === 0 &&
	j.outer.length === 0

/**
 * The union of justifications by its definition, built whole from every member, as the join was before it built only
 * the unions of two or more members resting on something (fds.ts at 94aa830e1): every premise by its text, the most
 * demanding context, every reason once in first-given order, every operator, coercion and outer column once in order.
 */
export const referenceJoin = (justs: ReadonlyArray<Justification>) => {
	const byText = <A>(entries: Iterable<readonly [string, A]>): ReadonlyArray<A> =>
		Arr.map(
			Arr.sort(
				[...new Map(entries)],
				Order.mapInput(Order.String, ([text]: readonly [string, A]) => text)
			),
			([, item]) => item
		)
	return {
		premises: byText(
			Arr.flatMap(justs, (j) => Arr.map(j.premises, (p) => [premiseText(p), p] as const))
		),
		context: strongest(Arr.map(justs, (j) => j.context)),
		reasons: Arr.dedupe(Arr.flatMap(justs, (j) => j.reasons)),
		equality: sortedOps(Arr.flatMap(justs, (j) => j.equality)),
		coercions: Arr.sort(Arr.dedupe(Arr.flatMap(justs, (j) => j.coercions)), Order.String),
		outer: byText(
			Arr.flatMap(justs, (j) => Arr.map(j.outer, (o) => [`${o.node}\u0000${o.column}`, o] as const))
		)
	}
}

/** A justification's grounds as plain data, for comparing with the reference. */
export const groundsOf = (j: Justification) => ({
	premises: j.premises,
	context: j.context,
	reasons: j.reasons,
	equality: j.equality,
	coercions: j.coercions,
	outer: j.outer
})
