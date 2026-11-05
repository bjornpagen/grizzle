import type { Outstanding, PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import { consumerOutput } from "#compiler/analysis/physical/consumers.ts"
import {
	type Justification,
	joinJustifications,
	justify,
	withReason
} from "#compiler/analysis/physical/fds.ts"
import { nativeComparison } from "#compiler/analysis/physical/rules.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type Certificate,
	type ElisionReason,
	type ElisionRule,
	type MultiplicityRule,
	makeCertificate
} from "#compiler/ir/certificate.ts"
import type { KeySet, RelNode } from "#compiler/ir/rel.ts"

/**
 * The certificate builder for multiplicity rewrites.
 *
 * Each elision or placement certificate records the equality operators, type, coercion and collation identity, the
 * installed constraints, parameter assumptions, and the visibility and transaction evidence it uses. Every certificate
 * here is built from a physical analysis's proof of the rewrite and refused when the analysis does not prove it: a
 * certificate is never a claim the analysis cannot back. ir/certificate.ts canonicalizes it.
 *
 * The rules, and the valid transformation each performs:
 *
 * - R17.elide.<reason>: a plain SELECT where a physical key proves the heading, named by its leading evidence; a
 *   retained base key, or a key of every joined occurrence;
 * - R02.existence: an EXISTS target list without DISTINCT, the right side being an emptiness test no other consumer
 *   observes;
 * - R17.unionAll: UNION ALL for a union whose arms are unique and pairwise told apart by a literal discriminant;
 * - R17.recursiveTerms: plain seed and step SELECTs feeding a recursive UNION directly;
 * - R17.placement: duplicate elimination placed before the first consumer that observes repeats.
 */
export const multiplicityRules = {
	existence: "R02.existence",
	unionAll: "R17.unionAll",
	recursiveTerms: "R17.recursiveTerms",
	placement: "R17.placement"
} as const satisfies Readonly<Record<string, MultiplicityRule>>

const elisionRule = (reason: ElisionReason): ElisionRule => `R17.elide.${reason}`

const refuse = (
	node: RelNode,
	capability: string
): Result.Result<Certificate<MultiplicityRule>, CompileError> =>
	Result.err(unsupported(SourceLoc(`node ${node.id}`, []), capability))

const paramsOf = (just: Justification): ReadonlyArray<ParamId> =>
	just.premises.flatMap((p) => (p.kind === "param" ? [p.param] : []))

const certify = (input: {
	readonly rule: MultiplicityRule
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
	readonly just: Justification
	readonly heading: KeySet
}): Result.Result<Certificate<MultiplicityRule>, CompileError> => {
	const params = paramsOf(input.just)
	return makeCertificate({
		rule: input.rule,
		inputs: input.inputs,
		outputs: input.outputs,
		premises: input.just.premises,
		context: input.just.context,
		preservedHeading: input.heading,
		equality: input.just.equality,
		coercion: input.just.coercions,
		params: params.length === 0 ? undefined : params
	})
}

/**
 * A plain SELECT at a node whose plain form a physical key proves unique. Never at a recursive relation:
 * its UNION is the only thing that removes repeated states, and the compiler applies no UNION ALL elision to
 * recursive feedback.
 */
export const elisionCertificate = (
	analysis: PhysicalAnalysis,
	node: RelNode
): Result.Result<Certificate<MultiplicityRule>, CompileError> => {
	const props = analysis.of(node).props
	if (props.kind === "Recursive") {
		return refuse(node, "a nonrecursive node; recursive feedback keeps its recursive UNION")
	}
	const plain = props.uniqueness
	if (plain.kind !== "plain") {
		return refuse(node, "a physical key proving the plain form unique; none survives here")
	}
	return certify({
		rule: elisionRule(plain.lead),
		inputs: [node.id],
		outputs: [node.id],
		just: plain.key.just,
		heading: props.columns
	})
}

/**
 * SELECT 1 under EXISTS or NOT EXISTS, with no DISTINCT and no fabricated witness key. Refused when the
 * right side's repeats reach some other observing consumer: only the complete observation path proves the
 * simplification.
 */
export const existenceCertificate = (
	analysis: PhysicalAnalysis,
	node: RelNode
): Result.Result<Certificate<MultiplicityRule>, CompileError> => {
	if (node.kind !== "SemiJoin" && node.kind !== "AntiJoin") {
		return refuse(node, "a semi- or anti-join")
	}
	if (analysis.of(node.right).observed) {
		return refuse(node, "a right side whose repeats no consumer observes")
	}
	return certify({
		rule: multiplicityRules.existence,
		inputs: [node.right.id],
		outputs: [node.id],
		just: {
			premises: [{ kind: "node", node: node.id }],
			context: "queryLocal",
			reasons: ["existentialObservation"],
			equality: [],
			coercions: [],
			outer: []
		},
		heading: node.heading.map((c) => c.name)
	})
}

/**
 * UNION ALL for a union whose arms are each unique and pairwise disjoint on their final coerced headings by a retained
 * literal discriminant. Distinct source identities that were projected away never qualify.
 */
export const unionAllCertificate = (
	analysis: PhysicalAnalysis,
	node: RelNode
): Result.Result<Certificate<MultiplicityRule>, CompileError> => {
	if (node.kind !== "Union") {
		return refuse(node, "a union")
	}
	const props = analysis.of(node).props
	const plain = props.uniqueness
	if (plain.kind !== "plain") {
		return refuse(node, "unique arms told apart by a retained literal discriminant")
	}
	const arms = node.groups.flatMap((g) => g.arms.map((a) => a.id))
	return certify({
		rule: multiplicityRules.unionAll,
		inputs: arms,
		outputs: [node.id],
		just: plain.key.just,
		heading: props.columns
	})
}

/**
 * Plain seed and step SELECTs under the recursive UNION, which removes repeated states within and across iterations.
 * Refused when a term's repeats reach another observing consumer first, or the recursion is not
 * realized with UNION: no generic UNION ALL applies to recursive feedback.
 */
export const recursiveTermsCertificate = (
	analysis: PhysicalAnalysis,
	node: RelNode
): Result.Result<Certificate<MultiplicityRule>, CompileError> => {
	if (node.kind !== "Recursive") {
		return refuse(node, "a recursive relation")
	}
	if (analysis.of(node).realization !== "distinct") {
		return refuse(node, "a recursive UNION; recursive feedback keeps its global deduplication")
	}
	if (analysis.of(node.base).observed || analysis.of(node.step).observed) {
		return refuse(node, "seed and step rows that go directly into the recursive UNION")
	}
	return certify({
		rule: multiplicityRules.recursiveTerms,
		inputs: [node.base.id, node.step.id],
		outputs: [node.id],
		just: {
			premises: [{ kind: "node", node: node.id }],
			context: "queryLocal",
			reasons: ["globalRecursiveClosure"],
			equality: [],
			coercions: [],
			outer: []
		},
		heading: node.heading.map((c) => c.name)
	})
}

/**
 * Duplicate elimination placed on an outstanding obligation's input, before the consumer that observes it. A discharged
 * obligation needs no placement: a redundant DISTINCT is what elision removes.
 */
export const placementCertificate = (
	obligation: Outstanding
): Result.Result<Certificate<MultiplicityRule>, CompileError> =>
	placedDeduplication(
		obligation.edge.input,
		consumerOutput(obligation.edge.consumer, obligation.edge.input),
		obligation.heading
	)

/**
 * The certificate of a duplicate elimination on `input` that deduplicates `heading` before the consumer whose output
 * is `output` (consumers.ts consumerOutput). The placement builds it once it finds the obligation outstanding, and
 * the test kernel's verification rebuilds it for the placement a plan performs: it is a function of the DAG alone.
 */
export const placedDeduplication = (
	input: RelNode,
	output: RelNode,
	heading: KeySet
): Result.Result<Certificate<MultiplicityRule>, CompileError> =>
	certify({
		rule: multiplicityRules.placement,
		inputs: [input.id],
		outputs: [output.id],
		just: joinJustifications([
			withReason(justify({ premises: [{ kind: "node", node: input.id }] }), ["exactDeduplication"]),
			nativeComparison(input.heading, heading)
		]),
		heading
	})
