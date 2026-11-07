import type { Array as Arr } from "effect"
import type { Codebook, RosterCodec } from "#compiler/ir/codes.ts"
import type { FillOrder } from "#compiler/ir/fill.ts"
import type { SpanCarrier } from "#compiler/ir/scalar.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type { Ddl, ObjectName, TypeRef } from "#compiler/sql/ast.ts"
import type { ClosedRows } from "#compiler/write/family/fold.ts"

/**
 * How a host value of a column is spelled as a typed SQL literal (literal.ts). A contract column spells its base's
 * value and casts it to the domain. A closed id is its handle's code under the installation's codes, cast to the
 * roster's domain; a set over a roster is its bit(size) text, position c code c, cast to the roster's bits domain.
 */
export type ValueKind =
	| { readonly kind: "integer"; readonly carrier: "int2" | "int4" | "int8" }
	| { readonly kind: "numeric" }
	| { readonly kind: "float"; readonly carrier: "float4" | "float8" }
	| { readonly kind: "money" }
	| { readonly kind: "bool" }
	| { readonly kind: "uuid" }
	| { readonly kind: "date" }
	| { readonly kind: "text" }
	| { readonly kind: "bytes" }
	| { readonly kind: "code"; readonly roster: RosterCodec }
	| { readonly kind: "bits"; readonly roster: RosterCodec }
	| { readonly kind: "span"; readonly carrier: SpanCarrier }
	| { readonly kind: "vector"; readonly dimensions: number }

export interface ColumnType {
	/**
	 * The column's PostgreSQL type: a builtin, a roster's domain, a roster's bits domain, a contract domain, or the
	 * extension's vector(N).
	 */
	readonly sql: TypeRef
	readonly value: ValueKind
	/** The contract whose domain types the column, or none. */
	readonly contract:
		| { readonly kind: "none" }
		| { readonly kind: "contract"; readonly name: string }
}

/** The contract of a column no contract types. */
export const uncontracted: ColumnType["contract"] = { kind: "none" }

export interface OracleColumn {
	readonly field: string
	readonly column: string
	readonly type: ColumnType
	/** A serial field is GENERATED ALWAYS AS IDENTITY with its named sequence; any other field has none. */
	readonly sequence:
		| { readonly kind: "none" }
		| { readonly kind: "identity"; readonly name: ObjectName }
	readonly location: string
}

export interface OracleForeignKey {
	readonly name: string
	/** Paired with referencedFields by position. A PERIOD foreign key lists its span pair last. */
	readonly fields: ReadonlyArray<string>
	readonly references: string
	readonly referencedFields: ReadonlyArray<string>
	/**
	 * Whether it is a span containment into a span key: FOREIGN KEY (<scalars>, PERIOD <span>) REFERENCES <target>
	 * (<scalars>, PERIOD <span>) DEFERRABLE INITIALLY DEFERRED. Its check runs at COMMIT, so it places no constraint on
	 * the load order.
	 */
	readonly period: boolean
	readonly location: string
}

/**
 * A primary key or key(R, fields). A span key, one with a span field, is PRIMARY KEY or UNIQUE (<scalars>, <span>
 * WITHOUT OVERLAPS), the span last and every scalar component through btree_gist.
 */
export interface OracleKey {
	readonly name: string
	/** Declared order, at least one, as a key has. */
	readonly fields: Arr.NonEmptyReadonlyArray<string>
	/** The span field of a span key; a key of scalar fields has none. */
	readonly span: { readonly kind: "none" } | { readonly kind: "span"; readonly field: string }
}

export interface OracleTable {
	readonly relation: string
	readonly name: ObjectName
	/** Declaration order. */
	readonly columns: ReadonlyArray<OracleColumn>
	readonly primaryKey: OracleKey
	/** Each key(R, fields) statement, in declaration order. */
	readonly keys: ReadonlyArray<OracleKey>
	readonly foreignKeys: ReadonlyArray<OracleForeignKey>
	readonly mutable: boolean
	readonly location: string
}

/**
 * What one roster installs (OPEN-2 (b)): its names constant, a zero-argument IMMUTABLE SQL function returning each
 * code's handle in code order as a name[], a hole the empty name; and its smallint domain, whose one CHECK admits
 * exactly the codes the constant names a handle at, `((names())[VALUE + 1] <> ''::pg_catalog.name) IS TRUE`. A
 * roster that types a set column also installs its live() constant and its bits domain over bit(size), which the
 * minimal installer leaves to the real one.
 */
export interface OracleRoster {
	readonly closed: string
	readonly names: ObjectName
	readonly domain: ObjectName
	/** The roster's codes in the installation: each live handle's code, each code's name. */
	readonly codes: RosterCodec
}

export interface OracleDomain {
	readonly contract: string
	readonly name: ObjectName
	readonly base: ColumnType
	readonly location: string
}

/**
 * What the loader fills a family's drawn values from, as grizzle's own host fill does (write/family/fold.ts filler): the
 * law model's fill order of its families, and the rows of the closed relations a fill's generated fields and fold
 * selections may read.
 * A fact never states a drawn value: each member's index, its copy of its owner's count and each fold's running values,
 * and the owner's count and ends.
 */
interface FamilyFill {
	readonly order: FillOrder
	readonly closed: ReadonlyMap<string, ClosedRows>
	/** The admitted patterns the host's fill evaluates against, compiled with the order (LawModel.patterns). */
	readonly patterns: PatternReads
}

/** Something the schema declares that the oracle installer does not install. */
export interface OracleOmission {
	readonly location: string
	readonly what: string
	readonly reason: string
}

/**
 * The oracle installation plan: what the minimal installer creates for an owned schema, and how to address it.
 *
 * The plan is pure data derived from a SchemaDesc (the `desc` of an OwnedSchema) and the installation's codes. It names
 * every table, column, constraint, roster constant and domain by the identifiers the installer's naming rules derive,
 * carries the DDL
 * as SQL AST statements and as emitted text, and records the declarations it skips (see `skipped`). It installs no
 * predicate CHECK, which the physical oracle models by what each admits (plan.ts header).
 */
export interface InstallPlan {
	/** The declared schema name and the PostgreSQL schema it is installed under. */
	readonly declared: string
	readonly schema: string
	readonly tables: Readonly<Record<string, OracleTable>>
	readonly rosters: Readonly<Record<string, OracleRoster>>
	/** The installation's codes: every code literal and every decoded code reads them. */
	readonly codes: Codebook
	readonly domains: Readonly<Record<string, OracleDomain>>
	/**
	 * Stored relations in an order every immediate foreign key allows loading in: referenced tables first. Deferred
	 * (PERIOD) foreign keys are checked at COMMIT and do not constrain it.
	 */
	readonly loadOrder: ReadonlyArray<string>
	readonly ddl: ReadonlyArray<Ddl>
	/** The emitted text of each DDL statement, in order. */
	readonly sql: ReadonlyArray<string>
	/** The schema the vector extension lives in, which names a vector column's type. */
	readonly vectorSchema: string
	/** Declarations skipped under `unsupported: "skip"`: laws and derived relations beyond the minimal installer. */
	readonly skipped: ReadonlyArray<OracleOmission>
	/** The fill of the families' drawn values: none for the minimal installer, which refuses every drawn field. */
	readonly fill: FamilyFill
}

export interface PlanOptions {
	/**
	 * What to do with a law or derived relation the minimal installer cannot install: refuse the schema or skip it and
	 * record it in `skipped`.
	 */
	readonly unsupported: "refuse" | "skip"
	/** The schema the vector extension lives in (vector_ext in the template database). */
	readonly vectorSchema: string
	/**
	 * The codes the plan installs the rosters under: a fresh installation's, each handle's code its declared position,
	 * or an installation's codes, holes included, which must hold every roster the schema declares.
	 */
	readonly codes:
		| { readonly kind: "fresh" }
		| { readonly kind: "installed"; readonly codes: Codebook }
	/**
	 * The existing schema btree_gist is created in, if the database has none yet, when a span key has a scalar
	 * component: public, which every database has and no install drops, whereas an extension created inside one
	 * installed schema would vanish, with every other install's GiST keys over it, when that schema is dropped.
	 */
	readonly extensionSchema: string
}

/** A declaration the installer cannot install refused, the template database's extension schemas. */
export const defaultPlanOptions: PlanOptions = {
	unsupported: "refuse",
	vectorSchema: "vector_ext",
	codes: { kind: "fresh" },
	extensionSchema: "public"
}
