/**
 * ChangeSet#deleteWhere's types (test/types/changeset/delete-where.ts): over every case of the deleteWhere box
 * (test/support/agreement/delete-where.ts), each relation a key may name with each selection shape, a deleteWhere
 * typechecks exactly when the engine builds and compiles it, and a refused one names the refusal its subject or its
 * selection breaks. Each case is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the
 * engine's build and compile of each case.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { deleteWhereBox } from "#test/types/changeset/delete-where.dictionary.ts"
import { deleteWhereProgram } from "#test/types/changeset/delete-where.ts"

/** Admits every case the engine builds and compiles, and refuses every other with the refusal its directive names. */
export const deleteWhere = boxAgreement(finite(word(deleteWhereBox)), {
	box: "every relation a deleteWhere's key may name by every selection shape its fields take",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: deleteWhereProgram,
	oracle: { kind: "second-implementation", name: "the engine's build and compile of each case" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "\t| InputTerm<DomainOf<C>, never, ParamOrigin, SqlOfCarrier<C>>",
			replacement: "\t| InputTerm<DomainOf<C>, never, ParamOrigin | unknown, SqlOfCarrier<C>>",
			why: "A field may equal any term of its type, whatever its origin (types/changeset/changeset.ts EqualedTo), so a variable or a typed constant in place of a parameter is admitted; the program fails."
		}
	]
})
