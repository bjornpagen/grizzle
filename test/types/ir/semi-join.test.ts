/**
 * A semi-join's right side (test/types/ir/semi-join.ts): over every node kind of the IR's roster, built, and the
 * editor's cell, a node's constructor takes a semi-join over the right side semiJoinRight minted, refuses one over the
 * node as it is, and takes an anti-join over the node as it is. Each node kind is a cell of the box, and so is the
 * editor's cell; a batch's cells are one program, checked disarmed. Oracle: the representation's own contract (rel.ts
 * SemiJoinRight), that only the mint, which reads the right side's subtree for a column of the left, makes a semi-join's
 * right side; the analysis reads a column the right side fixes as fixed per evaluation of the semi-join
 * (logical/props.ts), which a right side reading its left would break.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { semiJoinBox } from "#test/types/ir/semi-join.dictionary.ts"
import { semiJoinProgram } from "#test/types/ir/semi-join.ts"

/**
 * Over every node kind and the editor's cell, a semi-join takes the minted right side and refuses the node as it is,
 * which an anti-join takes.
 */
export const semiJoin = boxAgreement(finite(word(semiJoinBox)), {
	box: "every node kind of the IR's roster (rel.ts relKinds), built, and the editor's cell",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: semiJoinProgram,
	oracle: {
		kind: "specification",
		name: "rel.ts SemiJoinRight: only semiJoinRight mints a semi-join's right side"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/ir/rel.ts",
			original:
				"export type SemiJoinRight<N> = N extends NodeId ? N : N & { readonly [semiJoinRightBrand]: true }",
			replacement: "export type SemiJoinRight<N> = N",
			why: "A semi-join's right side is a plain node (rel.ts SemiJoinRight is the node itself), so a node as it is, correlated on its left or not, stands there unread; the program fails, every refusal's directive unused."
		}
	]
})
