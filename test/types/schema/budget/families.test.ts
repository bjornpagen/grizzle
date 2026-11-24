/**
 * Families, trees, folds and nested additions at scale (schema/budget/families.ts).
 *
 * Properties:
 * - Cost: the family-scale program, checked alone at three family counts an equal step apart, each step a whole number
 *   of its period, typechecks with no diagnostic, every relation a ChangeSet inserts at its top level inserted at once
 *   from the rows grizzle types (a round trip), and its instantiations grow no faster than linearly, exactly
 *   (test/support/growth.ts incrementsDoNotGrow; types are not judged: types/batch/measured.ts): the second step adds
 *   no more than the first. Oracle: the compiler's own counts, compared step against step.
 * - Invariance: at the largest size, beside its twin, the same declarations over the first and the last unit of each
 *   kind alone, each probe a cell of the program's box, checked disarmed beside the program at scale and its twin: every
 *   unit's additions, the relations a ChangeSet inserts at its top level and the rows insertAll takes of them are
 *   identical to the twin's; and an ordered member written alone and a counted member nested under its owner raise
 *   exactly the diagnostics, codes and refusals, they raise over the twin. Oracle: the twin.
 */
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { growthGate } from "#test/types/batch/measured.ts"
import { familyDimensions, familyProbes } from "#test/types/schema/budget/families.dictionary.ts"
import { familyProgram } from "#test/types/schema/budget/families.ts"

/**
 * The family-scale program typechecks at its three family counts with no diagnostic, each step adding types and
 * instantiations, its instantiations growing no faster than linearly.
 */
export const growth = growthGate(familyDimensions, {
	box: "the family-scale program's one dimension, its families",
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"/**\n * The owners of S's ordered and counted families under the name of their member relation, a member of several families\n * once with all their owners, and none under any other name: built once per schema, in one pass over its families, so\n * a member's owners are one property read, as SequenceIndexOf reads an owner's sequences.\n */\ntype RowOwnerIndexOf<S> = {\n\treadonly [Fa in RowFamilyOf<S> as NameOf<MemberRelationOf<Fa>>]: OwnerNameOf<Fa>\n} & { readonly [member: string]: never }\n\n/**\n * The immutable owners of the ordered and counted families R is a member of in S: one read of the schema's index\n * (RowOwnerIndexOf), so insertAll's keys cost one each, however many families the schema holds.\n */\ntype FixedOwnerOf<S, R> =\n\tstring extends NameOf<R> ? never : Exclude<RowOwnerIndexOf<S>[NameOf<R>], MutableNameOf<S>>",
			replacement:
				"/** The immutable owners of the ordered and counted families R is a member of in S. */\ntype FixedOwnerOf<S, R> =\n\tstring extends NameOf<R>\n\t\t? never\n\t\t: Exclude<\n\t\t\t\tRowFamilyOf<S> extends infer Fa\n\t\t\t\t\t? Fa extends unknown\n\t\t\t\t\t\t? [Extract<NameOf<MemberRelationOf<Fa>>, NameOf<R>>] extends [never]\n\t\t\t\t\t\t\t? never\n\t\t\t\t\t\t\t: OwnerNameOf<Fa>\n\t\t\t\t\t\t: never\n\t\t\t\t\t: never,\n\t\t\t\tMutableNameOf<S>\n\t\t\t>",
			why: "A key's immutable owners are found by a pass over every family of the schema for each key (FixedOwnerOf with no RowOwnerIndexOf), a cost per key that grows with the families: insertAll raises TS2589 from 680 families, the smallest size, so the program fails before the law reads its counts, and the twin's check fails with it, the insertAll at 2040 raising where the twin's does not."
		}
	]
})

/**
 * At its largest family count, every probe infers what the twin infers, and refuses what the twin refuses, as the
 * twin refuses it.
 */
export const invariance = boxAgreement(familyProbes, {
	box: "every probe of the 2,040-family program against its twin",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: familyProgram,
	oracle: {
		kind: "second-implementation",
		name: "the twin, the same declarations at the smallest scale the probes read"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"/**\n * The owners of S's ordered and counted families under the name of their member relation, a member of several families\n * once with all their owners, and none under any other name: built once per schema, in one pass over its families, so\n * a member's owners are one property read, as SequenceIndexOf reads an owner's sequences.\n */\ntype RowOwnerIndexOf<S> = {\n\treadonly [Fa in RowFamilyOf<S> as NameOf<MemberRelationOf<Fa>>]: OwnerNameOf<Fa>\n} & { readonly [member: string]: never }\n\n/**\n * The immutable owners of the ordered and counted families R is a member of in S: one read of the schema's index\n * (RowOwnerIndexOf), so insertAll's keys cost one each, however many families the schema holds.\n */\ntype FixedOwnerOf<S, R> =\n\tstring extends NameOf<R> ? never : Exclude<RowOwnerIndexOf<S>[NameOf<R>], MutableNameOf<S>>",
			replacement:
				"/** The immutable owners of the ordered and counted families R is a member of in S. */\ntype FixedOwnerOf<S, R> =\n\tstring extends NameOf<R>\n\t\t? never\n\t\t: Exclude<\n\t\t\t\tRowFamilyOf<S> extends infer Fa\n\t\t\t\t\t? Fa extends unknown\n\t\t\t\t\t\t? [Extract<NameOf<MemberRelationOf<Fa>>, NameOf<R>>] extends [never]\n\t\t\t\t\t\t\t? never\n\t\t\t\t\t\t\t: OwnerNameOf<Fa>\n\t\t\t\t\t\t: never\n\t\t\t\t\t: never,\n\t\t\t\tMutableNameOf<S>\n\t\t\t>",
			why: "A key's immutable owners are found by a pass over every family of the schema for each key (FixedOwnerOf with no RowOwnerIndexOf), a cost per key that grows with the families: insertAll raises TS2589 from 680 families, the smallest size, so the program fails before the law reads its counts, and the twin's check fails with it, the insertAll at 2040 raising where the twin's does not."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"type SequenceIndexOf<S> = {\n\treadonly [Fa in SequenceOf<S> as OwnerNameOf<Fa>]: Fa\n} & { readonly [owner: string]: never }",
			replacement:
				"type SequenceIndexOf<S> =\n\tStatementsOf<S> extends { readonly 99: unknown }\n\t\t? { readonly [owner: string]: never }\n\t\t: {\n\t\t\t\treadonly [Fa in SequenceOf<S> as OwnerNameOf<Fa>]: Fa\n\t\t\t} & { readonly [owner: string]: never }",
			why: "A schema's index of sequences by owner (SequenceIndexOf) is dropped once it holds a hundred statements, which the twin never does and the program at scale does: at 2040 families the additions of every probed sequence owner, the first and the last O, F and T, and insertAll's rows are not the twin's; the invariance property fails."
		}
	]
})
