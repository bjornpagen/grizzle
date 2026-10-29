import { type Diagnostic, diagnostic, safe } from "#compiler/core/diag.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { ElisionReason } from "#compiler/ir/certificate.ts"

const multiplicityReasons = [
	"retainedPrimaryKey",
	"oneToOneJoin",
	"combinedJoinKeys",
	"groupedOutputKey",
	"fixedKeyComponent",
	"existentialObservation",
	"projectedKeyLoss",
	"overlappingArms",
	"globalRecursiveClosure",
	"perParentAttachment",
	"inheritedDerivedKey",
	"unknownEvidence",
	"deduplicatedInput",
	"finiteFacts",
	"exactDeduplication",
	"atMostOneRow",
	"disjointArms",
	"injectiveRepresentation",
	"noninjectiveExpression",
	"uniqueOrdinal",
	"unreadBoundCanFail"
] as const
export type MultiplicityReason = (typeof multiplicityReasons)[number]

/**
 * The rank of each reason as an elision's leading evidence, most specific first. A reason that explains a present
 * duplicate elimination never leads an elision ("cause"): exactly the reasons an elision rule cannot name.
 */
const elisionRank: {
	readonly [R in MultiplicityReason]: R extends ElisionReason ? number : "cause"
} = {
	combinedJoinKeys: 0,
	oneToOneJoin: 1,
	disjointArms: 2,
	groupedOutputKey: 3,
	uniqueOrdinal: 4,
	inheritedDerivedKey: 5,
	retainedPrimaryKey: 6,
	deduplicatedInput: 7,
	finiteFacts: 8,
	globalRecursiveClosure: 9,
	exactDeduplication: 10,
	atMostOneRow: 11,
	fixedKeyComponent: 12,
	existentialObservation: 13,
	perParentAttachment: 14,
	injectiveRepresentation: 15,
	projectedKeyLoss: "cause",
	overlappingArms: "cause",
	unknownEvidence: "cause",
	noninjectiveExpression: "cause",
	unreadBoundCanFail: "cause"
}

/** Whether a reason may lead an elision: its rank says so. */
const leads = (reason: MultiplicityReason): reason is ElisionReason =>
	elisionRank[reason] !== "cause"

/**
 * The leading evidence a proof cites: the most specific of its reasons an elision rule can name, none when it cites
 * none (physical/rules.ts, which proves a plain form unique only by a key whose proof cites one).
 */
export const leadingReason = (
	reasons: ReadonlyArray<MultiplicityReason>
): ElisionReason | undefined =>
	reasons
		.filter(leads)
		.reduce<ElisionReason | undefined>(
			(best, reason) =>
				best !== undefined && elisionRank[best] <= elisionRank[reason] ? best : reason,
			undefined
		)

/**
 * Whether a reason explains an absent duplicate elimination (evidence) or a present one (a cause). The recursive
 * closure explains the one boundary the compiler always keeps; per-parent attachment evidence and
 * exact deduplication can explain either, and are classed by what they prove: uniqueness.
 *
 * The diagnostic reason vocabulary of physical multiplicity.
 *
 * "Diagnostics explain why deduplication is present or absent: retained primary key, one-to-one join, combined join
 * keys, grouped output key, fixed key component, existential observation, projected-key loss, overlapping arms, global
 * recursive closure, per-parent attachment evidence, inherited derived key, or unknown evidence. These are
 * explanations, not tuning controls." Those twelve come first, in that order. The inference rules rest on further
 * evidence, which an explanation must be able to cite as well: a relation parameter deduplicated on entry, canonical
 * finite facts, an exact duplicate-eliminating operator, a proved zero-or-one-row result, arms told apart by a retained
 * literal discriminant (the positive side of overlapping arms), a key represented through an injective coercion and a
 * key lost through a noninjective one, an ordinal unique per partition, and a bound column a fold reads nowhere else
 * that can fail, which its contributions' DISTINCT computes. They follow the twelve.
 *
 * A reason is either evidence for elision (the duplicate elimination is absent because of it) or a cause of a
 * retained boundary (it is present because of it). A reason never selects a strategy.
 */
export const reasonEffect: { readonly [R in MultiplicityReason]: "absent" | "present" } = {
	retainedPrimaryKey: "absent",
	oneToOneJoin: "absent",
	combinedJoinKeys: "absent",
	groupedOutputKey: "absent",
	fixedKeyComponent: "absent",
	existentialObservation: "absent",
	projectedKeyLoss: "present",
	overlappingArms: "present",
	globalRecursiveClosure: "present",
	perParentAttachment: "absent",
	inheritedDerivedKey: "absent",
	unknownEvidence: "present",
	deduplicatedInput: "absent",
	finiteFacts: "absent",
	exactDeduplication: "absent",
	atMostOneRow: "absent",
	disjointArms: "absent",
	injectiveRepresentation: "absent",
	noninjectiveExpression: "present",
	uniqueOrdinal: "absent",
	unreadBoundCanFail: "present"
}

/** The phrase each reason renders as, a constant (diagnostics carry no free text, core/diag.ts). */
const reasonPhrase: { readonly [R in MultiplicityReason]: string } = {
	retainedPrimaryKey: "the heading retains a declared key of the scanned relation",
	oneToOneJoin: "each joined row has at most one match, so a key of the other side survives",
	combinedJoinKeys: "the heading retains a key of every joined occurrence",
	groupedOutputKey: "the heading retains the complete grouping key",
	fixedKeyComponent: "a key component is fixed to one value per evaluation",
	existentialObservation:
		"only existence is observed, so repeated witnesses cannot change the result",
	projectedKeyLoss: "the projection drops every key, so distinct facts can produce equal rows",
	overlappingArms: "union arms are not told apart by a retained literal discriminant",
	globalRecursiveClosure: "recursive feedback keeps its global seen-state deduplication",
	perParentAttachment: "the attached child is judged per parent binding",
	inheritedDerivedKey: "the heading retains a key the derived relation inherits as a unique index",
	unknownEvidence: "no admissible evidence proves uniqueness in this execution context",
	deduplicatedInput: "the relation parameter is deduplicated on entry",
	finiteFacts: "the canonical finite facts are distinct",
	exactDeduplication: "an exact duplicate-eliminating operator establishes the heading",
	atMostOneRow: "at most one row is produced",
	disjointArms:
		"every union arm is unique and the arms are told apart by a retained literal discriminant",
	injectiveRepresentation: "a key column is represented through an injective coercion",
	noninjectiveExpression: "a key column is replaced by a noninjective expression",
	uniqueOrdinal: "the ordinal is unique per partition",
	unreadBoundCanFail:
		"a bound column the fold reads nowhere else can fail, and the DISTINCT computes it"
}

/** The stable code of a multiplicity explanation. */
const multiplicityDiagnosticCode = "Multiplicity"

/**
 * One explanation: why a node's duplicate elimination is present or absent. Every field is an identifier, a reason or
 * a column name, all safe; no parameter value ever enters it.
 */
export const explanation = (input: {
	readonly node: string
	readonly kind: string
	readonly status: "elided" | "required" | "ignored"
	readonly reasons: ReadonlyArray<MultiplicityReason>
	readonly heading: ReadonlyArray<string>
	/** The node's location, undefined for a node no description located (one a rewrite made). */
	readonly loc: SourceLoc | undefined
}): Diagnostic => {
	const fields: Record<string, ReturnType<typeof safe>> = {
		node: safe(input.node),
		kind: safe(input.kind),
		status: safe(input.status),
		heading: safe(input.heading.join(", ")),
		reasons: safe(input.reasons.join(", ")),
		because: safe(input.reasons.map((r) => reasonPhrase[r]).join("; "))
	}
	return diagnostic({
		code: multiplicityDiagnosticCode,
		severity: "info",
		message: "{kind} {node}: duplicate elimination on ({heading}) {status}: {because}",
		loc: input.loc,
		fields
	})
}
