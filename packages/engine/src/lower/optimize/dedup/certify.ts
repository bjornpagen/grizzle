import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	elisionCertificate,
	existenceCertificate,
	recursiveTermsCertificate,
	unionAllCertificate
} from "#compiler/analysis/certificates/builder.ts"
import type { PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Certificate, MultiplicityRule } from "#compiler/ir/certificate.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { elisionKinds } from "#compiler/lower/optimize/dedup/policy.ts"

/**
 * The certificate a node's kind performs beside an elision, if any: an unobserved existence test's, a recursion's
 * unobserved terms'.
 */
const kindCertificates = (
	a: PhysicalAnalysis,
	node: RelNode
): ReadonlyArray<Result.Result<Certificate<MultiplicityRule>, CompileError>> => {
	switch (node.kind) {
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
		case "Group":
		case "Produce":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
		case "Step":
		case "Call":
			return []
	}
}

/** The certificate a node's own realization, the one the analysis was made under, performs, if any. */
const nodeCertificates = (
	a: PhysicalAnalysis,
	node: RelNode
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
	return [...elided, ...kindCertificates(a, node)]
}

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
	placements: ReadonlyArray<Certificate<MultiplicityRule>>
): Result.Result<ReadonlyArray<Certificate<MultiplicityRule>>, CompileError> => {
	const all: Array<Certificate<MultiplicityRule>> = [...placements]
	for (const r of a.order.flatMap((node) => nodeCertificates(a, node))) {
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
 * Each label's first position in the node order, by one pass over it: the inverse of the order, read for every
 * certificate's first output (firstOutputAt), so the order is read once for a plan, where each certificate scanned it.
 */
const firstPositions = (order: ReadonlyArray<NodeId>): ReadonlyMap<NodeId, number> => {
	const positions = new Map<NodeId, number>()
	for (const [i, id] of order.entries()) {
		if (!positions.has(id)) {
			positions.set(id, i)
		}
	}
	return positions
}

/**
 * The position of a certificate's first output in node order, the least first position of its outputs (`positions`,
 * firstPositions): the first position whose label is one of them. A certificate none of whose outputs the order
 * reaches sorts after every one that does, at the order's length, `end`.
 */
const firstOutputAt = (
	positions: ReadonlyMap<NodeId, number>,
	end: number,
	outputs: ReadonlyArray<NodeId>
): number => outputs.reduce((first, id) => Math.min(first, positions.get(id) ?? end), end)

/**
 * One copy of each certificate, in topological order of first output, then rule, then canonical text. The order is
 * read once, into each label's first position (firstPositions), and each certificate's position is read from its
 * outputs': linear in the order and the certificates' outputs, where a scan of the order for each certificate was
 * their product.
 */
export const canonicalCertificates = (
	order: ReadonlyArray<NodeId>,
	certificates: ReadonlyArray<Certificate<MultiplicityRule>>
): Result.Result<ReadonlyArray<Certificate<MultiplicityRule>>, CompileError> => {
	const positions = firstPositions(order)
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
		keyed.push({ cert, text: text.value, at: firstOutputAt(positions, order.length, cert.outputs) })
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
