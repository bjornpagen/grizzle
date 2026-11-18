import type { DeclaredName, Identity, IndexMethod } from "#compiler/core/identity.ts"
import type { ColumnIdent, LawId, RelationIdent, StoredRelationName } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Direction } from "#compiler/core/order.ts"
import {
	type CanonicalSet,
	nameSet,
	type NonEmptyCanonicalSet,
	nonEmptyNameSet
} from "#compiler/core/set.ts"
import type { CellSide } from "#compiler/ir/cells.ts"
import type { FieldDesc, TermDesc } from "#compiler/ir/desc.ts"
import type { ExprTable, ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type { DeclaredKey, HeadingColumn } from "#compiler/ir/rel.ts"
import {
	isSpanCarrier,
	type RegexRef,
	type ScalarType,
	type SpanCarrier
} from "#compiler/ir/scalar.ts"

/** The recognized shapes. */
const lawShapes = [
	"pk",
	"key",
	"contract",
	"check",
	"contained",
	"spanKey",
	"coverage",
	"family",
	"tree",
	"fold"
] as const
export type LawShape = (typeof lawShapes)[number]

/**
 * A field of a stored or closed relation, resolved once where the theory types its relation (analysis/theory/theory.ts):
 * the heading column a law reads it as, its name and type, and its installed column. A law that names the field carries
 * this handle, so no later pass looks the name up again.
 */
export interface LawField extends HeadingColumn {
	/** The descriptor ownership owned it with, which its type is typed from. */
	readonly desc: FieldDesc
	readonly column: ColumnIdent
	/** Its position in its relation's fields and heading, the order a closed relation's facts hold their values in. */
	readonly position: number
	/** How the field is written. */
	readonly writing: FieldWriting
}

/**
 * How a stored field is written, resolved: by the caller; generated, STORED by PostgreSQL from its row by `expr`, an
 * expression over the row's caller-written fields of the field's type; drawn by grizzle from the nested arrays it is a
 * family's index, count, start or end of; accumulated by grizzle on the host, the copy the one axis that carries it
 * gives it, `start` at the axis's base, and proved by PostgreSQL; serial, by its sequence; or retirement, a header's
 * boolean PostgreSQL defaults to false and its group's retirement alone sets true. Only a caller field is in an insert's
 * head, and a serial one by all-or-none.
 */
export type FieldWriting =
	| { readonly kind: "caller" | "drawn" | "serial" | "retirement" }
	| { readonly kind: "generated"; readonly expr: ScalarExpr }
	| { readonly kind: "accumulated"; readonly start: TypedLiteral }

/**
 * A stored or closed relation, resolved once where the theory types it: its declared name and its fields in declared
 * order. A law that names the relation carries this handle. A closed relation installs nothing by its name, so only a
 * stored relation's handle has an installed identifier (TableRelation).
 */
export interface LawRelation {
	readonly name: string
	readonly fields: NonEmptyReadonlyArray<LawField>
	/** The keys ownership declared on it, the primary key first, each with its constraint identifier. */
	readonly keyNames: ReadonlyArray<KeyName>
}

/**
 * A stored relation's handle with its installed table's identifier: what a native object and a law column are
 * installed on.
 */
export interface TableRelation extends LawRelation {
	readonly name: StoredRelationName
	readonly ident: RelationIdent
}

/** A span field's type: a range. */
export type SpanType = Extract<ScalarType, { readonly carrier: SpanCarrier }>

/** A key's span field: its relation's own handle, of a range type. */
export interface SpanField extends LawField {
	readonly type: SpanType
}

export const isSpanField = (f: LawField): f is SpanField => isSpanCarrier(f.type.carrier)

/** The names of fields, in their order. */
export const fieldNames = (fields: ReadonlyArray<LawField>): ReadonlyArray<string> =>
	fields.map((f) => f.name)

/**
 * A key ownership declared: the handles of its fields in key order, its span field if it has one (ownership refuses a
 * key of two), whether it is the primary key, and the identity its constraint is named by.
 */
export interface KeyName {
	readonly fields: NonEmptyReadonlyArray<LawField>
	readonly span: SpanField | undefined
	readonly primary: boolean
	readonly named: Identity<"primaryKey" | "key">
}

/**
 * A stored relation of the owned schema, resolved once where the checked schema types it (analysis/schema.ts): its
 * handle (LawRelation), its fields' handles in declared order (`fields`, the installed table's column order) and in
 * canonical order (`heading`), and its declared keys as names and as handles. A query, a write and the theory's laws
 * read this one handle.
 */
interface StoredRelationOf<Kind extends "relation" | "closed"> extends LawRelation {
	readonly kind: Kind
	/** Its fields in canonical order (analysis/schema.ts CheckedSchema): the heading a query reads it as and a write
	 * writes it as. */
	readonly heading: NonEmptyReadonlyArray<LawField>
	readonly primaryKey: DeclaredKey
	/** The additional candidate keys declared with key(), in statement order. */
	readonly keys: ReadonlyArray<DeclaredKey>
	/** The handles of the primary key's fields, in key order. */
	readonly primaryFields: NonEmptyReadonlyArray<LawField>
	/** The handles of each additional candidate key's fields, as `keys` lists them. */
	readonly keyFields: ReadonlyArray<NonEmptyReadonlyArray<LawField>>
	readonly mutable: boolean
	/** The schema level that declares it: 0 for the root schema, n for its n-th extension. */
	readonly level: number
	readonly loc: SourceLoc
}

/**
 * What an insertion into an ordinary relation meets at its primary key, a row another insertion holds there:
 * `repeatable`, an exact repeat at every field it states, which changes nothing, else the key's law refusing it; or
 * `race`, by race(R), that row whatever it holds, which the insertion meets and leaves as it is, the first insertion
 * holding the key. Every insertion into a raced relation meets stored rows at its primary key, which holds no drawn
 * field and no span, so no other key ever decides one of its races; a put asserts its row and never races.
 */
export type Inserts = "repeatable" | "race"

/** An ordinary relation, the only kind a ChangeSet writes, with its installed table's identifier. */
export interface RelationInfo extends StoredRelationOf<"relation">, TableRelation {
	readonly name: StoredRelationName
	/** The keys ownership declared on it, its primary key first. */
	readonly keyNames: NonEmptyReadonlyArray<KeyName>
	readonly inserts: Inserts
}

/**
 * A key field of a closed relation that holds one of the slots of `fin(O, n)`: O, `fin.relation`, a closed relation
 * whose key pairs with the relation's first key fields, `owner`, in order and roster for roster, and n, `fin.count`, a
 * natural field of O. Slot `at` of an owner is the code `at` of the field's roster, and an owner holds as many slots as
 * its count, each owner O holds a row for listed in `counts` by its key's values in key order; an owner O holds no row
 * for holds no slot.
 */
export interface ClosedSlot {
	readonly field: string
	readonly fin: { readonly relation: string; readonly count: string }
	readonly owner: NonEmptyReadonlyArray<string>
	readonly counts: ReadonlyArray<{
		readonly owner: NonEmptyReadonlyArray<TypedLiteral>
		readonly count: bigint
	}>
}

/**
 * A closed relation with its facts: a roster, whose one field `id` is a closed id of itself, or a relation keyed by
 * closed ids. Its heading is its key fields in key order, then its payload fields; its primary key (`primaryKey`,
 * `primaryFields`) is its declared key, in key order.
 */
export interface ClosedTheoryRelation extends StoredRelationOf<"closed"> {
	/** The facts as typed rows in declared field order (`fields`): none for a relation that holds no fact. */
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
	/** The key fields that are slots of a fin coordinate, in key order: none for a key that is a product of closed ids. */
	readonly slots: ReadonlyArray<ClosedSlot>
}

/** A stored relation the theory's laws read: an ordinary relation, or a closed relation with its facts. */
export type TheoryRelation = RelationInfo | ClosedTheoryRelation

/** A heading's columns as an IR node carries them: each field's name and type, never its handle. */
export const headingColumns = (
	fields: NonEmptyReadonlyArray<LawField>
): NonEmptyReadonlyArray<HeadingColumn> =>
	mapNonEmpty(fields, (f): HeadingColumn => ({ name: f.name, type: f.type }))

/** A literal selector: the facts whose `column` holds `value`, as a containment's evidence states it. */
export interface Selector {
	readonly column: string
	readonly value: TypedLiteral
}

/**
 * A side a statement declares (desc.ts SideDesc), as a key's and a containment's are: its relation, and a projection
 * on at least one term. Which facts it reads is its resolved selection (analysis/theory/laws.ts ResolvedSide).
 */
export interface DeclaredSide {
	readonly relation: string
	readonly terms: NonEmptyReadonlyArray<TermDesc>
}

/**
 * A containment's side as evidence states it, the one form a query's rewrite reads: a projection on fields, over the
 * facts its literal selectors pick, in field name order. A containment with a term or a selection beyond these gives no
 * evidence.
 */
export interface EvidenceSide {
	readonly relation: string
	readonly fields: NonEmptyReadonlyArray<string>
	readonly selection: ReadonlyArray<Selector>
}

/**
 * What declares a law: `statement` is the index of the declaring statement in the schema description, of the relation
 * for a primary key, or of the contract for a contract. A law an alternatives or a retirable statement, a family, a tree
 * or a fold expands to is its statement's, by the statement's kind.
 */
export interface LawSource {
	readonly kind:
		| "relation"
		| "key"
		| "contract"
		| "check"
		| "contained"
		| "family"
		| "tree"
		| "fold"
		| "alternatives"
		| "retirable"
	readonly statement: number
}

/**
 * Laws: the normalized law node and its native objects.
 *
 * Every law means a violation query that must be empty (rel.ts Forbid, laws/model/violations.ts); the public
 * constructors produce its recognized shapes. A NormalizedLaw records one recognized obligation with its source
 * identity, and the law model lowers it to native objects alone, each listing the laws it discharges
 * (NativeObject.lawIds): keys, foreign keys, table CHECKs, domains and a family's drawn columns, which PostgreSQL
 * enforces on every statement or at commit. A law over closed relations alone is checked once, by its violation
 * query, in the migration that installs it.
 */
export interface NormalizedLaw {
	readonly id: LawId
	readonly source: LawSource
	readonly shape: LawShape
	/** The relations its violation query reads, which the theory's relation dependency graph joins. */
	readonly reads: ReadonlyArray<string>
	/**
	 * Where the law is declared: its first declaring statement's location, or for a law no statement declares, the
	 * relation of its primary key or its contract.
	 */
	readonly loc: SourceLoc
}

/**
 * A condition a row meets to be held by a native object over a selected side: a conjunct of the side's selection, a
 * row predicate over its relation's own fields, with the fields it reads, which one printer lowers over the row.
 */
export interface RowGuard {
	readonly predicate: ScalarExpr
	readonly reads: ReadonlyArray<LawField>
}

/**
 * A column a native object reads: a field of its relation, or a law column the law model adds to it (`LawColumn`).
 */
export type NativeColumn =
	| { readonly kind: "field"; readonly field: LawField }
	| { readonly kind: "law"; readonly column: ColumnIdent }

/** A native column's text: a field's name, or a law column's identifier, which starts with `__` as no declared name
 * does, so the texts of a relation's columns are distinct. */
export const nativeColumnText = (c: NativeColumn): string =>
	c.kind === "field" ? c.field.name : c.column

/**
 * A key's columns in index order: the order its B-tree or GiST index lists them, which a probe's leading columns read
 * and its readable name spells. What the key holds apart reads none of it (KeyColumnSet).
 */
export type KeyOrder = NonEmptyReadonlyArray<NativeColumn>

/**
 * What a key holds apart: its relation and its columns as a set, each by its text (`nativeColumnText`). A scalar key
 * holds apart two rows equal at every column of it; a span key two rows equal at its scalars whose spans overlap, its
 * span apart from them. Uniqueness reads no order, and PostgreSQL matches a foreign key's referenced columns to a
 * unique index in any order, a PERIOD one's span last (tablecmds.c transformFkeyCheckAttrs), so two keys of one
 * KeyColumnSet are one key: the law model holds one key per KeyColumnSet (laws/model/model.ts nativeIdentity), and the
 * installation one index (physical/ddl/tables.ts keyObjectOf).
 */
export type KeyColumnSet =
	| {
			readonly kind: "scalar"
			readonly relation: string
			readonly columns: NonEmptyCanonicalSet<string>
	  }
	| {
			readonly kind: "span"
			readonly relation: string
			readonly span: string
			readonly scalars: CanonicalSet<string>
	  }

/** The KeyColumnSet of a scalar key of `relation` over the columns `order` lists. */
export const scalarKeySet = (relation: string, order: KeyOrder): KeyColumnSet => ({
	kind: "scalar",
	relation,
	columns: nonEmptyNameSet(mapNonEmpty(order, nativeColumnText))
})

/** The KeyColumnSet of a span key of `relation` over its scalar columns and its span. */
export const spanKeySet = (
	relation: string,
	scalars: ReadonlyArray<NativeColumn>,
	span: NativeColumn
): KeyColumnSet => ({
	kind: "span",
	relation,
	span: nativeColumnText(span),
	scalars: nameSet(scalars.map(nativeColumnText))
})

/** The KeyColumnSet of a key ownership declared on `relation`: a span key's over its other fields and its span. */
const declaredKeySet = (relation: string, key: KeyName): KeyColumnSet => {
	const span = key.span
	const columns = mapNonEmpty(key.fields, (field): NativeColumn => ({ kind: "field", field }))
	return span === undefined
		? scalarKeySet(relation, columns)
		: spanKeySet(
				relation,
				columns.filter((c) => c.kind === "field" && c.field !== span),
				{ kind: "field", field: span }
			)
}

/** A KeyColumnSet as a TupleMap key: its kind and relation, a span key's span, then its columns in canonical order.
 * Two KeyColumnSets are one key exactly when their tuples hold equal elements in order. */
export type KeyTuple = readonly [string, string, ...Array<string>]

export const keyTuple = (k: KeyColumnSet): KeyTuple =>
	k.kind === "scalar"
		? [k.kind, k.relation, ...k.columns]
		: [k.kind, k.relation, k.span, ...k.scalars]

/** Whether two KeyColumnSets are one key. */
const sameKey = (a: KeyColumnSet, b: KeyColumnSet): boolean => {
	const x = keyTuple(a)
	const y = keyTuple(b)
	return x.length === y.length && x.every((element, i) => element === y[i])
}

/**
 * The key ownership declared on `relation` whose KeyColumnSet is `key`: one at most, as ownership refuses a second key
 * over one set of fields (schema/own.ts distinctKeys).
 */
export const declaredKeyOf = (relation: LawRelation, key: KeyColumnSet): KeyName | undefined =>
	relation.keyNames.find((k) => sameKey(declaredKeySet(relation.name, k), key))

/**
 * The operator class of an index key: its column type's default, or the one class beyond it the compiler asks for,
 * pgvector's cosine class in the schema the vector extension is installed in. A key names no class by free text, so a
 * default class stated by name is no state a request can hold.
 */
export type IndexOpclass =
	| { readonly kind: "default" }
	| { readonly kind: "vectorCosine"; readonly schema: string }

export const defaultOpclass: IndexOpclass = Object.freeze({ kind: "default" })

/**
 * An index a law's maintenance needs, over every row of its relation: its keys, each a column of the relation by its arm
 * (a field by its handle, a law column by its identifier), never a name looked up again; and its use, named for
 * diagnostics (`reverse reference`).
 */
export interface LawIndexRequest {
	readonly relation: string
	readonly keys: NonEmptyReadonlyArray<{
		readonly column: NativeColumn
		readonly dir: Direction
		readonly opclass: IndexOpclass
	}>
	readonly method: IndexMethod
	readonly role: "lawMaintenance"
	readonly use: string
	readonly justification: { readonly kind: "law"; readonly law: LawId }
}

/** The fields of native columns when every one is a field, which a declared key's columns are; undefined when one is
 * a law column. */
export const plainFields = (
	columns: ReadonlyArray<
		{ readonly kind: "field"; readonly field: LawField } | { readonly kind: "law" }
	>
): NonEmptyReadonlyArray<LawField> | undefined => {
	const fields = columns.flatMap((c) => (c.kind === "field" ? [c.field] : []))
	return isNonEmpty(fields) && fields.length === columns.length ? fields : undefined
}

/**
 * What a law column holds: generated from its row, its term where every conjunct of its guard holds, and null elsewhere,
 * or drawn by the host, never null, proved by the foreign key or CHECK that reads it.
 *
 * A generated column's empty guard is a total column, never null: a constant, which a constant selection of a target
 * places on its source, is a literal term under no guard. A selected side's term is guarded by the selection's
 * conjuncts, and a pred term by x > 0 besides, its term x - 1 (scalar/natural.ts guardedTerm). Every expression reads
 * the row's own fields alone.
 */
export type LawColumnValue =
	| {
			readonly kind: "generated"
			readonly guard: ReadonlyArray<ScalarExpr>
			readonly term: ScalarExpr
	  }
	| { readonly kind: "drawn"; readonly draws: Drawn }

/** A family by its slots: one count counts one family, so its owner relation and count field name it. */
export interface FamilyId {
	readonly owner: string
	readonly count: string
}

/** A family's key: one count counts one family. */
export const familyKey = (id: FamilyId): string => `${id.owner}\u0000${id.count}`

/** A generated field's law, by its relation and field (the `generated` arm of the public Law): its term has a value at
 * every row. */
export interface GeneratedLaw {
	readonly kind: "generated"
	readonly relation: StoredRelationName
	readonly field: string
}

/**
 * A generated field's law, by its relation and field: the one description every refusal of a generated field with no
 * value names, whether the host finds it filling a row or PostgreSQL's NOT NULL refuses the row (23502).
 */
export const generatedLaw = (relation: StoredRelationName, field: string): GeneratedLaw =>
	Object.freeze({ kind: "generated", relation, field })

/**
 * What a drawn law column holds, which the host draws from the nested arrays: ‹n›, the owner's count on each member; a
 * counted family's index ‹i›; or a fold's accumulator, before or after the member's step of plane `plane` of the
 * family's fold `fold`, by its position among the family's folds. An after is drawn, never
 * generated, since a count's, a sum's and a max's combine is not total in its carrier: a CHECK proves it in exact
 * arithmetic.
 */
export type Drawn =
	| { readonly kind: "copy" | "index"; readonly family: FamilyId }
	| {
			readonly kind: "before" | "after"
			readonly family: FamilyId
			readonly fold: number
			readonly plane: 0 | 1
	  }

/**
 * Native objects: laws the database enforces itself. A native body is what the object is; the object records every
 * law it discharges besides.
 */
type NativeBody =
	| {
			readonly kind: "PrimaryKey"
			readonly relation: TableRelation
			readonly columns: NonEmptyReadonlyArray<LawField>
			/** The identity ownership named the primary key's constraint by. */
			readonly named: Identity<"primaryKey" | "key">
	  }
	| {
			/** A UNIQUE NULLS DISTINCT: a row any of whose columns is null is outside it. */
			readonly kind: "Unique"
			readonly relation: TableRelation
			readonly columns: NonEmptyReadonlyArray<NativeColumn>
	  }
	| {
			/**
			 * A contract's domain, by the contract's name: the installation names the domain by its definition, which
			 * contracts of one definition share, so the native holds the contract and never the domain's name.
			 */
			readonly kind: "Domain"
			readonly name: DeclaredName
			readonly base: ScalarType
			readonly check: DomainCheck
	  }
	| {
			readonly kind: "TableCheck"
			readonly relation: TableRelation
			readonly check: TableCheckOrigin
			readonly predicate: ScalarExpr
	  }
	| {
			/**
			 * The containments into a roster that its domain discharges by typing the field: the domain is installed per
			 * roster whatever laws there are, so this native installs nothing and carries the laws for the evidence
			 * catalog alone.
			 */
			readonly kind: "RosterDomain"
			readonly name: DeclaredName
	  }
	| {
			/**
			 * A containment of an open relation's side into a closed relation's: a table CHECK on `relation`, reading the
			 * target's installed constant at the mixed-radix index of the row's columns. Each pair is a source column
			 * and the target field it meets, the target's key fields first, in key order; every key pair's source column
			 * is typed by its target key field's roster domain, so every digit of the index is in range. `side` is the
			 * target's side as a closed relation of its own, which its constant encodes, and `guard` the source side's
			 * selection, each conjunct a row predicate over `relation`, none for a side of every row.
			 */
			readonly kind: "ClosedCheck"
			readonly relation: TableRelation
			readonly target: ClosedTheoryRelation
			readonly side: CellSide<TypedLiteral>
			readonly pairs: NonEmptyReadonlyArray<{
				readonly source: NativeColumn
				readonly target: LawField
			}>
			readonly guard: ReadonlyArray<RowGuard>
	  }
	| {
			/** A FOREIGN KEY ... MATCH SIMPLE: a row any of whose columns is null references nothing. */
			readonly kind: "ForeignKey"
			readonly relation: TableRelation
			readonly columns: NonEmptyReadonlyArray<NativeColumn>
			readonly target: TableRelation
			readonly targetColumns: NonEmptyReadonlyArray<NativeColumn>
			readonly deferrable: boolean
			/** ON UPDATE: cascade on a family's owner axis alone, so an owner's count change reaches its members' copies. */
			readonly onUpdate: "cascade" | "noAction"
	  }
	| {
			/**
			 * A column a law adds to its relation, generated STORED from the row: in no heading and no role view. `field`
			 * is the field whose values it holds, its type the column's and an index entry over it sized as one of the
			 * field's: a term's own field, x of pred(x), or, for a constant, the field of the target it meets.
			 */
			readonly kind: "LawColumn"
			readonly relation: TableRelation
			readonly column: ColumnIdent
			readonly field: LawField
			readonly value: LawColumnValue
	  }
	| {
			readonly kind: "WithoutOverlaps"
			readonly relation: TableRelation
			/** The span compared by overlap: a span field, or the law column a selected side's span term is. */
			readonly span: NativeColumn
			readonly key: SpanKeyScalars
			/** The identity ownership named the span key's constraint by. */
			readonly named: Identity<"primaryKey" | "key">
	  }
	| {
			/**
			 * A PERIOD foreign key from the source's scalar columns, then its span, into the target's: a selected target's
			 * constant law column follows the source's scalar fields, matched against the target's selector field.
			 */
			readonly kind: "PeriodForeignKey"
			readonly relation: TableRelation
			readonly columns: ReadonlyArray<NativeColumn>
			/** The source's span: a span field, or the law column a selected side's span term is. */
			readonly span: NativeColumn
			readonly target: TableRelation
			readonly targetColumns: ReadonlyArray<NativeColumn>
			readonly targetSpan: NativeColumn
			readonly deferrable: boolean
	  }
	| ({
			/** The index over a foreign key's referencing columns, which its reverse probe reads (ReverseIndexOn). */
			readonly kind: "ReverseIndex"
			readonly relation: TableRelation
	  } & ReverseIndexOn)

/**
 * The index a reverse probe reads by its method: a B-tree over a leading run of the referencing columns whose entry is
 * bounded, or a GiST over such a run ending in a PERIOD reference's span, PostgreSQL rechecking the other columns on
 * the rows it finds; or, where no run is bounded, a hash index on one column, whose entry is a 4-byte hash code and
 * which serves the probe's equality on it, PostgreSQL's hash index holding one column.
 */
type ReverseIndexOn =
	| { readonly method: "btree" | "gist"; readonly columns: NonEmptyReadonlyArray<NativeColumn> }
	| { readonly method: "hash"; readonly columns: readonly [NativeColumn] }

/**
 * What a row CHECK enforces: a declared row check, its name and the identity ownership named its constraint by, or a
 * CHECK the law model generates for a law, named for its table and that law at the naming door.
 */
type TableCheckOrigin =
	| { readonly kind: "declared"; readonly name: string; readonly named: Identity<"check"> }
	| { readonly kind: "generated"; readonly law: LawId }

/**
 * The scalar fields of a span key, compared for equality before its span: a primary key has one at least, since
 * PostgreSQL's PRIMARY KEY needs a column before WITHOUT OVERLAPS (42601); a candidate key may have none.
 */
export type SpanKeyScalars =
	| { readonly kind: "primary"; readonly scalars: NonEmptyReadonlyArray<NativeColumn> }
	| { readonly kind: "unique"; readonly scalars: ReadonlyArray<NativeColumn> }

export type NativeObject = { readonly lawIds: NonEmptyReadonlyArray<LawId> } & NativeBody

/** A contract's domain native. */
export type DomainNative = Extract<NativeObject, { readonly kind: "Domain" }>

export type NativeOf<K extends NativeObject["kind"]> = Extract<NativeObject, { readonly kind: K }>

/**
 * The CHECK a contract's domain carries, <name>__check: the conjunction of its terms, its base's refined text pattern
 * first, then its own predicate. A contract over a contract checks only its own predicate,
 * since the inner domain checks the rest; a brand-only contract over an unrefined base has none.
 */
export type DomainCheck =
	| { readonly kind: "unchecked" }
	| {
			readonly kind: "checked"
			readonly terms: NonEmptyReadonlyArray<DomainCheckTerm>
	  }

/** One term of a domain CHECK: membership in its base's refined text pattern, or the contract's predicate. */
export type DomainCheckTerm =
	| { readonly kind: "pattern"; readonly regex: RegexRef }
	| { readonly kind: "predicate"; readonly predicate: ExprTable }
