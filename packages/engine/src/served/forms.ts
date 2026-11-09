import type { CursorGeneration } from "#compiler/codec/cursor/identity.ts"
import type { Delivery } from "#compiler/core/decoder.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import type {
	ColumnIdent,
	DomainName,
	LawId,
	RelationIdent,
	SchemaFingerprint
} from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import type { ConstraintLaws, ParamDecl } from "#compiler/ir/products.ts"
import type { CompletedOrder, Delivered, Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type {
	DeclaredParamSlot,
	PageStatementSlot,
	ProgramDelivery,
	StatementRole
} from "#compiler/lower/conservative/types.ts"
import type { FusedLayout } from "#compiler/lower/shapes/attach/decode.ts"
import type { Arrival, StatementForms } from "#compiler/lower/shapes/index.ts"
import type { PageRequestProgram } from "#compiler/lower/shapes/page/compile.ts"
import type {
	PageComparator,
	PageVariant,
	ProbeKind,
	VariantFill
} from "#compiler/lower/shapes/page/seek.ts"
import type { ChoiceInput, RelationInput } from "#compiler/lower/shapes/take/index.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { HeadValue } from "#compiler/types/query/terms.ts"
import type { ParsedChangeSet } from "#compiler/write/changeset/value.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"

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
	readonly login: DeclaredName
	/** The snapshot fingerprint the file was compiled under; a layer refuses a file whose snapshot it does not serve. */
	readonly fingerprint: SchemaFingerprint
	/** The declared name of the level the login is over, and that level's index among the snapshot's levels. */
	readonly base: DeclaredName
	readonly level: number
	/** The login's PostgreSQL role, and the PostgreSQL schema of its base. */
	readonly role: string
	readonly schema: string
	/** The texts of every Db transaction's prologue the file fixes: the ledger's fence, then entering the snapshot guard. */
	readonly prologue: ServedPrologue
	/**
	 * The codes of exactly the rosters the login's members read or write, by declared name: the codebook its codecs,
	 * readers and classifier are rebuilt under, so the file is all a layer reads.
	 */
	readonly rosters: ReadonlyMap<DeclaredName, RosterCodes>
	/** What the login's refusals may name of the levels above its base, which a refusal names by its level. */
	readonly above: ServedAbove
	/** The login's roles, in the login's declared order. */
	readonly roles: ReadonlyArray<ServedRoleForm>
}

/** The prologue texts of the installation's ledger (deploy/ledger/ledger.ts LedgerStatements fence and enter). */
export interface ServedPrologue {
	readonly fence: EmittedText
	readonly enter: EmittedText
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
 * One role of a login as its Dbs serve it: its name in the login, the theory role it is (a full role names its base),
 * its installed PostgreSQL role, the contexts its relations read, typed, which a Db's claims are decoded through, the classifier of its refusals, and
 * its workload members in the workloads' order, each program's own record order.
 */
export interface ServedRoleForm {
	readonly name: string
	readonly theory: string
	/** The role's installed PostgreSQL role, as the naming door gives it, which every transaction of its Dbs enters. */
	readonly installed: string
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
 * with its page; a key, whose lookup reads by the key's values; or a ChangeSet, compiled for each set of its fill
 * contexts that may hold a fact.
 */
export type ServedMember = { readonly name: string } & (
	| { readonly kind: "read"; readonly read: ServedRead }
	| { readonly kind: "paged"; readonly read: ServedRead; readonly page: ServedPage }
	| { readonly kind: "key"; readonly fields: ReadonlyArray<string>; readonly read: ServedRead }
	| { readonly kind: "change"; readonly variants: ServedVariants }
)

/**
 * What the runtime reads of an attachment, the Attach node of the compiled program it holds no more: its name, the
 * child columns its correlation equates with the parent's, and the delivery the analysis judged.
 */
export interface ServedAttach {
	readonly name: string
	readonly correlation: ReadonlyArray<{ readonly child: string }>
	readonly judged: Delivered
}

/** An attachment fused into its parent's statement, as the runtime splits its column into children. */
export interface ServedFused {
	readonly name: string
	readonly layout: FusedLayout
	readonly attach: ServedAttach
}

/** What the runtime reads of a statement's spec: the text it sends, and the heading of its output columns. */
export interface ServedSpec {
	readonly sql: EmittedText
	readonly heading: Heading
}

/** A statement's form as an execution sends it: its placeholders in number order, and the spec emitted from it. */
export interface ServedForm<Slot> {
	readonly statement: { readonly params: ReadonlyArray<Slot> }
	readonly spec: ServedSpec
}

/** A per-execution choice of a statement's form: an input above its threshold sends the large form. */
export interface ServedChoice<Source extends ChoiceInput> {
	readonly source: Source
	readonly threshold: number
}

/**
 * A statement as the runtime runs it, the lowered statement's AST and IR left behind: its role (an attachment's with
 * its parent key), the heading of the relation it delivers, its fused attachments, its placeholders, its forms and
 * how the runtime has its rows.
 */
export interface ServedStatement<Slot, Source extends ChoiceInput> {
	readonly role: StatementRole
	readonly heading: Heading
	readonly fused: ReadonlyArray<ServedFused>
	readonly params: ReadonlyArray<Slot>
	readonly forms: StatementForms<ServedChoice<Source>, ServedForm<Slot>>
	readonly arrival: Arrival
}

/** A statement with the spec emitted from it. */
export interface ServedSpecified<Slot, Source extends ChoiceInput> {
	readonly statement: ServedStatement<Slot, Source>
	readonly spec: ServedSpec
}

/** A statement of a program and the attachment statements stitched onto its rows, in emission order. */
export interface ServedTree<S> {
	readonly statement: S
	readonly attachments: ReadonlyArray<ServedAttached<S>>
}

/** An attachment statement under its parent's rows. */
export interface ServedAttached<S> extends ServedTree<S> {
	readonly attach: ServedAttach
}

/** A program's delivered statements, its main statement or one per heading group, in group order. */
export type ServedRoots<S> = NonEmptyReadonlyArray<ServedTree<S>>

/** A read statement: every placeholder a declared parameter's, every choice a relation parameter's count. */
export type ServedReadStatement = ServedSpecified<DeclaredParamSlot, RelationInput>

/** A read's artifact as the runtime runs it: its statements in their tree, and how their rows are delivered. */
export interface ServedSource {
	readonly delivery: ProgramDelivery
	readonly roots: ServedRoots<ServedReadStatement>
}

/**
 * The delivered spine of a read, from its root: each delivered attachment by name, its child's head keys, and the
 * delivered attachments under it, which say which correlation columns a child carries (adapter reader/analysis.ts).
 */
export interface ServedSpine {
	readonly under: ReadonlyMap<string, ServedSpineAttachment>
}

export interface ServedSpineAttachment extends ServedSpine {
	readonly heads: ReadonlySet<string>
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
export type ServedPageStatement<F extends VariantFill[PageVariant] = VariantFill[PageVariant]> =
	ServedSpecified<PageStatementSlot<F>, ChoiceInput>

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
 * How a column's cell text converts: by its carrier's conversion (scalar/values/convert.ts convertByCarrier), a vector
 * by its dimensions. A closed id, a set and bytes are columns of their own (ColumnForm).
 */
export type Conversion =
	| { readonly carrier: Exclude<Carrier, "bytes" | "code" | "bits" | "vector"> }
	| { readonly carrier: "vector"; readonly dimensions: number }

/**
 * A delivered column (core/decoder.ts Column) as data: its conversion; a closed id's, its roster's handle by the
 * code; a set's, its roster's handles by the bits; a refined text's or a uuid's, its text; head literals', the one of
 * them the cell converts to; bytes', its assembled value.
 */
export type ColumnForm =
	| { readonly kind: "convert"; readonly conversion: Conversion }
	| { readonly kind: "code"; readonly roster: DeclaredName }
	| { readonly kind: "bits"; readonly roster: DeclaredName }
	| { readonly kind: "text" }
	| {
			readonly kind: "constant"
			readonly values: NonEmptyReadonlyArray<HeadValue>
			readonly conversion: Conversion
	  }
	| { readonly kind: "bytes" }

/**
 * A record field (core/decoder.ts RecordFieldOf) as data: a column, or an attachment delivering its child's records as
 * stated, or an alternatives arm's attachment on a row whose handle selects the arm (Some) or another (None).
 */
export type FieldForm =
	| { readonly kind: "column"; readonly column: ColumnForm }
	| { readonly kind: "attachment"; readonly child: DecoderForm; readonly delivery: Delivery }
	| { readonly kind: "some"; readonly child: DecoderForm }
	| { readonly kind: "none"; readonly child: DecoderForm }

/**
 * A row decoder (core/decoder.ts RowDecoder) as data: a record of fields in key order; two decoders' records as one;
 * a union of two decoders' records; a parent's records with the arm of `handle` under `name`, chosen by the parent's
 * `field`; or the decoder of a query whose rows no builder can decode, which refuses every layout.
 */
export type DecoderForm =
	| { readonly kind: "record"; readonly fields: ReadonlyArray<readonly [string, FieldForm]> }
	| { readonly kind: "merge"; readonly first: DecoderForm; readonly second: DecoderForm }
	| { readonly kind: "oneOf"; readonly first: DecoderForm; readonly second: DecoderForm }
	| {
			readonly kind: "arm"
			readonly parent: DecoderForm
			readonly name: string
			readonly child: DecoderForm
			readonly field: string
			readonly handle: string
	  }
	| { readonly kind: "refused" }

/** What applying a ChangeSet reads of its value besides its program: its array members' facts and its bound values. */
export type ServedChangeValue = Pick<ParsedChangeSet, "inputs" | "values">

/**
 * A ChangeSet compiled for one set of its fill contexts: its program, its reads decoder and its value's inputs. The
 * program is the compiled one until the write lanes narrow it to the data bindWrite and the write runtime read, BIND's
 * compile-time bind facts among it.
 */
export interface ServedChange {
	readonly program: CompiledWrite
	readonly decoder: DecoderForm
	readonly change: ServedChangeValue
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
 * domains; and each generated field's law by its table and column.
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
		readonly law: Law
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
