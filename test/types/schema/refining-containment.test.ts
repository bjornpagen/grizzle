import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
/**
 * A containment across refining types (test/types/schema/refining-containment.ts): a field of each of ten types
 * contained in a field of each, int8, natural, a contract over int8, a contract over natural, a clock
 * instant, a stored instant, int4, a closed id of a roster, one of another roster of the same handles, and a
 * contract over the first roster's closed id, admitted exactly where the two are of one base carrier, either side's
 * contracts refining it, and refused as the sides' field types differing elsewhere, int4 against int8 and a closed id
 * against another roster's among them. Each pair is a cell of the box; a batch's cells are one program, checked
 * disarmed. Oracle: the engine's pairing rule (scalar/compute/types.ts sameCarrier), stated apart from the types.
 */
import { refiningBox } from "#test/types/schema/refining-containment.dictionary.ts"
import { refiningProgram } from "#test/types/schema/refining-containment.ts"

/** A containment pairs two fields exactly where their base carriers are one, either side refining the other. */
export const refiningContainment = boxAgreement(finite(word(refiningBox)), {
	box: "every pair of ten types: int8, natural, a contract over each, a clock and a stored instant, int4, a closed id of each of two rosters of the same handles, and a contract over the first's",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: refiningProgram,
	oracle: {
		kind: "specification",
		name: "a containment pairs fields of one base carrier: one SQL type once contracts are stripped, a closed id's roster kept"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/statements.ts",
			original:
				"\t? readonly [BaseOf<DomainOf<C[K]>>, RosterKeysOf<DomainOf<C[K]>>, SqlOfCarrier<C[K]>]",
			replacement:
				"\t? readonly [DomainOf<C[K]>, RosterKeysOf<DomainOf<C[K]>>, SqlOfCarrier<C[K]>]",
			why: "A side's field pairs by its domain, contracts and all, as before: natural, a contract and an instant are refused against int8 and each other, where their base carrier is one; the program fails."
		},
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original: "? Extract<K, ",
			replacement: "? Exclude<K, ",
			why: "A base carrier keeps a domain's contract brands and drops its roster's: natural and a contract are refused against int8, and a closed id is admitted against another roster's, which the engine refuses; the program fails."
		}
	]
})
