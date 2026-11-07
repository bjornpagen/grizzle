import type { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ViewRead } from "#compiler/ir/keys.ts"
import type { ClosedTheoryRelation, FieldWriting, RelationInfo } from "#compiler/ir/law.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { ClosedRelations } from "#compiler/scalar/compute/lower.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import type { Owned, OwnedRole } from "#compiler/schema/own.ts"

/**
 * A column of a relation a ChangeSet member writes: its name, its type, and how its field is written. A serial column
 * is one an addition may leave out for its sequence to fill.
 */
export interface MemberColumn extends HeadingColumn {
	readonly writing: { readonly kind: FieldWriting["kind"] }
}

/**
 * What a ChangeSet member written into a relation is checked against: the relation's name and its heading, each column
 * with how its field is written. An ordinary relation's RelationInfo is one; so is a role's writable query entry,
 * whose heading is its head typed and written as the fields of the relation it writes, a head field serial exactly
 * where an addition may leave it out.
 */
export interface MemberRelation {
	readonly name: string
	readonly heading: ReadonlyArray<MemberColumn>
}

/**
 * A closed relation (closed.relation, or a roster, the closed relation whose one field `id` is a closed id of itself)
 * as a query and a closed read read it: its theory handle (`relation`), whose primary fields are its key in key order;
 * its heading, the key fields in key order, then the payload in canonical order; and its rows as typed literals in that
 * heading order, a roster's one per handle in roster order, any other's in its key's text order.
 */
export interface ClosedRelation {
	readonly kind: "closed"
	readonly relation: ClosedTheoryRelation
	readonly name: string
	readonly heading: Heading
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
	readonly loc: SourceLoc
}

/**
 * A view a query reads: a derived relation's materialized view or a role query entry's view, by its analysis
 * (analysis/derived), whose `read` is what a Base over it reads, its heading and its keys.
 */
interface ViewRelation<Kind extends "derived" | "world"> {
	readonly kind: Kind
	readonly name: string
	readonly analysis: { readonly read: ViewRead }
}

/** A relation as the checker reads it: an ordinary relation, a closed relation with its rows, or a view. */
type ReadRelation = RelationInfo | ClosedRelation | ViewRelation<"derived"> | ViewRelation<"world">

/** What the checker reads a schema as: reality, or a role, whose contexts its Db holds. */
type ReadWorld = { readonly kind: "reality" } | { readonly kind: "role"; readonly role: OwnedRole }

/**
 * The schema as the checker reads it: the relations a query matches, each with its typed heading, and the types its
 * descriptors and literals resolve to. The checked schema (analysis/schema.ts CheckedSchema) is the one reading, built
 * above the checker because it checks its views' definitions with it.
 */
export interface SchemaReading {
	/** The owned schema whose rosters and contracts types resolve against: a role's base. */
	readonly owned: Owned
	readonly world: ReadWorld
	/**
	 * The closed relations a query matches, rosters among them, by name: reality's own; a role's, the rosters it holds
	 * whole and every closed relation of its base, which no role holds.
	 */
	readonly closed: ReadonlyMap<string, ClosedRelation>
	/** The closed relations C.at and C.row apply (check/closed.ts closedReads): every closed relation, no roster. */
	readonly closedReads: ClosedRelations
	/** A relation by name, refused when the schema or role holds none of that name. */
	relation(name: string, loc: SourceLoc): ReadRelation
	/**
	 * A literal of a declared value, checked against the type's contract and regex (ContractLiteral), by the admitted
	 * patterns of the caller's compile.
	 */
	literal(
		value: LiteralDesc,
		type: ScalarType,
		loc: SourceLoc,
		patterns: PatternAutomata
	): TypedLiteral
	/** Whether a literal is a value of `type`: one `literal` admits at it rather than refuses. */
	admits(value: LiteralDesc, type: ScalarType, patterns: PatternAutomata): boolean
	/**
	 * A descriptor a query carries, its contracts the schema's or declared once by the same query (`seen`), typed by the
	 * admitted patterns of the caller's compile.
	 */
	queryFieldType(
		desc: FieldDesc,
		loc: SourceLoc,
		seen: Map<string, { text: string; loc: SourceLoc }>,
		patterns: PatternAutomata
	): ScalarType
}
