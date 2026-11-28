/**
 * The schema builders' type cost by dimension (schema/budget/scaling.ts): relations, a full role's entries, a write
 * list's names, a roster's and a set's handles, laws per relation, roles per schema and fields per relation, each
 * program checked alone at three sizes an equal step apart, each step a whole number of its generator's periods.
 *
 * Properties: every program typechecks with no diagnostic; each step adds types and instantiations; and its
 * instantiations grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow; its types, which the
 * checker interns, are not judged by the law: test/support/types/batch/measured.ts): the second step adds no more than the first, so no
 * unit costs more for the units before it. Oracle: the compiler's own counts, compared step against step.
 */
import { growthGate } from "#test/support/types/batch/measured.ts"
import { schemaDimensions } from "#test/types/schema/budget/scaling.dictionary.ts"

/**
 * Each dimension's program typechecks at its three sizes with no diagnostic, each step adding types and
 * instantiations, its instantiations growing no faster than linearly.
 */
export const scaling = growthGate(schemaDimensions, {
	box: "every dimension of the schema-scale program",
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "type HoldersOf<N extends string, T, I extends ByName> = N extends unknown",
			replacement: "type HoldersOf<N extends string, T, I extends ByName> = N extends keyof I",
			why: "Whether a relation's name is among the key index's keys is asked by HoldersOf's `N extends keyof I`, which the checker computes over every key side of the schema at each read of a relation's keys: laws per relation turn superlinear in instantiations, a second difference of 19,200 at b3f355ef."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "\t\t\t: true extends SameAs<UnderName<Relations, NameStated<R>>, R>",
			replacement: "\t\t\t: true extends SameAs<Relations[keyof Relations], R>",
			why: "A statement's relations are found among the schema's by relating each to every relation of the schema (Undeclared's SameAs over the record's every relation, not the one under its name), a cost per statement that grows with the relations: the schema(...) call raises TS2589 from 668 relations, 760 full-role entries and 420 write-list names, so the programs fail before the law reads their counts."
		}
	]
})
