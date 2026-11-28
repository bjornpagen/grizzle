/**
 * The stored kinds' types (test/types/schema/stored-kinds.ts): over every way a caller writes or states a stored search
 * document (pg.tsvector) or a stored computed numeric (pg.numeric.within), a cell typechecks exactly where the rule
 * admits it, and a refused one names the refusal its directive states, or none where the types refuse it as no fact of
 * its relation. Each statement is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the
 * rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { storedKindsBox } from "#test/types/schema/stored-kinds.dictionary.ts"
import { storedKindsProgram } from "#test/types/schema/stored-kinds.ts"

/** Admits every write of a stored document or computed numeric the rule admits, and refuses every other with the refusal its directive names. */
export const storedKinds = boxAgreement(finite(word(storedKindsBox)), {
	box: "an insert of host rows stating a stored document from a read's or a string, a parameter, a relation parameter's column and a contract of a document's type, and an insert stating a stored computed numeric from a Decimal, a read's sum or a bigint, and one compared with a numeric",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: storedKindsProgram,
	oracle: {
		kind: "specification",
		name: "a stored document is a SearchDocument of its configuration a read delivered; a stored computed numeric a Decimal"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/query/rule.ts",
			original:
				"\ttype: Field<H, Sql, D, F> & NotStoredOnly<Sql> & NotSearchDocument<Sql> & NotInstant<D>",
			replacement: "\ttype: Field<H, Sql, D, F> & NotStoredOnly<Sql> & NotInstant<D>",
			why: "A parameter of a search document's type typechecks, which no caller states; its directive is unused and the program fails."
		},
		{
			file: "packages/engine/src/types/fields/constructors.ts",
			original: "\t) => SearchDocumentField<C>",
			replacement: '\t) => Field<string, "tsvector">',
			why: "pg.tsvector's field takes any string, so a stored document stated from a string typechecks; its directive is unused and the program fails."
		}
	]
})
