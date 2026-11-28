/**
 * An instant's types (test/types/changeset/instants.ts): over every way a caller may write, state or compare an
 * instant, a cell typechecks exactly where the rule admits it, an instant being the database's alone, and a refused one
 * names the refusal its directive states, or none where the types refuse it as no fact of its relation or no operand of
 * its comparison. Each statement is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the
 * rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { instantsBox } from "#test/types/changeset/instants.dictionary.ts"
import { instantsProgram } from "#test/types/changeset/instants.ts"

/** Admits every write of an instant the rule admits, and refuses every other with the refusal its directive names. */
export const instants = boxAgreement(finite(word(instantsBox)), {
	box: "an insert, a put and a delete of host rows and of a query's, the rows insertAll's record types and factsDecoder decodes inserted, insertAll'd and served, an instant stated from a stored one, a stored instant (instant.stored) stated from a read's instant and refused a bigint, an evaluator's rows stating instants as bigints and delivering none as a read's, a parameter, a relation parameter's column, a literal, a typed constant and a cast of its type, a contract named instant or over one, a span of instants, and instants compared with a literal and with instants",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: instantsProgram,
	oracle: {
		kind: "specification",
		name: "an instant is the database's alone: no value a caller holds is one but an instant a read delivered, which a stored instant takes as it is"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: "\t\t: [D] extends [InstantDomain]\n",
			replacement: "\t\t: [D] extends [never]\n",
			why: "No domain reads as an instant's, so a parameter, a typed constant, a cast, a contract and a span of instant's type typecheck and their directives are unused; the program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"\treadonly [K in InsertableNameOf<S>]: ReadonlyArray<\n\t\tHostRowsOf<AdditionIn<S, InsertedRelation<S, K>>, InsertedRelation<S, K>>\n\t>",
			replacement:
				"\treadonly [K in InsertableNameOf<S>]: ReadonlyArray<AdditionIn<S, InsertedRelation<S, K>>>",
			why: "insertAll's record of rows, which factsDecoder decodes, types a row as an addition, its instant optional, a second spelling of a host row where every insert of host rows leaves it out (HostRowsOf), so the decoded rows of a relation with a clock are refused by its own insert, insertAll and served facts, and the program fails."
		},
		{
			file: "packages/engine/src/scalar/instant.ts",
			original: 'export type Instant = bigint & Brand.Brand<"instant">',
			replacement: "export type Instant = bigint",
			why: "An instant's host value is a bare bigint, so a host row stating a stored instant of a bigint, a host's own, typechecks and its directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/evaluation.ts",
			original: "type Evaluated<V> = V extends Instant ? bigint : V",
			replacement: "type Evaluated<V> = V",
			why: "An evaluated row's instant is the read's Instant, so a row an author states to judge, its instant a bigint, is refused by admit, and an admitted row's instant reads as one a read delivered; the program fails."
		},
		{
			file: "packages/engine/src/types/query/rule.ts",
			original: "\t[K in keyof C]-?: C[K] extends StoredInstantField ? K : never",
			replacement: "\t[K in keyof C]-?: C[K] extends { readonly instant: true } ? K : never",
			why: "A relation parameter's stored instant column is admitted, a parameter of instant's type a caller states; its directive is unused and the program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "\t\t\t? Omit<F, InstantFieldsOf<R>>\n",
			replacement: "\t\t\t? F\n",
			why: "A host row may state an instant, so an insert of host rows stating the clock from a read's instant typechecks and its directive is unused; the program fails."
		}
	]
})
