/**
 * The member-handle program (test/types/api/handle.ts): a function over MemberHandle<typeof p> takes exactly the handle
 * of its own program, over a role of the program's level and over a role of an extension of it, for every kind of
 * served program, each read kind's explain fails with its read's error, and each kind's handle holds a watch exactly
 * where its program is live, an answered read's none. Each pairing is a cell of the box, and so is each explain and each
 * watch; a batch's cells are one program, checked armed. Oracle: whether the handle is of the function's own program,
 * and whether its program is live.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { handleBox } from "#test/types/api/handle.dictionary.ts"
import { handleProgram } from "#test/types/api/handle.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/**
 * Over every kind of served program, a function over MemberHandle<typeof p> admits exactly p's handles off a role of its
 * level and of an extension, and refuses another program's; each read's explain fails with its read's error; an
 * answered read's handle holds no watch, and every other's holds one.
 */
export const handle = boxAgreement(finite(word(handleBox)), {
	box: "every kind of served program (a query, a paged query, a key, an answered query, paged query and key, a ChangeSet of query members, one of array members) by a Db of the level and of its extension by the function's own program's handle and the other's, each read kind's explain, and each kind's watch",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: handleProgram,
	oracle: {
		kind: "specification",
		name: "a handle is admitted exactly when its program is the function's own, and holds a watch exactly when its program is live"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/live/program.ts",
			original: '\t\t\t? AnsweredShapeOf<ShapeOfRead<X["answered" & keyof X]>>',
			replacement: '\t\t\t? ShapeOfRead<X["answered" & keyof X]>',
			why: "An answered read's handle is typed as a live one's (live/program.ts ServedShape), so it holds a watch: answered treated as live; the program fails."
		}
	]
})
