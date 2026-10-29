import type { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ViewRead } from "#compiler/ir/keys.ts"
import type { ClosedTheoryRelation, RelationInfo } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { Owned, OwnedRole } from "#compiler/schema/own.ts"

/**
 * What a ChangeSet member written into a relation is checked against: the relation's name, its heading and its serial
 * fields. An ordinary relation's RelationInfo is one; so is a role's writable query entry, whose heading is its head
 * typed as the fields of the relation it writes.
 */
export interface MemberRelation {
	readonly name: string
	readonly heading: Heading
	readonly serial: ReadonlyArray<string>
}

/** A closed fact as a typed row in heading order: its handle, then its payload values. */
type ClosedRow = readonly [
	Extract<TypedLiteral, { readonly kind: "enum" }>,
	...ReadonlyArray<TypedLiteral>
]

/**
 * A closed relation as a query reads it: its handle (`relation`), and its handle column `id` then its payload in
 * canonical order, with its facts, one typed row per handle in roster order, in that heading order.
 */
export interface ClosedRelation {
	readonly kind: "closed"
	readonly relation: ClosedTheoryRelation
	readonly name: string
	readonly heading: Heading
	readonly rows: ReadonlyArray<ClosedRow>
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

/** A relation as the checker reads it: an ordinary relation, a closed relation with its facts, or a view. */
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
	readonly closed: ReadonlyMap<string, ClosedRelation>
	/** A relation by name, refused when the schema or role holds none of that name. */
	relation(name: string, loc: SourceLoc): ReadRelation
	/** A literal of a declared value, checked against the type's contract and regex (ContractLiteral). */
	literal(value: LiteralDesc, type: ScalarType, loc: SourceLoc): TypedLiteral
	/** Whether a literal is a value of `type`: one `literal` admits at it rather than refuses. */
	admits(value: LiteralDesc, type: ScalarType): boolean
	/** A descriptor a query carries, its contracts the schema's or declared once by the same query (`seen`). */
	queryFieldType(
		desc: FieldDesc,
		loc: SourceLoc,
		seen: Map<string, { text: string; loc: SourceLoc }>
	): ScalarType
}
