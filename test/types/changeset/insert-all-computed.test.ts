/**
 * ChangeSet#insertAllComputed's types (test/types/changeset/insert-all-computed.ts): over every case of the
 * insertAllComputed box (test/support/agreement/insert-all-computed.ts), pantry's publish of `package` from its one
 * parameter over relations keyed by their package, an insertAllComputed typechecks exactly when the engine builds,
 * compiles and binds it: an owner nesting its ordered members, a tree nesting its nodes and two relations at once, every
 * row leaving the computed field out and every nested one filled from its owner's value; and a refused one names the
 * refusal its fault breaks, each by its name. Each case is a cell of the box; a batch's cells are one program, checked
 * disarmed. Oracle: the engine's build, compile and bind of each case.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { insertAllComputedBox } from "#test/types/changeset/insert-all-computed.dictionary.ts"
import { insertAllComputedProgram } from "#test/types/changeset/insert-all-computed.ts"

/** Admits every case the engine builds, compiles and binds, and refuses every other with the refusal its directive names. */
export const insertAllComputed = boxAgreement(finite(word(insertAllComputedBox)), {
	box: "an owner nesting its ordered members, a tree nesting its nodes, two relations, and one fault each: a relation lacking the field, an ordered member by its own key, a record of no field, a field of another type, a field no relation holds, a row or a nested row stating the field",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: insertAllComputedProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's build, compile and bind of each case"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"\t\t\t\t: [ComputedRefusals<C, R>] extends [never]\n\t\t\t\t\t? MemberCheck<M, ComputedRow<AdditionIn<S, R>, keyof C>, R>\n\t\t\t\t\t: ComputedRefusals<C, R>\n",
			replacement: "\t\t\t\t: MemberCheck<M, ComputedRow<AdditionIn<S, R>, keyof C>, R>\n",
			why: "Each relation the record names is no longer held to the computed record: a relation lacking the field, a field no relation holds and one of another type are admitted, which the engine refuses; the program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "\t\t\t\t\t? MemberCheck<M, ComputedRow<AdditionIn<S, R>, keyof C>, R>\n",
			replacement: "\t\t\t\t\t? MemberCheck<M, AdditionIn<S, R>, R>\n",
			why: "The rows insertAllComputed takes are insertAll's, every computed field stated: the rows leaving the field out are refused, which the engine admits; the program fails."
		}
	]
})
