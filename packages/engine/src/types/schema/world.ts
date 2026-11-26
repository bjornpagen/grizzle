import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, Phantom, phantom } from "#compiler/core/phantom.ts"
import type { ContextFactSource, ContextFactSourceKind } from "#compiler/ir/desc.ts"
import type {
	Carriers,
	Headed,
	Invariant,
	Origin,
	PhantomOf,
	Refusal,
	Repeats
} from "#compiler/types/core/phantom.ts"
import type { AnyWorkload, Workload } from "#compiler/types/db/workload.ts"
import type {
	AnyDerived,
	DefinitionQuery,
	DefinitionShape
} from "#compiler/types/derived/derived.ts"
import type { Field, NoWriting, UnwrittenField } from "#compiler/types/fields/field.ts"
import type { ContextsOf, QueryBase } from "#compiler/types/query/query.ts"
import type {
	AnyClosed,
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	FactOfFields,
	NameOf
} from "#compiler/types/schema/relation.ts"

import type {
	AllFragmentsOf,
	AnyFragment,
	AnySchema,
	BelowOf,
	IsLevelOf,
	IsLevelOfInvariant,
	IsRelationOf,
	MutableNameOf,
	NamedBy,
	RelationsOf,
	StatementsOf,
	least,
	UnderName
} from "#compiler/types/schema/schema.ts"
import type { Mutable, Statement } from "#compiler/types/schema/statements.ts"

/**
 * A context field: text, uuid, boolean, an integer type, inet, cidr, a contract over one of them, or a closed handle;
 * never a field of a writing of its own.
 */
export type ContextField = Field<
	unknown,
	"text" | "uuid" | "boolean" | "smallint" | "integer" | "bigint" | "inet" | "cidr" | "code"
> &
	NoWriting

/**
 * Any context: the members every one has. `source` is where its one fact comes from (ir/desc.ts ContextFactSource): a
 * token's claims, read from the verified payload's top level or the nested claim object `claim` names, or the facts its
 * server attests.
 */
export interface AnyContext extends Built {
	readonly kind: "context"
	readonly name: string
	readonly fields: unknown
	readonly source: ContextFactSource
	readonly fact: RowDecoder<unknown>
}

/** A context's source of kind S, as its value states it. */
export type SourceOf<S extends ContextFactSourceKind> = Extract<
	ContextFactSource,
	{ readonly kind: S }
>

/**
 * A context named Name over its fields, of source S: its heading is the fields, the carriers v mints variables over,
 * and `fact` decodes its one fact. Its fields are a phantom too, as a derived relation's are, so no reader takes it for
 * a source of unknown heading. context(...) makes one of a token's claims, attested(...) one its server attests.
 */
export interface Context<Name extends string, Fields, S extends ContextFactSourceKind = "token">
	extends AnyContext, Phantom<{ readonly fields: Fields }> {
	readonly kind: "context"
	readonly name: Name
	readonly fields: Fields
	readonly source: SourceOf<S>
	readonly heading: Fields
	readonly fact: RowDecoder<FactOfFields<Fields>>
}

/**
 * The arguments after a context's fields: none, or its options, `claim` naming the nested claim object its fields are
 * read from.
 */
export type ContextOptions = readonly [] | readonly [options: { readonly claim: string }]

/** Any world relation: the members every one has. */
export interface AnyWorld extends Built, Headed<Carriers> {
	readonly kind: "world"
	readonly name: string
	readonly definition: QueryBase
	readonly fact: RowDecoder<unknown>
}

/**
 * Worlds: contexts, roles and logins. The builders context, role and login are the typed schema facade's
 * (schema/api.ts), written under these types over the admission cores of packages/engine/src/schema/world.ts: their argument
 * checks (EntriesCheck, RolesOver) and their values (Context, Role, Login) are declared here.
 *
 * - A context is the session's relation parameters: a source of at most one fact, bound once per Db from the verified
 *   token's claims, or from the facts its server attests where it opens the Db. Its fields are scalar types
 *   (ContextField). It belongs to no schema, so a rule of any query over
 *   any schema matches it; no law takes it and no ChangeSet writes it.
 * - A role is relations defined over its base, a schema, and is no schema itself. A whole entry is a relation of the
 *   base, itself, under its own name; a query entry is a world relation (World), a query over the base installed as a
 *   plain view, whose fields are its definition's heading and whose keys are those its definition's evidence proves,
 *   as a derived relation's are. The role keeps the base's laws among its whole entries. A role holding every relation
 *   of its base whole is a full role: its base is among its levels (LevelsOf), so programs over the base run on it;
 *   its entries are wholeEntriesOf(base) (WholeEntriesOf). `insert` names the role relations it only adds to and
 *   `write` the open ones it changes, each relation once between them (DistinctWrites), every one it may write whole
 *   being writableNamesOf(base) (WritableNameOf), which wholeWritesOf(base) splits by how the base declares each
 *   (WholeWritesOf).
 * - A login is one credential and one pool for roles over one base. DbLayer.make takes one; Db.open opens a role of
 *   the layer's login.
 *
 * Which contexts a role declares is a phantom, the names of its options' `contexts` (DeclaredContexts), the only ones
 * its query entries' definitions (EntriesCheck) and its programs (WithinRoleContexts) match, and the contexts
 * themselves (`declared`), so Db.open requires a token exactly when a role declares a token's context (ReadsToken) and
 * the attested facts exactly when it declares an attested one (ReadsAttested), and DbLayer.make a verify exactly when a
 * role of its login declares a token's.
 *
 * A role's query entry under its name. Its fields are a phantom, its definition's heading, which RelationFieldsOf
 * reads; the heading is a real member too, which v mints variables over, and `fact` decodes the facts of that heading.
 */
export interface World<Name extends string, Q extends DefinitionQuery>
	extends AnyWorld, Phantom<{ readonly fields: Q["heading"] }> {
	readonly kind: "world"
	readonly name: Name
	readonly definition: Q
	readonly heading: Q["heading"]
	readonly fact: RowDecoder<FactOfFields<Q["heading"]>>
}

/**
 * The head fields of a world relation W that its definition takes from a field of the base that its caller does not
 * write (types/fields UnwrittenField): a write through the entry never supplies them, as a write of the base never does.
 */
export type WorldUnwrittenFields<W> = W extends {
	readonly heading: infer H
	readonly definition: Phantom<{ readonly schema: Invariant<infer S> }>
}
	? { [K in keyof H]-?: UnwrittenOrigin<S, H[K]> extends true ? K : never }[keyof H]
	: never

type UnwrittenOrigin<S, T> =
	T extends Phantom<{ readonly origin: Origin<infer N, infer F> }>
		? UnderName<RelationsOf<S>, N> extends { readonly fields: infer Fs }
			? F extends keyof Fs
				? Fs[F] extends UnwrittenField
					? true
					: false
				: false
			: false
		: false

/**
 * Any scoped entry: the members every one has. scopedEntriesOf makes it, its relation's rows of one owner under the
 * relation's own name (schema/scope.ts Scope).
 */
export interface AnyScoped extends Built {
	readonly kind: "scope"
	readonly name: string
	readonly relation: AnyRelation
}

/**
 * A scoped entry of R: R under its own name and with its whole heading, its rows those of one owner. A role holding it
 * holds R (RoleRelations), so the base's programs over R run on the role, each over the owner's rows.
 */
export interface Scoped<R extends AnyRelation> extends AnyScoped {
	readonly name: NameOf<R>
	readonly relation: R
}

/**
 * What a role's relation record holds: a relation of the base, whole; a scoped entry of one; or a query over the base,
 * a query entry.
 */
export type EntryValue = AnyRelation | AnyRoster | AnyDerived | AnyScoped | DefinitionQuery

/**
 * The role relations an entry record makes: a whole entry is the base relation itself, and so is a scoped entry, its
 * relation; a query entry is the world relation of its key.
 */
export type RoleRelations<Rs> = {
	readonly [K in keyof Rs]: Rs[K] extends AnyRelation | AnyRoster | AnyDerived
		? Rs[K]
		: Rs[K] extends AnyScoped | AnyRelation | AnyDerived
			? HeldRelationOf<Rs[K]>
			: Rs[K] extends DefinitionQuery
				? World<K & string, Rs[K]>
				: never
}

/** The relation a whole or scoped entry V holds, each member of a union its own: a scoped entry's relation, or V. */
type HeldRelationOf<V> = V extends AnyScoped ? V["relation"] : V

/**
 * A query entry's level phantom, read off its phantom by key (LevelPhantom): the empty level's is assignable to every
 * level's, so a query entry over it is a query entry over every base.
 */
type QueryLevelPhantom<Q> = PhantomOf<Q>["schema" & keyof PhantomOf<Q>]

/**
 * One entry, checked: a whole entry is a relation of the base under its own name; a query entry is over a level of the
 * base, admissible as a definition (one flat heading of at least one field, no parameter), and matches only the
 * contexts the role declares, Declared their names (EntryContextsWithin).
 */
type EntryCheck<Base, K, V, Declared> = V extends AnyDerived
	? Refusal<"a role holds no derived relation: it reads one through the relations its definition reads">
	: V extends AnyRelation | AnyRoster
		? IsRelationOf<Base, V> extends true
			? [K] extends [NameOf<V>]
				? unknown
				: Refusal<"a whole entry is a relation of the base under its own name">
			: Refusal<"a whole entry is a relation of the base under its own name">
		: V extends AnyScoped
			? IsRelationOf<Base, V["relation"]> extends true
				? [K] extends [NameOf<V["relation"]>]
					? unknown
					: Refusal<"a scoped entry is a relation of the base under its own name">
				: Refusal<"a scoped entry is a relation of the base under its own name">
			: IsLevelOfInvariant<Base, QueryLevelPhantom<V>> extends true
				? DefinitionShape<V> & EntryContextsWithin<ContextsOf<V>, Declared>
				: Refusal<"a query entry is a query over the role's base">
export type EntriesCheck<Base, Rs, Declared = never> = {
	readonly [K in keyof Rs]: EntryCheck<Base, K, Rs[K], Declared>
}

/**
 * A query entry's contexts Cx within the names of the contexts its role declares: a Db of the role holds facts of
 * those alone, and role(...) refuses any other at run time too (RoleRefused entryContext).
 */
type EntryContextsWithin<Cx, Declared> = [Cx] extends [Declared]
	? unknown
	: Refusal<"a role's query entry matches only the contexts the role declares">

/** The names of the contexts a role declares, its options' `contexts`: never for none. */
export type DeclaredContexts<C> = C extends ReadonlyArray<infer X> ? NameOf<X> : never

/**
 * The entries a role may write: whole ordinary relations, scoped entries of them, and query entries; a key whose entry
 * may be any of several values (scopedEntriesOf's, or a record of unknown entries) where one of them is one, role(...)
 * refusing the others when it is built (RoleRefused writeKind, writeUnwritable).
 */
export type WritableKeys<Rs> = {
	[K in keyof Rs]-?: true extends WritableValue<Rs[K]> ? K : never
}[keyof Rs] &
	string

/** Whether a role may write an entry value V, each member of a union its own (WritableKeys). */
type WritableValue<V> = V extends AnyRelation
	? true
	: V extends AnyScoped
		? V["relation"] extends AnyRelation
			? true
			: false
		: V extends AnyRoster | AnyDerived
			? false
			: true

/**
 * The relations no role holds: a closed relation, whose rows are its constants and which every role reads, and a
 * derived relation, which a role reads through the relations its definition reads, from its stored table where the role
 * holds every one of them whole (analysis/schema.ts CheckedSchema). The one definition a full role's entries
 * (WholeEntries) and the levels a role holds whole (UnheldOf) both read.
 */
type UnheldRelation = AnyClosedRelation | AnyDerived

/**
 * A full role's entries over a schema's record of relations: each relation under its own key, whole, but the relations
 * no role holds (UnheldRelation). One key per relation, kept or dropped by its own type alone, so a record of n
 * relations costs n conditionals and an unheld relation can never stand among the entries.
 *
 * The kept keys are computed once (HeldKeys) and the record is mapped over them, never filtered by an `as` clause: the
 * checker re-instantiates a mapped type's `as` clause over its whole key set each time it reads one of its properties
 * (tsgo isGenericMappedType), so a record of n relations read at each of its n keys would cost n² conditionals. The
 * keys are the record's text keys alone: a record of unknown names, `{ readonly [name: string]: R }`, has `number` among
 * its keys too, and mapped over them would hold a number index beside its text one.
 */
export type WholeEntries<Rs> = HeldEntries<Rs, HeldKeys<Rs> & string>

/** The keys of a record whose relation a role may hold whole: every key but those of the relations no role holds. */
type HeldKeys<Rs> = { [K in keyof Rs]-?: Rs[K] extends UnheldRelation ? never : K }[keyof Rs]

/** The record Rs at its keys K, each read-only, and optional where Rs states it optional (K is a key of Rs). */
type HeldEntries<Rs, K extends keyof Rs> = { readonly [P in K]: Rs[P] }

/**
 * The entries of a full role over Base (wholeEntriesOf): every relation of every level of the base, under its own name,
 * whole, but the relations no role holds (UnheldRelation). A role holding them holds every relation of its base whole,
 * so its base is among its levels (FullBaseOf).
 */
export type WholeEntriesOf<Base extends AnySchema> = WholeEntries<Base["relations"]>

/**
 * The entries scopedEntriesOf(base, options) makes: every relation of every level of the base under its own name, as
 * WholeEntriesOf, each ordinary one whole or scoped (ScopedOrWhole), which of the two its
 * options and the base's declared containments decide when it runs. A role holding them holds every relation of its
 * base, each whole or scoped, so its base is among its levels (FullBaseOf).
 */
export type ScopedEntriesOf<Base extends AnySchema> = ScopedEntries<Base["relations"]>

/** The record Rs at its held keys (HeldKeys), each relation whole or scoped (ScopedOrWhole). */
export type ScopedEntries<Rs> = { readonly [P in HeldKeys<Rs> & string]: ScopedOrWhole<Rs[P]> }

/** A relation R as scopedEntriesOf holds it: an ordinary one whole or scoped, any other whole. */
export type ScopedOrWhole<R> = R extends AnyRelation ? R | Scoped<R> : R

/** The relations of a schema scopedEntriesOf may root, by name: its ordinary ones. */
export type ScopableNameOf<Base extends AnySchema> = {
	[K in keyof Base["relations"]]-?: Base["relations"][K] extends AnyRelation ? K : never
}[keyof Base["relations"]] &
	string

/**
 * scopedEntriesOf's options: `owner`, a query over a level of the base of one field reading the role's contexts and the
 * rows they determine by a key (schema/scope.ts ownerOf); `roots`, each relation stated a root by one of its fields,
 * whose rows are those whose field the owner holds.
 */
export interface ScopeOptions<Base extends AnySchema> {
	readonly owner: DefinitionQuery
	readonly roots: { readonly [K in ScopableNameOf<Base>]?: HeadingNameOf<Base["relations"][K]> }
}

/** The names of a relation's fields, its heading's. */
type HeadingNameOf<R> = R extends { readonly heading: infer H } ? keyof H & string : never

/**
 * The names a role over Base writes when it writes every whole entry it may (writableNamesOf): the base's ordinary
 * relations, every level's, which are WritableKeys of its full role's entries. A roster, a closed relation and a
 * derived relation are never among them.
 */
export type WritableNameOf<Base extends AnySchema> = WritableKeys<WholeEntriesOf<Base>>

/**
 * The options of a role over Base that writes every whole entry it may as the base declares its relation
 * (wholeWritesOf): `insert` the closed ones, whose facts are inserted and never changed or deleted, and `write` the open
 * ones, each declared mutable inside a unit, the two together WritableNameOf<Base>, each name once.
 */
export interface WholeWritesOf<Base extends AnySchema> {
	readonly insert: ReadonlyArray<Exclude<WritableNameOf<Base>, MutableNameOf<Base>>>
	readonly write: ReadonlyArray<Extract<WritableNameOf<Base>, MutableNameOf<Base>>>
}

/**
 * The highest level of a role's base it holds whole, every relation of that level and of every level below it under its
 * own name: then that level, and every level below it, is among the role's levels; never when it holds not every
 * relation of the base's root whole. A relation no role holds (UnheldRelation) is no entry, so a role holds every
 * relation but those. A level's record holds each relation under its own name too (Declared), so
 * each is read against the role's entry of its key alone. The walk is as deep as the extension chain.
 *
 * The keys the role does not hold at a level are a parameter of their own (FullBaseAt): a tuple of UnheldOf in this
 * body would be a reference the checker defers, holding the base and the role's record in its mapper, so deciding it
 * would instantiate both whole, every derived relation and the base below it with them. The level below is read off
 * the base's phantom by key (BelowOf), never bound by `infer` and read again, which instantiates it whole too.
 */
type FullBaseOf<Base, Relations> = FullBaseAt<
	Base,
	UnheldOf<RelationsOf<Base>, Relations>,
	Relations
>

/** Base, where the role holds every relation of it (Unheld, the keys it does not hold, is none); else a level below. */
type FullBaseAt<Base, Unheld, Relations> = [Unheld] extends [never]
	? Base
	: FullBaseBelow<BelowOf<Base>, Relations>

/** FullBaseOf at the level below, none below a root schema, whose phantom states never: Below is distributed over. */
type FullBaseBelow<Below, Relations> = Below extends unknown ? FullBaseOf<Below, Relations> : never

/**
 * The fragments a role over Base holds whole: each fragment a level of the base lists whose every relation the role
 * holds whole under its own name but the relations no role holds (UnheldOf), so programs over it run on the role.
 */
type HeldFragments<Base, Relations> =
	AllFragmentsOf<Base> extends infer F
		? F extends unknown
			? [UnheldOf<RelationsOf<F>, Relations>] extends [never]
				? F
				: never
			: never
		: never

/**
 * The keys of a base's record whose relation the role does not hold whole under that key, the relations no role holds
 * (UnheldRelation) aside. Each relation is read against the role's entry of its key alone (UnheldAt).
 */
type UnheldOf<BaseRelations, Relations> = {
	[K in keyof BaseRelations]-?: UnheldAt<BaseRelations[K], UnderName<Relations, K>, K>
}[keyof BaseRelations]

/**
 * K, where its relation R, each relation of R where its key holds several, is neither a relation no role holds nor
 * the role's entry E under K; never otherwise. R is tested naked, against UnheldRelation and then against E, each a
 * parameter: the checker walks a relation once for a naked test, keeps the walk on the relation and shares it with
 * every naked test of it, where a tuple of it, or of a union holding the entry, is walked again for each key, a
 * derived relation's definition and the base below it with it.
 */
type UnheldAt<R, E, K> = R extends UnheldRelation ? never : R extends E ? never : K

/**
 * The statements of the union St whose every relation is the role's entry under its name, each statement read on its
 * own: the relations it names (NamedBy, read by key), each read against the entry its name keys in the role's record
 * (HeldEach), one property read. A statement is never tested whole, nor as a tuple of the relations it names against
 * the union of the role's entries: a tuple of NamedBy is a reference the checker defers, holding the statement in its
 * mapper, and deciding it instantiates the statement whole, the derived relations it names and the base below them
 * with it, for each statement of each role.
 */
type KeptIn<St, Relations> = St extends unknown
	? KeptWhere<St, HeldEach<NamedBy<St>, Relations>>
	: never

/** St, where H, whether the role holds each relation it names, holds no false; a statement naming none is kept. */
type KeptWhere<St, H> = false extends H ? never : St

/**
 * Whether the role holds each relation of R whole, each its own: true where the relation is the role's entry under its
 * name, read by key and tested naked, as UnheldAt tests it, so the checker's walk of the relation is the one it keeps
 * and shares; false otherwise, and for a relation whose name is no key of the record. A relation typed `any` or
 * `unknown` (NamedBy's for a side typed `any`), to which unknown is assignable, names no entry: it is tested against
 * the record's values, as every relation was before, `any` held wherever the record holds one and `unknown` nowhere.
 */
type HeldEach<R, Relations> = R extends unknown
	? R extends UnderName<Relations, NameOf<R>>
		? true
		: unknown extends R
			? AmongEntries<R, Relations[keyof Relations]>
			: false
	: never

/** Whether R is among the entries E. */
type AmongEntries<R, E> = [R] extends [E] ? true : false

/**
 * The base's laws a role keeps: those whose every relation is one of the role's entries. A whole entry sits under its
 * own name (EntriesCheck) and no two relations of one name differ (DeclaredOnce), so a relation is among the entries
 * exactly when it is the entry under its name, the rule role(...) keeps a law by at run time (schema/world.ts: the
 * law's relation names, namesOf, each among the whole entries' names, `whole`).
 */
export type KeptStatements<Base, Relations> = KeptIn<StatementsOf<Base>[number], Relations>

/**
 * Any role: the members every one has. A role is no schema: it is relations defined over its base, a schema, and keeps
 * the base's laws among its whole entries, so its name, relations and statements are its own members, and no builder
 * that takes a schema takes it.
 */
export interface AnyRole extends Built {
	readonly kind: "role"
	readonly name: string
	readonly base: AnySchema
	readonly relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived | AnyWorld>>
	readonly statements: ReadonlyArray<Statement>
	readonly insert: ReadonlyArray<string>
	readonly write: ReadonlyArray<string>
}

/**
 * A role of which L is a level: the bound of a role parameter, for a program over L applied through whatever role over
 * L it is given, `<W extends RoleOver<typeof Level>>(role: W) => ChangeSet.over(role, program)`. It holds L's relations
 * whole under their names, as a full role over L or over a level above it does (WholeEntries), and states L as its least
 * level, the level a call of ChangeSet.over over the parameter checks the program's schema against (RoleLeastStated):
 * the one level the call knows. AnyRole is the weakest bound, which states none, so no program's schema is a level of a
 * parameter it bounds.
 */
export interface RoleOver<L extends AnySchema | AnyFragment> extends AnyRole {
	readonly relations: WholeEntries<L["relations"]>
	readonly [least]?: L | undefined
}

/**
 * What ChangeSet.over infers a role's least level Least from: the `least` member a role parameter's bound states
 * (RoleOver), which the parameter's type reads from its constraint. A built role states none, so Least is inferred from
 * none and stays never. `kind`, a member every role has, keeps it no weak type.
 */
export interface RoleLeastStated<Least> {
	readonly kind: "role"
	readonly [least]?: Least | undefined
}

/** A role's least level: the role itself where it states none, a built role; its bound's level where it is a parameter. */
export type RoleLeastOf<W, Least> = [Least] extends [never] ? W : Least

/**
 * A role over Base named Name: its relations, the base's laws it keeps, and its insert and write lists, as written. A
 * full role extends its base, and a role holds every fragment of its base it holds whole (the phantoms LevelsOf reads);
 * `contexts` is the union of the names of the contexts it declares.
 */
export interface Role<
	Base,
	Name extends string,
	Relations,
	Insert extends string,
	Write extends string,
	Contexts,
	Declared = never
> extends Phantom<{
	readonly extends: FullBaseOf<Base, Relations>
	readonly fragments: HeldFragments<Base, Relations>
	readonly contexts: Contexts
	readonly declared: Declared
}> {
	readonly kind: "role"
	readonly name: Name
	readonly base: Base
	readonly relations: Relations
	readonly statements: ReadonlyArray<KeptStatements<Base, Relations>>
	readonly insert: ReadonlyArray<Insert>
	readonly write: ReadonlyArray<Write>
}

/**
 * A role's insert and write lists name each role relation once, in one of them: a relation named twice is two entries
 * writing one relation, which role refuses at run time too (writeTwice). A repeat the lists' types do not show, at a
 * widened name, a union of names, or in a list of unknown length such as wholeWritesOf's, is role's to refuse at run
 * time.
 */
export type DistinctWrites<I extends ReadonlyArray<unknown>, W extends ReadonlyArray<unknown>> =
	Repeats<readonly [...I, ...W]> extends true
		? Refusal<"a role's insert and write lists name each role relation once, in one of them">
		: unknown

/**
 * A role's write list names open relations alone, as role refuses at run time too (writeClosed): a whole or scoped
 * entry of a relation no mutable statement of Base names is closed, its facts inserted and never changed or deleted,
 * so the insert list names it. A query entry's written relation is the writable-entry analysis's, which its type does
 * not show, and a base whose statements are generic, holding every Mutable, shows no relation closed: each is role's
 * to refuse at run time.
 */
export type WritesOpen<Base, Rs, W> =
	Mutable<unknown> extends StatementsOf<Base>[number]
		? unknown
		: [ClosedWritten<Rs, W, MutableNameOf<Base>>] extends [never]
			? unknown
			: Refusal<"a role's write list names open relations, each declared mutable inside a unit: its insert list names a closed one, whose facts are inserted, never changed or deleted">

/** The names among N of the entries of Rs whose written relation its type shows closed, none named in Open. */
type ClosedWritten<Rs, N, Open> = N extends keyof Rs
	? [Exclude<NameOf<WholeWritten<Rs[N]>>, Open>] extends [never]
		? never
		: N
	: never

/** The base relation an entry value writes, as its type shows it: a whole entry's own, a scoped entry's relation. */
type WholeWritten<V> = V extends AnyRelation ? V : V extends AnyScoped ? V["relation"] : never

/**
 * The arguments after a role's relations: none, or its options, `insert` naming the role relations it only adds to,
 * on each of which it holds INSERT and no DELETE or UPDATE, `write` naming the open ones it changes, each over a
 * relation declared mutable inside a unit, on which it holds INSERT, DELETE and UPDATE, the two naming each relation
 * once between them, and `contexts` the contexts it declares, the facts its Db's claims hold and the only ones its
 * query entries and programs match, each empty when left out.
 */
export type RoleOptions<I, W, C = ReadonlyArray<AnyContext>> =
	| readonly []
	| readonly [options: RoleOptionRecord<I, W, C>]
export type RoleOptionRecord<I, W, C = ReadonlyArray<AnyContext>> = {
	readonly insert?: I
	readonly write?: W
	readonly contexts?: C
}

/**
 * The contexts a role declares: never when it declares none, and unknown for a role whose type does not say (a role
 * widened to AnyRole, or typed `any`, whose keys are every string), which may declare any, so a token and a verify stay
 * required for it. They are read off the role's phantom by key, each role of a union its own, never by a match of
 * `Phantom<infer B>`, which binds the bundle, the role's base among its members, and instantiates it again, whole, in
 * the branch that reads it.
 */
export type ContextsReadBy<R> = R extends unknown
	? string extends keyof R
		? unknown
		: typeof phantom extends keyof R
			? ContextsStated<PhantomOf<R>>
			: unknown
	: never

/** The contexts a phantom bundle states, each bundle of a union its own: unknown for one that states none. */
type ContextsStated<B> = B extends unknown
	? "contexts" extends keyof B
		? B["contexts" & keyof B]
		: unknown
	: never

/**
 * The contexts a role declares, themselves (its options' `contexts`): never when it declares none, and unknown for a role
 * whose type does not say, read off its phantom as ContextsReadBy reads the names.
 */
type DeclaredReadBy<R> = R extends unknown
	? string extends keyof R
		? unknown
		: typeof phantom extends keyof R
			? DeclaredStated<PhantomOf<R>>
			: unknown
	: never

/** The contexts a phantom bundle declares, each bundle of a union its own: unknown for one that states none. */
type DeclaredStated<B> = B extends unknown
	? "declared" extends keyof B
		? B["declared" & keyof B]
		: unknown
	: never

/** The names of the contexts of a token's claims among Cs: unknown where Cs does not say which. */
type TokenNames<Cs> = unknown extends Cs
	? unknown
	: Cs extends { readonly source: { readonly kind: "token" } }
		? NameOf<Cs>
		: never

/** The contexts its server attests among Cs: unknown where Cs does not say which. */
type AttestedOfCs<Cs> = unknown extends Cs
	? unknown
	: Extract<Cs, { readonly source: { readonly kind: "attested" } }>

/**
 * Whether a role declares a context of a token's claims, the condition under which Db.open requires a token and
 * DbLayer.make a verify. The contexts are a parameter of their own (ReadsSome): a tuple of DeclaredReadBy here would be
 * a reference the checker defers, holding the role in its mapper, and deciding it would instantiate the role whole, its
 * base with it.
 */
export type ReadsToken<R> = ReadsSome<TokenNames<DeclaredReadBy<R>>>
type ReadsSome<C> = [C] extends [never] ? false : true

/**
 * Whether a role declares a context its server attests: `true`, the condition under which Db.open requires `attested`;
 * `false` where it declares none; and `unknown` for a role whose type does not say, which may declare one, so Db.open
 * takes `attested` without requiring it, a fact it leaves out being no fact, as a token without a claim holds none.
 */
export type ReadsAttested<R> =
	unknown extends AttestedOfCs<DeclaredReadBy<R>>
		? unknown
		: ReadsSome<AttestedOfCs<DeclaredReadBy<R>>>

/**
 * The facts a server attests for a Db of role R (Db.open's `attested`): under each attested context the role declares
 * its one fact, each field its host value, or none, where the server attests no fact of it, as a token without a
 * context's claim object holds no fact of it. A role whose type does not say states a record of any context's facts.
 */
export type AttestedFactsOf<R> = AttestedRecord<AttestedOfCs<DeclaredReadBy<R>>>

/** The record of the facts of the attested contexts Cs, by name. */
export type AttestedRecord<Cs> = unknown extends Cs
	? Readonly<Record<string, Readonly<Record<string, unknown>>>>
	: {
			readonly [
				C in Cs as C extends { readonly name: infer N extends string } ? N : never
			]?: C extends {
				readonly fact: RowDecoder<infer F>
			}
				? F
				: never
		}
/**
 * A program run on a Db of R matches only the contexts R declares (Cx, the program's ContextsOf): the Db's claims hold
 * facts of those alone, and the checker refuses any other at run time too (OutsideRole context). A role whose type does
 * not say which contexts it declares, and a schema, admit any. A Cx that names no context (string, where the argument is no program
 * of the kind the reader takes, so nothing inferred its names) is judged by nothing here: the argument's own mismatch is
 * the error. The role's contexts are a parameter of their own (ContextsWithin), as ReadsContext's are.
 */
export type WithinRoleContexts<R, Cx> = string extends Cx
	? unknown
	: ContextsWithin<Cx, ContextsReadBy<R>>
type ContextsWithin<Cx, Read> = [Cx] extends [Read]
	? unknown
	: Refusal<"a program on a Db of a role matches only the contexts the role declares, whose facts its claims hold">

/** The names of the relations a role may write: its insert list's and its write list's. */
export type WriteListOf<R> = R extends {
	readonly insert: ReadonlyArray<infer I extends string>
	readonly write: ReadonlyArray<infer W extends string>
}
	? I | W
	: never

/** Any login: the members every one has. Its roles are reached by name, each through the login (LoginRole). */
export interface AnyLogin extends Built {
	readonly kind: "login"
	readonly name: string
	readonly base: AnySchema
	readonly roles: Readonly<Record<string, AnyLoginRole>>
	readonly workload: ReadonlyArray<AnyWorkload>
}

/** Any role reached through its login: the members every one has. */
export interface AnyLoginRole extends Built {
	readonly kind: "loginRole"
	readonly role: AnyRole
	readonly login: AnyLogin
}

/**
 * A role R reached through its login, `Web.roles.member`: what a served login's roles, which Db.open takes, and an HTTP
 * client's are typed from. Ws is its login's workloads, a phantom no runtime value holds, whose programs a Db of R runs
 * (ProgramsOf) where a served role or a client reads them (adapter/types/layer.ts ServedRoles, client/client.ts
 * ProgramsOfRole), never in the login's own type: a login is related to AnyLogin, to every other login of a list of
 * them and to every parameter it is passed to by its parts, and a role's programs, a walk of every workload of the
 * login against the role's levels, were read there at each relation, more than one statement may instantiate for a list
 * of metis's 23 logins (TS2589).
 */
export interface LoginRole<R extends AnyRole, Ws>
	extends AnyLoginRole, Phantom<{ readonly workload: Invariant<Ws> }> {
	readonly role: R
}

/**
 * The programs of a login's workloads a Db of role R runs: those of every workload over R or a level of it, a full
 * role's base among them. unknown when none does, so the record of handles is empty.
 */
export type ProgramsOf<R, Ws> = Ws extends readonly [infer W, ...infer Rest]
	? (W extends Workload<infer S, infer P>
			? IsLevelOf<R, S> extends true
				? P
				: unknown
			: unknown) &
			ProgramsOf<R, Rest>
	: unknown

/** A login's roles by name, each reached through the login with its workloads, whose programs its Dbs run. */
export type LoginRoles<Roles extends ReadonlyArray<AnyRole>, Ws> = {
	readonly [R in Roles[number] as R["name"]]: LoginRole<R, Ws>
}

export interface Login<
	Base,
	Name extends string,
	Roles extends ReadonlyArray<AnyRole>,
	Ws
> extends Built {
	readonly kind: "login"
	readonly name: Name
	readonly base: Base
	readonly roles: LoginRoles<Roles, Ws>
	readonly workload: Ws
}

/**
 * The arguments after a login's roles: none, or its options, `workload` the workloads it owns, each over its base, a
 * level of it, or one of its roles, no two programs of one name among them.
 */
export type LoginOptions<Ws> = readonly [] | readonly [options: { readonly workload: Ws }]

/** The names of the programs two of the workloads share. */
export type SharedNames<Ws, Seen> = Ws extends readonly [infer W, ...infer Rest]
	? W extends Workload<unknown, infer P>
		? (keyof P & Seen) | SharedNames<Rest, Seen | keyof P>
		: SharedNames<Rest, Seen>
	: never

/** Whether S is one of the roles, compared invariantly. */
type IsOneOf<S, Roles> = true extends (
	Roles extends unknown ? ([Invariant<S>] extends [Invariant<Roles>] ? true : never) : never
)
	? true
	: false

/**
 * The verdict on a login's workloads W, a union of them: unknown where each is over the base, a level of it or a role of
 * the login, else the refusal. One verdict, never a list of them matched against the workloads, which relates the
 * workloads' array to a mapped copy of itself, the array's methods' generic signatures instantiated over every
 * workload's schema at every level of it: past the checker's depth for records whose attachments nest (types/schema
 * records.ts), each relation of which carries its parent's and its attachments' types.
 */
export type WorkloadsOver<Base, Roles, W> = [OffLogin<Base, Roles, W>] extends [never]
	? unknown
	: Refusal<"a login's workload is over its base, a level of it, or one of its roles">

/** The workloads of W over neither the base, a level of it, nor a role of the login. */
type OffLogin<Base, Roles, W> =
	W extends Workload<infer S, unknown>
		? IsLevelOf<Base, S> extends true
			? never
			: IsOneOf<S, Roles> extends true
				? never
				: W
		: never

/**
 * The verdict on a login's roles R, a union of them: unknown where each is over the base, compared invariantly as levels
 * are, else the refusal; one verdict, as WorkloadsOver is. Roles holding a member typed any are `any` as a union, which
 * no base matches, so the verdict would refuse them beside MembersTyped, and the two refusals, intersected, are a type
 * no diagnostic names: they are MembersTyped's alone (IsUntyped), read only where the roles would be refused, so roles
 * over the base cost no test of it.
 */
export type RolesOver<Base, R> = [OffBase<Base, R>] extends [never]
	? unknown
	: IsUntyped<R> extends true
		? unknown
		: Refusal<"a login's roles share its base">

/**
 * Whether a union of a list's members is `any`. Its keys are read first, as MembersTyped reads them, so no member is an
 * operand of the test.
 */
type IsUntyped<R> = symbol extends keyof R ? (0 extends 1 & R ? true : false) : false

/** The roles of R over another base than Base. */
type OffBase<Base, R> = R extends { readonly base: infer B }
	? [Invariant<B>] extends [Invariant<Base>]
		? never
		: R
	: never

export type RolesOf<L> = L extends { readonly roles: infer Rs }
	? Rs[keyof Rs] extends infer H
		? H extends { readonly role: infer R }
			? R
			: never
		: never
	: never
/** Whether a role of the login declares a token's context, the condition under which DbLayer.make requires a verify. */
export type LoginReadsToken<L> = ReadsToken<RolesOf<L>>
