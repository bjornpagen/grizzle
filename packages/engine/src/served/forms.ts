import type { CursorGeneration } from "#compiler/codec/cursor/identity.ts"
import type { DecoderForm } from "#compiler/core/decoder.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import type {
	ColumnIdent,
	DomainName,
	EntryName,
	GeneratedLawId,
	LawId,
	RelationIdent,
	SchemaFingerprint,
	StoredRelationName
} from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Prepared } from "#compiler/core/prepared.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import type { ConstraintLaws, PageFill, ParamDecl } from "#compiler/ir/products.ts"
import type { CompletedOrder, Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type { ServedWire } from "#compiler/live/member.ts"
import type { PageStatementSlot } from "#compiler/lower/conservative/types.ts"
import type { PageRequestProgram } from "#compiler/lower/shapes/page/compile.ts"
import type {
	PageComparator,
	PageVariant,
	ProbeKind,
	VariantFill
} from "#compiler/lower/shapes/page/seek.ts"
import type { ChoiceInput } from "#compiler/lower/shapes/take/index.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import type { ClosedTable } from "#compiler/runtime/write/fill.ts"
import type { ServedWrite } from "#compiler/runtime/write/flight.ts"
import type { ArrayMember } from "#compiler/runtime/write/members.ts"
import type { ServedMatchers } from "#compiler/scalar/regex/matcher.ts"
import type {
	ServedProgram,
	ServedReadBack,
	ServedSource,
	ServedSpine
} from "#compiler/served/read.ts"
import type { EmittedText, ObjectName } from "#compiler/sql/ast.ts"
import type { AboveLaw, Law } from "#compiler/types/changeset/changeset.ts"
import type { ParamValue } from "#compiler/types/core/phantom.ts"

/**
 * A login's served workload: what `grizzle generate` compiles for each login of the config, once, and commits as
 * `migrations/<schema>/served/<login>.json` (servedPath) under the snapshot's fingerprint, and the only thing a
 * running layer reads: it holds every fact of the installation its programs, prologue and refusals read, and nothing
 * else of the snapshot. Every member is pure data: records, arrays, strings, finite numbers, booleans, bigints, Maps,
 * Sets, ScalarTypes and canonical values (a Decimal, a Money, a Roster). What runs a member, its codecs, readers,
 * decoders, merges and classifier, is rebuilt from it at load, under the codebook of its own rosters, by the
 * constructors the compile path runs it through too.
 *
 * The file is canonical JSON (served/json.ts), so `grizzle check` compares bytes: each ScalarType once in its types
 * table, every occurrence its index; its rosters' codes in their own form (served/json.ts RosterWire), each roster's
 * handles in code order, a hole `false`; and each Roster by its declared name, rebuilt over the file's own codes.
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
	 * The installed tables and materialized views of the relations the login's statements read and write, its
	 * footprint (adapter served/compile.ts), each with the name of every index PostgreSQL holds on it (ServedTables):
	 * what an explain names a plan's relations and indexes by, cut by generate from the snapshot's, whose reasons for
	 * each index stay in snapshot.json.
	 */
	readonly tables: ServedTables
	/** The login's roles, in the login's declared order. */
	readonly roles: ReadonlyArray<ServedRoleForm>
}

/**
 * An installed table or materialized view as a served file names it: the declared name of the relation it stores, and
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
 * role's defaults (physical/ddl/roles.ts loginStartupOptions), each transaction's BEGIN at each isolation level, read
 * only or read write, and its COMMIT and ROLLBACK. A transaction begins at its role's level (ServedRoleForm isolation).
 */
export interface ServedSession {
	readonly startup: string
	readonly begin: {
		readonly [I in Isolation]: { readonly readOnly: EmittedText; readonly readWrite: EmittedText }
	}
	readonly commit: EmittedText
	readonly rollback: EmittedText
}

/**
 * An installation's live change source as a served file holds it (live/notify.ts LiveSource), emitted at generate
 * (program/live.ts servedLiveOf): none where the installation's live plan is empty; otherwise its names and the texts
 * its leader and its listeners send. The leader is the one process at a time holding `lock`, sent first on the
 * decoder login's replication connection, which takes simple queries alone; it creates the slot where `check` finds
 * none and streams its decoded changes (live/replication.ts), waits until each decoded transaction is `visible`, and
 * sends the round's sealed batches by `fanout`. A listener reads `secret`, LISTENs, and `check`s that the slot stands.
 *
 * - `publication`: the publication's name, the fan-out channel and the prefix of every announced message;
 * - `stem`: the replication slot's and the decoder login's stem, each named in the cluster under the installation's
 *   role space (core/identity.ts roleInSpace), which every slot parameter (`$1::name`) is filled with;
 * - `tables`: each published table by its installed identifier, with the columns it routes by;
 * - `secret`: the live secret's one cell, as hex (live/notify.ts parseLiveSecret);
 * - `lock`: the session-level advisory lock of the leadership, a simple query;
 * - `check`: whether the slot stands in the current database, not invalidated;
 * - `visible`: for each transaction id of `$1::text[]`, whether the statement's snapshot holds its commit;
 * - `fanout`: a notification on the channel for each payload of `$1::text[]`;
 * - `announce`: the sealed payload `$1::text` emitted as a transactional message under the publication's prefix, which
 *   the leader decodes and sends on with the transaction that announced it.
 */
export type ServedLive =
	| { readonly kind: "none" }
	| {
			readonly kind: "source"
			readonly publication: string
			readonly stem: string
			readonly tables: Readonly<Record<string, ReadonlyArray<string>>>
			readonly listen: EmittedText
			readonly lock: EmittedText
			readonly secret: Prepared<EmittedText>
			readonly check: Prepared<EmittedText>
			readonly visible: Prepared<EmittedText>
			readonly fanout: Prepared<EmittedText>
			readonly announce: Prepared<EmittedText>
	  }

/**
 * What a Db over the login's base knows of the levels above it (adapter witness/keylaw.ts LawsAbove), cut to what the
 * login's refusals may name: their PostgreSQL schemas, each constraint above the base a member's statement may meet,
 * under its owner, with its law, and each such law by its identity, as the level that states it names it.
 */
export interface ServedAbove {
	readonly schemas: ReadonlyArray<string>
	readonly constraints: ConstraintLaws
	readonly laws: ReadonlyMap<LawId, AboveLaw>
}

/** The directory, beside snapshot.json, that holds a schema's served files. */
export const servedDirectory = "served"

/** The file of a login's served workload, within its schema's migrations directory. */
export const servedPath = (login: string): string => `${servedDirectory}/${login}.json`

/**
 * One role of a login as its Dbs serve it: its name in the login, its installed PostgreSQL role, the isolation level
 * its writes begin at, the contexts its relations read, typed, which a Db's claims are decoded through, the classifier
 * of its refusals, and its workload members in the workloads' order, each program's own record order.
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
	readonly members: ReadonlyArray<ServedMember>
}

/**
 * A context of a role: its name, the claim its facts are read from (none for the claims' top level), and its fields
 * typed against the base, in code-unit order.
 */
export interface ServedContext {
	readonly name: string
	readonly claim: string | undefined
	readonly fields: ReadonlyArray<HeadingColumn>
}

/**
 * One program of a role's workload, by name, as its compile serves it: a query or ordered query read for its rows; an
 * ordered query that pages, with its page; a key, whose lookup reads by the key's values; a ChangeSet, compiled for each
 * set of its fill contexts that may hold a fact; or a refresh of materialized derived relations, its targets in refresh
 * order.
 */
export type ServedMemberForm = { readonly name: string } & (
	| { readonly kind: "read"; readonly read: ServedRead }
	| { readonly kind: "paged"; readonly read: ServedRead; readonly page: ServedPage }
	| { readonly kind: "key"; readonly fields: ReadonlyArray<string>; readonly read: ServedRead }
	| { readonly kind: "change"; readonly variants: ServedVariants }
	| { readonly kind: "refresh"; readonly refresh: ServedRefresh }
)

/**
 * One program of a role's workload as its served file holds it: its form, and its wire (live/member.ts ServedWire), the
 * shape its HTTP calls take and answer with and that shape's digest, which generate reads off the form once, so a
 * layer, a client and the OpenAPI document read it and none derives it again.
 */
export type ServedMember = ServedMemberForm & { readonly wire: ServedWire }

/**
 * A materialized view one refresh call refreshes, in refresh order (lower levels first, then declared order): its
 * derived relation's declared name, which a refusal names, and the view's qualified name.
 */
export interface ServedRefreshTarget {
	readonly relation: string
	readonly view: ObjectName
}

/**
 * One refresh call, served with every text it sends, printed once by generate (adapter refresh/statements.ts
 * refreshPlan): its targets in refresh order, each with its view's plain and CONCURRENTLY refresh statements, which the
 * call's report names; the catalog statement that reads which views of one PostgreSQL schema PostgreSQL holds
 * populated, run once per schema the targets' views live in, in their first target's order, with that schema's
 * parameters and its targets, each by its place in refresh order and its view's name; and the DO block that refreshes
 * every target, each plain or CONCURRENTLY as PostgreSQL holds it populated, in one statement. The catalog statement
 * and the block are sent, each named (core/prepared.ts); a target's two statements are only reported.
 */
export interface ServedRefresh {
	readonly targets: NonEmptyReadonlyArray<
		ServedRefreshTarget & { readonly plain: EmittedText; readonly concurrently: EmittedText }
	>
	readonly populated: Prepared<EmittedText>
	readonly schemas: NonEmptyReadonlyArray<{
		readonly params: ReadonlyArray<ParamText>
		readonly targets: NonEmptyReadonlyArray<{ readonly place: number; readonly view: string }>
	}>
	readonly block: Prepared<EmittedText>
}

/**
 * A query or ordered query compiled for a role's rows: its declared parameters, its artifact, its delivered spine,
 * the decoder of its records, the key each of its delivered rows is told apart by, and its footprint.
 */
export interface ServedRead {
	readonly params: ReadonlyArray<ParamDecl>
	readonly source: ServedSource
	readonly spine: ServedSpine
	readonly decoder: DecoderForm
	readonly key: ServedKey
	readonly footprint: ServedFootprint
}

/**
 * What tells a read's delivered rows apart under one binding, by the shape its answer is (live/events.ts): the tuple of
 * the decoded values of `fields`, head fields of its records, in order. A set's rows are keyed by the key its delivery
 * proves (lower/conservative/keys.ts KeySetProof), or by every head field of every heading group where it proves none,
 * and none at all is the key of at most one row; a list's, an ordered read's or a page's, by the fields of the completed
 * order it delivers them in, which a row after another is placed by.
 */
export type ServedKey =
	| { readonly kind: "set"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "list"; readonly fields: ReadonlyArray<string> }

/**
 * The routes of an installed table a read reads (logical/routes.ts Routes): each routed column, by its installed
 * identifier, to the declared name of the scalar parameter the read fixes it to. A change of the table's row reaches a
 * binding when the row's text in some routed column is that parameter's canonical text there; none routes every
 * change of the table to every binding.
 */
export type ServedRoutes = Readonly<Record<string, string>>

/**
 * What a read's answer depends on (logical/routes.ts Footprint): each stored relation's table and each materialized
 * derived relation's view it reads, by its installed identifier, with its routes, a view's none, since a refresh
 * replaces its rows at once.
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
 * One request variant of a page (lower/shapes/page/compile.ts PageRequestProgram): its program, with how it fetches,
 * the flag its lookahead row proves, an anchored variant's probe, and how it delivers its rows.
 */
export type ServedPageRequest<V extends PageVariant = PageVariant> = {
	readonly [P in V]: Omit<PageRequestProgram<P>, "program"> & {
		readonly program: ServedPageProgram<VariantFill[P]>
	}
}[V]

/** One probe of a page: its program of one part, delivering one row of its one Boolean column. */
export interface ServedPageProbe<K extends ProbeKind> {
	readonly kind: K
	readonly program: ServedPageProgram
	readonly column: HeadingColumn
}

/**
 * An ordered query's page: its completed order, its cursor's comparators, its delivered heading, each request
 * variant's and probe's statements with their specs emitted, the query's semantic fingerprint and its schema's cursor
 * generation, which the cursor codec is rebuilt from. Its parameters and spine are its read's.
 */
export interface ServedPage {
	readonly order: CompletedOrder
	readonly comparators: ReadonlyArray<PageComparator>
	readonly heading: Heading
	readonly requests: { readonly [V in PageVariant]: ServedPageRequest<V> }
	readonly probes: { readonly [K in ProbeKind]: ServedPageProbe<K> }
	readonly query: string
	readonly generation: CursorGeneration
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
		readonly law: Extract<Law, { readonly kind: "generated" }>
		readonly id: GeneratedLawId
	}>
}

/**
 * A query entry a role writes through, by its target: the entry's name, and each head field to the target field it
 * writes.
 */
export interface ServedEntryKey {
	readonly entry: EntryName
	readonly head: ReadonlyMap<string, string>
}

/**
 * The classifier of a role's refusals as data (adapter witness/index.ts InstallationWitness): its key laws, each stored
 * relation's heading, which a refusal's key text decodes through, and the query entries the role writes through.
 */
export interface ServedRefusals {
	readonly laws: ServedKeyLaws
	readonly relations: ReadonlyMap<StoredRelationName, Heading>
	readonly entries: ReadonlyMap<StoredRelationName, ServedEntryKey>
}
