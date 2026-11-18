import { costGate } from "#test/types/batch/measured.ts"
/**
 * The ChangeSet members' type cost against the schema they write (changeset/budget/members.ts): for each op, a delete,
 * a put, an insert or an insertAll's key, and each member kind, a query or an array of facts, and for a deleteWhere's
 * key, a selection by the package parameter, the program of `members`
 * members and the program of twice as many, each beside a query member under a package parameter, joined with a
 * ChangeSet over an extension of the schema and applied through the extension's workload's handle with that parameter,
 * and checked alone over a schema of `small` relations and over one of `large`, as edullm's pantry writes one member per
 * relation of a schema of hundreds (its replaceWrite) and qti-database applies it, joined with its own write over the
 * levels above (its publish), through its handle.
 *
 * Properties: instantiations per ChangeSet member are invariant in schema size. The members the second program adds,
 * its last `members` members, cost exactly as many instantiations over the large schema as over the small one, the
 * ChangeSet's calls and its handle's together: I(large, 2k) − I(large, k) = I(small, 2k) − I(small, k). What the first
 * member reads of the schema once, its index of families, its relations' union, is in both programs of a schema and
 * cancels; a member that reads the schema again costs more over the larger one, by every relation it walks, for each
 * member, the handle's read of each array member's level below the extension among them. And every program typechecks
 * with no diagnostic: the handle's once takes the package parameter beside every array member's facts, each fact
 * holding a field named `params`, as pantry's Reference does. Oracle: the compiler's own counts and diagnostics
 * (test/types/batch/measured.ts), compared across the two schemas.
 */
import { memberForms } from "#test/types/changeset/budget/members.dictionary.ts"
import { memberCost, memberFormName } from "#test/types/changeset/budget/members.ts"

/** Each op and member kind's members cost as many instantiations over the large schema as over the small one. */
export const cost = costGate(memberForms, {
	box: "every op and member kind of a ChangeSet",
	name: memberFormName,
	measure: memberCost,
	oracle: { kind: "universal", name: "the compiler's own counts, compared across the two schemas" },
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"export type ContextsOf<Q> = Q extends unknown\n\t? typeof phantom extends keyof Q\n\t\t? PhantomContexts<NonNullable<Q[typeof phantom & keyof Q]>>\n\t\t: never\n\t: never",
			replacement:
				"export type ContextsOf<Q> = Q extends Phantom<infer B> ? PhantomContexts<B> : never",
			why: "ContextsOf binds a program's phantom whole (`Q extends Phantom<infer B>`) before it reads its contexts: B holds the schema, and each read of it instantiates the schema again, so each query member's contexts walk every relation; the query members' cost grows with the schema."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"type ArrayAdded<Op extends ArrayOp, R, M, S, Done extends Strata> =\n\tIsArrayMember<M> extends true ? MemberOf<Op, R, PositionOf<Done>, S> : never",
			replacement:
				"type ArrayAdded<Op extends ArrayOp, R, M, S, Done extends Strata> = [M] extends [ReadonlyArray<unknown>]\n\t? MemberOf<Op, R, PositionOf<Done>, S>\n\t: never",
			why: "ArrayAdded tells an array member by testing the member boxed (`[M] extends [ReadonlyArray<unknown>]`): the box holds the query member, and the test instantiates it whole, its schema with it; the query members' cost grows with the schema."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"\t\t? RelationIn<Spelled, RelationsOf<LevelOfMember<S, Address, Spelled>>> extends infer R\n\t\t\t? RowOfOp<Op, LevelOfMember<S, Address, Spelled>, R> extends infer Row\n\t\t\t\t? {\n\t\t\t\t\t\treadonly [O in Op]: {\n\t\t\t\t\t\t\treadonly [N in NameOfSpelled<Spelled>]: ArrayFacts<R, Row, At>\n\t\t\t\t\t\t}\n\t\t\t\t\t}",
			replacement:
				"\t\t? LevelOfMember<S, Address, Spelled> extends infer L\n\t\t\t? RelationIn<Spelled, RelationsOf<L>> extends infer R\n\t\t\t\t? RowOfOp<Op, L, R> extends infer Row\n\t\t\t\t\t? {\n\t\t\t\t\t\t\treadonly [O in Op]: {\n\t\t\t\t\t\t\t\treadonly [N in NameOfSpelled<Spelled>]: ArrayFacts<R, Row, At>\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}\n\t\t\t\t\t: never",
			why: "RecordOf binds an array member's level by `infer` before it reads the member's relation and row: the level is the schema, and the branch that reads it instantiates it whole, once for each member, so each array member the handle reads walks every relation; the array members' cost grows with the schema."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				'type LevelAt<S, Depth> = DepthOf<S>["length"] extends Depth ? S : LevelAt<BelowOf<S>, Depth>',
			replacement:
				'type LevelAt<S, Depth> = DepthOf<S>["length"] extends Depth\n\t? S\n\t: S extends Phantom<{ readonly extends: infer Below }>\n\t\t? LevelAt<Below, Depth>\n\t\t: never',
			why: "LevelAt binds the level below by `infer` (`S extends Phantom<{ readonly extends: infer Below }>`) on its way down to a member's level: the branch that reads Below instantiates it whole, every relation and statement of the schema below the extension, once for each array member the handle reads, so the array members' cost grows with the schema (edullm's TS2589 at qti-database's publish.once, 2026-11-18)."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t\t\t\t>\n\t\t\t: unknown",
			replacement: "\t\t\t\t>\n\t\t\t: never",
			why: "ParamsOf reads a member with no phantom, an array, as needing never: the ChangeSet's parameters, joined with its array members', are never, and the handle's once refuses the package parameter; the array programs fail with a diagnostic."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\t\t: typeof phantom extends keyof X\n\t\t\t? UnionToIntersection<\n\t\t\t\t\tParamsContribution<PhantomParams<NonNullable<X[typeof phantom & keyof X]>>>\n\t\t\t\t>\n\t\t\t: unknown",
			replacement:
				"\t\t: UnionToIntersection<\n\t\t\t\tParamsContribution<PhantomParams<NonNullable<X[typeof phantom & keyof X]>>>\n\t\t\t>",
			why: "ParamsOf reads a member's phantom by its key without asking whether the member has one: an array indexed by a key it lacks is its fact, so a fact's field named `params` is read as the member's parameters, and the handle's once refuses the package parameter; the array programs fail with a diagnostic."
		}
	]
})
