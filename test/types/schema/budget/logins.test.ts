/**
 * A login, its workloads and a ChangeSet over its role, over a schema of qti-pie's size and shape, at scale
 * (schema/budget/logins.ts).
 *
 * Property: the login-scale program, checked alone at three relation counts an equal step apart, each step a whole
 * number of its modules, the largest past qti-pie's 370 relations by more than half again, typechecks with no
 * diagnostic, no expression of it past TypeScript's 5,000,000 instantiations, and its instantiations grow no faster
 * than linearly, exactly (test/support/growth.ts incrementsDoNotGrow; types are not judged: types/batch/measured.ts): the second step adds no more than the
 * first, so the role, the login and the ChangeSet over the role cost no more per relation at a larger schema. Oracle:
 * the compiler's own counts, compared step against step.
 */
import { growthGate } from "#test/support/types/batch/measured.ts"
import { loginDimensions } from "#test/types/schema/budget/logins.dictionary.ts"

/**
 * Each dimension's program typechecks at its three sizes with no diagnostic, each step adding types and
 * instantiations, its instantiations growing no faster than linearly.
 */
export const scaling = growthGate(loginDimensions, {
	box: "the login-scale program's one dimension, its relations",
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"\t: DeclaredByName<R>\n\n/**\n * The relations of R under their names, keyed by R's names read once, so keyof the record is its key set and a lookup\n * by name is one property read. A record whose keys an `as` clause names is read again whole at every lookup and every\n * keyof: the checker instantiates the clause over every relation of R to ask whether the record is generic, which made\n * each statement's, role's and ChangeSet's lookup of a relation cost the level's every relation. Each name's relations\n * are those of R (Extract), so every reader of the record reads R's relations, generic ones included. The names are\n * read by key (NameStated), never by a test of a relation: a derived relation holds its definition, a query over the\n * level below, and a conditional the checker resolves instantiates it whole. DeclaredIn reaches the record only where\n * every relation states one literal name.\n */\ntype DeclaredByName<R> = {\n\treadonly [N in NameStated<R>]: Extract<NamedIn<R>[N], R>\n}\n\n/**\n * Each relation of R under its name, the relations of one name in one union: read once per name, as DeclaredByName\n * resolves its properties, its clause a read by key, one instantiation over all of R.\n */\ntype NamedIn<R> = { readonly [X in R as Stated<X, \"name\"> & string]: X }",
			replacement: "\t: { readonly [X in R as NameOf<X>]: X }",
			why: "c614875c's Declared comes back, a level's record keyed by an `as NameOf<X>` clause, which the checker instantiates over every relation of the level at each lookup by name and each keyof (qti-pie's TS2589 at its author login): the program's increments grow, 2,294,580 then 3,254,580 instantiations a step at b3f355ef, a second difference of 960,000."
		}
	]
})
