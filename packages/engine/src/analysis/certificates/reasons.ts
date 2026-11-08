import type { ElisionReason } from "#compiler/ir/certificate.ts"

/** The rank of each reason as an elision's leading evidence, most specific first. */
const elisionRank: { readonly [R in ElisionReason]: number } = {
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
	injectiveRepresentation: 15
}

/**
 * The leading evidence a proof cites: the most specific of its reasons, none when it cites none (physical/rules.ts,
 * which proves a plain form unique only by a key whose proof cites one).
 */
export const leadingReason = (reasons: ReadonlyArray<ElisionReason>): ElisionReason | undefined =>
	reasons.reduce<ElisionReason | undefined>(
		(best, reason) =>
			best !== undefined && elisionRank[best] <= elisionRank[reason] ? best : reason,
		undefined
	)
