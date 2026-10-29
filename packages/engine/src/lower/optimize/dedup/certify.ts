import {
	contributionCertificate,
	elisionCertificate,
	existenceCertificate,
	recursiveTermsCertificate,
	unionAllCertificate
} from "#compiler/analysis/certificates/builder.ts"
import type { PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { Certificate, MultiplicityRule } from "#compiler/ir/certificate.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import type { FoldInput } from "#compiler/lower/optimize/dedup/plan.ts"
import { elisionKinds } from "#compiler/lower/optimize/dedup/policy.ts"

/**
 * The certificate a node's kind performs beside an elision, if any: a plain fold's contribution, an unobserved
 * existence test's, a recursion's unobserved terms'.
 */
const kindCertificates = (
	a: PhysicalAnalysis,
	node: RelNode,
	form: FoldForm
): ReadonlyArray<Result.Result<Certificate<MultiplicityRule>, CompileError>> => {
	switch (node.kind) {
		case "Group":
			return node.aggs.length > 0 &&
				form(node) === "plain" &&
				a.of(node).contribution?.identity.kind === "removable"
				? [contributionCertificate(a, node)]
				: []
		case "SemiJoin":
		case "AntiJoin":
			return !a.of(node.right).observed ? [existenceCertificate(a, node)] : []
		case "Recursive":
			return !a.of(node.base).observed && !a.of(node.step).observed
				? [recursiveTermsCertificate(a, node)]
				: []
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Produce":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return []
	}
}

/** The certificate a node's own realization, the one the analysis was made under, performs, if any. */
const nodeCertificates = (
	a: PhysicalAnalysis,
	node: RelNode,
	form: FoldForm
): ReadonlyArray<Result.Result<Certificate<MultiplicityRule>, CompileError>> => {
	const { props, realization } = a.of(node)
	const elided =
		realization === "plain" && elisionKinds.includes(node.kind) && props.uniqueness.kind === "plain"
			? [
					node.kind === "Union" && node.groups.flatMap((g) => g.arms).length > 1
						? unionAllCertificate(a, node)
						: elisionCertificate(a, node)
				]
			: []
	return [...elided, ...kindCertificates(a, node, form)]
}

/** How each fold with aggregates takes its input, decided once by the placement (place.ts foldOf). */
export type FoldForm = (group: NodeOf<"Group">) => FoldInput

/**
 * The certificates of a placement's multiplicity rewrites.
 *
 * Every rewrite the plan performs relative to the conservative lowering, which deduplicates at every set boundary and
 * uses no certificate, carries one, built by analysis/certificates from the final analysis's own proof
 * and refused when that analysis does not prove it:
 *
 * - R17.elide.<leading reason>: a plain SELECT where the conservative form has a DISTINCT, because a physical key
 *   proves the plain form unique (a retained primary key, or combined join keys);
 * - R17.unionAll: UNION ALL for a union of several arms, each unique and pairwise disjoint on the final coerced
 *   headings;
 * - R17.contribution: a fold without its contribution DISTINCT, because B determines a physical key of the input proved
 *   without the input's own DISTINCT;
 * - R02.existence: an EXISTS whose right side carries no DISTINCT, because no other consumer observes its repeats;
 * - R17.recursiveTerms: plain seed and step SELECTs feeding the recursive UNION directly;
 * - R17.placement: a duplicate elimination placed before the consumer that observes repeats, made during the worklist
 *   from the analysis in which the obligation was outstanding.
 *
 * The list is canonical: one copy of each certificate, ordered by the topological position of its first output, then
 * by rule, then by its canonical text, so identical input yields byte-identical certificates.
 */
export const certifyPlan = (
	a: PhysicalAnalysis,
	form: FoldForm,
	placements: ReadonlyArray<Certificate<MultiplicityRule>>
): Result.Result<ReadonlyArray<Certificate<MultiplicityRule>>, CompileError> => {
	const all: Array<Certificate<MultiplicityRule>> = [...placements]
	for (const r of a.order.flatMap((node) => nodeCertificates(a, node, form))) {
		if (!r.ok) {
			return Result.err(r.error)
		}
		all.push(r.value)
	}
	return canonicalCertificates(
		a.order.map((node) => node.id),
		all
	)
}

/**
 * The position of a certificate's first output in node order. A certificate none of whose outputs the order reaches
 * sorts after every one that does.
 */
const firstOutputAt = (order: ReadonlyArray<NodeId>, outputs: ReadonlyArray<NodeId>): number => {
	for (const [i, id] of order.entries()) {
		if (outputs.includes(id)) {
			return i
		}
	}
	return order.length
}

/** One copy of each certificate, in topological order of first output, then rule, then canonical text. */
const canonicalCertificates = (
	order: ReadonlyArray<NodeId>,
	certificates: ReadonlyArray<Certificate<MultiplicityRule>>
): Result.Result<ReadonlyArray<Certificate<MultiplicityRule>>, CompileError> => {
	const keyed: Array<{
		readonly cert: Certificate<MultiplicityRule>
		readonly text: string
		readonly at: number
	}> = []
	const seen = new Set<string>()
	for (const cert of certificates) {
		const text = encode(cert, everyProperty)
		if (!text.ok) {
			return Result.err(text.error)
		}
		if (seen.has(text.value)) {
			continue
		}
		seen.add(text.value)
		keyed.push({ cert, text: text.value, at: firstOutputAt(order, cert.outputs) })
	}
	keyed.sort((x, y) =>
		x.at !== y.at
			? x.at - y.at
			: x.cert.rule !== y.cert.rule
				? x.cert.rule < y.cert.rule
					? -1
					: 1
				: x.text < y.text
					? -1
					: x.text > y.text
						? 1
						: 0
	)
	return Result.ok(Object.freeze(keyed.map((k) => k.cert)))
}
