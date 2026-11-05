import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type { Carriers, Headed, Invariant, Refusal } from "#compiler/types/core/phantom.ts"
import type { AnyDerived, Derived } from "#compiler/types/derived/derived.ts"
import type { QueryOver } from "#compiler/types/query/query.ts"
import type { AnyClosed, AnyRelation, NameOf } from "#compiler/types/schema/relation.ts"
import type {
	Alternatives,
	AlternativesBase,
	Capacity,
	Check,
	Containment,
	ExpansionOf,
	Key,
	Mirrors,
	Mutable,
	RelationOfKey,
	Side,
	SideRelation,
	Statement
} from "#compiler/types/schema/statements.ts"
import type { AnyWorld } from "#compiler/types/schema/world.ts"

/**
 * Schemas, schema extension, and the projections that read a schema's captured statements. The builders schema and
 * schema.extend are the typed schema facade's (schema/api.ts), written under these types over the admission cores of
 * packages/engine/src/schema.
 *
 * The schema this one extends (never for a root schema) is a phantom, so the levels below a schema are part of its
 * type. It is the type-level image of SchemaDesc.extends; an extension's runtime value also holds its base, and a root
 * schema's holds undefined.
 */
export interface Schema<
	Name extends string,
	Relations,
	Statements extends ReadonlyArray<Statement>,
	Base = never
> extends Phantom<{ readonly extends: Base }> {
	readonly name: Name
	readonly relations: Relations
	readonly statements: Statements
}

/**
 * Any schema: the members every one has. Every Schema whose relations are a record of relations is one, and so is
 * every role (world.ts), whose query entries are world relations.
 */
export interface AnySchema extends Built {
	readonly name: string
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived | AnyWorld>>
	readonly statements: ReadonlyArray<Statement>
}

/** The schema S extends, never for a root schema. */
export type BaseSchemaOf<S> = S extends Phantom<{ readonly extends: infer B }> ? B : never

/** A derived relation whose definition is a query over one of the levels L. */
export type DerivedAt<L> = L extends unknown
	? Derived<string, QueryOver<L> & Headed<Carriers>>
	: never

/**
 * The relations a statement names: the relation of a key, a mutable or a check; the source of each law side (a
 * selection's relation); and an alternatives law's parent, roster and arms.
 */
type SideNames<X> = X extends Side<infer Src> ? SideRelation<Src> : never
export type NamedBy<St> =
	St extends Key<infer R, ReadonlyArray<string>>
		? R
		: St extends Mutable<infer R>
			? R
			: St extends Check<string, infer R>
				? R
				: St extends Containment<infer L, infer R>
					? SideNames<L> | SideNames<R>
					: St extends Mirrors<infer L, infer R>
						? SideNames<L> | SideNames<R>
						: St extends Capacity<infer T, infer F>
							? SideNames<T> | SideNames<F>
							: St extends Alternatives<infer P, string, infer C, infer Arms>
								? RelationOfKey<P> | C | RelationOfKey<Exclude<Arms[keyof Arms], undefined>>
								: never

/**
 * The relations a statement names that are none of the record's relations. A relation whose name the type does not
 * know (a widened arm of alternatives, a side over AnySide, a statement list typed ReadonlyArray<Statement>) is not
 * refused here; the run time checks it.
 */
type Undeclared<Members, R> = R extends unknown
	? [NameOf<R>] extends [never]
		? never
		: string extends NameOf<R>
			? never
			: [R] extends [Members]
				? never
				: R
	: never

/**
 * Every relation a statement names is one of the schema's, at some level (the runtime refusal of schemaArtifacts,
 * "names B, which no level of the schema declares", as a type error).
 */
export type StatementsWithin<Statements extends ReadonlyArray<Statement>, Relations> = [
	Undeclared<Relations[keyof Relations], NamedBy<Statements[number]>>
] extends [never]
	? unknown
	: Refusal<"a statement names a relation no level of the schema declares">

/**
 * Each relation of a level's record sits under its own name, as a role's whole entries do (EntriesCheck), the type
 * of the run time's refusal "a relation under its own name". The record's values are then the level's relations, one
 * per name, so "R is the level's relation of R's name" is "R is one of the record's values": one identity test
 * against the union of the values, which the checker builds once per record, and no index by name is derived. A
 * relation whose name the type does not know passes here; the run time checks it.
 */
export type UnderOwnNames<Relations> = {
	readonly [K in keyof Relations]: [K] extends [NameOf<Relations[K]>]
		? unknown
		: Refusal<"a schema holds each relation under its own name">
}

/**
 * S and every schema below it. A query over any of them is a query over S. The recursion
 * is as deep as the extension chain, never over relations or statements.
 */
export type LevelsOf<S> =
	| S
	| (S extends Phantom<{ readonly extends: infer B }>
			? [B] extends [never]
				? never
				: LevelsOf<B>
			: never)

/**
 * Whether X is one of the levels of S. Each level is compared invariantly, as Query compares its schema, so a schema
 * that is structurally wider or narrower than every level (an extension of S, or another schema of the same name
 * with more relations) is not a level even where plain assignability would admit it.
 */
export type IsLevelOf<S, X> = 0 extends 1 & S
	? true
	: true extends LevelMatch<LevelsOf<S>, X>
		? true
		: false

type LevelMatch<L, X> = L extends unknown
	? [Invariant<X>] extends [Invariant<L>]
		? true
		: false
	: never

/**
 * Schema projections. Each is a property read or a single Extract over the statement tuple's
 * element union; none recurses over the schema graph.
 */
export type RelationsOf<S> = S extends { readonly relations: infer Rs } ? Rs : never
export type RelationOf<S> = RelationsOf<S>[keyof RelationsOf<S>]

/**
 * Whether R is a relation, closed relation or derived relation of S; any schema admits every relation. S's record
 * holds each relation under its own name (UnderOwnNames), so R is S's relation of its name exactly when it is one of
 * RelationOf<S>, the union the checker builds once per schema.
 */
export type IsRelationOf<S, R> = 0 extends 1 & S ? true : [R] extends [RelationOf<S>] ? true : false

/**
 * One entry of an index by a single name. An index here is keyed by its own domain (KeyIndexOf by the names its key
 * statements declare), never by a key remapped with `as`, so `keyof Index` is the index's own key set, which the
 * checker holds once. The keys of a remapped index are recomputed at every `keyof`, one instantiation of the remapping
 * per key, so a lookup into one costs the size of the whole index.
 */
type Lookup<Index, N> = N extends keyof Index ? Index[N] : never
export type StatementsOf<S> = S extends {
	readonly statements: infer St extends ReadonlyArray<Statement>
}
	? St
	: never
type StatementOf<S> = StatementsOf<S>[number]

/**
 * The keys of R in S: its primary key, the keys a derived or world relation's definition proves, and every
 * candidate key declared for R with key(). Each key is a list of field names. A context holds at most one fact, so
 * its key is the empty one.
 */
export type KeysOf<S, R> = R extends { readonly kind: "context" }
	? readonly []
	:
			| (R extends { readonly primaryKey: infer P }
					? P
					: R extends AnyClosed
						? readonly ["id"]
						: R extends { readonly kind: "derived" | "world"; readonly definition: infer Q }
							? DefinitionKeysOf<Q>
							: never)
			| Lookup<KeyIndexOf<S>, NameOf<R>>

/** The key statements of S. */
type KeyStatementOf<S> = Extract<StatementOf<S>, Key<unknown, ReadonlyArray<string>>>

/**
 * The candidate keys of every relation of S, keyed by its own domain, the names S's key statements declare. It is
 * built once per schema and each relation's entry is computed once, on its first read, so reading one relation's keys
 * is a property read rather than a pass over the statement tuple for every match. Relation names are unique within a
 * schema, so the name identifies the relation.
 */
type KeyIndexOf<S> = {
	readonly [N in NameOf<KeyStatementOf<S>["relation"]>]: Extract<
		KeyStatementOf<S>,
		{ readonly relation: { readonly name: N } }
	>["fields"]
}

/** The proved keys a query's evidence carries. */
type DefinitionKeysOf<Q> =
	Q extends Phantom<{ readonly evidence: { readonly keys: infer Ks } }>
		? Ks extends ReadonlyArray<infer K extends ReadonlyArray<string>>
			? K
			: never
		: never

/** The laws of S: its statements, each alternatives law read as the statements it expands to. */
export type LawsOf<S> =
	StatementOf<S> extends infer St ? (St extends AlternativesBase ? ExpansionOf<St> : St) : never
export type ContainmentsOf<S> = Extract<LawsOf<S>, Containment<unknown, unknown>>
