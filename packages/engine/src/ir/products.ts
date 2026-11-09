import type { EncodingFailure } from "#compiler/core/errors.ts"
import type { IndexMethod } from "#compiler/core/identity.ts"
import type {
	DomainName,
	ExprId,
	LawId,
	ParamId,
	RelationIdent,
	SchemaFingerprint
} from "#compiler/core/ids.ts"
import type { Direction } from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
import type { OutputText, Param, ParamBinary, ParamText } from "#compiler/core/wire.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { IndexOpclass, LawIndexRequest, LawLowering, NormalizedLaw } from "#compiler/ir/law.ts"
import type { Heading, RootedDag, ValidDag } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { WriteIR } from "#compiler/ir/write.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { CarrierName } from "#compiler/sql/naming.ts"

/**
 * Codec contracts ("codec"). Codecs are straight-line closures with no eval.
 * Encoder: one host value to its text-form parameter.
 */
export type Encoder = (value: unknown) => Result.Result<ParamText, EncodingFailure>

/**
 * An admitted fact (scalar/values/identity.ts) with its identity, factIdentity's over the input's heading: each field's
 * canonical text in field-name order (FactIdentity).
 */
export interface IdentifiedFact {
	readonly identity: ReadonlyArray<string>
	readonly fact: { readonly [field: string]: unknown }
}

declare const normalFactsBrand: unique symbol

/**
 * Facts in normal form over one heading: frozen admitted facts, distinct by fact identity and in identity order, with
 * the heading they were normalized against (the canonical text of its name-ordered fields and carrier specs). A
 * ChangeSet's facts are normalized once on the host and then encoded for every statement that binds them, and a
 * relation parameter's once per execution and then written in each statement's column order: normalizing them again
 * under the same heading would admit every value again, find no repeat and keep the order, so a holder of normal facts
 * takes them to their arrays (codec/recordset.ts normalArray) and never normalizes them again.
 *
 * Branded: codec/recordset.ts mints it from facts keyed by their identities, a Map, so the facts are a set by
 * construction and their order is the mint's, and no other value stands where normal facts are taken.
 */
export interface NormalFacts {
	readonly heading: string
	/** The admitted facts, frozen, in canonical order. */
	readonly facts: ReadonlyArray<{ readonly [field: string]: unknown }>
	/** The same facts each with its identity. */
	readonly entries: ReadonlyArray<IdentifiedFact>
	readonly [normalFactsBrand]: true
}

/**
 * A relation input's arrays as its placeholders in one statement carry them, in placeholder order: one text-format
 * array literal per column of the statement's reading of it, or, for an input of no column, its count of facts
 * (codec/recordset.ts arrayTexts).
 */
export type ArrayTexts = ReadonlyArray<ParamText>

/**
 * A relation input's column whose array no placeholder can carry, so the input is refused before any SQL is sent, which
 * the shell raises as InputTooLarge: a text array literal longer than the longest string the host builds, `limit`
 * UTF-16 code units (core/limits.ts maxStringLength), or a bytes column's binary array longer than the longest message
 * PostgreSQL reads, `limit` bytes (core/limits.ts messageMaxBytes; codec/bytea.ts). `input` names the relation
 * parameter or the written relation, `column` its field.
 */
export interface LiteralBound {
	readonly _tag: "LiteralBound"
	readonly form: "text" | "binary"
	readonly input: string
	readonly column: string
	readonly limit: number
}

/**
 * A relation input no statement can carry, refused before any of its bytes is read: the statement that carries it, its
 * write's whole input or, for a nested write, one row of it, would send a Bind message of at least `bytes` with its
 * placeholders (codec/recordset.ts ReadRelation), past the longest message PostgreSQL reads, `limit` bytes
 * (core/limits.ts messageMaxBytes), which the shell raises as InputTooLarge. `input` names the member.
 */
export interface MessageBound {
	readonly _tag: "MessageBound"
	readonly input: string
	readonly bytes: number
	readonly limit: number
}

declare const keyNormalizedBrand: unique symbol

/**
 * A write member slot's normal facts once they passed their relation's key check on the host: no two of them share a
 * key with different identities. That is what a member input's `normalized` proof (write/insert/input.ts
 * inputGuarantees) says of the rows its statements read, so a member placeholder takes these and nothing weaker.
 * Branded: the write's normalization (write/normalize/normalize.ts normalizeChangeSet) mints it, after its key check
 * and nowhere else.
 */
export type KeyNormalized = KeyedFacts & { readonly [keyNormalizedBrand]: true }

/**
 * A member slot's normal facts with the binary array of each of its bytes columns, by field, each written once for the
 * whole write from its facts' values (codec/bytea.ts byteaArray) and carried by every placeholder of that column
 * (codec/recordset.ts memberArray), so a value is copied once however many statements read its member.
 */
export type KeyedFacts = NormalFacts & { readonly binary: ReadonlyMap<string, ParamBinary> }

/**
 * An array encoder over normal facts of kind `F`: of the facts written as a statement's arrays over the columns its
 * placeholders of one input share, the array at `part` alone (codec/recordset.ts normalArray), so each placeholder
 * writes its own array once and no placeholder's encoding is kept for another's.
 */
type ArrayEncoder<F extends NormalFacts> = (
	facts: F,
	part: number
) => Result.Result<Param, LiteralBound>

/** MemberEncoder: a member slot's key-normalized facts to one of its arrays. */
export type MemberEncoder = ArrayEncoder<KeyNormalized>

/** RelationEncoder: a relation parameter's input, normalized once per execution, to one of its arrays. */
export type RelationEncoder = ArrayEncoder<NormalFacts>
/** RelationParamEncoder: a relation-valued input to its deduplicated arrays and its distinct fact count. */
export type RelationParamEncoder = (
	facts: Iterable<unknown>
) => Result.Result<
	{ readonly arrays: ArrayTexts; readonly count: number },
	EncodingFailure | LiteralBound
>

/**
 * The compiler's products.
 *
 * The products are separate instead of all being called a statement: OwnedSchema, CheckedTheory, LogicalQuery,
 * LoweredProgram, ProgramAccess, InstallationManifest, ProgramArtifacts and WriteProgram. A semantic fingerprint is none
 * of a PostgreSQL OID, a server statement's name, a server plan, or a snapshot; each product names the identity it
 * carries.
 *
 * The IR depends only on the kernel, so the products do not name the SQL AST (sql/) or the codecs (codec/): an emitted
 * statement is its text plus parameter slots, and the DDL of a physical object is a type parameter the physical
 * package instantiates with its SQL statements. Encoder is declared here, as the codecs' contract.
 *
 * Canonical fields, closed facts, declarations, stable source locations.
 */
export interface OwnedSchema {
	readonly desc: SchemaDesc
	readonly fingerprint: SchemaFingerprint
}

/** A field-compatibility class: fields union-find proved compatible. */
export interface CompatibilityClass {
	readonly fields: ReadonlyArray<string>
}

/** Field compatibility, normalized laws, directed dependencies, evidence, capability obligations. */
export interface CheckedTheory {
	readonly schema: SchemaFingerprint
	readonly classes: ReadonlyArray<CompatibilityClass>
	readonly laws: ReadonlyArray<NormalizedLaw>
	readonly lowerings: Readonly<Record<LawId, LawLowering>>
	/** The violation queries the laws name, in one DAG. */
	readonly dag: ValidDag
	/** Relation dependencies: each relation and the relations its laws read. */
	readonly dependencies: Readonly<Record<string, ReadonlyArray<string>>>
	readonly capabilities: ReadonlyArray<string>
}

/** A declared parameter: a relation parameter of a heading, or a scalar parameter of a type. */
export type ParamDecl = { readonly id: ParamId; readonly name: string } & (
	| { readonly kind: "relation"; readonly heading: Heading }
	| { readonly kind: "scalar"; readonly type: ScalarType }
)
export type RelationParamDecl = Extract<ParamDecl, { readonly kind: "relation" }>

/** The columns a parameter binds: a relation parameter's heading, a scalar parameter's one column, named by it. */
export const paramColumns = (p: ParamDecl): Heading =>
	p.kind === "relation" ? p.heading : [{ name: p.name, type: p.type }]

/**
 * The scoped relational and scalar DAG with exact headings and binding semantics, its root first among its DAG's roots.
 */
export interface LogicalQuery {
	readonly dag: RootedDag
	readonly params: ReadonlyArray<ParamDecl>
}

/** The public view of a lowered program: the optimized artifact's statement texts. */
export interface LoweredProgram {
	readonly statements: ReadonlyArray<string>
}

export type StatementRole =
	| "main"
	| "headingGroup"
	| "attachment"
	| "probe"
	| "member"
	| "readBack"
	| "setval"
	| "carrier"

/**
 * A page placeholder every request fills from its size: the limit, the validated requested size plus one, or the size
 * itself, the most rows the page delivers, which an attachment's statement bounds the page's rows by
 * (lower/shapes/page/seek.ts SizeSlots).
 */
export type SizeFill = { readonly kind: "limit" } | { readonly kind: "size" }

/**
 * A page placeholder only an anchored request and a probe fill: the boundary value of one comparator, the cursor
 * tuple's text at that position (lower/shapes/page/seek.ts BoundarySlots).
 */
export interface BoundaryFill {
	readonly kind: "boundary"
	readonly position: number
	readonly field: string
}

/** What fills one page placeholder: a size fill, or, in an anchored request's or a probe's statement, a boundary. */
export type PageFill = SizeFill | BoundaryFill

/**
 * What fills one placeholder of a statement spec, decided where the lowering allocated it, with its encoder. For a
 * scalar or relation parameter, `param` is the declared ParamId, which is the parameter's declared name and the key of
 * its host value (check/params.ts). A member slot is a write's enumerated member input (write/insert/input.ts); a page
 * placeholder is one only the page compiler allocates, and has no encoder: the page runtime binds its fill's text
 * (adapter/page/execute.ts), a limit or a size as the decimal digits of a bigint, `$n::bigint`, and a boundary as the
 * text its cursor carried.
 *
 * A relation input's placeholders in one statement, one per array (ArrayTexts), each carry an encoder over the columns
 * they share and their `part`, the position of their array among the input's arrays: a binder writes each
 * placeholder's array by its own encoder at its part (write/program/bind.ts), the input's facts encoded once in all.
 */
export type ParamSlot =
	| { readonly kind: "scalar"; readonly param: ParamId; readonly encode: Encoder }
	| {
			readonly kind: "relation"
			readonly param: ParamId
			readonly part: number
			/** Over the parameter's input, normalized once per execution: every statement encodes one set. */
			readonly encode: RelationEncoder
	  }
	| {
			readonly kind: "member"
			readonly slot: ParamId
			readonly part: number
			readonly encode: MemberEncoder
	  }
	| { readonly kind: "page"; readonly fill: PageFill }

/** A placeholder of a write's statement: a declared parameter or a member slot, never a page fill. */
export type WriteSlot = Exclude<ParamSlot, { readonly kind: "page" }>

/**
 * A statement's rows are its output texts, one per column of its heading (and, after a rows statement's heading, one
 * per fused attachment column): a read's are decoded by the value's decoder (core/decoder.ts), a write's by the write
 * program's outcome (write/program/outcome.ts).
 */
export interface StatementSpec<S extends ParamSlot = ParamSlot> {
	/** The emitted text; placeholder $n is paramSlots[n - 1]. */
	readonly sql: EmittedText
	readonly paramSlots: ReadonlyArray<S>
	readonly heading: Heading
	readonly role: StatementRole
	/** Indices of statements in the same artifact that must run first. */
	readonly dependsOn: ReadonlyArray<number>
}

export interface TemplateRequirements {
	readonly schema: SchemaFingerprint
	readonly extensions: ReadonlyArray<string>
	readonly extensionSchemas: Readonly<Record<string, string>>
}

/**
 * Stable SQL, positional codecs, expected native types, runtime requirements. Both
 * the optimized and the conservative artifact travel together; a weaker execution context runs the conservative one.
 */
export interface ProgramArtifacts {
	readonly kind: "query" | "ordered" | "write"
	readonly context: TemplateContext
	readonly optimized: ReadonlyArray<StatementSpec>
	readonly conservative: ReadonlyArray<StatementSpec>
	readonly requirements: TemplateRequirements
	readonly certificates: ReadonlyArray<Certificate>
	/** Generated SQL name to the source variable or relation occurrence it stands for. */
	readonly nameMap: Readonly<Record<string, string>>
}

export interface CarrierDecl {
	readonly name: CarrierName
	readonly heading: Heading
	readonly fill: "insertSelect"
}

export interface CountRule {
	readonly relation: string
	readonly statement: number
	readonly counts: "added" | "deleted" | "put"
}

/**
 * Converts the witness of an invariant-rejected outcome from grizzle-controlled fields only: texts grizzle's own SQL
 * wrote, so nothing is checked.
 */
export interface WitnessDecoder {
	/**
	 * A write statement's refusal names the relation and the refused key's fields with their texts (write/refusal.ts).
	 */
	readonly fromRefusal: (
		relation: string,
		key: ReadonlyArray<{ readonly field: string; readonly text: OutputText }>
	) => unknown
}

export interface WriteProgram extends ProgramArtifacts {
	readonly requirements: TemplateRequirements
	readonly ir: WriteIR<unknown>
	readonly strata: ReadonlyArray<ReadonlyArray<StatementSpec>>
	readonly carriers: ReadonlyArray<CarrierDecl>
	/** Per written relation, the statements whose RETURNING forms delta.added and delta.removed. */
	readonly deltas: Readonly<
		Record<
			string,
			{ readonly added: ReadonlyArray<number>; readonly removed: ReadonlyArray<number> }
		>
	>
	readonly reads: Readonly<Record<string, number>>
	readonly outcome: {
		readonly counts: ReadonlyArray<CountRule>
		readonly witness: WitnessDecoder
	}
}

/**
 * The accesses workload programs ask an index for; each decides how a request's keys must lead a serving index
 * (physical/indexes/engine.ts).
 *
 * - key lookup: An equality lookup whose columns contain a declared key: the key's own index serves it.
 * - equality lookup: An equality lookup on parameters or outer values.
 * - join key: The probe of one occurrence from a join partner, an attachment's delivered parents, or an EXISTS.
 * - range: An equality prefix followed by one range column.
 * - prefix search: An equality prefix followed by a text column bounded on both sides: a code-point interval.
 * - take seek: An equality prefix followed by a take's completed order.
 * - page seek: An equality prefix followed by a paged ordered program's completed order.
 * - span predicate: A span predicate: one GiST index per span field, scalar prefix through btree_gist.
 * - approximate vector retrieval: ApproximateNearest over a cosine distance: HNSW with the cosine operator class.
 * - write target: The key a ChangeSet's statement matches written facts on: exact deletion, put occupants, the
 *   insert arbiter.
 */
const accessUses = [
	"key lookup",
	"equality lookup",
	"join key",
	"range",
	"prefix search",
	"take seek",
	"page seek",
	"span predicate",
	"approximate vector retrieval",
	"write target"
] as const
export type AccessUse = (typeof accessUses)[number]

export interface AccessKey {
	readonly field: string
	readonly dir: Direction
}

/** The access methods a workload's access path asks for: every one but hash, which no access path's probe needs. */
type WorkloadIndexMethod = Exclude<IndexMethod, "hash">

/**
 * What a workload program's predicates, joins, seeks and approximate retrievals ask of an index.
 *
 * An access path names one relation, an access method and the key columns in index order, with the direction of each.
 * Its `use` is the use family that produced it. A path is a pure value of the IR the workload compiler extracted
 * (physical/access/extract.ts extractAccess); equal paths of the workload's programs become one IndexRequest with role
 * `access` (physical/access/paths.ts). The fixed form policy that decides which paths exist is extractAccess'.
 */
export interface AccessPath {
	readonly relation: string
	/**
	 * A derived relation's materialized view takes workload indexes like any relation; the installer passes them on
	 * only where it installs the view.
	 */
	readonly derived: boolean
	readonly method: WorkloadIndexMethod
	readonly keys: ReadonlyArray<AccessKey>
	readonly use: AccessUse
}

/** The extended statistics a workload program's filters and groupings ask for: one relation's columns, together. */
export interface StatisticsShape {
	readonly relation: string
	/** In code point order. */
	readonly columns: ReadonlyArray<string>
	readonly use: "correlated selection" | "grouping"
}

/**
 * A workload program's access: the paths its reads and writes go through, each once in canonical order, and the
 * statistics it asks for. The snapshot records each program's, and DbLayer.make and `grizzle check` compare a
 * workload's with the snapshot's, so a program whose access moved is named before it runs.
 */
export interface ProgramAccess {
	readonly paths: ReadonlyArray<AccessPath>
	readonly statistics: ReadonlyArray<StatisticsShape>
}

/** Each login's workload programs' access, by login name, then by program name. */
export type WorkloadAccess = Readonly<Record<string, Readonly<Record<string, ProgramAccess>>>>

/** pgvector's cosine operator class, whose ordering operator is `<=>` (check/approximate/policy.ts hnswPolicy). */
export const vectorCosineOpclass = "vector_cosine_ops"

/** Whether two keys' operator classes are one class. */
export const sameIndexOpclass = (a: IndexOpclass, b: IndexOpclass): boolean =>
	a.kind === "default" ? b.kind === "default" : b.kind === "vectorCosine" && a.schema === b.schema

/** A class as DDL and a snapshot spell it: none for the default, the schema-qualified class otherwise. */
export const indexOpclassText = (c: IndexOpclass): string | undefined =>
	c.kind === "default" ? undefined : `${c.schema}.${vectorCosineOpclass}`

/**
 * An index the workload's programs and the roles' write filters ask for, by the access they make: each key an
 * expression of a program or a field by name, and its operator class. A program's access reads every row of its
 * relation, so its request names none. Which programs make it, the snapshot's workload access records, so a program
 * edit that moves no index changes no request. A key carries no collation: every collatable key is
 * pg_catalog.pg_c_utf8, the closed constant of the SQL AST, so the request carries no option for it.
 */
export interface AccessIndexRequest {
	readonly relation: string
	readonly keys: ReadonlyArray<{
		readonly expr: ExprId | string
		readonly dir: Direction
		readonly opclass: IndexOpclass
	}>
	readonly method: WorkloadIndexMethod
	readonly role: "access"
	readonly use: AccessUse
}

/** Every index is justified by a law's maintenance or by the workload's access. */
export type IndexRequest = LawIndexRequest | AccessIndexRequest

type PhysicalState = "needed" | "created" | "building" | "validated" | "trusted"

export type DeployPhase = "setup" | "structure" | "indexes" | "validate" | "publish"

/**
 * Why an object is installed: a law it enforces, the workload's access (its programs' and the roles' write filters'),
 * a declaration it enforces, or, for a derived relation's unique index, the proof of the key it states, by the laws
 * that proof rests on (none for a group key or a set's whole heading), so dropping a law names the proofs it breaks.
 */
export type PhysicalReason =
	| { readonly kind: "law"; readonly law: LawId }
	| { readonly kind: "access" }
	| { readonly kind: "enforcement"; readonly of: string }
	| { readonly kind: "proof"; readonly premises: ReadonlyArray<LawId> }

/**
 * The kinds of physical object an installation manifest holds, in their rank among the objects of one phase: what
 * the physical package installs (physical/obligations/graph.ts), and the migrations ledger a snapshot's manifest adds.
 */
export const physicalKinds = [
	"databaseDefault",
	"schema",
	"extension",
	"constant",
	"domain",
	"table",
	"lawColumn",
	"primaryKey",
	"unique",
	"check",
	"foreignKey",
	"refusalFunction",
	"advanceFunction",
	"isolationFunction",
	"snapshotGuard",
	"isolationTrigger",
	"materializedView",
	"uniqueIndex",
	"index",
	"statistics",
	"validation",
	"lawFunction",
	"lawTrigger",
	"role",
	"membership",
	"roleSchema",
	"view",
	"worldFunction",
	"policy",
	"rowSecurity",
	"privileges",
	"ledger"
] as const
export type PhysicalKind = (typeof physicalKinds)[number]

/** A physical object: every manifest object is of a PhysicalKind. */
export interface PhysicalObject<Ddl = unknown> {
	readonly kind: PhysicalKind
	readonly ident: string
	readonly ddl: ReadonlyArray<Ddl>
	readonly reasons: ReadonlyArray<PhysicalReason>
	readonly state: PhysicalState
	readonly phase: DeployPhase
}

/**
 * A workload access request as a snapshot records it: each key's operator class as DDL spells it (indexOpclassText),
 * absent from the JSON for the column type's default, so the snapshot's text and fingerprint name a class only where an
 * index names one.
 */
interface StoredRequestKey {
	readonly expr: string
	readonly dir: Direction
	readonly opclass: string | undefined
}

export type StoredIndexRequest = Omit<AccessIndexRequest, "keys"> & {
	readonly keys: ReadonlyArray<StoredRequestKey>
}

/** Every installed object with its justification, and the dependencies between them. */
export interface InstallationManifest<Ddl = unknown> {
	readonly objects: ReadonlyArray<PhysicalObject<Ddl>>
	readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>
	readonly roleDefaults: ReadonlyArray<Ddl>
	readonly publicRevokes: ReadonlyArray<Ddl>
	/** Every installed object's COMMENT, its declared name or identity spelled out (physical/install/comments.ts). */
	readonly comments: ReadonlyArray<Ddl>
}

/**
 * What a constraint lives on, as PostgreSQL reports it beside a violation: the table of a table constraint or a unique
 * index (the ErrorResponse's table field), or the domain of a domain constraint (its data type field). PostgreSQL scopes
 * a constraint's name to its table or domain, and grizzle's readable names repeat across owners (every domain's CHECK
 * is `check`, and two tables may declare a row check of one name), so a name is one constraint only under its owner.
 */
export type ConstraintOwner =
	| { readonly kind: "table"; readonly name: RelationIdent }
	| { readonly kind: "domain"; readonly name: DomainName }

/** One kind of owner's constraint names, by owner, to the law a violation reports. */
type OwnedConstraintLaws = Readonly<Record<string, Readonly<Record<string, LawId>>>>

/**
 * Each owner's constraint names to the law a violation reports: a table's constraints and unique indexes under the
 * table, a domain's constraints under the domain. A write statement's refusal raises under the law's identity itself
 * and reports no owner, so it is no entry (write/refusal.ts).
 */
export type ConstraintLaws = {
	readonly tables: OwnedConstraintLaws
	readonly domains: OwnedConstraintLaws
}

/** The law the constraint `name` of `owner` reports, when the map holds it. */
export const constraintLaw = (
	laws: ConstraintLaws,
	owner: ConstraintOwner,
	name: string
): LawId | undefined => {
	const owned = owner.kind === "table" ? laws.tables : laws.domains
	if (!Object.hasOwn(owned, owner.name)) {
		return undefined
	}
	const named = owned[owner.name]
	return named !== undefined && Object.hasOwn(named, name) ? named[name] : undefined
}

export interface Snapshot<Ddl = unknown> {
	readonly fingerprint: SchemaFingerprint
	readonly schemaName: string
	readonly theory: unknown
	readonly manifest: InstallationManifest<Ddl>
	readonly constraintToLaw: ConstraintLaws
	readonly workload: WorkloadAccess
	readonly accessPaths: ReadonlyArray<StoredIndexRequest>
}
