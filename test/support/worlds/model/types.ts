import type { WildKind } from "@grizzle/testing/lsw"
import type { Array as Arr } from "effect"
import type { Identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { Direction } from "#compiler/core/order.ts"
import type { HeadStanding } from "#compiler/schema/entry.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import type { AmbientFeature } from "#test/support/ambient.ts"
import type { IdentifierFeature } from "#test/support/kernel/dict.ts"
import type { HostFact, HostSchema, HostState, HostValue } from "#test/support/laws/model.ts"
import type { Written } from "#test/support/worlds/model/session/writes.ts"

/**
 * The worlds model's shared vocabulary: what a base, an installation, a session, an action and an observation are, as
 * the model, the real-system executor, the generators, the drivers, the feature map and the suites all name them.
 *
 * The model is independent of grizzle's source: it reads no compiler representation. Laws are judged by the host law
 * model (test/support/laws/model.ts). Facts and values are that model's `HostFact` and `Value`.
 */
export type { HostFact, HostSchema, HostState, HostValue }

/** The domain a field's values are drawn from, as the base declares it. */
export type FieldDomain =
	| { readonly kind: "uuid" }
	| {
			readonly kind: "text"
			readonly pattern: string
			readonly flags: "u" | "su"
			/** Its pattern compiled, as the domain is built (text.ts textDomain). */
			readonly matcher: RegExp
			/** Its pool of values, drawn as the domain is built (text.ts textDomain). */
			readonly pool: Arr.NonEmptyReadonlyArray<string>
	  }
	| { readonly kind: "integer"; readonly bits: 16 | 32 | 64 }
	| { readonly kind: "serial"; readonly bits: 32 | 64 }
	| { readonly kind: "boolean" }
	| {
			readonly kind: "handle"
			readonly closed: string
			readonly members: Arr.NonEmptyReadonlyArray<string>
	  }
	| { readonly kind: "span"; readonly bits: 32 | 64 }
	| {
			readonly kind: "contract"
			readonly name: string
			readonly bits: 16 | 32 | 64
			readonly min: number
			readonly max: number
	  }

export interface FieldSpec {
	readonly name: string
	readonly domain: FieldDomain
}

/** An ordinary relation of the base. Immutable relations add and delete facts; mutable ones also replace in place. */
export interface RelationSpec {
	readonly name: string
	readonly fields: Arr.NonEmptyReadonlyArray<FieldSpec>
	readonly key: Arr.NonEmptyReadonlyArray<string>
	readonly mutability: "immutable" | "mutable"
}

/**
 * A side of a law: a relation, its paired fields in pair order, and the field values its selector fixes, the
 * selection `select(R, (r) => r.and(r.eq(r.f, v), ...))` states.
 */
export interface SideSpec {
	readonly relation: string
	readonly fields: Arr.NonEmptyReadonlyArray<string>
	readonly where: Readonly<Record<string, HostValue>>
}

/** A row check the host can evaluate: comparisons of a field with an integer literal, conjoined. */
export type RowPredicate =
	| {
			readonly kind: "compare"
			readonly field: string
			readonly op: ComparisonOp
			readonly value: number
	  }
	| { readonly kind: "and"; readonly parts: Arr.NonEmptyReadonlyArray<RowPredicate> }

export type ComparisonOp = "<" | "<=" | "=" | "<>" | ">=" | ">"

/** A law as the base declares it, one arm per law family README "Rules" lists. */
export type LawSpec =
	| {
			readonly kind: "key"
			readonly relation: string
			readonly fields: Arr.NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "spanKey"
			readonly relation: string
			readonly scalars: ReadonlyArray<string>
			readonly span: string
			/** Where key() lists the span among the key's fields: before its scalars or after them. */
			readonly spanAt: "first" | "last"
	  }
	| {
			readonly kind: "check"
			readonly name: string
			readonly relation: string
			readonly predicate: RowPredicate
	  }
	| { readonly kind: "contained"; readonly source: SideSpec; readonly target: SideSpec }
	| {
			readonly kind: "covered"
			readonly source: SideSpec
			readonly target: SideSpec
			readonly span: { readonly source: string; readonly target: string }
	  }
	| {
			readonly kind: "alternatives"
			readonly relation: string
			readonly tag: string
			readonly closed: string
			readonly arms: Readonly<Record<string, string>>
	  }

/** Where a context reads its fields in the verified token's payload: the top level, or one named claim object. */
export type ClaimSource =
	| { readonly kind: "top-level" }
	| { readonly kind: "object"; readonly key: string }

/** A session context: at most one fact per Db, decoded from the verified token. */
export interface ContextSpec {
	readonly name: string
	readonly claim: ClaimSource
	readonly fields: Arr.NonEmptyReadonlyArray<FieldSpec>
}

/** A closed roster of the base. */
export interface ClosedSpec {
	readonly name: string
	readonly members: Arr.NonEmptyReadonlyArray<string>
}

/** A stored query of the base, installed as a materialized view and brought up to date only by a refresh. */
export interface DerivedSpec {
	readonly name: string
	readonly rules: Arr.NonEmptyReadonlyArray<Rule>
}

export interface BaseSpec {
	readonly name: string
	readonly closed: ReadonlyArray<ClosedSpec>
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>
	readonly laws: ReadonlyArray<LawSpec>
	readonly contexts: ReadonlyArray<ContextSpec>
	readonly derived: ReadonlyArray<DerivedSpec>
}

/**
 * A term of a rule: a variable, a JavaScript value, a roster's member as a typed constant (`X.handle("Member")`), or a
 * field of a context's fact.
 */
export type Term =
	| { readonly kind: "var"; readonly name: string }
	| { readonly kind: "literal"; readonly value: HostValue }
	| { readonly kind: "handle"; readonly closed: string; readonly member: string }
	| { readonly kind: "context"; readonly context: string; readonly field: string }

/** What an occurrence matches: an ordinary, closed or derived relation of the base, or a context, each by its kind. */
export type Source = {
	readonly kind: "ordinary" | "closed" | "derived" | "context"
	readonly name: string
}

/** One match of a rule: each named field bound to a term; unnamed fields are free. */
export interface Occurrence {
	readonly source: Source
	readonly fields: Readonly<Record<string, Term>>
}

export interface Comparison {
	readonly left: Term
	readonly op: ComparisonOp
	readonly right: Term
}

/**
 * One rule with set semantics: every match holds, no negated conjunction holds, every comparison holds; the head maps
 * each head field to a term. A shared variable is a join; a second rule of an entry is a union.
 */
export interface Rule {
	readonly matches: Arr.NonEmptyReadonlyArray<Occurrence>
	readonly negations: ReadonlyArray<Arr.NonEmptyReadonlyArray<Occurrence>>
	readonly comparisons: ReadonlyArray<Comparison>
	readonly head: Readonly<Record<string, Term>>
}

/** A role relation: a base relation held whole under its own name, or a query over the base installed as a view. */
export type EntrySpec =
	| { readonly kind: "whole"; readonly relation: string }
	| { readonly kind: "query"; readonly rules: Arr.NonEmptyReadonlyArray<Rule> }

export interface RoleSpec {
	readonly name: string
	readonly entries: Readonly<Record<string, EntrySpec>>
	readonly write: ReadonlyArray<string>
	readonly refresh: ReadonlyArray<string>
}

export interface LoginSpec {
	readonly name: string
	readonly roles: Arr.NonEmptyReadonlyArray<string>
}

/** A base with its worlds: every role in exactly one login. */
export interface InstallSpec {
	readonly base: BaseSpec
	readonly roles: Arr.NonEmptyReadonlyArray<RoleSpec>
	readonly logins: Arr.NonEmptyReadonlyArray<LoginSpec>
}

/**
 * The law identities the compiler gave one declared law: one for most laws, and for alternatives two per armed handle,
 * the containments it states (fin.md §7).
 */
export type LawIds =
	| {
			readonly kind: "key" | "spanKey" | "check" | "contained" | "covered"
			readonly law: LawId
	  }
	| {
			readonly kind: "alternatives"
			/** Each armed handle's arm in the parent selected by it, keyed by the handle. */
			readonly arms: Readonly<Record<string, LawId>>
			/** The parent selected by each armed handle in that handle's arm, keyed by the handle. */
			readonly reverse: Readonly<Record<string, LawId>>
	  }

/** The names the compiler gave an installation, read back from it by the executor: never spelled by a test. */
export interface InstalledNames {
	/** The identity of the installed schema, which the naming door mints every installation-scoped name under: each
	 * role's schema, filter functions and key probes (core/identity.ts). */
	readonly installation: Identity<"schema">
	/** The root level's PostgreSQL schema, which holds what is the installation's own: its ledger and guard. */
	readonly schema: string
	/**
	 * The identity of each level's PostgreSQL schema, the root's first: the worlds stand on the last, whose identity the
	 * naming door mints each role's identity, its schema, filter functions and key probes under.
	 */
	readonly levels: Arr.NonEmptyReadonlyArray<Identity<"schema">>
	/** Each relation's table or materialized view, in the schema of the level declaring it. */
	readonly tables: Readonly<Record<string, ObjectName>>
	readonly columns: Readonly<Record<string, Readonly<Record<string, string>>>>
	/** Each relation's primary-key law. A span primary key is a span-key law. */
	readonly primaryKeys: Readonly<Record<string, LawId>>
	/** The law identities of each `BaseSpec.laws` entry, aligned by index and of the same kind. */
	readonly laws: ReadonlyArray<LawIds>
	/**
	 * The CHECK law of each contract and refined-text DOMAIN, by its domain's name, as PostgreSQL alone reports it to a
	 * direct writer or reader, by the domain and never the column (the installation's constraint map): a written value
	 * outside a contract's range or a text's pattern passes grizzle's encoder (it checks the base type) and is refused
	 * by the domain's CHECK as its statement casts it, before row constraints and policies.
	 */
	readonly domains: Readonly<Record<string, LawId>>
	/**
	 * Each stored relation's refined-text fields' own pattern laws, by relation and field: what a Db's refusal names,
	 * the host deciding the column whose value the shared DOMAIN refused.
	 */
	readonly patterns: Readonly<Record<string, Readonly<Record<string, LawId>>>>
	/** The PostgreSQL role of each grizzle role and login. */
	readonly roles: Readonly<Record<string, string>>
	readonly logins: Readonly<Record<string, string>>
	/**
	 * Each roster's names constant, by the roster's name: the function its domain's CHECK and every role view's decoded
	 * column call, named by the digest of its names in code order, so a removal's hole names a new one. A role that
	 * holds USAGE on the roster's domain, or reads a view that decodes through it, holds EXECUTE on it.
	 */
	readonly rosterConstants: Readonly<Record<string, string>>
	/** Each roster's handles by code, as the installation holds them: what a closed id's claim and column hold. */
	readonly codes: HandleCodes
	/**
	 * Each ordinary relation's declared keys, each by its fields, in the order the engine reads them for a witness: its
	 * primary key first, then each key a law declares (the compiled relation's keyNames).
	 */
	readonly keys: Readonly<Record<string, ReadonlyArray<Arr.NonEmptyReadonlyArray<string>>>>
}

/** Each roster's handles by code, by the roster's name: a removed handle's code a hole, "". */
export type HandleCodes = Readonly<Record<string, ReadonlyArray<string>>>

/**
 * Why a query entry cannot be written, restating the writable-entry rule of README "Writing through a role" clause by clause: a field of the
 * target outside the head and outside its primary key that is not fixed is `field-not-fixed`; a primary-key field
 * neither in the head nor fixed is `key-not-determined`. Every other match, negation and comparison of a rule only
 * filters under set semantics, so no refusal names it.
 */
export type WritableRefusal =
	| "several-rules"
	| "no-supplier"
	| "head-term-not-own-field"
	| "field-not-fixed"
	| "key-not-determined"

/** How an insert through a writable entry fills a field of its target that the head does not carry. */
export type Fill =
	| { readonly kind: "literal"; readonly value: HostValue }
	| { readonly kind: "context"; readonly context: string; readonly field: string }

/**
 * A head field of a writable entry: the field of T it writes, and how an UPDATE in place of T's row stands toward it,
 * as grizzle's analysis classifies it (schema/entry.ts HeadField). `keyed`: in a key of T, its primary key or a key or
 * span key a law states, the identity an UPDATE matches by; it wins over the others. `claimFixed`: outside every key,
 * its head variable bound by a field of a positive context match of the rule (a head context term such as
 * `Session.sub`, or a variable a context match binds), so every fact of the world holds the claim's value there; one
 * bound to the claim only through a join is not. `free`: any other. A role holds column UPDATE on a query entry's free
 * head fields alone.
 */
export interface HeadField {
	readonly field: string
	readonly kind: HeadStanding
}

export type EntryClass =
	| {
			readonly kind: "writable"
			readonly target: string
			/** Each head field, the target field it supplies and its standing. */
			readonly head: Readonly<Record<string, HeadField>>
			readonly fills: Readonly<Record<string, Fill>>
	  }
	| { readonly kind: "read-only"; readonly reason: WritableRefusal }

/** The facts a session's claims hold, per context name; a context without a key has no fact. */
export type ContextFacts = Readonly<Record<string, HostFact>>

/** Where a stale value comes from. */
export type StaleSource =
	| "removed-user"
	| "left-organization"
	| "deleted-organization"
	| "previous-request"

/**
 * Why a wild token payload is wild. `refinement-edge`: a claim at the edge of its field's refinement, a text at its
 * pattern's or a contract's integer at its bounds, on either side, which the host's encoder admits and PostgreSQL judges.
 */
export type TokenWild =
	| "not-json"
	| "claim-object-missing"
	| "claim-object-null"
	| "claim-object-array"
	| "field-missing"
	| "field-wrong-type"
	| "unsafe-integer"
	| "int8-not-digits"
	| "lone-surrogate"
	| "nul-character"
	| "proto-key"
	| "huge-payload"
	| "refinement-edge"
	| "extra-fields"
	| "verify-throws"
	| "verify-not-object"

/** A token handed to `Db.open`: none, a live payload, a stale one, or a wild one. */
export type Token =
	| { readonly kind: "none" }
	| { readonly kind: "live"; readonly payload: Readonly<Record<string, unknown>> }
	| {
			readonly kind: "stale"
			readonly payload: Readonly<Record<string, unknown>>
			readonly source: StaleSource
	  }
	| { readonly kind: "wild"; readonly text: string; readonly wild: TokenWild }

/** A PostgreSQL role a direct writer names. */
export type RoleRef =
	| { readonly kind: "own"; readonly role: string }
	| { readonly kind: "other-login"; readonly role: string }
	| { readonly kind: "dropped"; readonly role: string }
	| { readonly kind: "nonexistent"; readonly name: string }
	| { readonly kind: "owner" }

export type SettingScope = "transaction" | "session"

/** What a direct writer sets `grizzle.claims` to. */
export type ClaimsSetting =
	| { readonly kind: "facts"; readonly facts: ContextFacts; readonly scope: SettingScope }
	| { readonly kind: "malformed"; readonly text: string; readonly scope: SettingScope }

/**
 * How a read of a context refuses a hand-set claim (packages/engine/src/sql/print.ts contextClaims): with a SQLSTATE
 * alone, 22P02 or 22003 for a claim no value of its base type, 23514 for a closed id's code its roster's domain refuses;
 * or on a law domain's CHECK as the claim is cast to it, 23514 on the domain's law, for a contract's integer past its
 * bounds or a text past its pattern.
 */
export type RefusedClaim =
	| { readonly kind: "state"; readonly sqlstate: ClaimRefusal }
	| {
			readonly kind: "check"
			readonly domain: Extract<FieldDomain, { readonly kind: "contract" | "text" }>
	  }

/**
 * One refusal a read of a context meets: its member holding other keys than the context's fields (22P02), or one of its
 * fields' claims, refused as its field's type is cast (RefusedClaim).
 */
export type ContextRefusal =
	| { readonly kind: "keys" }
	| {
			readonly kind: "claim"
			readonly field: string
			readonly domain: FieldDomain
			readonly refusal: RefusedClaim
	  }

/**
 * What PostgreSQL reads from a direct writer's claims setting (packages/engine/src/sql/print.ts claimsDocument,
 * contextClaims), parsed once where the setting enters (model/session/direct.ts settingRead): a claims document,
 * holding the facts of the contexts whose member holds exactly their fields, each value admitted by its field's type,
 * and the contexts whose member holds other keys or a value its type refuses, each with the refusals a read of it meets;
 * or a text that is no claims document, which every read of a claim refuses (22P02).
 */
export type ClaimsRead =
	| {
			readonly kind: "document"
			readonly facts: ContextFacts
			readonly refused: ReadonlyMap<string, Arr.NonEmptyReadonlyArray<ContextRefusal>>
	  }
	| { readonly kind: "malformed" }

/** The claims a direct writer sets as it begins: none, or a setting, sent as `grizzle.claims`. */
export type ClaimsStart =
	| { readonly kind: "none" }
	| { readonly kind: "set"; readonly setting: ClaimsSetting }

/** A function the installation defines that a direct writer may try to call: no law function is one (fin.md §7). */
export type WorldFunction =
	| { readonly kind: "filter"; readonly role: string; readonly entry: string }
	| {
			readonly kind: "key-probe"
			readonly role: string
			readonly entry: string
			readonly key: number
	  }
	| { readonly kind: "advance"; readonly relation: string; readonly field: string }

export type Isolation = "serializable" | "repeatable read" | "read committed" | "read uncommitted"

/**
 * How a direct read of a role's view filters: not at all, or with a predicate that raises on one value of one field, so
 * a security-barrier view shows whether the world's filter runs before a caller's expression.
 */
export type ViewFilter =
	| { readonly kind: "none" }
	| { readonly kind: "raise-on"; readonly field: string; readonly value: HostValue }

/** What a direct writer's prepared statement reads. */
export type PreparedRead =
	| { readonly kind: "view"; readonly role: string; readonly relation: string }
	| { readonly kind: "table"; readonly relation: string }

/** One statement of a direct SQL writer, inside a transaction it began. */
export type DirectStatement =
	| { readonly kind: "set-role"; readonly role: RoleRef }
	| { readonly kind: "reset-role" }
	| { readonly kind: "set-session-authorization"; readonly role: RoleRef }
	| { readonly kind: "set-claims"; readonly setting: ClaimsSetting }
	| {
			readonly kind: "select-view"
			readonly role: string
			readonly relation: string
			readonly filter: ViewFilter
	  }
	| { readonly kind: "select-table"; readonly relation: string; readonly filter: ViewFilter }
	| { readonly kind: "insert"; readonly relation: string; readonly fact: HostFact }
	| { readonly kind: "delete"; readonly relation: string; readonly key: HostFact }
	| {
			readonly kind: "update"
			readonly relation: string
			readonly key: HostFact
			readonly set: HostFact
	  }
	| { readonly kind: "truncate"; readonly relation: string }
	| { readonly kind: "call"; readonly fn: WorldFunction; readonly args: ReadonlyArray<HostValue> }
	| {
			readonly kind: "setval"
			readonly relation: string
			readonly field: string
			readonly value: number
	  }
	| {
			readonly kind: "insert-on-conflict"
			readonly relation: string
			readonly fact: HostFact
			readonly onConflict: "nothing" | "select" | "update"
	  }
	| {
			readonly kind: "merge-delete"
			readonly relation: string
			readonly keys: ReadonlyArray<HostFact>
	  }
	| { readonly kind: "prepare"; readonly name: string; readonly read: PreparedRead }
	| { readonly kind: "execute-prepared"; readonly name: string }

/** A write through a role relation. */
export interface EntryOp {
	readonly relation: string
	readonly kind: "insert" | "delete" | "put"
	readonly facts: ReadonlyArray<HostFact>
}

export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE"

/**
 * A trigger the installation defines: a table's below-SERIALIZABLE guard, the only trigger grizzle installs, since every
 * law is native (fin.md §7).
 */
export type TriggerRef = { readonly kind: "isolation-guard"; readonly relation: string }

/**
 * A change to the installed catalog behind grizzle's back. `Db.open` judges what a login can do (memberships, settings,
 * privileges, row security, the database's isolation); `grizzle drift` also judges catalog-only changes (defaults,
 * nullability, indexes, tables, rules, triggers, view and policy definitions).
 */
export type CatalogPerturbation =
	| { readonly kind: "membership-admin"; readonly login: string; readonly role: string }
	| { readonly kind: "membership-inherit"; readonly login: string; readonly role: string }
	| { readonly kind: "membership-revoked"; readonly login: string; readonly role: string }
	| {
			readonly kind: "membership-extra"
			readonly login: string
			readonly inherit: boolean
			readonly set: boolean
			readonly holds: "nothing" | "a-privilege"
	  }
	| { readonly kind: "member-extra"; readonly role: string; readonly set: boolean }
	| {
			readonly kind: "role-attribute"
			readonly role: string
			readonly attribute:
				| "SUPERUSER"
				| "BYPASSRLS"
				| "CREATEROLE"
				| "CREATEDB"
				| "REPLICATION"
				| "LOGIN"
				| "INHERIT"
	  }
	| {
			readonly kind: "role-setting"
			readonly who:
				| { readonly kind: "login"; readonly login: string }
				| { readonly kind: "role"; readonly role: string }
			readonly scope: "own" | "this-database"
			readonly change: "default-reset" | "default-changed" | "extra"
	  }
	| {
			readonly kind: "database-setting"
			readonly change: "isolation-changed" | "isolation-reset" | "owner-setting"
	  }
	| {
			readonly kind: "row-security"
			readonly relation: string
			readonly state: "disabled" | "forced" | "enabled"
	  }
	| {
			readonly kind: "extra-grant"
			readonly role: string
			readonly relation: string
			readonly privilege: TablePrivilege
	  }
	| {
			readonly kind: "grant-revoked"
			readonly role: string
			readonly relation: string
			readonly privilege: TablePrivilege
	  }
	| {
			readonly kind: "extra-column-grant"
			readonly role: string
			readonly relation: string
			readonly field: string
			readonly privilege: "SELECT" | "INSERT" | "UPDATE"
	  }
	| {
			readonly kind: "inherited-grant"
			readonly role: string
			readonly relation: string
			readonly privilege: TablePrivilege
	  }
	| { readonly kind: "public-grant"; readonly relation: string }
	| { readonly kind: "policy-dropped"; readonly role: string; readonly entry: string }
	| { readonly kind: "policy-edited"; readonly role: string; readonly entry: string }
	| { readonly kind: "view-redefined"; readonly role: string; readonly entry: string }
	| { readonly kind: "function-redefined"; readonly fn: WorldFunction }
	| { readonly kind: "search-path-altered"; readonly fn: WorldFunction }
	| { readonly kind: "default-privileges"; readonly privilege: "EXECUTE" | "USAGE" }
	| { readonly kind: "column-default"; readonly relation: string; readonly field: string }
	| { readonly kind: "not-null-dropped"; readonly relation: string; readonly field: string }
	| { readonly kind: "extra-index"; readonly relation: string; readonly field: string }
	| { readonly kind: "extra-table" }
	| { readonly kind: "rewrite-rule"; readonly relation: string }
	| { readonly kind: "trigger-disabled"; readonly trigger: TriggerRef }

/** One key of an order a read asks for: a field of the relation read, ascending or descending. */
export interface OrderKey {
	readonly field: string
	readonly direction: Direction
}

/** Where a paged read starts: at the first page, then each after it, or at the last, then each before it. */
export type PageFrom = "first" | "last"

/**
 * How a Db reads a role relation: a program executed, `get` by a key, every page in turn under an order its fields
 * draw (which grizzle completes with a key of the relation, so a tie never splits or repeats a row across pages), a
 * compiled program, the relation with another of the role's relations attached to each row as an array (the child's
 * rows whose field `child` equals the row's `parent`, delivered without that field), or every pair of values of two
 * fields of one domain the relation's rows chain, read by a recursive query over the relation.
 */
export type ReadVia =
	| { readonly kind: "execute" }
	| { readonly kind: "get"; readonly key: HostFact }
	| {
			readonly kind: "page"
			readonly size: number
			readonly order: Arr.NonEmptyReadonlyArray<OrderKey>
			readonly from: PageFrom
	  }
	| { readonly kind: "compile" }
	| {
			readonly kind: "attach"
			readonly relation: string
			readonly parent: string
			readonly child: string
	  }
	| { readonly kind: "reach"; readonly from: string; readonly to: string }

/**
 * The snapshot the opening role's login layer is given (DbConfig): the installation's own, an older version's, or
 * another schema's. The layer compares nothing with it and Db.open contacts nothing, so a Db opens on either of the
 * others too, and every one of its calls that sends SQL meets the snapshot guard (README "Deploying").
 */
export type SnapshotRef = "current" | "stale" | "foreign"

/** Where a JavaScript caller hands grizzle a value its types refuse. */
export type WildSite =
	| { readonly kind: "open-role" }
	| { readonly kind: "open-token"; readonly role: string }
	| {
			readonly kind: "session"
			readonly session: number
			readonly call: "read" | "apply" | "refresh"
	  }

/**
 * How a migration reaches the database: applied whole, a run stopped part-way (the runner's session ends after a file
 * commits, leaving the folder pending), or edited by hand.
 */
export type MigrationHow = "complete" | "half-applied" | "hand-edited"

/** One step of the world: the model predicts it, the executor performs it on the real system. */
export type Action =
	| {
			readonly kind: "open-db"
			readonly role: RoleRef
			readonly token: Token
			readonly snapshot: SnapshotRef
	  }
	| {
			readonly kind: "read"
			readonly session: number
			readonly relation: string
			readonly via: ReadVia
	  }
	| {
			readonly kind: "apply"
			readonly session: number
			readonly strata: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>
			readonly reads: ReadonlyArray<string>
	  }
	| { readonly kind: "refresh"; readonly session: number; readonly relation: string }
	| { readonly kind: "close"; readonly session: number }
	| {
			readonly kind: "direct-begin"
			readonly login: string
			readonly isolation: Isolation
			readonly start: DirectStart
	  }
	| { readonly kind: "direct"; readonly session: number; readonly statement: DirectStatement }
	| {
			readonly kind: "direct-end"
			readonly session: number
			readonly end: "commit" | "rollback"
	  }
	| { readonly kind: "interrupt"; readonly session: number }
	| { readonly kind: "migrate"; readonly to: InstallSpec; readonly how: MigrationHow }
	| { readonly kind: "tamper"; readonly perturbation: CatalogPerturbation }
	| { readonly kind: "drift" }
	| { readonly kind: "wild"; readonly at: WildSite; readonly wild: WildKind }

export type ActionKind = Action["kind"]

/** The SQLSTATEs the README names for direct writers and for the laws; any other is `other`. */
export type SqlState =
	| "42501"
	| "25000"
	| "23505"
	| "23503"
	| "23514"
	| "23000"
	| "23P01"
	| "40001"
	| "40P01"
	| "22P02"
	| "22003"
	| "22023"
	| "428C9"
	| "other"

/** What refuses a token (README "Errors and outcomes"): verify, its refusal or throw a TokenError; or the claims, a ClaimRefused. */
export type TokenRefuser = "verify" | "claims"

/**
 * The stage `Db.open` reports, as grizzle names it, in the order it checks them, all on the host: the role, the role
 * value and the snapshot its login layer was given (`schema`), then the token; at stage token, with what refused it:
 * `token:verify` a TokenError, `token:claims` a ClaimRefused (a payload that does not decode through the role's
 * contexts). Db.open contacts nothing, so no stage judges the database.
 */
export type ModelOpenStage = "role" | "schema" | `token:${TokenRefuser}`

/** Why a migration was refused before it changed anything: a hand-edited file, a ledger out of step, or drift after it. */
export type MigrationRefusal = "edited" | "ledger" | "order" | "marker" | "decision" | "drift"

/** Why a Db's call met a catalog its snapshot does not describe: a migration in progress, or one completed past it. */
export type ModelStaleReason = "migrating" | "migrated"

type TransientReason =
	| "SerializationFailure"
	| "Deadlock"
	| "PutTargetConflict"
	| "GeneratedSerialUnique"
	| "SpanKeyChange"
	| "UnseenOccupant"
	| "ConcurrentRefresh"

/** A read-back: a role relation over the post-change state, and the change's own delta on it. */
export interface ReadBack {
	readonly relation: string
	readonly rows: ReadonlyArray<HostFact>
	readonly delta: {
		readonly inserted: ReadonlyArray<HostFact>
		readonly deleted: ReadonlyArray<HostFact>
	}
}

/** A refusal's witness: the violating facts' keys, shown only to a role holding the witness relation whole. */
export type Witness =
	| { readonly kind: "shown"; readonly keys: ReadonlyArray<HostFact> }
	| { readonly kind: "withheld" }

/**
 * What one action did, as the model predicts it and the executor observes it. Rows and keys compare as keyed sets, and
 * an observation that repeats one agrees with no prediction.
 */
export type ActionOutcome =
	| { readonly kind: "opened"; readonly session: number; readonly verifyCalls: 0 | 1 }
	| { readonly kind: "open-refused"; readonly stage: ModelOpenStage; readonly verifyCalls: 0 | 1 }
	| { readonly kind: "rows"; readonly rows: ReadonlyArray<HostFact> }
	| {
			readonly kind: "applied"
			readonly outcome: "accepted" | "no-change"
			readonly reads: ReadonlyArray<ReadBack>
	  }
	| { readonly kind: "invariant-rejected"; readonly law: LawId; readonly witness: Witness }
	| {
			readonly kind: "law-refused"
			readonly sqlstate: SqlState
			readonly law: LawId
			readonly witness: Witness
	  }
	| { readonly kind: "encoding-refused" }
	| { readonly kind: "outside-world"; readonly relation: string }
	| { readonly kind: "compile-refused" }
	| { readonly kind: "resource-bound" }
	| { readonly kind: "transient"; readonly reason: TransientReason }
	| { readonly kind: "commit-unknown" }
	| { readonly kind: "interrupted" }
	| { readonly kind: "refused"; readonly sqlstate: SqlState }
	| { readonly kind: "migration-refused"; readonly stage: MigrationRefusal }
	| { readonly kind: "handle-refused" }
	| { readonly kind: "stale-snapshot"; readonly reason: ModelStaleReason }
	| { readonly kind: "ok" }
	| { readonly kind: "drift"; readonly objects: ReadonlyArray<string> }

/**
 * What only the real system can show and the model never predicts: a hidden value in an error, notice or witness, or
 * the two artifacts of one read disagreeing. Either one is a failed run.
 */
export type Defect =
	| {
			readonly kind: "leak"
			readonly field: "message" | "detail" | "hint" | "where" | "notice" | "witness"
			readonly token: string
	  }
	| { readonly kind: "artifacts-disagree" }

/** What one action did on the real system: an outcome the model can predict, or a defect it never allows. */
export type Observation = ActionOutcome | Defect

/**
 * What the executor reads from a session's connection to check the real system entered the state the model claims. An
 * aborted transaction refuses every statement, so it shows nothing but that it is aborted. `claims` is "" when no claims
 * are set: PostgreSQL spells an unset placeholder and an ended transaction-local setting alike.
 */
export type Probe =
	| { readonly transaction: "aborted" }
	| {
			readonly transaction: "idle" | "in-transaction"
			readonly currentUser: string
			readonly claims: string
	  }

/**
 * The installation a Db's snapshot describes, at its version, with its names and host schema: grizzle judges a call on
 * the host by it, before any SQL, and the call's prologue refuses as `migrated` once the state's version moved past it.
 */
export interface Snapshotted {
	readonly version: number
	readonly install: InstallSpec
	readonly names: InstalledNames
	readonly host: HostSchema
}

/**
 * What the snapshot guard of a Db's every transaction holds the ledger to: its snapshot's version (`held`), or a
 * snapshot no migration of the installation lands (`never`: an older version's, another schema's), whose calls the
 * guard always refuses.
 */
export type SnapshotGuard = "held" | "never"

/**
 * Whether PostgreSQL admits every refined claim of a Db's facts where a statement reads it (`admitted`), or refuses one
 * (`refused`): Db.open judges no claim against the database, so a Db opens either way.
 */
export type ClaimsJudged = "admitted" | "refused"

/**
 * A Db: its login and role, the facts its claims decode to and whether PostgreSQL admits them, its pooled connection,
 * the snapshot it was opened with and what its guard holds the ledger to.
 */
export interface DbSessionState {
	readonly kind: "db"
	readonly login: string
	readonly role: string
	readonly facts: ContextFacts
	readonly claims: ClaimsJudged
	readonly connection: number
	readonly snapshot: Snapshotted
	readonly guard: SnapshotGuard
}

/**
 * Who a direct writer begins its transaction as and the claims it sets, the README's direct-writer shape in one move:
 * its login or one of its login's roles (SET ROLE), and `grizzle.claims` or none, sent right after BEGIN
 * (startStatements), so the facts inside, outside and hidden from a role's world, and a login's statements under claims
 * it holds, are one statement away.
 */
export interface DirectStart {
	readonly current: DirectSessionState["current"]
	readonly claims: ClaimsStart
}

/** A direct SQL writer inside the one transaction it began: who it acts as, the claims it set, and what it sees. */
export interface DirectSessionState {
	readonly kind: "direct"
	readonly login: string
	readonly current: { readonly kind: "login" } | { readonly kind: "role"; readonly role: string }
	/** The claims it set, and what PostgreSQL reads from them (ClaimsRead), parsed once as the setting entered. */
	readonly claims:
		| { readonly kind: "none" }
		| { readonly kind: "set"; readonly setting: ClaimsSetting; readonly read: ClaimsRead }
	readonly isolation: Isolation
	readonly transaction: "open" | "aborted"
	/** The state the transaction sees: reality when it began, with its own statements applied; COMMIT makes it reality. */
	readonly view: HostState
	/** The reads this session prepared, by name; a direct session lives one transaction, and so do they. */
	readonly prepared: Readonly<Record<string, PreparedRead>>
	/**
	 * Every statement its direct actions sent the transaction, in order (BEGIN's own take on a role and set claims, which
	 * the session's world shows): what a refusal at COMMIT, which judges them, may quote (README "Errors and outcomes": the values a
	 * statement was given).
	 */
	readonly sent: ReadonlyArray<DirectStatement>
}

/** A session as the model tracks it: a Db, a direct writer, or one closed. */
export type ModelSession =
	| DbSessionState
	| DirectSessionState
	| { readonly kind: "closed"; readonly was: "db" | "direct" }

/** What a pooled connection still carries between transactions: nothing, when grizzle is correct. */
export interface ConnectionState {
	readonly login: string
	readonly leftover:
		| { readonly kind: "clean" }
		| { readonly kind: "role"; readonly role: string }
		| { readonly kind: "claims"; readonly text: string }
}

/**
 * Where the schema's ledger stands on the first pending folder: `unfinished` once it holds the folder's row, which the
 * runner records with the folder's first committed file, or, when that first file runs outside a transaction (new enum
 * labels, concurrent indexes), in a transaction of its own before the file's statements; `untouched` while it holds no
 * row of it, a first file that runs in a transaction having failed or been killed before it committed, so the catalog
 * is exactly the installation's. While a folder is unfinished every Db call and every Db.open is refused (README
 * "Deploying").
 */
export type LedgerStanding = "untouched" | "unfinished"

/**
 * The migrations directory: every folder applied, or the last folders installing a drafted version that a run stopped
 * part-way through (at a law statement its data breaks, or by a run that stopped). Each file is its own transaction, so
 * the files before that point stay committed and recorded. The pending folders run oldest first: a later migrate or
 * drift resumes them, landing each whose data holds and stopping at the first that breaks.
 */
export type MigrationsState =
	| { readonly kind: "applied" }
	| {
			readonly kind: "pending"
			readonly folders: Arr.NonEmptyReadonlyArray<InstallSpec>
			readonly ledger: LedgerStanding
	  }

/** The whole world as the model sees it. */
/** An entry of a role, by its name, with how the installation's base classes it (model/host.ts classifyEntry). */
export interface ClassedEntry {
	readonly name: string
	readonly entry: EntrySpec
	readonly classified: EntryClass
	/**
	 * A writable query entry's one rule and the index of its supplying occurrence, by which a fact of its target is
	 * judged a member (model/host.ts isMember); undefined for a whole entry and a read-only one.
	 */
	readonly supply: { readonly rule: Rule; readonly supplier: number } | undefined
}

/**
 * A role of the installation as its base classes it, once per installation (model/session/writes.ts installedRoles):
 * each entry classed, and the relations its write list writes through them, in that list's order.
 */
export interface InstalledRole {
	readonly entries: ReadonlyArray<ClassedEntry>
	readonly written: ReadonlyArray<Written>
}

export interface ModelState {
	readonly install: InstallSpec
	readonly names: InstalledNames
	readonly host: HostSchema
	/** Each role of `install`, by its name, as the base classes it: what every call reads its entries and writes by. */
	readonly roles: Readonly<Record<string, InstalledRole>>
	readonly reality: HostState
	/** Each derived relation's facts as of its last refresh. */
	readonly derived: Readonly<Record<string, ReadonlyArray<HostFact>>>
	readonly sessions: ReadonlyArray<ModelSession>
	readonly connections: ReadonlyArray<ConnectionState>
	readonly tampered: ReadonlyArray<CatalogPerturbation>
	/**
	 * The installation's version: it advances when a migration to another installation completes, and stays when one
	 * lands the installation it replaces, whose snapshot is the same.
	 */
	readonly version: number
	/**
	 * The version whose migration created each installed login's PostgreSQL role, 0 for the first installation's: a
	 * login a migration drops and a later one creates again is another role (a migration drops a removed login and
	 * declines every rename, so it never carries one over), and a Db opened before holds a connection of no role.
	 */
	readonly loginsCreated: Readonly<Record<string, number>>
	readonly migrations: MigrationsState
}

/** One allowed outcome of an action and the state it leads to; an action may allow several (nature's choices). */
export interface Branch {
	readonly observation: ActionOutcome
	readonly next: ModelState
}

/**
 * What a landed migration's state follows from: the installation it landed, whose names are the compiler's to give, and
 * the state it leads to under them (step.ts settle).
 */
export interface Landing {
	readonly install: InstallSpec
	readonly complete: (names: InstalledNames) => ModelState
}

/** One allowed outcome of a migration that lands an installation, the state it leads to awaiting that one's names. */
export interface Landed {
	readonly observation: ActionOutcome
	readonly landing: Landing
}

/** One allowed outcome of an action: a branch, or, for a run that lands an installation, a landing awaiting its names. */
export type Allowed = Branch | Landed

/** The invariants every state and every observation must keep. */
export type InvariantName =
	| "laws-hold"
	| "no-hidden-value"
	| "claims-end-with-transaction"
	| "role-ends-with-transaction"
	| "login-isolation"
	| "deleted-means-gone"
	| "least-privilege"

export interface InvariantViolation {
	readonly invariant: InvariantName
	readonly detail: string
}

/** Every kind of invalid input, by name, so a suite can require that each was drawn. */
export type InvalidKind =
	| `token:${TokenWild}`
	| `token:stale:${StaleSource}`
	| `claims:${ClaimsSetting["kind"]}:${SettingScope}`
	| `role:${Exclude<RoleRef["kind"], "own">}`
	| "fact:law-broken"
	| "fact:outside-world"
	| "fact:hidden-key-collision"
	| "fact:hidden-reference"
	| "fact:deleted-reference"
	| "fact:duplicate-in-input"
	| "fact:partial-serial"
	| "fact:filtered-serial-omitted"
	| "fact:domain-refused"
	| "handle:closed-db"
	| "handle:closed-direct"
	| "handle:wrong-kind"
	| "handle:other-role"
	| "handle:other-login"
	| "handle:stale-snapshot"
	| "handle:foreign-snapshot"
	| "handle:stale-db"
	| "handle:wild-js-value"
	| `catalog:${CatalogPerturbation["kind"]}`
	| "migration:half-applied"
	| "migration:hand-edited"
	| "migration:law-over-violating-data"
	| "migration:roster-removal-held"
	| "migration:roster-reorder"
	| "install:unwritable-write"
	| "install:two-writes-one-relation"
	| `isolation:${Exclude<Isolation, "serializable">}`
	| "session:interrupted"
	| "session:after-refusal"

/** Whether a fact is in the session's world, visible outside it, or hidden from it. */
export type Membership = "inside" | "outside-visible" | "hidden"

export type ClaimState = "absent" | "matching" | "not-matching" | "malformed"

export type Writer = "db" | "direct-role" | "direct-login"

export type ObjectKind =
	| "view"
	| "barrier-view"
	| "policy"
	| "filter-function"
	| "key-probe"
	| "advance-function"
	| "grant"
	| "revoke"
	| "membership"

/**
 * The closed feature vocabulary of the worlds suites: an operation in a situation with its outcome, a world object and
 * what was shown of it, an invalid input drawn, an invariant checked, the ambient session the case's owner sessions
 * started under, a feature of a name the installation drew from the kernel dictionary, a base object or a role
 * entry named after a PostgreSQL type, and a generated addition through a query entry that stores a serial value it
 * supplies, one its filter reads or its fill fixes, which the driver holds to the model's committed state; how a read
 * went (its path, the key a page's order is completed by and where it starts, an attachment that nested rows, a
 * recursive read that chained past one step, a span read through a world, a context field of a domain decoded from
 * the token and read); the SQLSTATE a direct writer's read met for a hand-set claim its field's type refuses, by the
 * field's domain; how each read-back stood to the change; the law family a refused write met, the path it took and
 * what its witness showed; and the shape of relation an accepted write through a world changed.
 */
export type WorldFeature =
	| AmbientFeature
	| `name:${IdentifierFeature}`
	| "catalog-type name"
	| `op:${ActionKind}:${Membership}:${ClaimState}:${Writer}:${ActionOutcome["kind"]}`
	| `object:${ObjectKind}:${"hidden-row-absent" | "raise-suppressed" | "accepted-inside" | "refused-outside" | "attempt-refused" | "witness-shown" | "witness-withheld"}`
	| `invalid:${InvalidKind}`
	| `invariant:${InvariantName}`
	| `deletion:${"base-gone" | "world-gone" | "derived-kept" | "derived-refreshed"}`
	| `via:${ReadVia["kind"]}`
	| `page:${PageKey}:${PageFrom}`
	| "attach:nested"
	| "reach:chained"
	| "read:span"
	| `claim:${ClaimDomain}`
	| `claim-refused:${ClaimDomain}:${ClaimRefusal}`
	| `claim-refused-read:${RefinedClaim}:${ClaimReadAt}`
	| `readback:${ReadBackClass}`
	| `law:${LawFamily}:${LawPath}:${Witness["kind"]}`
	| "law:check:declared-key"
	| `write:${WriteShape}:${RelationSpec["mutability"]}:${"entry" | "whole"}:${EntryOp["kind"]}`
	| `strata:${"one" | "union" | "sequence" | "refused-order"}`
	| AdditionFeature
	| `migration:${MigrationKind}:${ActionOutcome["kind"]}`
	| "addition:generated:entry:supplied-serial"
	| `connection:${"shared-by-roles" | "after-commit" | "after-no-change" | "after-invariant-rejected" | "after-outside-world" | "after-compile-refused" | "after-transient" | "after-interrupted" | "after-stale-snapshot"}`

/**
 * The key grizzle completes a page's order with, by the relation paged: a key it proves of a role's entry short of its
 * whole heading (a table's primary key, through a whole entry or a query entry that keeps it); a key of a derived
 * relation, which its stored query proves; or the whole heading, a set's own key.
 */
export type PageKey = "proven-key" | "derived-key" | "heading-key"

/**
 * How a read-back's delta stands to the change, by README "Writes"' rule (session/apply.ts deltaOf): `untouched`, the
 * change writes nothing the relation's definition reads, so its delta is empty; `written`, the relation is written and
 * the change writes nothing else its definition reads, so its delta is its target's; `beside`, a whole entry over a
 * target the change writes through another entry, whose delta is the target's own; `undetermined`, any other, whose
 * rows moving in or out depend on more than the change, which grizzle refuses when the ChangeSet compiles.
 */
export type ReadBackClass = "untouched" | "written" | "beside" | "undetermined"

/**
 * The family of the law a refusal names (README "Rules"): a key or a no-overlap key (a primary or a candidate one), a
 * row check, a contract's or a pattern's domain CHECK, a containment, a coverage, or one of an alternatives law's
 * containments.
 */
export type LawFamily =
	| "key"
	| "span-key"
	| "check"
	| "domain"
	| "contained"
	| "covered"
	| "alternatives"

/**
 * How a refused write reached its law: a Db's ChangeSet writing through a query entry, a partial world, or through whole
 * entries alone; or a direct writer's statement as the role it took on.
 */
export type LawPath = "entry" | "whole" | "direct"

/**
 * A shape of relation a write through a world meets: keyed WITHOUT OVERLAPS (a span in its primary key), or a pure set
 * (every field in its primary key).
 */
export type WriteShape = "span-key" | "pure-set"

/** The domain kinds a context field takes (README "Permissions"): never a serial or a span. */
type ClaimDomain = Exclude<FieldDomain["kind"], "serial" | "span">

/**
 * The SQLSTATEs a hand-set claim its field refuses meets where a statement reads it (README "Direct SQL access"): no
 * value of its type, an integer past its range, a value its contract, pattern or roster refuses.
 */
export type ClaimRefusal = Extract<SqlState, "22P02" | "22003" | "23514">

/** The domain kinds of a refined claim, the ones whose refusal is 23514: a contract, a pattern and a roster. */
export type RefinedClaim = Extract<ClaimDomain, "contract" | "text" | "handle">

/** Where a statement reads a claim: delivered into an output column, or only in a filter. */
export type ClaimReadAt = "output" | "filter"

/**
 * An applied insertion, by its facts' serial class (complete, or generated: leaving out every classed serial field),
 * the role relation it goes through (a whole entry or a query entry), and what its relation's generated class carries:
 * some field, or none, the unit relation (README "Writes", "Writing through a role").
 */
export type AdditionFeature =
	`addition:${"complete" | "generated"}:${"whole" | "entry"}:${"carried" | "unit"}`

/**
 * What a migration changes, as its (migration kind, verdict) feature reads it: a roster grown by a handle, a roster
 * losing one (a hole its VALIDATE judges), a roster declared out of its codes' order (D1), a law added, or the
 * installation otherwise.
 */
const MIGRATION_KINDS = [
	"roster-growth",
	"roster-removal",
	"roster-reorder",
	"law-added",
	"install"
] as const

export type MigrationKind = (typeof MIGRATION_KINDS)[number]

/** The weights a run draws its actions with: swarm testing draws a fresh set per run. */
export type ActionWeights = Readonly<Record<ActionKind, number>>

/** Live, stale and wild shares of every drawn input, drawn per run. */
export interface ValidityWeights {
	readonly live: number
	readonly stale: number
	readonly wild: number
}

/** The bounds of the exhaustive box. */
export interface SmallScope {
	readonly relations: number
	readonly rules: number
	readonly contexts: number
	readonly subjects: number
	readonly facts: number
	readonly depth: number
}
