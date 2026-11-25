import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { DecoderForm } from "#compiler/core/decoder.ts"
import type { DeclaredName, ParamPlace } from "#compiler/core/identity.ts"
import type {
	ColumnIdent,
	DomainName,
	GeneratedLawId,
	LawId,
	RelationIdent,
	SchemaFingerprint,
	StoredRelationName
} from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { Prepared } from "#compiler/core/prepared.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import type { ContextFactSource } from "#compiler/ir/desc.ts"
import type { CallerParamDecl, ConstraintLaws, PageFill } from "#compiler/ir/products.ts"
import type { CompletedOrder, Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { RosterHandles } from "#compiler/ir/scalar.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type { RoleWire, ServedWire } from "#compiler/live/member.ts"
import type { PageStatementSlot } from "#compiler/lower/conservative/types.ts"
import type { PageRequestProgram } from "#compiler/lower/shapes/page/compile.ts"
import type { PageComparator, PageVariant, VariantFill } from "#compiler/lower/shapes/page/seek.ts"
import type { ChoiceInput } from "#compiler/lower/shapes/take/index.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import type { RecordedGenerated } from "#compiler/runtime/law-entry.ts"
import type { RecordsLayout } from "#compiler/runtime/records.ts"
import type { ClosedTable } from "#compiler/runtime/write/fill.ts"
import type { ServedWrite } from "#compiler/runtime/write/flight.ts"
import type { ArrayMember } from "#compiler/runtime/write/members.ts"
import type { EntryKey } from "#compiler/runtime/write/witness.ts"
import type { ServedMatchers } from "#compiler/scalar/regex/matcher.ts"
import type {
	ServedProgram,
	ServedReadBack,
	ServedSource,
	ServedSpine
} from "#compiler/served/read.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { AboveLaw, RecordedLaw } from "#compiler/types/changeset/changeset.ts"
import type { ParamValue } from "#compiler/types/core/phantom.ts"
import type { UnmatchedQuery } from "#compiler/write/unmatched.ts"

/**
 * A login's served workload: what `grizzle generate` compiles for each login of the config, once, and commits as
 * `migrations/<schema>/served/<login>.json` (servedPath) under the snapshot's fingerprint, and the only thing a
 * running layer reads: it holds every fact of the installation its programs, prologue and refusals read, and nothing
 * else of the snapshot. Every member is pure data: records, arrays, strings, finite numbers, booleans, bigints, Maps,
 * Sets, ScalarTypes and canonical values (a Decimal, a Money, a Roster). What runs a member, its codecs, readers,
 * decoders, merges and classifier, is rebuilt from it at load, under the codebook of its own rosters, by the
 * constructors the compile path runs it through too.
 *
 * The file is canonical JSON (served/json.ts), so `grizzle check` compares bytes: each repeated shape once in its
 * table, every other place it stands a reference to its entry; its rosters' codes in their own form (served/json.ts
 * RosterWire), each roster's handles in code order, a hole `false`; and each Roster by its declared name, rebuilt over
 * the file's own codes.
 */
export type ServedFile = {
	/** The login's declared name, which names its file. */
	readonly login: string
	/** The snapshot fingerprint the file was compiled under; a layer refuses a file whose snapshot it does not serve. */
	readonly fingerprint: SchemaFingerprint
	/** The declared name of the level the login is over, and that level's index among the snapshot's levels. */
	readonly base: string
	readonly level: number
	/** The login's PostgreSQL role, and the PostgreSQL schema of its base. */
	readonly role: string
	readonly schema: string
	/**
	 * The texts of every Db transaction's prologue the file fixes: the ledger's fence, then entering the snapshot guard.
	 */
	readonly prologue: ServedPrologue
	/** The texts every session of the login sends besides its programs': its startup options and its transactions'. */
	readonly session: ServedSession
	/** The installation's live change source, which the login's live reads are woken by (ServedLive). */
	readonly live: ServedLive
	/**
	 * The codes of exactly the rosters the login's members read or write, by declared name: the codebook its codecs,
	 * readers and classifier are rebuilt under, so the file is all a layer reads.
	 */
	readonly rosters: ReadonlyMap<DeclaredName, RosterCodes>
	/**
	 * Every pattern the login's types read, each with its automaton as generate built it, over one table of the char sets
	 * their edges step on (scalar/regex/matcher.ts ServedMatchers): what a layer judges every refined value by, so it
	 * parses no pattern.
	 */
	readonly matchers: ServedMatchers
	/**
	 * Each closed relation the login's writes evaluate, once, by name (runtime/write/fill.ts ClosedTable): every write's
	 * binding and witness name the ones they read, and a layer prepares each against this table.
	 */
	readonly closed: ClosedTable
	/** What the login's refusals may name of the levels above its base, which a refusal names by its level. */
	readonly above: ServedAbove
	/**
	 * The installed tables of the relations the login's statements read and write, its
	 * footprint (adapter served/compile.ts), each with the name of every index PostgreSQL holds on it (ServedTables):
	 * what an explain names a plan's relations and indexes by, cut by generate from the snapshot's, whose reasons for
	 * each index stay in snapshot.json.
	 */
	readonly tables: ServedTables
	/** The login's roles, in the login's declared order. */
	readonly roles: ReadonlyArray<ServedRoleForm>
	/**
	 * Each records (program/records.ts records) its base's levels list whose relation the login's statements read or
	 * write, by its stem (ServedRecords): what a served login's recordedOf reads a found row's text and the insert of found
	 * rows by, so a process that serves the login builds both with no records value, query or schema at hand.
	 */
	readonly records: ReadonlyMap<string, ServedRecords>
}

/**
 * A records as a served file carries it (ServedFile records): its query's rows' decoder form, which its found rows'
 * one text is read off (runtime/read/text.ts rowTextOf), each roster a code or set column of the form names as its
 * schema declares it, its handles in their declared order, and its layout, which the insert of found rows is worked
 * out from (runtime/records.ts recordsFacts).
 */
export interface ServedRecords {
	readonly form: DecoderForm
	readonly rosters: ReadonlyMap<string, RosterHandles>
	readonly layout: RecordsLayout
}

/**
 * An installed table as a served file names it: the declared name of the relation it stores, and
 * the names of the indexes PostgreSQL holds on it, in code-unit order (deploy/snapshot/types.ts SnapshotTable, its
 * reasons left in snapshot.json).
 */
export interface ServedTable {
	readonly relation: string
	readonly indexes: ReadonlyArray<string>
}

/** A login's installed tables, by their PostgreSQL schema, then by their own name (ServedTable). */
export type ServedTables = Readonly<Record<string, Readonly<Record<string, ServedTable>>>>

/**
 * The prologue texts of the installation's ledger (deploy/ledger/ledger.ts LedgerStatements fence and enter), each
 * named (core/prepared.ts): every Db transaction sends both.
 */
export interface ServedPrologue {
	readonly fence: Prepared<EmittedText>
	readonly enter: Prepared<EmittedText>
}

/**
 * What every session of a login sends that no program states, emitted at generate: the startup options pinning its
 * role's defaults (physical/ddl/roles.ts loginStartupOptions), the startup options of every owner's session beside it,
 * the live leader's and a listener's, generic plans alone (ownerStartupOptions), each transaction's BEGIN, and its
 * COMMIT and ROLLBACK. A read begins SERIALIZABLE READ ONLY; a write begins read write at its role's level
 * (ServedRoleForm isolation).
 */
export interface ServedSession {
	readonly startup: string
	readonly ownerStartup: string
	readonly begin: {
		readonly read: EmittedText
		readonly write: { readonly [I in Isolation]: EmittedText }
	}
	readonly commit: EmittedText
	readonly rollback: EmittedText
	/**
	 * The read of a session's reap window from its server, one row of four settings, each as pg_settings reports it in
	 * its unit: tcp_keepalives_idle, tcp_keepalives_interval and tcp_keepalives_count in seconds, and
	 * idle_session_timeout in milliseconds (program/served.ts reapWindowRead). A pool sends it at a session's first lease
	 * and again, as the probe its answer is, before a lease runs anything on a session silent past the window (the
	 * shell's wire/pool.ts makePool).
	 */
	readonly reapWindow: EmittedText
}

/**
 * A served replication command (live/replication.ts): its text before the slot's quoted name and its text after it, so
 * the command is `before`, the name double-quoted with each `"` in it doubled, then `after`. The slot's name is the one
 * thing in it no generate knows, the live source's stem under the role space a layer reads at load, so a layer fills it
 * once it names the slot (live/replication.ts slotCommand).
 */
export interface SlotCommand {
	readonly before: string
	readonly after: string
}

/**
 * What a read's watch needs that its installation's live source does not give (UncoveredRead): the source itself, which
 * every watch needs for the version notice a migration ends it with; a table it reads that the source does not
 * publish; or a column of a published table it routes the table by that the source does not route it by, so a change
 * there reaches no subscription of the read.
 */
export type LiveGap =
	| { readonly kind: "source" }
	| { readonly kind: "table"; readonly table: string }
	| { readonly kind: "column"; readonly table: string; readonly column: string }

/**
 * A watchable read of a login whose watch the live source of the snapshot it compiles under does not serve, its `gaps`
 * (program/live.ts readGaps): a watch of it would miss every change there, or a migration, so the compile refuses it.
 * Only a snapshot of an installation migrated without the login's workload holds one, since generate builds the
 * installation's publication from the same workload.
 */
export interface UncoveredRead {
	readonly _tag: "UncoveredRead"
	readonly gaps: readonly [LiveGap, ...ReadonlyArray<LiveGap>]
}

/**
 * An installation's live change source as a served file holds it (live/notify.ts LiveSource), emitted at generate
 * (program/live.ts servedLiveOf): none where the login has no live read, every read of it answered (ServedReadLive
 * `answered`); otherwise its names and the texts its leader and its listeners send,
 * since every watch needs the source, a constant read's for the version notice a migration ends it with. The leader is
 * the one process at a time holding `lock`, sent first on the decoder login's replication connection, which takes
 * simple queries alone, each one of this source's texts: `lock`,
 * `senderTimeout`, and `createSlot` and `start` over the slot's name (SlotCommand). It reads its
 * stream's deadline by `senderTimeout`, creates the slot where `check` finds none, streams its decoded changes by
 * `start`, waits until a `snapshot` sees each decoded transaction, and sends the round's sealed batches by `fanout`. A
 * listener reads `secret`, LISTENs by `listen`, and `check`s that the slot stands, each a named prepared statement.
 *
 * - `publication`: the publication's name and the fan-out channel;
 * - `ledger`: the migrations ledger's table in the root's schema, which the publication publishes whole, so a change of
 *   it is a migration applied, which the leader fans out as `:migrated` (live/notify.ts), after which every watch is
 *   stale;
 * - `stem`: the decoder login's stem, named in the cluster under the installation's role space (core/identity.ts
 *   roleInSpace), and the stem of its replication slot, named in the cluster by the stem and the database it decodes
 *   (core/identity.ts liveSlotOf), which every slot parameter (`$1::name`) is filled with;
 * - `tables`: each published table by its installed identifier, an authored or a stored derived relation's, with the
 *   columns it routes by;
 * - `secret`: the live secret's one cell, as hex (live/notify.ts parseLiveSecret);
 * - `lock`: the session-level advisory lock of the leadership, a simple query;
 * - `senderTimeout`: the replication session's wal_sender_timeout in milliseconds, one row where its unit is `ms`
 *   (live/replication.ts parseSenderDeadline), a simple query;
 * - `createSlot`: CREATE_REPLICATION_SLOT of the slot, and `start`: START_REPLICATION of it from the position it last
 *   confirmed, over the publication, each its text around the slot's name;
 * - `check`: the position the slot stands at in the current database, not invalidated, its confirmed_flush_lsn, or an
 *   empty text where none stands, and the WAL's insert position, each its bytes from 0/0 in decimal (live/notify.ts
 *   WalPosition): a listener's source stands on the slot at its position, and a leader that finds none fans out an
 *   invalidation of the insert position, which names every slot that stood at or before it and none made since;
 * - `snapshot`: the statement's snapshot, pg_current_snapshot's text `xmin:xmax:xip,...` of 64-bit transaction ids,
 *   which the leader places each decoded transaction in (live/replication.ts placement);
 * - `fanout`: a notification on the channel for each payload of `$1::text[]`.
 */
export type ServedLive =
	| { readonly kind: "none" }
	| {
			readonly kind: "source"
			readonly publication: string
			readonly ledger: string
			readonly stem: string
			readonly tables: Readonly<Record<string, ReadonlyArray<string>>>
			readonly listen: Prepared<EmittedText>
			readonly lock: EmittedText
			readonly senderTimeout: EmittedText
			readonly createSlot: SlotCommand
			readonly start: SlotCommand
			readonly secret: Prepared<EmittedText>
			readonly check: Prepared<EmittedText>
			readonly snapshot: Prepared<EmittedText>
			readonly fanout: Prepared<EmittedText>
	  }

/**
 * What a Db over the login's base knows of the levels above it (adapter witness/keylaw.ts LawsAbove), cut to what the
 * login's refusals may name: their PostgreSQL schemas, each constraint above the base a member's statement may meet,
 * under its owner, with its law, and each such law by its identity, as the level that states it names it.
 */
export interface ServedAbove {
	readonly schemas: ReadonlyArray<string>
	readonly constraints: ConstraintLaws
	readonly laws: ReadonlyMap<LawId, AboveLaw<RecordedLaw>>
}

/** The directory, beside snapshot.json, that holds a schema's served files. */
export const servedDirectory = "served"

/** The file of a login's served workload, within its schema's migrations directory. */
export const servedPath = (login: string): string => `${servedDirectory}/${login}.json`

/**
 * One role of a login as its Dbs serve it: its name in the login, its installed PostgreSQL role, the isolation level
 * its writes begin at, the contexts it declares, typed, which a Db's claims are decoded through, the classifier
 * of its refusals, its wire (live/member.ts RoleWire), the witnesses its refusals may name on the wire, once for all its
 * members, and its workload members in the workloads' order, each program's own record order.
 */
export interface ServedRoleForm {
	readonly name: string
	/** The role's installed PostgreSQL role, as the naming door gives it, which every transaction of its Dbs enters. */
	readonly installed: string
	/**
	 * The level the role's writes begin at: SERIALIZABLE, until generate certifies a role for READ COMMITTED over the
	 * installation (analysis/isolation certify).
	 */
	readonly isolation: Isolation
	readonly contexts: ReadonlyArray<ServedContext>
	readonly refusals: ServedRefusals
	readonly wire: RoleWire
	readonly members: ReadonlyArray<ServedMember>
}

/**
 * A context of a role: its name, its source (ir/desc.ts ContextFactSource: a token's, with the claim its facts are read
 * from, none for the claims' top level, or attested by the server), and its fields typed against the base, in
 * code-unit order.
 */
export interface ServedContext {
	readonly name: string
	readonly source: ContextFactSource
	readonly fields: ReadonlyArray<HeadingColumn>
}

/**
 * One program of a role's workload, by name, as its compile serves it: a query or ordered query read for its rows; an
 * ordered query that pages, with its page; a key, whose lookup reads by the key's values, each read live or answered
 * (ServedReadLive); or a ChangeSet, compiled for each set of its fill contexts that may hold a fact.
 */
export type ServedMemberForm = MemberForm<{
	readonly read: ServedRead
	readonly page: ServedPage
	readonly variants: ServedVariants
}>

/**
 * What a program of a role's workload is read by, part by part: a read's, a key's and a paged one's read, a paged
 * read's page and a ChangeSet's variants, as a served file holds them (ServedMemberForm) or as a layer loaded them
 * (packages/grizzle adapter/served/load.ts LoadedMember).
 */
export interface MemberParts {
	readonly read: unknown
	readonly page: unknown
	readonly variants: unknown
}

/** One program of a role's workload, by name, of each kind its form takes (ServedMemberForm), over its parts `P`. */
export type MemberForm<P extends MemberParts> = { readonly name: string } & (
	| { readonly kind: "read"; readonly read: P["read"] }
	| { readonly kind: "paged"; readonly read: P["read"]; readonly page: P["page"] }
	| { readonly kind: "key"; readonly fields: ReadonlyArray<string>; readonly read: P["read"] }
	| { readonly kind: "change"; readonly variants: P["variants"] }
)

/**
 * One program of a role's workload as its served file holds it: its form, and its wire (live/member.ts ServedWire), the
 * shape its HTTP calls take and answer with and that shape's digest, which generate reads off the form once, so a
 * layer, a client and the OpenAPI document read it and none derives it again.
 */
export type ServedMember = ServedMemberForm & { readonly wire: ServedWire }

/**
 * How a read is called: `answered`, at its call's instant alone and never live, a read its member declares answered(...)
 * or a clocked one, since no change wakes it and time passing is no change, so its calls hold no watch, it subscribes
 * to nothing and needs no live source; or live, its watch woken from its footprint (logical/routes.ts Footprint):
 * `constant`, a read of closed relations alone, whose rows only a migration changes, so its watch subscribes to no row,
 * and only the installation's version notice ends it; `routed`, every other, by its footprint's tables and views, at
 * least one, and their routes. Whether an answered read reads the database's clock is its program's to state: under a
 * moved clock it declares the clock's stated instant (check/clock.ts sourcedParams).
 */
export type ServedReadLive =
	| { readonly kind: "answered" }
	| { readonly kind: "constant" }
	| { readonly kind: "routed"; readonly footprint: ServedFootprint }

/**
 * A query or ordered query compiled for a role's rows, as one call reads it: the declared parameters a call supplies,
 * its artifact, which prints a parameter its member binds to
 * the database's clock as the reading itself, its delivered spine, the decoder of its records, the key each of its
 * delivered rows is told apart by, and how it is called, answered or live (ServedReadLive).
 */
export interface ServedRead {
	readonly params: ReadonlyArray<CallerParamDecl>
	readonly source: ServedSource
	readonly spine: ServedSpine
	readonly decoder: DecoderForm
	readonly key: ServedKey
	readonly live: ServedReadLive
}

/**
 * What tells a read's delivered rows apart under one binding, and orders them: the tuple of the decoded values of
 * `fields`, head fields of its records, in order, the fields of the completed order it delivers them in (its stated
 * order completed by its key, or its key ascending where it states none, check/checker.ts rootOrder), which a row after
 * another is placed by (live/events.ts). None at all is the key of at most one row.
 */
export interface ServedKey {
	readonly fields: ReadonlyArray<string>
}

/**
 * The routes of an installed table a read reads (logical/routes.ts Routes): each routed column, by its installed
 * identifier, to the declared name of the scalar parameter the read fixes it to. A change of the table's row reaches a
 * binding when the row's text in some routed column is that parameter's canonical text there; none routes every
 * change of the table to every binding.
 */
export type ServedRoutes = Readonly<Record<string, string>>

/**
 * What a read's answer depends on (logical/routes.ts Footprint): each stored relation's table it reads, an authored or a
 * stored derived relation's, by its installed identifier, with its routes.
 */
export type ServedFootprint = Readonly<Record<string, ServedRoutes>>

/**
 * A page's program: a page placeholder is the page's own, a choice a relation parameter's count or the page's size.
 */
export type ServedPageProgram<F extends PageFill = PageFill> = ServedProgram<
	PageStatementSlot<F>,
	ChoiceInput
>

/**
 * One window variant of a page (lower/shapes/page/compile.ts PageRequestProgram): its program, with the direction it
 * fetches in and how it delivers its rows.
 */
export type ServedPageRequest<V extends PageVariant = PageVariant> = {
	readonly [P in V]: Omit<PageRequestProgram<P>, "program"> & {
		readonly program: ServedPageProgram<VariantFill[P]>
	}
}[V]

/**
 * An ordered query's page: its completed order, the comparators a window's anchor key is written by, its delivered
 * heading, and each window variant's statements with their specs emitted. Its parameters and spine are its read's.
 */
export interface ServedPage {
	readonly order: CompletedOrder
	readonly comparators: ReadonlyArray<PageComparator>
	readonly heading: Heading
	readonly requests: { readonly [V in PageVariant]: ServedPageRequest<V> }
}

/**
 * A ChangeSet compiled for one set of its fill contexts: its program, its read-backs, its reads decoder, the values its
 * declaration bound (ChangeSet.bind), by their private names, which a call's parameters are read beside, and the array
 * members a call supplies facts for, by relation (write/program/served-members.ts servedMembers). Its program is the
 * write as data (runtime/write/flight.ts ServedWrite), which a layer loads with loadWrite.
 */
export interface ServedChange {
	readonly program: ServedWrite
	/** Its read-backs, run after its writes, which its reads decoder reads (adapter apply/readback.ts). */
	readonly readBacks: ReadonlyArray<ServedReadBack>
	readonly decoder: DecoderForm
	readonly bound: ReadonlyMap<string, ParamValue>
	readonly members: ReadonlyArray<ArrayMember>
}

/**
 * A ChangeSet compiled for every set of its fill contexts that may hold a fact: a decision over those contexts, each
 * split by whether a Db's claims hold a fact of it, whose leaves are the changes compiled for the contexts the path
 * holds.
 */
export type ServedVariants =
	| { readonly kind: "change"; readonly change: ServedChange }
	| {
			readonly kind: "split"
			readonly context: string
			readonly holding: ServedVariants
			readonly lacking: ServedVariants
	  }

/**
 * The key-law tables of a role's installation as data (adapter witness/keylaw.ts KeyLaws), cut to what the role's
 * members' writes can raise (program/schema.ts raisableOf), the laws of the levels above the role's own the file's
 * (ServedFile above): its levels' PostgreSQL schemas; every installed constraint a member's statement may meet, with
 * its owner and laws, a domain's that types stored columns by the uses on the written tables; every law of the theory
 * a write statement may raise, under its identity; each written relation's table; the two domains of each roster that
 * types a written column; and each generated field's law, with its identity, by its table and column.
 */
export interface ServedKeyLaws {
	readonly schemas: ReadonlyArray<string>
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	readonly theoryLaws: ReadonlyArray<DescribedLaw>
	readonly tables: ReadonlyMap<StoredRelationName, RelationIdent>
	readonly rosterDomains: ReadonlyArray<{
		readonly roster: DeclaredName
		readonly code: DomainName
		readonly bits: DomainName
	}>
	readonly generated: ReadonlyArray<{
		readonly table: RelationIdent
		readonly column: ColumnIdent
		readonly law: RecordedGenerated
		readonly id: GeneratedLawId
	}>
}

/**
 * A parameter's pattern domain as a refusal by it names the parameter (physical/ddl/domains.ts paramDomainsOf): its
 * place, a scalar parameter or a field of a relation parameter's facts (core/identity.ts ParamPlace), and its pattern as
 * its type spells it.
 */
export interface ServedParamDomain {
	readonly param: ParamPlace
	readonly patterns: Patterns
}

/**
 * The classifier of a role's refusals as data (adapter witness/index.ts InstallationWitness): its key laws, each stored
 * relation's heading, which a refusal's key text decodes through, the query entries the role writes through, and the
 * pattern domains its members' parameters are cast to, by identifier, which generate names (paramDomainsOf), so a
 * refusal by one names its parameter with no compile at load; and the witness query of each deferred foreign key its
 * writes can raise at COMMIT (write/unmatched.ts), which names the row a refused COMMIT left unmatched.
 */
export interface ServedRefusals {
	readonly laws: ServedKeyLaws
	readonly relations: ReadonlyMap<StoredRelationName, Heading>
	readonly entries: ReadonlyMap<StoredRelationName, EntryKey>
	readonly params: ReadonlyMap<string, ServedParamDomain>
	readonly unmatched: ReadonlyArray<UnmatchedQuery>
}
