import { Array as Arr, Record as Rec } from "effect"
import {
	elisionCertificate,
	existenceCertificate,
	multiplicityRules,
	placedDeduplication,
	recursiveTermsCertificate,
	unionAllCertificate
} from "#compiler/analysis/certificates/builder.ts"

import {
	analyzePhysical,
	type PhysicalAnalysis,
	type RootObservation
} from "#compiler/analysis/physical/analyze.ts"

import {
	type Consumer,
	classifyEdges,
	consumerOutput
} from "#compiler/analysis/physical/consumers.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import { appendAll } from "#compiler/core/array.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { NodeId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { Certificate, ElisionRule, MultiplicityRule } from "#compiler/ir/certificate.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import { contextAdmits, type EvidenceCatalog, type TemplateContext } from "#compiler/ir/evidence.ts"
import { deliveredInput, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import {
	elisionKinds,
	isPinnedDistinct,
	placementTarget
} from "#compiler/lower/optimize/dedup/policy.ts"
import { problem, type VerificationProblem } from "#test/support/oracle/verify/problems.ts"

/**
 * Each multiplicity rule's class: an elision certificate leads with an elision reason; every other rule certifies
 * a proof. Total over MultiplicityRule, and its type fixes each entry, so a new rule is classified where it is added.
 */
const multiplicityRuleClass: {
	readonly [R in MultiplicityRule]: R extends ElisionRule ? "elision" : "proof"
} = {
	"R02.existence": "proof",
	"R17.unionAll": "proof",
	"R17.recursiveTerms": "proof",
	"R17.placement": "proof",
	"R17.elide.retainedPrimaryKey": "elision",
	"R17.elide.oneToOneJoin": "elision",
	"R17.elide.combinedJoinKeys": "elision",
	"R17.elide.groupedOutputKey": "elision",
	"R17.elide.fixedKeyComponent": "elision",
	"R17.elide.existentialObservation": "elision",
	"R17.elide.globalRecursiveClosure": "elision",
	"R17.elide.perParentAttachment": "elision",
	"R17.elide.inheritedDerivedKey": "elision",
	"R17.elide.deduplicatedInput": "elision",
	"R17.elide.finiteFacts": "elision",
	"R17.elide.exactDeduplication": "elision",
	"R17.elide.atMostOneRow": "elision",
	"R17.elide.disjointArms": "elision",
	"R17.elide.injectiveRepresentation": "elision",
	"R17.elide.uniqueOrdinal": "elision"
}

/** Whether a multiplicity rule is an elision, which names its leading evidence after the prefix. */
const isElisionRule = (rule: MultiplicityRule): rule is ElisionRule =>
	multiplicityRuleClass[rule] === "elision"

/** What verification reads of a plan: everything it claims, nothing it derived. */
export interface PlanUnderVerification {
	readonly context: TemplateContext
	readonly realization: Readonly<Record<NodeId, Realization>>
	readonly certificates: ReadonlyArray<Certificate<MultiplicityRule>>
}

interface VerificationEnv {
	/** The execution context the artifact is compiled for. */
	readonly context: TemplateContext
	/** The compilation's catalog, which the plan's proofs were made under. */
	readonly catalog: EvidenceCatalog
	/** How the program consumes its roots. */
	readonly roots: RootObservation
}

const nodeLabel = (node: RelNode): string => `${node.kind} ${node.id}`

const consumerLabel = (consumer: Consumer): string =>
	consumer.kind === "node" ? nodeLabel(consumer.node) : "the program's result"

/** The nodes of the DAG under verification by label: a plan's records and a certificate's names read through them. */
type Labelled = ReadonlyMap<NodeId, RelNode>

const coverage = (
	dag: RelDag,
	labelled: Labelled,
	plan: PlanUnderVerification
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	for (const node of topoOrder(dag)) {
		const r = plan.realization[node.id]
		if (r !== "plain" && r !== "distinct") {
			out.push(
				problem(
					"realizationCoverage",
					`node ${node.id}`,
					"a realization, plain or distinct, for every node"
				)
			)
		}
	}
	for (const id of Arr.map(Rec.keys(plan.realization), (k) => NodeId(k))) {
		if (!labelled.has(id)) {
			out.push(
				problem("realizationCoverage", `node ${id}`, "a realization only for nodes of the DAG")
			)
		}
	}
	return out
}

const setForms = (
	a: PhysicalAnalysis,
	plan: PlanUnderVerification
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	for (const node of a.order) {
		const id = node.id
		const r = plan.realization[id]
		if (isPinnedDistinct(node) && r !== "distinct") {
			out.push(
				problem(
					"pinnedSetForm",
					`${node.kind} ${id}`,
					node.kind === "Recursive"
						? "recursive feedback keeps its recursive UNION; no UNION ALL elision applies to it"
						: "INTERSECT and EXCEPT keep their set forms; no ALL form is admitted"
				)
			)
		}
		if (deliveredInput(node) !== undefined && r === "distinct") {
			out.push(
				problem(
					"unrealizableDistinct",
					`${node.kind} ${id}`,
					"a duplicate elimination on a node with a fragment of its own; an attachment, a law query and an ordered result deliver another node's rows, so the DISTINCT sits on that node"
				)
			)
		}
		if (node.kind === "Union" && r === "plain" && a.of(node).props.uniqueness.kind !== "plain") {
			out.push(
				problem(
					"unprovedUnionAll",
					`Union ${id}`,
					"UNION ALL only over unique arms pairwise disjoint on their final coerced headings"
				)
			)
		}
	}
	return out
}

const obligations = (a: PhysicalAnalysis): ReadonlyArray<VerificationProblem> =>
	Arr.flatMap(a.obligations, (o): ReadonlyArray<VerificationProblem> => {
		if (o.discharged) {
			return []
		}
		return [
			problem(
				"unprovedMultiplicity",
				`${consumerLabel(o.edge.consumer)} reading ${nodeLabel(o.edge.input)}`,
				`a proof or a placed duplicate elimination for the repeats it observes on (${Arr.join(o.heading, ", ")}), because ${o.edge.why}`
			)
		]
	})

/** The certificate the recomputed analysis proves for the rewrite a certificate names, or a reason it cannot. */
const rederive = (
	labelled: Labelled,
	a: PhysicalAnalysis,
	plan: PlanUnderVerification,
	cert: Certificate<MultiplicityRule>,
	rule: Exclude<MultiplicityRule, typeof multiplicityRules.placement>
): Result.Result<Certificate<MultiplicityRule>, CompileError> | string => {
	const [output] = cert.outputs
	if (output === undefined || cert.outputs.length !== 1) {
		return "exactly one output node"
	}
	const node = labelled.get(output)
	if (node === undefined) {
		return "an output node of the DAG"
	}
	const r = plan.realization[output]
	if (isElisionRule(rule)) {
		if (r !== "plain" || !elisionKinds.includes(node.kind)) {
			return "a plain realization of a node whose conservative form deduplicates"
		}
		return elisionCertificate(a, node)
	}
	switch (rule) {
		case multiplicityRules.unionAll:
			return r === "plain" ? unionAllCertificate(a, node) : "a union realized as UNION ALL"
		case multiplicityRules.existence:
			return existenceCertificate(a, node)
		case multiplicityRules.recursiveTerms:
			return r === "distinct" ? recursiveTermsCertificate(a, node) : "a recursive UNION"
	}
}

/**
 * The placement certificates a plan's placement on `input` before `output` may carry, rebuilt from the DAG
 * (placedDeduplication), or what the placement lacks. A node realized `distinct` deduplicates what an observing consumer of it needs, through the nodes
 * that only deliver its rows (placementTarget), or the program's result its root delivers, which the certificate names
 * as the placed node itself. The consumer is classified as realized plain: a placement placed later on the consumer
 * itself absorbs the repeats it once observed, but this placement still deduplicates what it needed then.
 */
const placements = (
	dag: RelDag,
	a: PhysicalAnalysis,
	plan: PlanUnderVerification,
	env: VerificationEnv,
	input: RelNode,
	output: RelNode
): ReadonlyArray<Result.Result<Certificate<MultiplicityRule>, CompileError>> | string => {
	if (plan.realization[input.id] !== "distinct") {
		return "a duplicate elimination the plan actually places"
	}
	const realized = (node: RelNode): Realization => a.of(node).realization
	return Arr.flatMap(
		classifyEdges(dag, a.order, {
			props: (node) => a.of(node).props,
			realization: (node) => (node === output ? "plain" : realized(node)),
			roots: env.roots
		}),
		(e) =>
			e.sensitivity === "observes" &&
			placementTarget(e.input) === input &&
			consumerOutput(e.consumer, input) === output
				? [placedDeduplication(input, output, e.requires)]
				: []
	)
}

/**
 * An EXISTS whose right side no other consumer observes carries no DISTINCT there.
 *
 * Seed and step feeding the recursive UNION directly carry no DISTINCT of their own.
 */
const certificates = (
	dag: RelDag,
	labelled: Labelled,
	a: PhysicalAnalysis,
	plan: PlanUnderVerification,
	env: VerificationEnv
): ReadonlyArray<VerificationProblem> => {
	const out: Array<VerificationProblem> = []
	/** A placement certificate against the placements the recomputed analysis proves for its one input and output. */
	const placementProblems = (
		cert: PlanUnderVerification["certificates"][number],
		where: string
	): ReadonlyArray<VerificationProblem> => {
		const [inputId] = cert.inputs
		const [outputId] = cert.outputs
		const input = inputId === undefined ? undefined : labelled.get(inputId)
		const output = outputId === undefined ? undefined : labelled.get(outputId)
		if (
			input === undefined ||
			output === undefined ||
			cert.inputs.length !== 1 ||
			cert.outputs.length !== 1
		) {
			return [problem("certificate", where, "exactly one input and one output, nodes of the DAG")]
		}
		const rebuilt = placements(dag, a, plan, env, input, output)
		if (typeof rebuilt === "string") {
			return [problem("certificate", where, rebuilt)]
		}
		return Arr.some(rebuilt, (r) => r.ok && canonicalEquals(r.value, cert, everyProperty))
			? []
			: [problem("certificate", where, "the certificate the recomputed analysis proves")]
	}
	for (const [i, cert] of plan.certificates.entries()) {
		const where = `certificate ${i} (${cert.rule})`
		if (!contextAdmits(env.context, cert.context)) {
			out.push(
				problem(
					"certificate",
					where,
					`evidence of context ${cert.context}, which ${env.context} does not admit`
				)
			)
		}
		const rule = cert.rule
		if (rule === multiplicityRules.placement) {
			appendAll(out, placementProblems(cert, where))
			continue
		}
		const derived = rederive(labelled, a, plan, cert, rule)
		if (typeof derived === "string") {
			out.push(problem("certificate", where, derived))
		} else if (!derived.ok) {
			out.push(problem("certificate", where, derived.error.message))
		} else if (!canonicalEquals(derived.value, cert, everyProperty)) {
			out.push(problem("certificate", where, "the certificate the recomputed analysis proves"))
		}
	}
	const has = (
		rule: MultiplicityRule,
		pick: (c: Certificate<MultiplicityRule>) => ReadonlyArray<NodeId>,
		id: NodeId
	) => Arr.some(plan.certificates, (c) => c.rule === rule && pick(c).includes(id))
	const hasElision = (id: NodeId) =>
		Arr.some(plan.certificates, (c) => isElisionRule(c.rule) && c.outputs.includes(id))
	for (const node of a.order) {
		const id = node.id
		const r = plan.realization[id]
		const props = a.of(node).props
		if (
			r === "distinct" &&
			!isPinnedDistinct(node) &&
			node.kind !== "Union" &&
			!has(multiplicityRules.placement, (c) => c.inputs, id)
		) {
			out.push(problem("missingCertificate", `${node.kind} ${id}`, "an R17.placement certificate"))
		}
		const several = node.kind === "Union" && Arr.flatMap(node.groups, (g) => g.arms).length > 1
		if (
			r === "plain" &&
			elisionKinds.includes(node.kind) &&
			props.uniqueness.kind === "plain" &&
			(several ? !has(multiplicityRules.unionAll, (c) => c.outputs, id) : !hasElision(id))
		) {
			out.push(
				problem(
					"missingCertificate",
					`${node.kind} ${id}`,
					several ? "an R17.unionAll certificate" : "an R17.elide certificate"
				)
			)
		}
		if (
			(node.kind === "SemiJoin" || node.kind === "AntiJoin") &&
			!a.of(node.right).observed &&
			!has(multiplicityRules.existence, (c) => c.outputs, id)
		) {
			out.push(problem("missingCertificate", `${node.kind} ${id}`, "an R02.existence certificate"))
		}
		if (
			node.kind === "Recursive" &&
			!a.of(node.base).observed &&
			!a.of(node.step).observed &&
			!has(multiplicityRules.recursiveTerms, (c) => c.outputs, id)
		) {
			out.push(
				problem("missingCertificate", `Recursive ${id}`, "an R17.recursiveTerms certificate")
			)
		}
	}
	return out
}

interface MultiplicityVerification {
	readonly analysis: PhysicalAnalysis
	readonly problems: ReadonlyArray<VerificationProblem>
}

/**
 * Structural obligation verification, a property of the test kernel (verify/index.ts checkedLowering).
 *
 * "Verify that every required set boundary is discharged and that no sensitive consumer sees unproved multiplicity. Do
 * not merely scan SQL for DISTINCT keywords." Verification recomputes the physical analysis of the plan's realization
 * from the DAG, the execution context and the evidence catalog, and trusts nothing the plan says about itself:
 *
 * - the plan is for this execution context, and names a realization for every node;
 * - recursive closure keeps its recursive UNION and INTERSECT and EXCEPT their set forms;
 * - no node that only delivers another node's rows (an attachment, a law query, an ordered result) is realized
 *   `distinct`: it has no fragment of its own, so no emission could carry that DISTINCT (rel.ts deliveredInput);
 * - a union realized as UNION ALL has a plain form a physical key proves unique: unique arms pairwise disjoint on their
 *   final coerced headings;
 * - every observing edge is discharged by the input's physical keys: COUNT, SUM, a bound, a page, a window, an
 *   attachment or the public result never sees an input whose repeats nothing proves away (a fold reads its input on
 *   the input's whole heading, of which its bound tuple is a key);
 * - every certificate is the one the recomputed analysis proves for the rewrite it names, equal in every field, in an
 *   evidence context the execution context admits, and every rewrite the realization performs has its certificate.
 *   A placement's is rebuilt for the placement the plan performs, from the DAG and what its consumer needs.
 */
export const verifyMultiplicity = (
	dag: RelDag,
	plan: PlanUnderVerification,
	env: VerificationEnv
): Result.Result<MultiplicityVerification, CompileError> => {
	const context =
		plan.context === env.context
			? []
			: [
					problem(
						"context",
						"the plan",
						`a plan compiled for the ${env.context} context, not ${plan.context}; a weaker context runs the conservative artifact`
					)
				]
	const labelled = nodesByLabel(dag)
	const covered = coverage(dag, labelled, plan)
	const a = analyzePhysical(dag, {
		context: env.context,
		realization: (id) => plan.realization[id],
		catalog: env.catalog,
		roots: env.roots
	})
	return Result.ok({
		analysis: a,
		problems: [
			...context,
			...covered,
			...setForms(a, plan),
			...obligations(a),
			...certificates(dag, labelled, a, plan, env)
		]
	})
}
