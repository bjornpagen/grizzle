import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
/**
 * The member-handle program (test/types/api/handle.ts): a function over MemberHandle<typeof p> takes exactly the handle
 * of its own program, over a role of the program's level and over a role of an extension of it, for every kind of
 * served program, and each read kind's explain fails with its read's error. Each pairing is a cell of the box, and so is
 * each explain; a batch's cells are one program, checked armed. Oracle: whether the handle is of the function's own
 * program.
 */
import { handleBox } from "#test/types/api/handle.dictionary.ts"
import { handleProgram } from "#test/types/api/handle.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/**
 * Over every kind of served program, a function over MemberHandle<typeof p> admits exactly p's handles off a role of its
 * level and of an extension, and refuses another program's; each read's explain fails with its read's error.
 */
export const handle = boxAgreement(finite(word(handleBox)), {
	box: "every kind of served program (a query, a paged query, a key, a deferrable read, a ChangeSet of query members, one of array members) by a Db of the level and of its extension by the function's own program's handle and the other's, and each read kind's explain",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: handleProgram,
	oracle: {
		kind: "specification",
		name: "a handle is admitted exactly when its program is the function's own"
	},
	kept: [],
	kills: []
})
