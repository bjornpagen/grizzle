import type { CursorGeneration } from "#compiler/codec/cursor/identity.ts"
import type { DecoderForm } from "#compiler/core/decoder.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import type {
	ColumnIdent,
	DomainName,
	GeneratedLawId,
	LawId,
	RelationIdent,
	SchemaFingerprint
} from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Prepared } from "#compiler/core/prepared.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import type { ConstraintLaws, PageFill, ParamDecl } from "#compiler/ir/products.ts"
import type { CompletedOrder, Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
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
	ServedReadBack,
	ServedRoots,
	ServedSource,
	ServedSpecified,
	ServedSpine
} from "#compiler/served/read.ts"
import type { EmittedText, ObjectName } from "#compiler/sql/ast.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
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
 * table, every occurrence its index, and each Roster by its declared name, rebuilt from the file's own codes.
 */
export interface ServedFile {
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
	/** The texts of every Db transaction's prologue the file fixes: the ledger's fence, then entering the snapshot guard. */
	readonly prologue: ServedPrologue
	/** The texts every session of the login sends besides its programs': its startup options and its transactions'. */
	readonly session: ServedSession
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
	/** The login's roles, in the login's declared order. */
	readonly roles: ReadonlyArray<ServedRoleForm>
}

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
 * What a Db over the login's base knows of the levels above it (adapter witness/keylaw.ts LawsAbove), cut to what the
 * login's refusals may name: their PostgreSQL schemas, each constraint above the base a member's statement may meet,
 * under its owner, with its law, and each such law by its identity, as the level that states it names it.
 */
export interface ServedAbove {
	readonly schemas: ReadonlyArray<string>
	readonly constraints: ConstraintLaws
	readonly laws: ReadonlyMap<LawId, Law>
}

/** The directory, beside snapshot.json, that holds a schema's served files. */
export const servedDirectory = "served"

/** The file of a login's served workload, within its schema's migrations directory. */
export const servedPath = (login: string): string => `${servedDirectory}/${login}.json`

/**
 * One role of a login as its Dbs serve it: its name in the login, its installed PostgreSQL role, the isolation level its
 * writes begin at, the contexts its relations read, typed, which a Db's claims are decoded through, the classifier of
 * its refusals, and its workload members in the workloads' order, each program's own record order.
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
 * One program of a role's workload, by name: a query or ordered query read for its rows; an ordered query that pages,
 * with its page; a key, whose lookup reads by the key's values; a ChangeSet, compiled for each set of its fill
 * contexts that may hold a fact; or a refresh of materialized derived relations, its targets in refresh order.
 */
export type ServedMember = { readonly name: string } & (
	| { readonly kind: "read"; readonly read: ServedRead }
	| { readonly kind: "paged"; readonly read: ServedRead; readonly page: ServedPage }
	| { readonly kind: "key"; readonly fields: ReadonlyArray<string>; readonly read: ServedRead }
	| { readonly kind: "change"; readonly variants: ServedVariants }
	| { readonly kind: "refresh"; readonly refresh: ServedRefresh }
)

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
 * parameters and its targets, each by its place in refresh order and its view's name; and the DO block that refreshes every target, each plain or CONCURRENTLY
 * as PostgreSQL holds it populated, in one statement. The catalog statement and the block are sent, each named
 * (core/prepared.ts); a target's two statements are only reported.
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
 * the decoder of its records, and whether get may read it (proved at most one row per parameter binding).
 */
export interface ServedRead {
	readonly params: ReadonlyArray<ParamDecl>
	readonly source: ServedSource
	readonly spine: ServedSpine
	readonly decoder: DecoderForm
	readonly getEligible: boolean
}

/** A page statement: a page placeholder is the page's own, a choice a relation parameter's count or the page's size. */
export type ServedPageStatement<F extends PageFill = PageFill> = ServedSpecified<
	PageStatementSlot<F>,
	ChoiceInput
>

/**
 * One request variant of a page (lower/shapes/page/compile.ts PageRequestProgram): its statements, with how it fetches,
 * the flag its lookahead row proves, an anchored variant's probe, and how it delivers its rows.
 */
export type ServedPageRequest<V extends PageVariant = PageVariant> = {
	readonly [P in V]: Omit<PageRequestProgram<P>, "roots"> & {
		readonly roots: ServedRoots<ServedPageStatement<VariantFill[P]>>
	}
}[V]

/** One probe of a page: its one statement, delivering one row of its one Boolean column. */
export interface ServedPageProbe<K extends ProbeKind> {
	readonly kind: K
	readonly statement: ServedPageStatement
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
 * members may meet, the laws of the levels above the role's own the file's (ServedFile above): its levels' PostgreSQL
 * schemas; every installed constraint a member's statement may meet, with its owner and laws; every law of the theory under its identity; each stored relation's table; each roster's two
 * domains; and each generated field's law, with its identity, by its table and column.
 */
export interface ServedKeyLaws {
	readonly schemas: ReadonlyArray<string>
	readonly constraintLaws: ReadonlyArray<ConstraintLaw>
	readonly theoryLaws: ReadonlyArray<DescribedLaw>
	readonly tables: ReadonlyMap<string, RelationIdent>
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

/** A query entry a role writes through, by its target: the entry's name, and each head field to the target field it writes. */
export interface ServedEntryKey {
	readonly entry: string
	readonly head: ReadonlyMap<string, string>
}

/**
 * The classifier of a role's refusals as data (adapter witness/index.ts InstallationWitness): its key laws, each stored
 * relation's heading, which a refusal's key text decodes through, and the query entries the role writes through.
 */
export interface ServedRefusals {
	readonly laws: ServedKeyLaws
	readonly relations: ReadonlyMap<string, Heading>
	readonly entries: ReadonlyMap<string, ServedEntryKey>
}
