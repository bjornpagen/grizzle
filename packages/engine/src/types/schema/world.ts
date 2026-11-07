import type { RowDecoder } from "#compiler/core/decoder.ts"
import type { Built, Phantom } from "#compiler/core/phantom.ts"
import type { Carriers, Headed, Invariant, Origin, Refusal } from "#compiler/types/core/phantom.ts"
import type { AnyWorkload, Workload } from "#compiler/types/db/workload.ts"
import type {
	AnyDerived,
	DefinitionQuery,
	DefinitionShape
} from "#compiler/types/derived/derived.ts"
import type {
	Field,
	NotSerial,
	NotSerialBases,
	SerialField,
	UnwrittenField
} from "#compiler/types/fields/field.ts"
import type { ContextsOf, QueryBase } from "#compiler/types/query/query.ts"
import type {
	AnyClosedRelation,
	AnyRelation,
	AnyRoster,
	FactOfFields,
	NameOf
} from "#compiler/types/schema/relation.ts"

import type {
	AnySchema,
	IsLevelOf,
	IsRelationOf,
	NamedBy,
	RelationsOf,
	StatementsOf,
	UnderName
} from "#compiler/types/schema/schema.ts"

/**
 * A context field: text, uuid, boolean, an integer type, a contract over one of them, or a closed handle; never a
 * serial generation declaration.
 */
export type ContextField = Field<
	unknown,
	"text" | "uuid" | "boolean" | "smallint" | "integer" | "bigint" | "code"
> &
	NotSerial

/** A context's fields with every contract's base chain read: a field whose chain ends at a serial is never. */
export type ContextFieldBases<Fields> = { readonly [K in keyof Fields]: NotSerialBases<Fields[K]> }

/**
 * Any context: the members every one has. `claim` names the nested claim object its fields are read from, undefined
 * for the verified payload's own top level.
 */
export interface AnyContext extends Built {
	readonly kind: "context"
	readonly name: string
	readonly fields: unknown
	readonly claim: string | undefined
	readonly fact: RowDecoder<unknown>
}

/**
 * A context named Name over its fields: its heading is the fields, the carriers v mints variables over, and `fact`
 * decodes its one fact. Its fields are a phantom too, as a derived relation's are, so no reader takes it for a source
 * of unknown heading.
 */
export interface Context<Name extends string, Fields>
	extends AnyContext, Phantom<{ readonly fields: Fields }> {
	readonly kind: "context"
	readonly name: Name
	readonly fields: Fields
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
 *   token. Its fields are claims of scalar types (ContextField). It belongs to no schema, so a rule of any query over
 *   any schema matches it; no law takes it and no ChangeSet writes it.
 * - A role is a schema whose relations are defined over its base. A whole entry is a relation of the base, itself,
 *   under its own name; a query entry is a world relation (World), a query over the base installed as a plain view,
 *   whose fields are its definition's heading and whose keys are those its definition's evidence proves, as a derived
 *   relation's are. The role keeps the base's laws among its whole entries. A role holding every relation of its base
 *   whole is a full role: its base is among its levels (LevelsOf), so programs over the base run on it; its entries are
 *   wholeEntriesOf(base) (WholeEntriesOf). `write` names the role relations it may write, every one it may write whole
 *   being writableNamesOf(base) (WritableNameOf), `refresh` the derived whole entries it may refresh.
 * - A login is one credential and one pool for roles over one base. DbLayer.make takes one; Db.open opens a role of
 *   the layer's login.
 *
 * Which contexts a role reads is a phantom: the contexts its query entries' definitions match (ContextsOf), so Db.open
 * requires a token exactly when a role's relations read one, and DbLayer.make a verify exactly when a role of its login
 * does.
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
 * The head fields of a world relation its definition takes from a serial field of a base relation, each a term v minted
 * over that field: an addition into the world may omit them, as an addition into the relation may, and the identity
 * default draws them. A filter of the entry that reads such a field needs it in every fact, which the types cannot see
 * and the host refuses as a missing field.
 */
export type WorldSerialFields<W> = W extends {
	readonly heading: infer H
	readonly definition: Phantom<{ readonly schema: Invariant<infer S> }>
}
	? { [K in keyof H]-?: SerialOrigin<S, H[K]> extends true ? K : never }[keyof H]
	: never

type SerialOrigin<S, T> =
	T extends Phantom<{ readonly origin: Origin<infer N, infer F> }>
		? UnderName<RelationsOf<S>, N> extends { readonly fields: infer Fs }
			? F extends keyof Fs
				? Fs[F] extends Pick<SerialField<unknown, never>, "writing">
					? true
					: false
				: false
			: false
		: false

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

/** What a role's relation record holds: a relation of the base, whole, or a query over the base, a query entry. */
export type EntryValue = AnyRelation | AnyRoster | AnyDerived | DefinitionQuery

/**
 * The role relations an entry record makes: a whole entry is the base relation itself, a query entry the world
 * relation of its key.
 */
export type RoleRelations<Rs> = {
	readonly [K in keyof Rs]: Rs[K] extends AnyRelation | AnyRoster | AnyDerived
		? Rs[K]
		: Rs[K] extends DefinitionQuery
			? World<K & string, Rs[K]>
			: never
}

type QuerySchema<Q> = Q extends Phantom<{ readonly schema: Invariant<infer QS> }> ? QS : never

/**
 * One entry, checked: a whole entry is a relation of the base under its own name; a query entry is over a level of the
 * base and admissible as a definition (one flat heading of at least one field, no parameter).
 */
type EntryCheck<Base, K, V> = V extends AnyRelation | AnyRoster | AnyDerived
	? IsRelationOf<Base, V> extends true
		? [K] extends [NameOf<V>]
			? unknown
			: Refusal<"a whole entry is a relation of the base under its own name">
		: Refusal<"a whole entry is a relation of the base under its own name">
	: IsLevelOf<Base, QuerySchema<V>> extends true
		? DefinitionShape<V>
		: Refusal<"a query entry is a query over the role's base">
export type EntriesCheck<Base, Rs> = { readonly [K in keyof Rs]: EntryCheck<Base, K, Rs[K]> }

/** The entries a role may write: whole ordinary relations and query entries. */
export type WritableKeys<Rs> = {
	[K in keyof Rs]-?: Rs[K] extends AnyRelation
		? K
		: Rs[K] extends AnyRoster | AnyDerived
			? never
			: K
}[keyof Rs] &
	string

/** The entries a role may refresh: whole derived relations. */
export type RefreshableKeys<Rs> = {
	[K in keyof Rs]-?: Rs[K] extends AnyDerived ? K : never
}[keyof Rs] &
	string

/**
 * A full role's entries over a schema's record of relations: each relation under its own key, whole, but the closed
 * relations, which are no entry (every role reads their rows). One key per relation, kept or dropped by its own type
 * alone, so a record of n relations costs n conditionals and a closed relation can never stand among the entries.
 */
export type WholeEntries<Rs> = {
	readonly [K in keyof Rs as Rs[K] extends AnyClosedRelation ? never : K]: Rs[K]
}

/**
 * The entries of a full role over Base (wholeEntriesOf): every relation of every level of the base, under its own name,
 * whole, its closed relations aside. A role holding them holds every relation of its base whole, so its base is among
 * its levels (FullBaseOf).
 */
export type WholeEntriesOf<Base extends AnySchema> = WholeEntries<Base["relations"]>

/**
 * The names a role over Base writes when it writes every whole entry it may (writableNamesOf): the base's ordinary
 * relations, every level's, which are WritableKeys of its full role's entries. A roster, a closed relation and a
 * derived relation are never among them.
 */
export type WritableNameOf<Base extends AnySchema> = WritableKeys<WholeEntriesOf<Base>>

/** The contexts a role's query entries read. */
export type EntryContexts<Rs> = {
	[K in keyof Rs]-?: Rs[K] extends AnyRelation | AnyRoster | AnyDerived ? never : ContextsOf<Rs[K]>
}[keyof Rs]

/**
 * Whether a role holds every relation of its base whole, under its own name: then the base is among its levels. A
 * closed relation is no entry (its rows are constants every role reads, D3), so a role holds every relation but those.
 * The base's record holds each relation under its own name too (UnderOwnNames), so each is read against the role's
 * entry of its key alone.
 */
type FullBaseOf<Base, Relations> = [UnheldOf<RelationsOf<Base>, Relations>] extends [never]
	? Base
	: never

/** The keys of a base's record whose relation the role does not hold whole under that key, closed relations aside. */
type UnheldOf<BaseRelations, Relations> = {
	[K in keyof BaseRelations]-?: [BaseRelations[K]] extends [
		AnyClosedRelation | UnderName<Relations, K>
	]
		? never
		: K
}[keyof BaseRelations]

/**
 * The relations among Named that are not the role's entry under their own names. A whole entry sits under its own name
 * (EntriesCheck), so "R is a whole entry" is "R is the entry under R's name", one lookup, never a pass over the entries.
 */
type NotWhole<Relations, Named> = Named extends unknown
	? [Named] extends [UnderName<Relations, NameOf<Named>>]
		? never
		: Named
	: never

/** The base's laws a role keeps: those whose every relation is the role's entry under that relation's name. */
type KeptStatement<St, Relations> = St extends unknown
	? [NotWhole<Relations, NamedBy<St>>] extends [never]
		? St
		: never
	: never

export type KeptStatements<Base, Relations> = KeptStatement<StatementsOf<Base>[number], Relations>

/** Any role: the members every one has. A role is a schema: it has a name, relations and statements. */
export interface AnyRole extends AnySchema {
	readonly kind: "role"
	readonly base: AnySchema
	readonly write: ReadonlyArray<string>
	readonly refresh: ReadonlyArray<string>
}

/**
 * A role over Base named Name: its relations, the base's laws it keeps, and its write and refresh lists, as written. A
 * full role extends its base (the phantom LevelsOf reads); `contexts` is the union of the contexts its relations read.
 */
export interface Role<
	Base,
	Name extends string,
	Relations,
	Write extends string,
	Refresh extends string,
	Contexts
> extends Phantom<{ readonly extends: FullBaseOf<Base, Relations>; readonly contexts: Contexts }> {
	readonly kind: "role"
	readonly name: Name
	readonly base: Base
	readonly relations: Relations
	readonly statements: ReadonlyArray<KeptStatements<Base, Relations>>
	readonly write: ReadonlyArray<Write>
	readonly refresh: ReadonlyArray<Refresh>
}

/**
 * The arguments after a role's relations: none, or its options, `write` naming the role relations it may write and
 * `refresh` the derived whole entries it may refresh, each empty when left out.
 */
export type RoleOptions<W, F> = readonly [] | readonly [options: RoleOptionRecord<W, F>]
export interface RoleOptionRecord<W, F> {
	readonly write?: W
	readonly refresh?: F
}

/**
 * The contexts a role's relations read: never when none does, and unknown for a role whose type does not say (a role
 * widened to AnyRole), which may read any, so a token and a verify stay required for it.
 */
export type ContextsReadBy<R> =
	R extends Phantom<infer B> ? (B extends { readonly contexts: infer C } ? C : unknown) : unknown
/** Whether a role's relations read a context, the condition under which Db.open requires a token. */
export type ReadsContext<R> = [ContextsReadBy<R>] extends [never] ? false : true
/**
 * A program run on a Db of R matches only the contexts R's relations read (Cx, the program's ContextsOf): the Db's
 * claims hold facts of those alone, and the checker refuses any other at run time too. A role whose type does not say
 * which contexts it reads, and a schema, admit any. A Cx that names no context (string, where the argument is no program
 * of the kind the reader takes, so nothing inferred its names) is judged by nothing here: the argument's own mismatch is
 * the error.
 */
export type WithinRoleContexts<R, Cx> = string extends Cx
	? unknown
	: [Cx] extends [ContextsReadBy<R>]
		? unknown
		: Refusal<"a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold">

/** The names of the relations a role may write: its write list. */
export type WriteListOf<R> = R extends { readonly write: ReadonlyArray<infer W extends string> }
	? W
	: never

/** The relations a role may refresh: the role relations its refresh list names. */
export type RefreshListOf<R> = R extends {
	readonly refresh: ReadonlyArray<infer F extends string>
	readonly relations: infer Rs
}
	? UnderName<Rs, F>
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
 * A role R reached through its login, `Web.roles.member`: what Db.open takes. P is the programs of the login's
 * workloads a Db of R runs (ProgramsOf), which the Db shows as `db.workload`, a phantom no runtime value holds.
 */
export interface LoginRole<R extends AnyRole, P>
	extends AnyLoginRole, Phantom<{ readonly workload: Invariant<P> }> {
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

/** A login's roles by name, each reached through the login with the programs its Dbs run. */
export type LoginRoles<Roles extends ReadonlyArray<AnyRole>, Ws> = {
	readonly [R in Roles[number] as R["name"]]: LoginRole<R, ProgramsOf<R, Ws>>
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

/** A login's workloads, checked one by one: each over the base, a level of it or a role of the login. */
export type WorkloadsOver<Base, Roles, Ws> = {
	readonly [I in keyof Ws]: Ws[I] extends Workload<infer S, unknown>
		? IsLevelOf<Base, S> extends true
			? unknown
			: IsOneOf<S, Roles> extends true
				? unknown
				: Refusal<"a login's workload is over its base, a level of it, or one of its roles">
		: unknown
}

/** Every role of a login is over its base, compared invariantly as levels are. */
export type RolesOver<Base, Roles> = {
	readonly [K in keyof Roles]: Roles[K] extends { readonly base: infer B }
		? [Invariant<B>] extends [Invariant<Base>]
			? unknown
			: Refusal<"a login's roles share its base">
		: unknown
}

export type RolesOf<L> = L extends { readonly roles: infer Rs }
	? Rs[keyof Rs] extends infer H
		? H extends { readonly role: infer R }
			? R
			: never
		: never
	: never
/** Whether a role of the login reads a context, the condition under which DbLayer.make requires a verify. */
export type LoginReadsContext<L> = ReadsContext<RolesOf<L>>
