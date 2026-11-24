/**
 * The query facade's type cost by dimension (query/budget/scaling.ts): rules with attachments, ChangeSet members of
 * each kind, an insertAll over every relation, contexts, and relations with their rules and members, each program
 * checked alone at three sizes an equal step apart, each step a whole number of its generator's periods.
 *
 * Properties: every program typechecks with no diagnostic; each step adds types and instantiations; and its
 * instantiations grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow): the second step adds
 * no more than the first, so no unit costs more for the units before it. Its types, which the checker interns, are not
 * judged by the law (test/types/batch/measured.ts). Oracle: the compiler's own counts, compared step against step.
 */
import { growthGate } from "#test/types/batch/measured.ts"
import { queryDimensions } from "#test/types/query/budget/scaling.dictionary.ts"

/**
 * Each dimension's program typechecks at its three sizes with no diagnostic, each step adding types and
 * instantiations, its instantiations growing no faster than linearly.
 */
export const scaling = growthGate(queryDimensions, {
	box: "every dimension of the query-scale program",
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\t\tOver,\n\t\tconst Name extends string,\n\t\tC extends Child<Over>,\n\t\tCH,\n\t\tCI,\n\t\tconst K extends DeliveryKind,\n\t\tconst F extends keyof Head & string,\n\t\tconst Hd extends string\n\t>(\n\t\tthis: OverSchema<Over>,\n\t\tname: AttachmentName<Name, Head>,\n\t\tchild: (\n\t\t\tparent: ParentVars<DeliveredHeading<Head, Hc>, Ev>",
			replacement:
				"\t\tOver extends S,\n\t\tconst Name extends string,\n\t\tC extends Child<S>,\n\t\tCH,\n\t\tCI,\n\t\tconst K extends DeliveryKind,\n\t\tconst F extends keyof Head & string,\n\t\tconst Hd extends string\n\t>(\n\t\tname: AttachmentName<Name, Head>,\n\t\tchild: (\n\t\t\tparent: ParentVars<DeliveredHeading<Head, Hc>, Ev>",
			why: "An attachment's method is typed over the whole schema rather than its own source: a second difference of 11,200."
		},
		{
			file: "packages/engine/src/live/program.ts",
			original: "\t? BundleParams<NonNullable<P[typeof phantom & keyof P]>>",
			replacement: "\t? BundleParams<Exclude<P[typeof phantom & keyof P], undefined>>",
			why: "A bundle's parameters are read through an Exclude over its phantom's union: a second difference of 1,600."
		},
		{
			file: "packages/engine/src/live/program.ts",
			original: "\t? ListOf<ServedRow<X>>",
			replacement: "\t? KeyedList<ServedRow<X>>",
			why: "A read's value named by its class directly rather than through the alias over its row: each once call instantiates its program whole, its schema with it, a second difference of 1,600."
		},
		{
			file: "packages/engine/src/types/db/workload.ts",
			original: 'type ChecksOf<S, X, K> = [K] extends ["read"]',
			replacement: 'type ChecksOf<S, X, K> = [Kinds<X>] extends ["read"]',
			why: "A member is checked by its workload's kinds rather than its own: a second difference of 3,200."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"\t? HeldWhere<N, T, HoldersOf<N, T, I>>\n\t: never\n\n/**\n * T where every name of N is among its holders H, never otherwise. The holders are a parameter of their own: a tuple of\n * HoldersOf in HeldByAll's body would be a reference the checker defers, holding the key index in its mapper, so\n * deciding it would instantiate the whole index again.\n */\ntype HeldWhere<N extends string, T, H> = [N] extends [H] ? T : never",
			replacement: "\t? [N] extends [HoldersOf<N, T, I>]\n\t\t? T\n\t\t: never\n\t: never",
			why: "A relation's declared keys are read through a tuple the checker defers: a second difference of 640."
		}
	]
})
