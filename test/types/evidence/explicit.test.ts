/**
 * An evidence a caller writes is held to Evidence whole (test/types/evidence/explicit.ts): each public type that takes
 * one, a query, an ordered query and a finished arm, admits an Evidence and refuses, where it is written, an evidence
 * whose card is no Card, whose origins hold a value that is no Origin, or whose values are no record. The sites that infer
 * an evidence require its keys and card alone (InferredEvidence), which every evidence grizzle builds has; the types a
 * caller writes keep the whole bound. Each type is a cell of the box; a batch's cells are one program, checked disarmed.
 * Oracle: the TypeScript compiler's own constraint check of each written type.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { explicitEvidenceBox } from "#test/types/evidence/explicit.dictionary.ts"
import { explicitEvidenceProgram } from "#test/types/evidence/explicit.ts"

/** Each public type that takes an evidence refuses, where it is written, an evidence that is no Evidence. */
export const explicitEvidence = boxAgreement(finite(word(explicitEvidenceBox)), {
	box: "each public type that takes an evidence, a query, an ordered query and a finished arm, written with an Evidence and with three evidences that are none",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: explicitEvidenceProgram,
	oracle: {
		kind: "second-implementation",
		name: "the TypeScript compiler's constraint check of each written type"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "export interface Query<\n\tS,\n\tHead,\n\tEv extends Evidence = Evidence.Unknown,",
			replacement:
				"export interface Query<\n\tS,\n\tHead,\n\tEv extends InferredEvidence = Evidence.Unknown,",
			why: "A query's evidence is bound by what an inference site requires of one (InferredEvidence), its keys and card alone, so a Query a caller writes with an origin that is no Origin, or values that are no record, is admitted; the program fails."
		}
	]
})
