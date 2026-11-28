/**
 * The window-anchor program (test/types/api/anchor.ts): a paged member's window takes exactly the anchors the runtime's
 * window parse admits, among anchors whose members' types decide them: each kind with exactly its own members, the
 * start and the end with none, after and before with a key, at with a position, and none with another's member, none
 * missing its own and no position of another type than a number. Each anchor is a cell of the box; a batch's cells are
 * one program, checked armed. Oracle: the runtime's window parse (adapter/page/window.ts windowCall) of the same anchor.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { anchorBox } from "#test/types/api/anchor.dictionary.ts"
import { anchorProgram } from "#test/types/api/anchor.ts"

/** A paged member's window takes exactly the anchors the runtime's window parse admits, among those a type decides. */
export const anchor = boxAgreement(finite(word(anchorBox)), {
	box: "every anchor a type decides: the start, the end, after and before a key, at the first and a later position, and at no position, at a position of text or a bigint, at a position and a key, the start at a position, after a position, and a kind of no anchor",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: anchorProgram,
	oracle: { kind: "second-implementation", name: "the runtime's window parse of the same anchor" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/live/program.ts",
			original: '\t| { readonly kind: "at"; readonly position: number }',
			replacement: '\t| { readonly kind: "at"; readonly position: number | string }',
			why: "A position of text is an anchor's, which the runtime refuses; the program fails at the cell of a position of text."
		},
		{
			file: "packages/engine/src/live/program.ts",
			original: '\t| { readonly kind: "at"; readonly position: number }',
			replacement: '\t| { readonly kind: "at"; readonly position?: number }',
			why: "An anchor at no position is a window's, which the runtime refuses; the program fails at the cell at no position."
		}
	]
})
