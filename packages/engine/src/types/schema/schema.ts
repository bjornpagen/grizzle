import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type { Identical } from "#compiler/types/core/identical.ts"
import type {
	Carriers,
	Headed,
	Invariant,
	IsOneLiteral,
	MembersTyped,
	Refusal
} from "#compiler/types/core/phantom.ts"
import type { AnyDerived, Derived } from "#compiler/types/derived/derived.ts"
import type { QueryOver } from "#compiler/types/query/query.ts"
import type {
	AnyClosed,
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	NameOf
} from "#compiler/types/schema/relation.ts"
import type {
	Alternatives,
	AlternativesBase,
	AnyFin,
	AnyTerm,
	CandidateKey,
	Check,
	Containment,
	Counted,
	ExpansionOf,
	Fin,
	Fold,
	Key,
	Mirrors,
	MirrorsBase,
	Mutable,
	Ordered,
	Race,
	RelationOfKey,
	Selection,
	Side,
	SideRelation,
	Statement,
	Tree
} from "#compiler/types/schema/statements.ts"

/**
 * Schemas, schema extension, and the projections that read a schema's captured statements. The builders schema and
 * schema.extend are the typed schema facade's (schema/api.ts), written under these types over the admission cores of
 * packages/engine/src/schema.
 *
 * A schema's type holds its statements by name (StatementsByName): each relation a statement names, which the record
 * holds under its name, is spelled as that name. A type argument holds no relation then, and so no relation's field
 * record, an object-literal type the checker takes for one that may hold a type variable: every generic call whose type
 * mentions the schema instantiates its type arguments again, and would walk every statement's relations each time.
 * `statements` reads each statement back whole (StatementsFromNames), the very type the call wrote.
 *
 * The schema this one extends (never for a root schema) is a phantom, so the levels below a schema are part of its
 * type. It is the type-level image of SchemaDesc.extends; an extension's runtime value also holds its base, and a root
 * schema's holds undefined. The fragments its list holds (Fragments, never for none) are a phantom too, each a level of
 * the schema (LevelsOf). An extension's statements are its base's, then its own, then its fragments', each
 * fragment's held by name as the fragment holds them.
 */
export interface Schema<
	Name extends string,
	Relations,
	Named extends ReadonlyArray<Statement>,
	Base extends AnySchema = never,
	Fragments extends AnyFragment = never
> extends Phantom<{ readonly extends: Base; readonly fragments: Fragments }> {
	readonly kind: "schema"
	readonly name: Name
	readonly relations: Relations
	readonly statements: readonly [
		...StatementsBelow<Base>,
		...StatementsFromNames<Named, Relations>,
		...ReadonlyArray<Fragments["statements"][number]>
	]
}

/**
 * A fragment: relations and the statements over them, declared by no schema of their own, which an application's
 * schema lists among its relations (schema/schema.ts fragment), each schema that lists it holding its relations and
 * statements as its own. It has no name and no installation: its identity is its content. A query or a ChangeSet over a
 * fragment reads and writes its relations alone, and is a program of every schema that lists it (LevelsOf). Its
 * relations are held by name and its statements by name read back whole, as a schema holds its own (Schema).
 */
export interface Fragment<Relations, Named extends ReadonlyArray<Statement>> extends Built {
	readonly kind: "fragment"
	readonly relations: Relations
	readonly statements: readonly [...StatementsFromNames<Named, Relations>]
}

/** Any fragment: the members every one has. */
export interface AnyFragment extends Built {
	readonly kind: "fragment"
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed>>
	readonly statements: ReadonlyArray<Statement>
}

/** The fragments a level's list holds. */
export type FragmentsIn<Relations extends ReadonlyArray<unknown>> = Extract<
	Relations[number],
	AnyFragment
>

/**
 * What one item of a level's list declares: a fragment, each of its relations; any other item, itself. It distributes
 * over a union of items, as a list's element type is.
 */
type Listed<X> = X extends AnyFragment ? X["relations"][keyof X["relations"]] : X

/** The statements of the levels below a schema: its base's, none below a root schema. */
export type StatementsBelow<Base extends AnySchema> = [Base] extends [never]
	? readonly []
	: Base["statements"]

/**
 * How a statement spells each relation it names: by name, the literal key of the schema's record that holds that very
 * relation, or by the relation itself. A relation the record does not hold under its name, and one whose name is no
 * literal, is spelled as itself either way, so reading a statement back by relation gives the statement it was.
 */
type Spelling = "name" | "relation"

/** R by name: its literal name, where the record holds R itself under it, and R otherwise. */
export type NameIn<R, Rs> = R extends { readonly name: infer N extends string }
	? string extends N
		? R
		: Identical<R, UnderName<Rs, N>> extends true
			? N
			: R
	: R

/** N by relation: the record's relation under the name N, and N where N is no name of the record. */
export type RelationIn<N, Rs> = N extends keyof Rs ? Rs[N] : N

type Spelled<R, Rs, To extends Spelling> = To extends "name" ? NameIn<R, Rs> : RelationIn<R, Rs>

/** A law side's source spelled: a selection over its relation spelled, or the relation. */
type SourceSpelled<Src, Rs, To extends Spelling> =
	Src extends Selection<infer R>
		? Spelled<R, Rs, To> extends infer X
			? Selection<X>
			: never
		: Spelled<Src, Rs, To>

type SideSpelled<S, Rs, To extends Spelling> =
	S extends Side<infer Src, infer T extends ReadonlyArray<AnyTerm>>
		? SourceSpelled<Src, Rs, To> extends infer X
			? Side<X, T>
			: never
		: S

/** A relation or a candidate key in key position, spelled. */
type KeyRefSpelled<K, Rs, To extends Spelling> =
	K extends Key<infer S>
		? SideSpelled<S, Rs, To> extends infer X
			? Key<X>
			: never
		: Spelled<K, Rs, To>

type FinSpelled<Fi, Rs, To extends Spelling> =
	Fi extends Fin<infer O, infer N extends string>
		? Spelled<O, Rs, To> extends infer X
			? Fin<X, N>
			: never
		: Fi

type FamilySpelled<Fa, Rs, To extends Spelling> =
	Fa extends Ordered<infer F, infer Fi>
		? [SideSpelled<F, Rs, To>, FinSpelled<Fi, Rs, To>] extends [infer A, infer B]
			? Ordered<A, B>
			: never
		: Fa extends Counted<infer F, infer Fi>
			? [SideSpelled<F, Rs, To>, FinSpelled<Fi, Rs, To>] extends [infer A, infer B]
				? Counted<A, B>
				: never
			: Fa extends Tree<infer F, infer Fi, infer Root extends string>
				? [SideSpelled<F, Rs, To>, FinSpelled<Fi, Rs, To>] extends [infer A, infer B]
					? Tree<A, B, Root>
					: never
				: Fa

/**
 * One statement spelled, each relation it names in place: an alternatives law keeps its arm map as written, the
 * caller's own object-literal type, which the checker instantiates as one type without walking its arms. Every
 * statement is built by an `infer` binding, so no spelled statement is a type reference the checker defers.
 */
type StatementSpelled<St, Rs, To extends Spelling> =
	St extends Key<infer S>
		? SideSpelled<S, Rs, To> extends infer X
			? Key<X>
			: never
		: St extends Mutable<infer R>
			? Spelled<R, Rs, To> extends infer X
				? Mutable<X>
				: never
			: St extends Race<infer R>
				? Spelled<R, Rs, To> extends infer X
					? Race<X>
					: never
				: St extends Check<infer N extends string, infer R>
					? Spelled<R, Rs, To> extends infer X
						? Check<N, X>
						: never
					: St extends Containment<infer L, infer R>
						? [SideSpelled<L, Rs, To>, SideSpelled<R, Rs, To>] extends [infer A, infer B]
							? Containment<A, B>
							: never
						: St extends Mirrors<infer L, infer R>
							? [SideSpelled<L, Rs, To>, SideSpelled<R, Rs, To>] extends [infer A, infer B]
								? Mirrors<A, B>
								: never
							: St extends Alternatives<infer P, infer D extends string, infer C, infer Arms>
								? [KeyRefSpelled<P, Rs, To>, Spelled<C, Rs, To>] extends [infer A, infer B]
									? Alternatives<A, D, B, Arms>
									: never
								: St extends Fold<infer Fa, infer M, infer S, infer E>
									? [
											FamilySpelled<Fa, Rs, To>,
											SideSpelled<S, Rs, To>,
											SideSpelled<E, Rs, To>
										] extends [infer A, infer B, infer C]
										? Fold<A, M, B, C>
										: never
									: FamilySpelled<St, Rs, To>

/** Statements by name: each relation of the record a statement names spelled as its name. */
export type StatementsByName<Statements, Relations> = {
	readonly [I in keyof Statements]: StatementSpelled<Statements[I], Relations, "name">
}

/** Statements by name read back whole: each name spelled as the record's relation under it. */
type StatementsFromNames<Named, Relations> = {
	readonly [I in keyof Named]: StatementSpelled<Named[I], Relations, "relation">
}

/**
 * The statements schema(…) and schema.extend(…) admit: those that read back from their names as themselves, which
 * every tuple of statements does, so a builder holds its statements at the type the schema reads them back at.
 */
export type StatementsReadBack<Statements, Relations> = StatementsFromNames<
	StatementsByName<Statements, Relations>,
	Relations
>

/**
 * Any schema: the members every one has. Every Schema whose relations are a record of relations is one. A role is no
 * schema (world.ts AnyRole): it is defined over one, so what takes a schema (role, login, schema.extend, lawsOf) never
 * takes a role, and what reads a schema or a role (query, ChangeSet.empty, workload) names both.
 */
export interface AnySchema extends Built {
	readonly kind: "schema"
	readonly name: string
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>>
	readonly statements: ReadonlyArray<Statement>
}

/** A derived relation whose definition is a query over one of the levels L. */
export type DerivedAt<L> = L extends unknown
	? Derived<string, QueryOver<L> & Headed<Carriers>>
	: never

/**
 * The relations a statement names: the relation of a mutable, a race or a check; the source of each law side (a selection's
 * relation), a key's, a family's, a tree's and a fold's included; a family's and a tree's owner; and an alternatives
 * law's parent, roster and arms.
 */
type SideNames<X> = X extends Side<infer Src> ? SideRelation<Src> : never
export type NamedBy<St> =
	St extends Key<infer S>
		? SideNames<S>
		: St extends Mutable<infer R>
			? R
			: St extends Race<infer R>
				? R
				: St extends Check<string, infer R>
					? R
					: St extends Containment<infer L, infer R>
						? SideNames<L> | SideNames<R>
						: St extends Mirrors<infer L, infer R>
							? SideNames<L> | SideNames<R>
							: St extends Alternatives<infer P, string, infer C, infer Arms>
								? RelationOfKey<P> | C | RelationOfKey<Exclude<Arms[keyof Arms], undefined>>
								: St extends Ordered<infer F, infer Fi> | Counted<infer F, infer Fi>
									? SideNames<F> | OwnerOf<Fi>
									: St extends Tree<infer F, infer Fi, string>
										? SideNames<F> | OwnerOf<Fi>
										: St extends Fold<unknown, unknown, infer S, infer E>
											? SideNames<S> | SideNames<E>
											: never

/** The owner a family's slots count over. */
type OwnerOf<Fi> = Fi extends Fin<infer O, string> ? O : never

/**
 * Whether every relation of the union U is R itself: false where some is another relation, true where U is R, and
 * true where U is copies of R the checker keeps apart, as one name's relations in Declared are. Identical compares
 * a union with a relation false by its kind alone, so U is compared member by member.
 */
type SameAs<U, R> = U extends unknown ? Identical<U, R> : never

/**
 * Whether a record's keys are names the type knows: false for a record with an index signature, which a list holding
 * a relation of a name the type does not know as one literal makes (Declared), as a record typed
 * `Record<string, R>` is.
 */
type KnownNames<Relations> = string extends keyof Relations ? false : true

/**
 * The relations a statement names that are not the record's relation of their name: one the record holds under no
 * key, and one whose name the record holds only other relations under, which a statement would name by that name
 * alone (ir/desc.ts SideDesc). A relation is the record's where it is one of the relations under its name: the list
 * refuses two of one name differing (DeclaredOnce), so several there are copies, or the relations one element chosen
 * at run time may be. Over a record whose names the type does not know, a relation is the record's where it is one of
 * its relations. A relation whose name the type does not know (a widened arm of alternatives, a side over AnySide, a
 * statement list typed ReadonlyArray<Statement>) is not refused here; the run time checks it.
 */
type Undeclared<Relations, R> = R extends unknown
	? IsOneLiteral<NameOf<R>> extends false
		? never
		: KnownNames<Relations> extends false
			? [R] extends [Relations[keyof Relations]]
				? never
				: R
			: true extends SameAs<UnderName<Relations, NameOf<R>>, R>
				? never
				: R
	: never

/**
 * Every statement is typed (MembersTyped), and every relation it names is the schema's relation of its name, at some
 * level (the run time's refusals at the schema's build: "a statement names a relation no level of the schema
 * declares", and DuplicateIdentity for another relation of a declared name, as one type error). A statement typed
 * `any` names whatever its reader asks, so it is refused before the relations it names are read.
 */
export type StatementsWithin<Statements extends ReadonlyArray<Statement>, Relations> = 0 extends 1 &
	Statements[number]
	? Refusal<"a member typed any, which every check admits: type each member of the list or record">
	: [Undeclared<Relations, NamedBy<Statements[number]>>] extends [never]
		? unknown
		: Refusal<"a statement names a relation no level of the schema declares">

/**
 * A level's relations by name, from the list its call writes: each relation under its own name, and the relations
 * of one name in one union there, which DeclaredOnce refuses unless they are one relation. Its keys are the level's
 * names, so a lookup by name is one property read.
 */
export type Declared<Relations extends ReadonlyArray<unknown>> = DeclaredIn<
	Listed<Relations[number]>
>

/**
 * The relations of the union R by name; where some relation's name is no one literal the type knows, every relation
 * of R under any name, as a record typed `Record<string, R>` holds them.
 */
type DeclaredIn<R> = true extends (
	R extends unknown ? (IsOneLiteral<NameOf<R>> extends true ? false : true) : never
)
	? { readonly [name: string]: R }
	: { readonly [X in R as NameOf<X>]: X }

/**
 * Each element of a list, boxed: a tuple's elements one by one, each as its call wrote it (a relation chosen at run
 * time among several of one name is one element), and an array's possible elements, each relation of its element
 * type, any two of which it may hold. A fragment's relations are each an element of their own (Boxed).
 */
type Elements<Relations extends ReadonlyArray<unknown>> = number extends Relations["length"]
	? Listed<Relations[number]> extends infer R
		? R extends unknown
			? readonly [R]
			: never
		: never
	: { readonly [I in keyof Relations]: Boxed<Relations[I]> }[number]

/** A tuple's element boxed: a fragment, each of its relations boxed apart; any other element, itself whole. */
type Boxed<X> = [X] extends [AnyFragment]
	? Listed<X> extends infer R
		? R extends unknown
			? readonly [R]
			: never
		: never
	: readonly [X]

/**
 * The name of R where `Named`, the relations of a list or a level below under R's name, holds another relation: R's
 * name where they are not R, or copies of R, or the one element R itself is.
 */
type ClashOf<R, Named> = [Named] extends [never]
	? never
	: Identical<Named, R> extends true
		? never
		: false extends SameAs<Named, R>
			? NameOf<R>
			: never

/**
 * The names the list's relations declare, each with another relation of its name in the list or among the relations
 * below it: two declarations of one name differing. A relation whose name the type does not know as one literal, and
 * a list or base whose record holds such a name, pass here; the run time checks them.
 */
type Clashing<Relations extends ReadonlyArray<unknown>, Below> =
	Elements<Relations> extends infer B
		? B extends readonly [infer R]
			? IsOneLiteral<NameOf<R>> extends false
				? never
				:
						| (KnownNames<Declared<Relations>> extends true
								? ClashOf<R, UnderName<Declared<Relations>, NameOf<R>>>
								: never)
						| (KnownNames<Below> extends true ? ClashOf<R, UnderName<Below, NameOf<R>>> : never)
			: never
		: never

/**
 * A level's list of relations, each name declared once (the run time's DuplicateIdentity, as a type error): a
 * relation is refused where another relation of its name is in the list or, for an extension, at a level below
 * (`Below`, the base's relations). One relation listed twice, or copies of one relation, declare it once. Every
 * relation of a clashing name carries the refusal, so each side of the clash is named; a list with no clash is checked
 * as itself, so a list spreading an array of relations keeps its inferred tuple. A relation typed `any` states no name
 * and passes every reader of the list, so it is refused (MembersTyped).
 */
export type DeclaredOnce<
	Relations extends ReadonlyArray<unknown>,
	Below = never
> = MembersTyped<Relations> &
	([Clashing<Relations, Below>] extends [never]
		? unknown
		: {
				readonly [I in keyof Relations]: [
					NameOf<Listed<Relations[I]>> & Clashing<Relations, Below>
				] extends [never]
					? unknown
					: Refusal<"two relations of one name across a schema's levels">
			})

/**
 * An extension's record: the base's relations, then each relation of the level's list the base does not hold under
 * its name, so a name the level declares again, as the base declares it, is the base's relation alone.
 */
export type DeclaredOver<BaseRelations, Relations extends ReadonlyArray<unknown>> = BaseRelations &
	(KnownNames<BaseRelations> extends false
		? Declared<Relations>
		: DeclaredIn<Exclude<Listed<Relations[number]>, { readonly name: keyof BaseRelations }>>)

/**
 * S, every schema below it, and every fragment one of them lists (FragmentsOf). A query over any of them is a query
 * over S. The recursion is as deep as the extension chain, never over relations or statements.
 */
export type LevelsOf<S> =
	| S
	| FragmentsOf<S>
	| (S extends Phantom<{ readonly extends: infer B }>
			? [B] extends [never]
				? never
				: LevelsOf<B>
			: never)

/**
 * The fragments that are levels of S itself: a schema's, those its list holds; a role's, those of its base's levels it
 * holds whole (types/schema/world.ts Role); none for anything else.
 */
export type FragmentsOf<S> = S extends Phantom<{ readonly fragments: infer F }> ? F : never

/** The fragments every level of a schema lists, the levels below it included. */
export type AllFragmentsOf<S> =
	| FragmentsOf<S>
	| (S extends Phantom<{ readonly extends: infer B }>
			? [B] extends [never]
				? never
				: AllFragmentsOf<B>
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
 * What a record of relations holds under the name N, none where it holds nothing of that name. A schema's record and
 * a role's hold each relation under its own name (Declared, EntriesCheck), so a relation is found by its name in
 * one property read, never in a pass over the record's values.
 */
export type UnderName<Rs, N> = N extends keyof Rs ? Rs[N] : never

/**
 * Whether R is a relation, closed relation or derived relation of S; any schema admits every relation. S's record
 * holds each relation under its own name (Declared), so R is S's relation of its name exactly when it is one of
 * RelationOf<S>, the union the checker builds once per schema.
 */
export type IsRelationOf<S, R> = 0 extends 1 & S ? true : [R] extends [RelationOf<S>] ? true : false

export type StatementsOf<S> = S extends {
	readonly statements: infer St extends ReadonlyArray<Statement>
}
	? St
	: never
type StatementOf<S> = StatementsOf<S>[number]

/**
 * The keys of R in S: its primary key, a roster's handle and a closed relation's declared key, the keys a derived or
 * world relation's definition proves, and every candidate key declared for R with key(), for each relation its name
 * may be where it is a generic relation's union of names (DeclaredKeysOfAll). Each key is a list of field names. A
 * context holds at most one fact, so its key is the empty one.
 */
export type KeysOf<S, R> = R extends { readonly kind: "context" }
	? readonly []
	:
			| (R extends { readonly primaryKey: infer P }
					? P
					: R extends AnyRoster
						? readonly ["id"]
						: R extends AnyClosedRelation
							? R["key"]
							: R extends { readonly kind: "derived" | "world"; readonly definition: infer Q }
								? DefinitionKeysOf<Q>
								: never)
			| DeclaredKeysOfAll<S, NameOf<R>>

/**
 * The candidate keys of every relation of S, each relation's under its name and none under any other name. Relation
 * names are unique within a schema, so the name identifies the relation. The index is built once per schema, in one
 * pass over its key sides, each placed under its relation's name, so reading one relation's keys is a property read: no
 * read passes over the statement tuple, and no read takes the index's keys (`keyof`), which a remapped index computes
 * again at every read.
 */
type KeyIndexOf<S> = {
	readonly [K in KeySideOf<StatementOf<S>> as NameOf<SourceOf<K>>]: TermsOf<K>
} & { readonly [name: string]: never }

/**
 * The candidate keys declared for every relation of S named in N: a generic relation's, whose name is the union of its
 * relations' names, are the keys each of them holds; a relation's, its own. Each name's keys are one property read of
 * the index, which holds a value under every name (ByName), so no read asks whether a name is among its keys.
 */
export type DeclaredKeysOfAll<S, N extends string> = HeldByAll<N, KeyIndexOf<S>[N], KeyIndexOf<S>>
type HeldByAll<N extends string, T, I extends ByName> = T extends unknown
	? [N] extends [HoldersOf<N, T, I>]
		? T
		: never
	: never
type HoldersOf<N extends string, T, I extends ByName> = N extends unknown
	? [T] extends [I[N]]
		? N
		: never
	: never

/** An index by name that holds a value under every name, as KeyIndexOf holds none, `never`, under a name it keys none of. */
interface ByName {
	readonly [name: string]: unknown
}

type SourceOf<X> = X extends Side<infer R> ? R : never
type TermsOf<X> = X extends Side<unknown, infer T> ? T : never

/**
 * The side of every candidate key a statement declares: a key statement's, an ordered family's (its group and index),
 * and a tree's document order, (root, start). A counted family's index is in no heading, and a tree's (parent, at) is
 * a key of its members alone, so neither is a key of the relation.
 */
type KeySideOf<St> =
	St extends CandidateKey<AnyRelation>
		? St["side"]
		: St extends Ordered<infer F, AnyFin>
			? F
			: St extends Tree<Side<infer T>, AnyFin, infer Root>
				? Side<T, readonly [Root, "start"]>
				: never

/** The proved keys a query's evidence carries. */
type DefinitionKeysOf<Q> =
	Q extends Phantom<{ readonly evidence: { readonly keys: infer Ks } }>
		? Ks extends ReadonlyArray<infer K extends ReadonlyArray<string>>
			? MinimalKeys<K>
			: never
		: never

/**
 * The minimal keys among a union of keys K, as a derived relation's analysis lists them: each key no other key's
 * fields lie strictly within. The whole heading a definition's evidence states, a set's own key, is one only where no
 * fewer fields are. Quadratic in the keys, which a definition states a few of.
 */
type MinimalKeys<K> = MinimalAmong<K, K>

/** Each key of Each that no key of All lies strictly within. */
type MinimalAmong<Each, All> =
	Each extends ReadonlyArray<infer F> ? (true extends StrictlyWithin<All, F> ? never : Each) : never

/** Whether some key of Ks has fields strictly within F: all of its fields among F's, and not all of F's among its. */
type StrictlyWithin<Ks, F> =
	Ks extends ReadonlyArray<infer G>
		? [G] extends [F]
			? [F] extends [G]
				? false
				: true
			: false
		: never

/** A law read without its sugar: a mirrors as the two containments it is, any other law as itself. */
type Desugared<L> = L extends MirrorsBase
	? L extends Mirrors<infer A, infer B>
		? Containment<A, B> | Containment<B, A>
		: never
	: L

/**
 * The laws of S: its statements, each alternatives law read as the statements it expands to, and each mirrors, its
 * own or an alternatives arm's, as its two containments.
 */
export type LawsOf<S> =
	StatementOf<S> extends infer St
		? Desugared<St extends AlternativesBase ? ExpansionOf<St> : St>
		: never
export type ContainmentsOf<S> = Extract<LawsOf<S>, Containment<unknown, unknown>>
