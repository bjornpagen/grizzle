import { familyKey, familyText, membersSelection } from "#compiler/analysis/theory/families.ts"
import type {
	ResolvedConjunct,
	ResolvedSelection,
	ResolvedSelector,
	ResolvedSide,
	ResolvedTerm,
	TheoryLaw
} from "#compiler/analysis/theory/laws.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { DeclaredName, Identity, LawColumnStatement } from "#compiler/core/identity.ts"
import type { ColumnIdent, LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { descText, type ExprDesc, fieldTermsOf, termText } from "#compiler/ir/desc.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type { AxisKind, AxisPair, Family, FamilyFold } from "#compiler/ir/family.ts"
import {
	type ClosedTheoryRelation,
	type Drawn,
	type FamilyId,
	fieldNames,
	isSpanField,
	type KeyName,
	type LawField,
	type NativeColumn,
	type RelationInfo,
	type SpanField,
	type TheoryRelation
} from "#compiler/ir/law.ts"
import { type CombineFn, monoidSpecs } from "#compiler/ir/monoid.ts"

import { type CellSide, sideOf } from "#compiler/ir/cells.ts"
import { closedCell } from "#compiler/ir/rel.ts"
import { baseOf, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { literalKey } from "#compiler/laws/model/names.ts"
import type { OwnedContract } from "#compiler/schema/own.ts"
import {
	type BtreeEntryBytes,
	btreeEntry,
	type DatumBound,
	datumBound,
	type EntryColumn,
	type GistEntryBytes,
	gistEntry,
	indexMaxKeys,
	setDatumBound
} from "#compiler/schema/representability.ts"

/** A refusal deep inside recognition is a core Refusal, which the model's boundary returns (`catchRefusal`). */
const refuse = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/** What the planner always holds where it reads it: its absence is a defect. */
const missing = (what: string): never => {
	throw defect(what)
}

/** A key of `relation` over `key` whose index entry is unrepresentable, for `fault`. */
const unrepresentable = (
	loc: SourceLoc,
	subject: string,
	key: ReadonlyArray<string>,
	fault: KeyFault
): never => {
	throw new Refusal(CompileError.make({ _tag: "UnrepresentableKey", at: loc, subject, key, fault }))
}

/**
 * A column a law adds to its relation, as planned (ir/law.ts LawColumn), its name and expressions still to settle:
 *
 * - a constant a selected target fixes on its source `relation`, the value of the target's `field`;
 * - a term of a side of `relation` under the side's selection, a pred term or any term of a selected side, generated
 *   from the row;
 * - a drawn column of a family (`Drawn`), a plain column the host writes and the family's foreign keys and CHECKs
 *   prove, holding values of `field`;
 * - a counted family's ‹p›, pred of its drawn index, generated from the row.
 *
 * A field term over every fact is the field itself, never a law column (`sideColumns`).
 */
export type LawColumnPlan =
	| {
			readonly kind: "constant"
			readonly relation: RelationInfo
			readonly target: RelationInfo
			readonly field: LawField
			readonly value: TypedLiteral
	  }
	| {
			readonly kind: "term"
			readonly relation: RelationInfo
			readonly term: ResolvedTerm
			readonly selection: ResolvedSelection
	  }
	| {
			readonly kind: "drawn"
			readonly relation: RelationInfo
			/** The field whose values it holds, which types it and sizes an index entry over it. */
			readonly field: LawField
			readonly draws: Drawn
			/** What it is at the naming door: its family and what it draws, a hidden accumulator by its fold's law. */
			readonly named: DrawnStatement
	  }
	| {
			readonly kind: "indexPred"
			readonly relation: RelationInfo
			readonly family: FamilyId
			/** The family's count, whose values the index and its predecessor hold. */
			readonly field: LawField
			/** The drawn index the predecessor is pred of. */
			readonly index: LawColumnPlan
	  }

/** A family's law column as the naming door states it (core/identity.ts LawColumnStatement): a drawn one's, by its
 * family and what it draws. */
export type DrawnStatement = Exclude<LawColumnStatement, { readonly kind: "constant" | "term" }>

/** A constant law column, which a constant selection places on its source. */
type ConstantColumn = Extract<LawColumnPlan, { readonly kind: "constant" }>

/** A column a planned native reads: a field, or a law column. */
export type PlannedColumn =
	| { readonly kind: "field"; readonly field: LawField }
	| { readonly kind: "law"; readonly column: LawColumnPlan }

/** A field as a planned native reads it. */
const fieldColumn = (field: LawField): PlannedColumn => ({ kind: "field", field })

/**
 * The field a planned column's values are of, whose descriptor and type size an index entry over it: a field itself,
 * or the field a law column holds the values of (a pred term's is its natural field).
 */
const plannedField = (c: PlannedColumn): LawField => {
	if (c.kind === "field") {
		return c.field
	}
	const column = c.column
	switch (column.kind) {
		case "term":
			return column.term.column
		case "constant":
		case "drawn":
		case "indexPred":
			return column.field
	}
}

/**
 * The most bytes a planned column's datum takes in an index entry (schema/representability.ts datumBound), none for
 * text of no bound. A set is its roster's bit(n), n the codes its installation has minted, which the law model does not
 * hold: it is counted at its roster's handles, the fewest codes the roster can have, so the count refuses only an entry
 * certainly past the bound.
 */
const plannedDatum = (c: PlannedColumn): DatumBound | undefined => {
	const field = plannedField(c)
	const base = baseOf(field.type)
	return base.carrier === "bits"
		? setDatumBound(base.roster.handles.length)
		: datumBound(field.desc)
}

/** A planned column as a refusal names it: a field by its name, a law column by what it holds. */
const plannedText = (c: PlannedColumn): string =>
	c.kind === "field" ? c.field.name : lawColumnText(c.column)

/**
 * The B-tree entry of an index the law model plans over `columns`, a UNIQUE or a reverse index, proved within
 * BTMaxItemSize for every value its columns admit (schema/representability.ts btreeEntry), or its refusal: past
 * INDEX_MAX_KEYS columns, over a text of no byte bound, or over an entry that can outgrow the limit, it is
 * UnrepresentableKey, `subject` naming the index and the law that plans it, since PostgreSQL would refuse the write
 * whose entry outgrows it (54000). A field is NOT NULL; a law column may hold NULL, which gives the entry its null
 * bitmap. A planned Unique and ReverseIndex hold this entry, so none is planned past it.
 */
const plannedEntry = (
	columns: NonEmptyReadonlyArray<PlannedColumn>,
	subject: string,
	loc: SourceLoc
): BtreeEntryBytes => {
	const key = columns.map(plannedText)
	if (columns.length > indexMaxKeys.value) {
		return unrepresentable(loc, subject, key, { kind: "columns", limit: indexMaxKeys.value })
	}
	const entry: Array<EntryColumn> = []
	for (const c of columns) {
		const datum = plannedDatum(c)
		if (datum === undefined) {
			return unrepresentable(loc, subject, key, { kind: "unboundedText", field: plannedText(c) })
		}
		entry.push(entryColumn(c, datum))
	}
	const proved = btreeEntry(entry)
	return proved.ok ? proved.value : unrepresentable(loc, subject, key, proved.error)
}

/** A planned column as an index entry holds it: a field NOT NULL, a law column possibly NULL. */
const entryColumn = (c: PlannedColumn, datum: DatumBound): EntryColumn => ({
	name: plannedText(c),
	datum,
	nullable: c.kind === "law"
})

/** A planned column with its datum, where its datum is bounded. */
interface BoundedColumn {
	readonly column: PlannedColumn
	readonly datum: DatumBound
}

/** The columns of `columns` whose datum is bounded, in their order. */
const boundedColumns = (columns: ReadonlyArray<PlannedColumn>): ReadonlyArray<BoundedColumn> =>
	columns.flatMap((column) => {
		const datum = plannedDatum(column)
		return datum === undefined ? [] : [{ column, datum }]
	})

/**
 * Whether PostgreSQL has a hash operator class for a column's type, its domain's base: every scalar carrier but money,
 * a set's bit string and a vector.
 */
const hashable = (c: PlannedColumn): boolean => {
	switch (baseOf(plannedField(c).type).carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "range4":
		case "range8":
		case "exactInteger":
			return true
		case "money":
		case "exactMoney":
		case "bits":
		case "vector":
			return false
	}
}

/**
 * The index a containment's reverse probe reads over its referencing columns `columns`, which binds every one of them by
 * equality: an index over a leading run of them serves it, PostgreSQL rechecking the rest on the rows it finds, so the
 * width of a referencing column never refuses a containment. A B-tree over the longest leading run of the columns
 * whose datum is bounded, in their order, whose entry btreeEntry proves within BTMaxItemSize; where that run is empty,
 * a hash index on one hashable column, a field before a law column, whose entry is a 4-byte hash code (a text with no
 * byte bound is hashable, texteq under pg_c_utf8 being deterministic). Only referencing columns none of which a B-tree
 * entry holds and none of which hashes, wide sets and vectors and money, refuse, as UnrepresentableKey naming `subject`.
 */
const plannedReverse = (
	columns: NonEmptyReadonlyArray<PlannedColumn>,
	subject: string,
	loc: SourceLoc
): PlannedReverse => {
	const bounded = boundedColumns(columns)
	for (let n = Math.min(bounded.length, indexMaxKeys.value); n > 0; n--) {
		const run = bounded.slice(0, n)
		const [first, ...rest] = run
		const proved = btreeEntry(run.map((b) => entryColumn(b.column, b.datum)))
		if (first !== undefined && proved.ok) {
			return {
				method: "btree",
				columns: [first.column, ...rest.map((b) => b.column)],
				entry: proved.value
			}
		}
	}
	const hashed = [
		...columns.filter((c) => c.kind === "field"),
		...columns.filter((c) => c.kind === "law")
	].find(hashable)
	if (hashed !== undefined) {
		return { method: "hash", columns: [hashed] }
	}
	const [widest] = bounded
	const fault =
		widest === undefined ? undefined : btreeEntry([entryColumn(widest.column, widest.datum)])
	return fault === undefined || fault.ok
		? missing(`a referencing column of ${subject} a B-tree entry holds or a hash index hashes`)
		: unrepresentable(loc, subject, columns.map(plannedText), fault.error)
}

/**
 * The GiST index a PERIOD reference's reverse probe reads over its referencing scalars and then its span: the longest
 * leading run of the scalars whose datum is bounded, in their order, whose entry gistEntry proves with the span within a
 * GiST page, else the span alone, which a GiST entry always holds.
 */
const plannedPeriodReverse = (
	scalars: ReadonlyArray<PlannedColumn>,
	span: PlannedColumn,
	subject: string,
	loc: SourceLoc
): PlannedReverse => {
	const spanDatum = plannedDatum(span) ?? missing(`the bounded datum of the span of ${subject}`)
	const spanEntry = { field: plannedText(span), datum: spanDatum }
	const bounded = boundedColumns(scalars)
	for (let n = Math.min(bounded.length, indexMaxKeys.value - 1); n >= 0; n--) {
		const run = bounded.slice(0, n)
		const proved = gistEntry(
			run.map((b) => ({ field: plannedText(b.column), datum: b.datum })),
			spanEntry
		)
		if (proved.ok) {
			return {
				method: "gist",
				columns: appendNonEmpty(
					run.map((b) => b.column),
					span
				),
				entry: proved.value
			}
		}
	}
	const alone = gistEntry([], spanEntry)
	return alone.ok
		? { method: "gist", columns: [span], entry: alone.value }
		: unrepresentable(loc, subject, [plannedText(span)], alone.error)
}

/**
 * The GiST entry of a span key the law model plans, its scalar columns and then its span, proved within a GiST page for
 * every value its columns admit (schema/representability.ts gistEntry), or its refusal, UnrepresentableKey with
 * `subject`: past INDEX_MAX_KEYS columns, over a text of no byte bound, over a column btree_gist has no operator class
 * for, or over an entry past the page. A planned WithoutOverlaps holds this entry, so none is planned past it.
 */
const plannedGist = (
	scalars: ReadonlyArray<PlannedColumn>,
	span: PlannedColumn,
	subject: string,
	loc: SourceLoc
): GistEntryBytes => {
	const key = [...scalars.map(plannedText), plannedText(span)]
	if (key.length > indexMaxKeys.value) {
		return unrepresentable(loc, subject, key, { kind: "columns", limit: indexMaxKeys.value })
	}
	const bounded = (c: PlannedColumn): { readonly field: string; readonly datum: DatumBound } => {
		const datum = plannedDatum(c)
		return datum === undefined
			? unrepresentable(loc, subject, key, { kind: "unboundedText", field: plannedText(c) })
			: { field: plannedText(c), datum }
	}
	const proved = gistEntry(scalars.map(bounded), bounded(span))
	return proved.ok ? proved.value : unrepresentable(loc, subject, key, proved.error)
}

/** A side as a refusal names it: its terms over its relation, selected or whole. */
const sideText = (side: ResolvedSide): string =>
	`${side.selection.conjuncts.length === 0 ? "" : "selected "}${side.relation}(${side.terms.map(termText).join(", ")})`

/** A law column as a planned native reads it. */
const lawColumn = (column: LawColumnPlan): PlannedColumn => ({ kind: "law", column })

/**
 * What a leaf of a generated CHECK's predicate names beyond its relation's fields: a law column of the relation at the
 * type of the values it holds, or a literal at its type.
 */
export type CheckLeaf =
	| { readonly kind: "law"; readonly column: LawColumnPlan; readonly type: ScalarType }
	| { readonly kind: "literal"; readonly literal: TypedLiteral; readonly type: ScalarType }

/**
 * A generated CHECK's predicate over one row of its relation: a predicate whose field leaves each name a field of the
 * relation, or one of `leaves`, by its name there. A leaf's name is never a field's.
 */
export interface CheckPredicate {
	readonly predicate: ExprDesc
	readonly leaves: ReadonlyMap<string, CheckLeaf>
}

/**
 * How a planned foreign key is deferred: by the schema-wide rule (on a cycle of the rule's foreign keys, or into a
 * replaceable target), or as its family axis fixes it.
 */
export type ForeignKeyDeferral = "rule" | "immediate" | "deferred"

/** A native object as planned: the frozen NativeObject kinds, with a law column still symbolic, a foreign key's deferral
 * still to decide, and a generated CHECK still to lower. */
export type NativePlan =
	| {
			readonly kind: "PrimaryKey"
			readonly relation: RelationInfo
			readonly columns: NonEmptyReadonlyArray<LawField>
			readonly named: Identity<"primaryKey" | "key">
	  }
	| {
			readonly kind: "Unique"
			readonly relation: RelationInfo
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
			/** Its B-tree entry, proved within BTMaxItemSize where it was planned (`plannedEntry`). */
			readonly entry: BtreeEntryBytes
	  }
	| { readonly kind: "Domain"; readonly contract: OwnedContract }
	| {
			readonly kind: "TableCheck"
			readonly relation: RelationInfo
			readonly name: string
			readonly named: Identity<"check">
			/** The predicate as the check law's violation query lowers it. */
			readonly predicate: ScalarExpr
	  }
	| {
			/** One CHECK a law generates on `relation`: the conjunction of every row condition it states there. */
			readonly kind: "GeneratedCheck"
			readonly relation: RelationInfo
			readonly check: CheckPredicate
	  }
	| { readonly kind: "RosterDomain"; readonly name: DeclaredName }
	| {
			/** A containment into a closed side (`#intoClosed`), its source's selection still to lower over its row. */
			readonly kind: "ClosedCheck"
			readonly relation: RelationInfo
			readonly target: ClosedTheoryRelation
			readonly side: CellSide<TypedLiteral>
			readonly pairs: NonEmptyReadonlyArray<{
				readonly source: PlannedColumn
				readonly target: LawField
			}>
			readonly guard: ReadonlyArray<ResolvedConjunct>
	  }
	| {
			readonly kind: "ForeignKey"
			readonly relation: RelationInfo
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
			readonly target: RelationInfo
			readonly targetColumns: NonEmptyReadonlyArray<PlannedColumn>
			readonly onUpdate: "cascade" | "noAction"
			readonly deferral: ForeignKeyDeferral
			/**
			 * The laws it discharges, the reported one first, where it is a family axis whose pairs state several (its
			 * former's and every containment that rides it); undefined for a foreign key of one law, the law that plans it.
			 */
			readonly laws: NonEmptyReadonlyArray<LawId> | undefined
	  }
	| { readonly kind: "LawColumn"; readonly column: LawColumnPlan }
	| {
			readonly kind: "WithoutOverlaps"
			readonly relation: RelationInfo
			readonly span: PlannedColumn
			readonly key: PlannedSpanKey
			/** The identity ownership named a declared span key's constraint by; undefined for a key over a projected side,
			 * which the naming door names by its columns. */
			readonly named: Identity<"primaryKey" | "key"> | undefined
			/** Its GiST entry, proved within a GiST page where it was planned (`plannedGist`). */
			readonly entry: GistEntryBytes
	  }
	| {
			readonly kind: "PeriodForeignKey"
			readonly relation: RelationInfo
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
			readonly span: PlannedColumn
			readonly target: RelationInfo
			readonly targetColumns: NonEmptyReadonlyArray<PlannedColumn>
			readonly targetSpan: PlannedColumn
	  }
	| ({ readonly kind: "ReverseIndex"; readonly relation: RelationInfo } & PlannedReverse)

/**
 * The index of a reverse probe as planned (ir/law.ts ReverseIndexOn), with the proof of its entry: a B-tree's or a
 * GiST's proved within its limit, or a hash index's, whose entry is a 4-byte hash code (`plannedReverse`).
 */
export type PlannedReverse =
	| {
			readonly method: "btree"
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
			readonly entry: BtreeEntryBytes
	  }
	| {
			readonly method: "gist"
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
			readonly entry: GistEntryBytes
	  }
	| { readonly method: "hash"; readonly columns: readonly [PlannedColumn] }

/** A span key's scalar columns as planned (ir/law.ts SpanKeyScalars). */
export type PlannedSpanKey =
	| { readonly kind: "primary"; readonly scalars: NonEmptyReadonlyArray<PlannedColumn> }
	| { readonly kind: "unique"; readonly scalars: ReadonlyArray<PlannedColumn> }

/** The law column natives a list of planned columns reads, each once. */
const lawColumns = (columns: ReadonlyArray<PlannedColumn>): ReadonlyArray<NativePlan> =>
	columns.flatMap((c): ReadonlyArray<NativePlan> =>
		c.kind === "law" ? [...dependencies(c.column), { kind: "LawColumn", column: c.column }] : []
	)

/** The law columns a law column's value reads, which must stand beside it: a counted predecessor reads its index. */
const dependencies = (column: LawColumnPlan): ReadonlyArray<NativePlan> =>
	column.kind === "indexPred" ? [{ kind: "LawColumn", column: column.index }] : []

/**
 * The columns a side lowers to, one per term (§ partial projections): a field term of an unselected side is its field;
 * every term of a selected side, and every pred term, is a law column generated `CASE WHEN φ THEN t END`, null
 * wherever the side reads no tuple, so a key over it holds apart only the rows it reads and a reference from it
 * references only from them.
 */
const sideColumns = (side: ResolvedSide): NonEmptyReadonlyArray<PlannedColumn> =>
	mapNonEmpty(side.terms, (term) => termColumn(tableOf(side.rel), term, side.selection))

/** One term of a side over `relation` under `selection` as a column (`sideColumns`). */
const termColumn = (
	relation: RelationInfo,
	term: ResolvedTerm,
	selection: ResolvedSelection
): PlannedColumn =>
	term.kind === "field" && selection.conjuncts.length === 0
		? fieldColumn(term.column)
		: lawColumn({ kind: "term", relation, term, selection })

/**
 * `r` as the ordinary relation a native object is installed on. `plan` routes every law over a closed relation alone to
 * the migration (`migrationPlan`) and every containment into one to a ClosedCheck on its open source (`#intoClosed`)
 * before it plans any other object, and the theory admits no family over a closed relation, so a closed relation here
 * is a defect.
 */
const tableOf = (r: TheoryRelation): RelationInfo => {
	if (r.kind === "closed") {
		throw defect(
			`an object of an ordinary relation; ${r.name} is closed, which plan routes elsewhere`
		)
	}
	return r
}

/** A primary key's native object as planned: a PRIMARY KEY, or a primary key WITHOUT OVERLAPS. */
export type PrimaryKeyPlan =
	| Extract<NativePlan, { readonly kind: "PrimaryKey" }>
	| (Extract<NativePlan, { readonly kind: "WithoutOverlaps" }> & {
			readonly key: Extract<PlannedSpanKey, { readonly kind: "primary" }>
			readonly named: Identity<"primaryKey" | "key">
	  })

/**
 * The native object of the primary key `key` of `r`: a PRIMARY KEY over a scalar key, or its span field last WITHOUT
 * OVERLAPS. A primary key whose only field is a span has no native lowering: PostgreSQL's PRIMARY KEY needs a column
 * before WITHOUT OVERLAPS (42601), and an exclusion constraint is no primary key, so it is UnrepresentableKey.
 */
export const primaryKeyPlan = (r: RelationInfo, key: KeyName, loc: SourceLoc): PrimaryKeyPlan => {
	const { fields, span, named } = key
	if (span === undefined) {
		return { kind: "PrimaryKey", relation: r, columns: fields, named }
	}
	const scalars = fields.filter((f) => f !== span)
	if (!isNonEmpty(scalars)) {
		return unrepresentable(loc, `the primary key of ${r.name}`, fieldNames(fields), {
			kind: "spanAlone",
			field: span.name
		})
	}
	const scalarColumns = mapNonEmpty(scalars, fieldColumn)
	return {
		kind: "WithoutOverlaps",
		relation: r,
		span: fieldColumn(span),
		key: { kind: "primary", scalars: scalarColumns },
		named,
		entry: plannedGist(scalarColumns, fieldColumn(span), `the primary key of ${r.name}`, loc)
	}
}

export interface LawPlan {
	readonly law: TheoryLaw
	readonly natives: ReadonlyArray<NativePlan>
	/**
	 * Where the law is discharged: on every write, by its natives; or, for a law that reads closed relations alone,
	 * once by PostgreSQL in the migration that installs them, as its violation query over their rows, so it installs
	 * nothing (fin.md §17, "Where each law is discharged").
	 */
	readonly discharge: "write" | "migration"
}

/** A law that reads closed relations alone, discharged by the migration: no native. */
const migrationPlan = (law: TheoryLaw): LawPlan => ({ law, natives: [], discharge: "migration" })

const sameSet = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean =>
	a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

const contains = <T>(outer: ReadonlyArray<T>, inner: ReadonlyArray<T>): boolean =>
	inner.every((x) => outer.includes(x))

/** The handles of each declared key's fields, the primary key's first. */
const declaredFields = (r: TheoryRelation): ReadonlyArray<NonEmptyReadonlyArray<LawField>> => [
	r.primaryFields,
	...r.keyFields
]

/** The declared keys of `r` with no span field. */
const scalarKeys = (r: TheoryRelation): ReadonlyArray<NonEmptyReadonlyArray<LawField>> =>
	declaredFields(r).filter((k) => !k.some(isSpanField))

/** A side's fields, or the refusal of `what` over a side with a pred term, which `what` reads as fields alone. */
const fieldsOf = (
	side: ResolvedSide,
	loc: SourceLoc,
	what: string
): NonEmptyReadonlyArray<LawField> => {
	const fields = fieldTermsOf(side.terms)
	return fields === undefined
		? refuse(
				"UnsupportedLawFamily",
				loc,
				`${what} over fields; ${side.relation}(${side.terms.map(termText).join(", ")}) has a pred term`
			)
		: mapNonEmpty(fields, (t) => t.column)
}

/** A side's selectors, or the refusal of `what` over a side with a conjunct that fixes no field. */
const literalsOf = (
	side: ResolvedSide,
	loc: SourceLoc,
	what: string
): ReadonlyArray<ResolvedSelector> =>
	side.selection.conjuncts.map((c) =>
		c.kind === "fixed"
			? c.selector
			: refuse(
					"UnsupportedLawFamily",
					loc,
					`${what} whose sides select by conjunctions of field = literal; select(${side.relation}, ...) selects by another predicate`
				)
	)

/** Whether a key over `key` keys `target`: every conjunct of the key's selection is one of the target's, which so
 * reads only facts the key holds apart, and the target's terms hold every term of the key, each of one kind over one
 * field. */
const keyedBy = (key: ResolvedSide, target: ResolvedSide): boolean =>
	key.selection.conjuncts.every((k) => target.selection.conjuncts.some((c) => c.text === k.text)) &&
	key.terms.every((k) => target.terms.some((t) => t.kind === k.kind && t.column === k.column))

/** Whether `key` is exactly `side`: the same conjuncts and the same terms, each of one kind over one field. */
const sameSide = (key: ResolvedSide, side: ResolvedSide): boolean =>
	keyedBy(key, side) &&
	key.selection.conjuncts.length === side.selection.conjuncts.length &&
	key.terms.length === side.terms.length

/** The one span field term of a side, if it has exactly one; the refusal of a key holding two. */
const spanTermOf = (side: ResolvedSide, loc: SourceLoc): ResolvedTerm | undefined => {
	const spans = side.terms.filter((t) => isSpanField(t.column))
	if (spans.length > 1) {
		return unrepresentable(
			loc,
			`the key over ${side.relation}(${side.terms.map(termText).join(", ")})`,
			side.terms.map(termText),
			{ kind: "spans", fields: spans.map((t) => t.field) }
		)
	}
	return spans[0]
}

/** The coverage refusal of an unkeyed target: a temporal reference needs the target's spans disjoint within a key. */
const coverageKeySentence =
	"a coverage target needs a `WITHOUT OVERLAPS` key over its span; coalesce the spans, or key them"

/** A literal expression of a small natural, which every comparison of a family's drawn naturals reads. */
const naturalLiteral = (value: 0n | 1n): ExprDesc => ({ kind: "literal", value, type: undefined })

const cmp = (
	op: "eq" | "ne" | "lt" | "le" | "gt" | "ge",
	left: ExprDesc,
	right: ExprDesc
): ExprDesc => ({
	kind: "compare",
	op,
	left,
	right
})

const or = (args: NonEmptyReadonlyArray<ExprDesc>): ExprDesc =>
	args.length === 1 ? args[0] : { kind: "or", args }

const and = (args: NonEmptyReadonlyArray<ExprDesc>): ExprDesc =>
	args.length === 1 ? args[0] : { kind: "and", args }

/**
 * The row conditions one law states on one relation, gathered into the one generated CHECK the law installs there: each
 * column it reads a leaf, a field by its name and every other by a name no field has.
 */
class RowConditions {
	readonly relation: RelationInfo
	readonly #leaves = new Map<string, CheckLeaf>()
	readonly #conjuncts: Array<ExprDesc> = []

	constructor(relation: RelationInfo) {
		this.relation = relation
	}

	/** A column of the relation, a field by its name and a law column as a leaf of the type of the values it holds. */
	column(c: PlannedColumn): ExprDesc {
		if (c.kind === "field") {
			return { kind: "field", field: c.field.name }
		}
		return this.#leaf({ kind: "law", column: c.column, type: heldType(c.column) })
	}

	literal(literal: TypedLiteral, type: ScalarType): ExprDesc {
		return this.#leaf({ kind: "literal", literal, type })
	}

	add(conjunct: ExprDesc): void {
		this.#conjuncts.push(conjunct)
	}

	native(): NativePlan | undefined {
		const [first, ...rest] = this.#conjuncts
		return first === undefined
			? undefined
			: {
					kind: "GeneratedCheck",
					relation: this.relation,
					check: { predicate: and([first, ...rest]), leaves: new Map(this.#leaves) }
				}
	}

	#leaf(leaf: CheckLeaf): ExprDesc {
		const name = `‹${this.#leaves.size}›`
		if (this.relation.fields.some((f) => f.name === name)) {
			throw defect(`a leaf name no field of ${this.relation.name} has; ${name} is one`)
		}
		this.#leaves.set(name, leaf)
		return { kind: "field", field: name }
	}
}

/** The type of the values a law column holds: its field's. */
const heldType = (column: LawColumnPlan): ScalarType => {
	switch (column.kind) {
		case "constant":
		case "drawn":
		case "indexPred":
			return column.field.type
		case "term":
			return column.term.column.type
	}
}

/** Whether PostgreSQL generates a column: a generated field, or a law column generated from its row. */
const isGenerated = (c: PlannedColumn): boolean => {
	if (c.kind === "field") {
		return c.field.writing.kind === "generated"
	}
	switch (c.column.kind) {
		case "term":
		case "constant":
		case "indexPred":
			return true
		case "drawn":
			return false
	}
}

/** The key a law column's plan is known by within a family: a drawn column's identifier. */
const columnKey = (c: NativeColumn): string =>
	c.kind === "field" ? `f ${c.field.name}` : `l ${c.column}`

/**
 * One axis of a family as planned: its foreign key and the UNIQUE over its target's columns it references, the law
 * columns either side reads, and every law its pairs state.
 */
interface AxisPlan {
	readonly natives: ReadonlyArray<NativePlan>
	readonly foreignKey: Extract<NativePlan, { readonly kind: "ForeignKey" }>
}

/** A carried pair as planned: its two columns, each with its key in its row, and the laws it states. */
interface CarriedPair {
	readonly from: PlannedColumn
	readonly to: PlannedColumn
	readonly fromKey: string
	readonly toKey: string
	readonly laws: NonEmptyReadonlyArray<LawId>
}

/**
 * A family's natives as planned once for every law that reads them: its axes, its key, and every row condition each
 * law states on each relation of the family.
 */
interface FamilyPlan {
	readonly family: Family
	readonly law: TheoryLaw
	readonly member: RelationInfo
	readonly owner: RelationInfo
	/** The family's own natives: its law columns, its key and its three axes. */
	readonly natives: ReadonlyArray<NativePlan>
	readonly axes: { readonly [A in AxisKind]: AxisPlan }
	/** Each law's row conditions, by relation name, the family's own law's among them. */
	readonly conditions: ReadonlyMap<LawId, ReadonlyMap<string, RowConditions>>
	/** Each hidden fold accumulator's law column natives, by fold. */
	readonly folds: ReadonlyArray<ReadonlyArray<NativePlan>>
}

/**
 * The recognition table: each normalized law to its plan of native objects. Laws are database obligations.
 *
 * A shape the recognizer does not know is rejected, never interpreted. Each case below states the row it implements;
 * everything else is refused with UnsupportedLawFamily, naming what the compiler admits. A plan is pure data: law
 * column names, foreign key deferral and the generated CHECK predicates are settled afterwards, over every plan at once
 * (`compileLaws`), because they depend on the whole schema.
 *
 * The rules it implements, the partial projections first:
 *
 * - A side lowers to one column per term (`sideColumns`): an unselected side's field term is its field, and every term
 *   of a selected side and every pred term is a law column generated `CASE WHEN φ₁ AND … THEN t END` STORED over its
 *   selection's conjuncts, pred(x) being `CASE WHEN x > 0 THEN x - 1 END` (scalar/natural.ts guardedTerm). A row whose
 *   side reads no tuple holds a null there.
 * - A key over a side is UNIQUE NULLS DISTINCT over its columns, which holds apart only the rows the side reads; one
 *   whose terms hold a span field is WITHOUT OVERLAPS over them, the span last.
 * - A containment is FOREIGN KEY MATCH SIMPLE from the source's columns, which references nothing from a row whose side
 *   reads no tuple, into a UNIQUE over exactly the target's columns, and its referencing columns are indexed. The
 *   target must contain a key: a declared key of its relation among its field terms, or a projected key of the
 *   relation whose conjuncts are among the target's and whose terms are among its terms. Its UNIQUE is that key's when
 *   the columns are exactly a declared key's, and otherwise a generated superkey, exact because a superkey of a key is
 *   unique.
 * - A constant selection of a target: its fixed conjuncts over fields that are none of its terms, which, with its field
 *   terms, contain a declared key of the target, are a constant law column each on the source instead, matched against
 *   the target's terms under its other conjuncts and then its fixed fields, so every constant shares one target
 *   UNIQUE. An alternatives arm of one handle is one: its parent selected by the handle.
 * - A coverage, a containment pairing a span field of each side, is a PERIOD foreign key from the source's columns into
 *   the target's, which must be keyed WITHOUT OVERLAPS over exactly its terms: a declared span key, or a key over its
 *   projected side. A target whose spans may overlap within a key is refused.
 * - A family is its three axes (`#familyPlan`): the owner axis, member to owner carrying the owner's count ‹n› and ON
 *   UPDATE CASCADE, a tree's from its plain parent with no action, its root referencing itself; the predecessor axis,
 *   each member to the one before it; and the last axis, the owner to its last member. A containment that rides an axis has no native of its own: its pairs and its law are on the axis's foreign
 *   key. A tree adds its interval laws as CHECKs and its copies as pairs, and a fold its accumulators' CHECK and pins.
 * - A key containing a span field is a pointwise nonoverlap rule: facts may share its scalar fields provided their
 *   spans share no point. Its native lowering places the span last WITHOUT OVERLAPS, as the primary key or as
 *   `UNIQUE (..., span WITHOUT OVERLAPS)` for a candidate key, both under the key's own constraint name; every scalar
 *   component needs a btree_gist operator class, which Setup creates if absent and verifies. A key whose only field is
 *   a span needs none: it is `EXCLUDE USING gist (span WITH &&)` under the same name, and since an exclusion constraint
 *   is no primary key, every span-only key is a candidate key. A key with two span fields, and a primary key whose
 *   only field is a span, have no native lowering and are UnrepresentableKey at recognition.
 * - Every writer meets a span key's overlap as SQLSTATE 23P01 under the key's constraint name, which the
 *   constraint-to-LawId map turns into the span key law. A span key is no ON CONFLICT ... DO SELECT arbiter:
 *   PostgreSQL refuses an exclusion constraint there. */
export class Recognizer {
	/** Each relation's keys over projected sides, by relation name, which a containment's target may contain. */
	readonly #projectedKeys: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>
	readonly #relations: Readonly<Record<string, TheoryRelation>>
	readonly #families: ReadonlyMap<string, Family>
	/** Each family's or tree's own law, by family key. */
	readonly #familyLaws: ReadonlyMap<string, TheoryLaw>
	/** Each family's fold laws, by family key, each at its fold's position. */
	readonly #foldLaws: ReadonlyMap<string, ReadonlyMap<number, FoldLaw>>
	/** Each family's plan, built once for every law that reads it. */
	readonly #planned = new Map<string, FamilyPlan>()
	/** The columns each relation's owner axes write by ON UPDATE CASCADE, by relation name and column key. */
	readonly #cascaded: ReadonlyMap<string, ReadonlySet<string>>

	constructor(
		laws: ReadonlyArray<TheoryLaw>,
		families: ReadonlyArray<Family>,
		relations: Readonly<Record<string, TheoryRelation>>
	) {
		const keys = new Map<string, Array<ResolvedSide>>()
		const familyLaws = new Map<string, TheoryLaw>()
		const foldLaws = new Map<string, Map<number, FoldLaw>>()
		for (const law of laws) {
			const d = law.detail
			switch (d.kind) {
				case "projectedKey":
					keys.set(d.side.relation, [...(keys.get(d.side.relation) ?? []), d.side])
					break
				case "family":
				case "tree":
					familyLaws.set(familyKey(d.family.id), law)
					break
				case "fold": {
					const own = foldLaws.get(familyKey(d.family)) ?? new Map<number, FoldLaw>()
					own.set(d.fold, { law, detail: d })
					foldLaws.set(familyKey(d.family), own)
					break
				}
				case "key":
				case "check":
				case "contract":
				case "containment":
					break
			}
		}
		this.#projectedKeys = keys
		this.#relations = relations
		this.#families = new Map(families.map((f) => [familyKey(f.id), f] as const))
		this.#familyLaws = familyLaws
		this.#foldLaws = foldLaws
		const cascaded = new Map<string, Set<string>>()
		for (const f of families) {
			const own = cascaded.get(f.member.name) ?? new Set<string>()
			for (const c of ownerSources(f)) {
				own.add(columnKey(c))
			}
			cascaded.set(f.member.name, own)
		}
		this.#cascaded = cascaded
	}

	plan(law: TheoryLaw): LawPlan {
		const loc = law.loc
		const d = law.detail
		const done = (natives: ReadonlyArray<NativePlan>): LawPlan => ({
			law,
			natives,
			discharge: "write"
		})
		switch (d.kind) {
			case "key":
				return d.rel.kind === "closed" ? migrationPlan(law) : done(this.#key(d, d.rel, loc))
			case "projectedKey":
				return d.side.rel.kind === "closed"
					? migrationPlan(law)
					: done(this.#projectedKey(d.side, loc))
			case "check":
				return d.rel.kind === "closed"
					? migrationPlan(law)
					: done([
							{
								kind: "TableCheck",
								relation: d.rel,
								name: d.name,
								named: d.named,
								predicate: d.lowered
							}
						])
			case "contract":
				return done([{ kind: "Domain", contract: d.owned }])
			case "containment":
				return this.#containment(law, d, loc, done)
			case "family":
			case "tree":
				return done(this.#familyNatives(this.#familyPlan(d.family.id, loc), law.id))
			case "fold": {
				const planned = this.#familyPlan(d.family, loc)
				return done([
					...(planned.folds[d.fold] ?? []),
					planned.axes.predecessor.foreignKey,
					planned.axes.last.foreignKey,
					...this.#axisNatives(planned, ["predecessor", "last"]),
					...conditionsOf(planned, law.id)
				])
			}
		}
	}

	/** A scalar key is PRIMARY KEY or UNIQUE; a span key places its span field last
	 * WITHOUT OVERLAPS, or, alone, is an exclusion constraint under the key's name. */
	#key(
		d: Extract<TheoryLaw["detail"], { readonly kind: "key" }>,
		rel: RelationInfo,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const { fields, span, primary, named } = d.key
		if (primary) {
			return [primaryKeyPlan(rel, d.key, loc)]
		}
		if (span === undefined) {
			const columns = mapNonEmpty(fields, fieldColumn)
			return [
				{
					kind: "Unique",
					relation: rel,
					columns,
					entry: plannedEntry(columns, `key (${fieldNames(fields).join(", ")}) of ${rel.name}`, loc)
				}
			]
		}
		const scalars = fields.filter((f) => f !== span).map(fieldColumn)
		return [
			{
				kind: "WithoutOverlaps",
				relation: rel,
				span: fieldColumn(span),
				key: { kind: "unique", scalars },
				named,
				entry: plannedGist(
					scalars,
					fieldColumn(span),
					`key (${fieldNames(fields).join(", ")}) of ${rel.name}`,
					loc
				)
			}
		]
	}

	/** A key over a projected side: UNIQUE NULLS DISTINCT over its columns, or WITHOUT OVERLAPS over them where one term
	 * is a span field, its law column last. */
	#projectedKey(side: ResolvedSide, loc: SourceLoc): ReadonlyArray<NativePlan> {
		const relation = tableOf(side.rel)
		const columns = sideColumns(side)
		const span = spanTermOf(side, loc)
		if (span === undefined) {
			return [
				...lawColumns(columns),
				{
					kind: "Unique",
					relation,
					columns,
					entry: plannedEntry(columns, `key ${sideText(side)}`, loc)
				}
			]
		}
		const at = side.terms.indexOf(span)
		const spanColumn = columns[at] ?? missing(`the column of the span term of ${side.relation}`)
		const scalars = columns.filter((_, i) => i !== at)
		return [
			...lawColumns(columns),
			{
				kind: "WithoutOverlaps",
				relation,
				span: spanColumn,
				key: { kind: "unique", scalars },
				named: undefined,
				entry: plannedGist(scalars, spanColumn, `key ${sideText(side)}`, loc)
			}
		]
	}

	#containment(
		law: TheoryLaw,
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		loc: SourceLoc,
		done: (natives: ReadonlyArray<NativePlan>) => LawPlan
	): LawPlan {
		const fromRel = d.from.rel
		const toRel = d.to.rel
		if (fromRel.kind === "closed") {
			if (toRel.kind !== "closed") {
				return refuse(
					"UnsupportedLawFamily",
					loc,
					`a containment into a closed relation, or between closed ones; ${d.from.relation}'s rows into the open ${d.to.relation} would require rows of an open relation: state those rows as a closed relation`
				)
			}
			return migrationPlan(law)
		}
		if (toRel.kind === "closed") {
			switch (d.pairing.kind) {
				case "span":
					return refuse(
						"UnsupportedLawFamily",
						loc,
						`a coverage law into a span-keyed stored relation; ${d.to.relation} is closed`
					)
				case "scalar":
					return done(this.#intoClosed(d, fromRel, toRel, loc))
			}
		}
		const lowers = d.lowers
		if (lowers.kind === "rides") {
			const planned = this.#familyPlan(lowers.family, loc)
			return done([
				planned.axes[lowers.axis].foreignKey,
				...this.#axisNatives(planned, [lowers.axis]),
				...conditionsOf(planned, law.id)
			])
		}
		switch (d.pairing.kind) {
			case "span":
				return done(this.#coverage(d, d.pairing, loc))
			case "scalar":
				return done(this.#scalarContainment(d.from, d.to, loc))
		}
	}

	/**
	 * A containment of an open relation's side into a closed relation's (U3): a lone closed-id field contained in its own
	 * roster's unselected id is discharged by the roster's domain, which types the field, whatever rows the source
	 * selects; every other is a ClosedCheck, a table CHECK on the source reading the target side's constant at the row's
	 * codes, holding vacuously outside the source's selection. The target side is a closed relation of its own
	 * (ir/cells.ts sideOf), its rows the target's facts its fixed selection keeps, keyed by the smallest declared key it
	 * contains or else by all its fields. Each of its key fields is a closed id, and its source a field of that
	 * roster's type, so every digit of its mixed-radix index is a code its column's roster domain proves in range; a
	 * side keyed by an open-typed field has no such index, and is refused.
	 */
	#intoClosed(
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		fromRel: RelationInfo,
		toRel: ClosedTheoryRelation,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const what = "a containment into a closed relation"
		const fromFields = fieldsOf(d.from, loc, what)
		const toFields = fieldsOf(d.to, loc, what)
		const toSelection = literalsOf(d.to, loc, what)
		const [only, ...more] = d.pairs
		const roster = rosterOf(baseOf(only.from.column.type))
		if (
			more.length === 0 &&
			only.to.column.name === "id" &&
			toSelection.length === 0 &&
			roster?.closed === toRel.name
		) {
			return [{ kind: "RosterDomain", name: roster.closed }]
		}
		const rows = toRel.rows.filter((row) =>
			toSelection.every((s) => literalKey(closedCell(row, s.col.position)) === literalKey(s.value))
		)
		const side = sideOf(
			{ fields: mapNonEmpty(toRel.fields, (f) => f.name), keys: [toRel.primaryKey] },
			mapNonEmpty(toFields, (f) => f.name),
			rows,
			literalKey
		)
		/** The source field each target field meets, by the containment's pairs. */
		const sourceOf = (target: LawField): LawField =>
			fromFields[toFields.indexOf(target)] ??
			refuse("MalformedDescription", loc, `${what} pairing every field of ${d.to.relation}`)
		const targetField = (name: string): LawField =>
			toFields.find((f) => f.name === name) ??
			refuse("MalformedDescription", loc, `${what} over fields of ${d.to.relation}, not ${name}`)
		const keyPairs = mapNonEmpty(side.key, (name) => {
			const target = targetField(name)
			const source = sourceOf(target)
			const targetRoster = rosterOf(baseOf(target.type))
			if (targetRoster === undefined) {
				return refuse(
					"UnsupportedLawFamily",
					loc,
					`${what} whose side is keyed by closed ids, each a code its column's roster domain keeps in range; ${d.to.relation}(${toFields.map((f) => f.name).join(", ")}) is keyed by ${name}, which is open-typed`
				)
			}
			if (rosterOf(baseOf(source.type))?.closed !== targetRoster.closed) {
				return refuse(
					"UnsupportedLawFamily",
					loc,
					`${what} whose key fields each meet a field of their roster's type; ${d.from.relation}.${source.name} is no closed id of ${targetRoster.closed}`
				)
			}
			return { source: fieldColumn(source), target }
		})
		const payloadPairs = side.payload.map((name) => {
			const target = targetField(name)
			return { source: fieldColumn(sourceOf(target)), target }
		})
		return [
			{
				kind: "ClosedCheck",
				relation: fromRel,
				target: toRel,
				side,
				pairs: extendNonEmpty(keyPairs, payloadPairs),
				guard: d.from.selection.conjuncts
			}
		]
	}

	/** Whether `fields` contain a declared scalar key of `r`. */
	#containsKey(r: TheoryRelation, fields: ReadonlyArray<LawField>): boolean {
		return scalarKeys(r).some((k) => contains<LawField>(fields, k))
	}

	/**
	 * A containment from one side into another: a foreign key MATCH SIMPLE from the source's columns into the target's,
	 * the UNIQUE over the target's columns it references, the law columns either side reads, and the index over the
	 * referencing columns. A target fixed by a constant selection references through constant law columns on the
	 * source, which the index leaves out: a constant narrows no lookup.
	 */
	#scalarContainment(
		from: ResolvedSide,
		to: ResolvedSide,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const fromRel = tableOf(from.rel)
		const toRel = tableOf(to.rel)
		const sourceColumns = sideColumns(from)
		const constant = this.#constantTarget(to, fromRel)
		const columns: NonEmptyReadonlyArray<PlannedColumn> =
			constant === undefined
				? sourceColumns
				: extendNonEmpty(sourceColumns, constant.tags.map(lawColumn))
		const targetColumns = constant === undefined ? sideColumns(to) : constant.columns
		if (constant === undefined && !this.#targetKeyed(to)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a containment into a side that contains a key of ${toRel.name}; ${to.relation}(${to.terms.map(termText).join(", ")}) contains no declared key among its fields and no key over its own selection, and a containment into an unkeyed side is not admitted`
			)
		}
		const containment = `the containment of ${sideText(from)} in ${sideText(to)}`
		return [
			...lawColumns(columns),
			...lawColumns(targetColumns),
			...this.#targetUnique(toRel, targetColumns, containment, loc),
			{
				kind: "ForeignKey",
				relation: fromRel,
				columns,
				target: toRel,
				targetColumns,
				onUpdate: "noAction",
				deferral: "rule",
				laws: undefined
			},
			{
				kind: "ReverseIndex",
				relation: fromRel,
				...plannedReverse(
					sourceColumns,
					`the index of ${fromRel.name} over the columns ${containment} references from`,
					loc
				)
			}
		]
	}

	/**
	 * The UNIQUE a reference into `columns` of `r` needs, `containment` the law that references it: none where they are
	 * exactly a declared scalar key's fields, which its own key law installs, else a generated one, whose entry is
	 * bounded as a key's is.
	 */
	#targetUnique(
		r: RelationInfo,
		columns: NonEmptyReadonlyArray<PlannedColumn>,
		containment: string,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const fields = columns.flatMap((c) => (c.kind === "field" ? [c.field] : []))
		const declared =
			fields.length === columns.length && scalarKeys(r).some((k) => sameSet<LawField>(k, fields))
		return declared
			? []
			: [
					{
						kind: "Unique",
						relation: r,
						columns,
						entry: plannedEntry(columns, `the UNIQUE of ${r.name} ${containment} references`, loc)
					}
				]
	}

	/**
	 * A target side fixed by a constant selection (see the recognition table): the target's terms are fields, and its
	 * fixed conjuncts over fields that are none of them, with its field terms, contain a declared key of the target. Its
	 * fixed conjuncts' constants are law columns of the source, and the target's columns are its terms under its other
	 * conjuncts (`sideColumns`), then its fixed fields: a fact the other conjuncts reject holds a null among its terms,
	 * which references nothing, and the declared key holds the rest apart, so one UNIQUE over them serves every
	 * constant. Undefined for any other target.
	 */
	#constantTarget(
		to: ResolvedSide,
		fromRel: RelationInfo
	):
		| {
				readonly tags: NonEmptyReadonlyArray<ConstantColumn>
				readonly columns: NonEmptyReadonlyArray<PlannedColumn>
		  }
		| undefined {
		const fields = fieldTermsOf(to.terms)
		if (fields === undefined) {
			return undefined
		}
		const terms = fields.map((t) => t.column)
		const fixes = (c: ResolvedConjunct): boolean =>
			c.kind === "fixed" && !terms.includes(c.selector.col)
		const selected = to.selection.conjuncts
			.flatMap((c) => (c.kind === "fixed" && fixes(c) ? [c.selector] : []))
			.toSorted((a, b) => a.col.position - b.col.position)
		if (
			!isNonEmpty(selected) ||
			!this.#containsKey(to.rel, [...terms, ...selected.map((s) => s.col)])
		) {
			return undefined
		}
		const rest: ResolvedSide = {
			...to,
			selection: { conjuncts: to.selection.conjuncts.filter((c) => !fixes(c)) }
		}
		return {
			tags: mapNonEmpty(selected, (s): ConstantColumn => ({
				kind: "constant",
				relation: fromRel,
				target: tableOf(to.rel),
				field: s.col,
				value: s.value
			})),
			columns: extendNonEmpty(
				sideColumns(rest),
				selected.map((s) => fieldColumn(s.col))
			)
		}
	}

	/** Whether a target side contains a key: a declared scalar key of its relation among its field terms, or a projected
	 * key of the relation over its own selection among its terms. */
	#targetKeyed(to: ResolvedSide): boolean {
		const fields = to.terms.flatMap((t) => (t.kind === "field" ? [t.column] : []))
		return (
			this.#containsKey(to.rel, fields) ||
			(this.#projectedKeys.get(to.relation) ?? []).some((k) => keyedBy(k, to))
		)
	}

	/**
	 * A coverage: each source fact's span covered by the union of the spans of the target facts it meets at its scalar
	 * terms. Each selected side's terms are law columns (`sideColumns`); the target must be keyed WITHOUT OVERLAPS over
	 * exactly its terms, by a declared span key of an unselected target or by a key over its projected side, so the
	 * target facts one source fact meets hold disjoint spans; and the law is `FOREIGN KEY (f…, PERIOD s) REFERENCES B
	 * (g…, PERIOD t)`, NO ACTION, deferred by the schema-wide rule, with the index over its referencing columns. A target
	 * whose spans may overlap within a key is refused. Grouped by at least one scalar term: PostgreSQL's PERIOD foreign
	 * key compares a scalar column before its period.
	 */
	#coverage(
		d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
		pairing: {
			readonly from: SpanField
			readonly to: SpanField
			readonly pair: (typeof d.pairs)[number]
		},
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const from = d.from
		const to = d.to
		const fromRel = tableOf(from.rel)
		const toRel = tableOf(to.rel)
		const at = d.pairs.indexOf(pairing.pair)
		if (at === -1) {
			return refuse(
				"MalformedDescription",
				loc,
				"a coverage law whose span pair is one of its pairs"
			)
		}
		const sourceColumns = sideColumns(from)
		const targetColumns = sideColumns(to)
		const sourceSpan = sourceColumns[at] ?? missing("a coverage source's span column")
		const targetSpan = targetColumns[at] ?? missing("a coverage target's span column")
		const sourceScalars = sourceColumns.filter((_, i) => i !== at)
		const targetScalars = targetColumns.filter((_, i) => i !== at)
		if (!isNonEmpty(sourceScalars) || !isNonEmpty(targetScalars)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`coverage grouped by at least one scalar field; ${from.relation} into ${to.relation} pairs only spans, an ungrouped span law`
			)
		}
		const toFields = to.terms.map((t) => t.column)
		const declared =
			to.selection.conjuncts.length === 0 &&
			to.terms.every((t) => t.kind === "field") &&
			toRel.keyNames.some((k) => k.span === pairing.to && sameSet<LawField>(k.fields, toFields))
		const projected = (this.#projectedKeys.get(to.relation) ?? []).some((k) => sameSide(k, to))
		if (!declared && !projected) {
			return refuse("UnsupportedLawFamily", loc, coverageKeySentence)
		}
		return [
			...lawColumns(sourceColumns),
			...lawColumns(targetColumns),
			{
				kind: "PeriodForeignKey",
				relation: fromRel,
				columns: sourceScalars,
				span: sourceSpan,
				target: toRel,
				targetColumns: targetScalars,
				targetSpan
			},
			{
				kind: "ReverseIndex",
				relation: fromRel,
				...plannedPeriodReverse(
					sourceScalars,
					sourceSpan,
					`the index of ${fromRel.name} over the columns the coverage of ${sideText(from)} in ${sideText(to)} references from`,
					loc
				)
			}
		]
	}

	/** The relation a family names, an ordinary one: the theory admits no family over a closed relation. */
	relation(name: string): RelationInfo {
		const r = this.#relations[name]
		if (r === undefined) {
			throw defect(`the relation ${name} a family names, which the theory typed`)
		}
		return tableOf(r)
	}

	/** The fold law at `fold` of the family `key`, which the theory states for every fold it resolves. */
	foldLaw(key: string, fold: number): FoldLaw {
		return (
			this.#foldLaws.get(key)?.get(fold) ?? missing(`the law of fold ${fold} of the family ${key}`)
		)
	}

	/** The natives of the family's own law: everything the family plans, and its own row conditions. */
	#familyNatives(planned: FamilyPlan, law: LawId): ReadonlyArray<NativePlan> {
		return [...planned.natives, ...conditionsOf(planned, law)]
	}

	/** The law column and UNIQUE natives the named axes' foreign keys read. */
	#axisNatives(planned: FamilyPlan, axes: ReadonlyArray<AxisKind>): ReadonlyArray<NativePlan> {
		return axes.flatMap((a) => planned.axes[a].natives)
	}

	/**
	 * A family's natives, planned once (fin.md §5.2, trees.md §2):
	 *
	 * - its columns: the index, a field when ordered and a drawn ‹i› when counted; the drawn ‹n› on each member; ‹p›,
	 *   the generated pred of the index; ‹pn›, the generated pred of the count on the owner; and for a tree ‹parent₀›,
	 *   its parent where its start is above 0, the one guarded group column, and the drawn ‹ps›. One guarded column per
	 *   side is exact: MATCH SIMPLE and UNIQUE NULLS DISTINCT both pass over a row with any null column;
	 * - its key, `UNIQUE (‹g₀›, g₂…, i)`, and its bound `CHECK (i < ‹n›)`, with `‹i› >= 0` beside it for a counted index,
	 *   which as a law column has no natural domain to keep it there;
	 * - its three axes (`#axis`), each carrying its pairs: the former's (a tree's ‹ps›, interval and root copies, a fold's
	 *   accumulators) and every containment's that rides it;
	 * - every base pin of a carried copy, the copy's first law's: `i > 0 OR f = s` on a predecessor copy and `n > 0 OR
	 *   f = s` on a last copy, `s` the copy's start: an accumulated field's, or a hidden accumulator's identity;
	 * - a tree's owner axis from its plain parent, so the root, which references itself, holds its own count as ‹n›,
	 *   its own start as ‹ps› and its own value of every copy by the axis's foreign key, with no action: PostgreSQL
	 *   refuses a cascade over a generated column (42601), and a tree is written whole and rewritten by deletion;
	 * - for a tree, T1's `UNIQUE (r, start)`, and the CHECK of the family bound, T2, the root pin (the root, outside the
	 *   family, holds `at = 0`), T3 and T6;
	 * - for each fold, its hidden accumulators and the CHECK of its combine, `after = combine(before, x)` where its step
	 *   selection holds and `after = before` where it does not, compared in exact arithmetic: an after is drawn, never
	 *   generated, since a count's, a sum's and a max's combine is not total in its carrier.
	 */
	#familyPlan(id: FamilyId, loc: SourceLoc): FamilyPlan {
		const key = familyKey(id)
		const known = this.#planned.get(key)
		if (known !== undefined) {
			return known
		}
		const family =
			this.#families.get(key) ?? missing(`the family ${key}, which the theory resolved`)
		const law = this.#familyLaws.get(key) ?? missing(`the law of the family ${key}`)
		const planned = new FamilyPlanner(this, family, law, loc).plan()
		this.#planned.set(key, planned)
		return planned
	}

	/**
	 * Whether an owner axis into `owner` over `targets` is cascade-fed: the owner is mutable, so its rows are updated, and
	 * one of the target columns is written by an owner axis's ON UPDATE CASCADE, or generated from one. Its foreign
	 * key is then deferred: RI fires per row event, with no order across a statement's rows.
	 */
	cascadeFed(owner: RelationInfo, targets: ReadonlyArray<PlannedColumn>): boolean {
		if (!owner.mutable) {
			return false
		}
		const cascaded = this.#cascaded.get(owner.name) ?? new Set<string>()
		const fed = (field: LawField): boolean => cascaded.has(columnKey({ kind: "field", field }))
		const written = (field: LawField): boolean =>
			fed(field) || owner.fields.some((f) => fed(f) && readsField(field.writing, f))
		/** A law column is fed where its term's field or its guard's are; a drawn one is written by its host fill or its
		 * axis, so it is fed. */
		const lawFed = (column: LawColumnPlan): boolean => {
			switch (column.kind) {
				case "term":
					return (
						written(column.term.column) ||
						column.selection.conjuncts.some((k) => k.reads.some(written))
					)
				case "constant":
					return false
				case "drawn":
				case "indexPred":
					return true
			}
		}
		return targets.some((c) => (c.kind === "field" ? written(c.field) : lawFed(c.column)))
	}
}

/** A fold's law with its detail, which names its step side. */
interface FoldLaw {
	readonly law: TheoryLaw
	readonly detail: Extract<TheoryLaw["detail"], { readonly kind: "fold" }>
}

/** Whether a field's writing generates it by an expression that reads `field`. */
const readsField = (writing: LawField["writing"], field: LawField): boolean => {
	if (writing.kind !== "generated") {
		return false
	}
	const names = new Set<string>()
	const visit = (e: ScalarExpr): void => {
		if (e.kind === "column") {
			names.add(e.column.name)
		}
		for (const a of e.args) {
			visit(a)
		}
	}
	visit(writing.expr)
	return names.has(field.name)
}

/** The columns a family's owner axis writes on its members by ON UPDATE CASCADE: its group, ‹n›, and every carried
 * source; none for a tree's, which takes no action, since a tree is written whole and rewritten by deletion. */
const ownerSources = (f: Family): ReadonlyArray<NativeColumn> =>
	f.members.kind === "tree"
		? []
		: [
				...f.group.map((g): NativeColumn => ({ kind: "field", field: g.member })),
				{ kind: "law", column: f.copy },
				...f.axes.owner.map((p) => p.from)
			]

/** The row conditions `law` states over a family, one generated CHECK per relation. */
const conditionsOf = (planned: FamilyPlan, law: LawId): ReadonlyArray<NativePlan> =>
	[...(planned.conditions.get(law)?.values() ?? [])].flatMap((c) => {
		const native = c.native()
		return native === undefined ? [] : [native]
	})

/** The literal one a count's combine adds, and the application of a combine's operation, as a description. */
const combineBuild = {
	one: naturalLiteral(1n),
	apply: (fn: CombineFn, left: ExprDesc, right: ExprDesc): ExprDesc => ({
		kind: "compute",
		fn,
		args: [left, right]
	})
} as const

/** The start of a carried copy's source: an accumulated field's, or a hidden accumulator's identity; none for any other. */
interface CopyStart {
	readonly start: TypedLiteral
	readonly type: ScalarType
}

/** One family's natives as `Recognizer.#familyPlan` states them, planned by one walk. */
class FamilyPlanner {
	readonly #recognizer: Recognizer
	readonly #family: Family
	readonly #law: TheoryLaw
	readonly #loc: SourceLoc
	readonly #member: RelationInfo
	readonly #owner: RelationInfo
	/** Each drawn law column of the family, by its identifier. */
	readonly #drawn = new Map<ColumnIdent, LawColumnPlan>()
	/** Each hidden fold accumulator's start, its plane's identity, by its identifier. */
	readonly #hidden = new Map<ColumnIdent, CopyStart>()
	readonly #conditions = new Map<LawId, Map<string, RowConditions>>()

	constructor(recognizer: Recognizer, family: Family, law: TheoryLaw, loc: SourceLoc) {
		this.#recognizer = recognizer
		this.#family = family
		this.#law = law
		this.#loc = loc
		this.#member = recognizer.relation(family.member.name)
		this.#owner = recognizer.relation(family.owner.name)
	}

	plan(): FamilyPlan {
		const f = this.#family
		const member = this.#member
		const owner = this.#owner
		const tree = f.members.kind === "tree" ? f.members : undefined
		const copy = lawColumn(
			this.#draw(f.copy, member, f.count, { kind: "copy", family: f.id }, this.#familyNamed("copy"))
		)
		const index: PlannedColumn =
			f.index.kind === "field"
				? fieldColumn(f.index.field)
				: lawColumn(
						this.#draw(
							f.index.column,
							member,
							f.count,
							{ kind: "index", family: f.id },
							this.#familyNamed("index")
						)
					)
		const parentStart =
			tree === undefined
				? undefined
				: lawColumn(
						this.#draw(
							tree.parentStart,
							member,
							tree.start,
							{ kind: "parentStart", family: f.id },
							this.#familyNamed("parentStart")
						)
					)
		const folds = f.folds.map((fold, i) => this.#foldColumns(fold, i))
		const [g0, ...grest] = f.group
		const group: NonEmptyReadonlyArray<PlannedColumn> = [
			tree === undefined
				? fieldColumn(g0.member)
				: lawColumn({
						kind: "term",
						relation: member,
						term: { kind: "field", field: g0.member.name, column: g0.member },
						selection: this.#members(tree.start)
					}),
			...grest.map((g) => fieldColumn(g.member))
		]
		const ownerKey = mapNonEmpty(f.group, (g) => fieldColumn(g.owner))
		const pred: PlannedColumn =
			index.kind === "field"
				? lawColumn({
						kind: "term",
						relation: member,
						term: { kind: "pred", field: index.field.name, column: index.field },
						selection: { conjuncts: [] }
					})
				: lawColumn({
						kind: "indexPred",
						relation: member,
						family: f.id,
						field: f.count,
						index: index.column
					})
		const lastPred = lawColumn({
			kind: "term",
			relation: owner,
			term: { kind: "pred", field: f.count.name, column: f.count },
			selection: { conjuncts: [] }
		})
		const familyKeyColumns = appendNonEmpty(group, index)
		const ownerTargets = appendNonEmpty(ownerKey, fieldColumn(f.count))
		const carried = {
			owner: this.#carried("owner", f.axes.owner, extendNonEmpty(group, [copy]), ownerTargets),
			predecessor: this.#carried(
				"predecessor",
				f.axes.predecessor,
				appendNonEmpty(group, pred),
				familyKeyColumns
			),
			last: this.#carried("last", f.axes.last, appendNonEmpty(ownerKey, lastPred), familyKeyColumns)
		}
		const ownerTargetColumns = extendNonEmpty(
			ownerTargets,
			carried.owner.map((p) => p.to)
		)
		const axes: FamilyPlan["axes"] = {
			owner:
				tree === undefined
					? this.#axis(
							"owner",
							carried.owner,
							{ relation: member, base: extendNonEmpty(group, [copy]) },
							{ relation: owner, base: ownerTargets },
							"cascade",
							this.#recognizer.cascadeFed(owner, ownerTargetColumns) ? "deferred" : "immediate"
						)
					: this.#axis(
							"owner",
							carried.owner,
							{
								relation: member,
								base: [...mapNonEmpty(f.group, (g) => fieldColumn(g.member)), copy]
							},
							{ relation: owner, base: ownerTargets },
							"noAction",
							"immediate"
						),
			predecessor: this.#axis(
				"predecessor",
				carried.predecessor,
				{ relation: member, base: appendNonEmpty(group, pred) },
				{ relation: member, base: familyKeyColumns },
				"noAction",
				index.kind === "field" ? "immediate" : "deferred"
			),
			last: this.#axis(
				"last",
				carried.last,
				{ relation: owner, base: appendNonEmpty(ownerKey, lastPred) },
				{ relation: member, base: familyKeyColumns },
				"noAction",
				"deferred"
			)
		}

		const own = this.#conditionsFor(this.#law.id, member)
		if (tree === undefined) {
			const i = own.column(index)
			const n = own.column(copy)
			own.add(
				index.kind === "field"
					? cmp("lt", i, n)
					: and([cmp("ge", i, naturalLiteral(0n)), cmp("lt", i, n)])
			)
		} else if (parentStart !== undefined) {
			this.#treeConditions(own, tree, index, copy, parentStart)
		}
		for (const kind of ["owner", "predecessor", "last"] as const) {
			for (const p of carried[kind]) {
				this.#pin(kind, p, index)
			}
		}
		for (const [i, fold] of f.folds.entries()) {
			this.#combine(fold, i)
		}

		const treeKey =
			tree === undefined ? undefined : mapNonEmpty([tree.root, tree.start] as const, fieldColumn)
		const natives: ReadonlyArray<NativePlan> = [
			...lawColumns([copy, index, pred, ...group, lastPred]),
			...(parentStart === undefined ? [] : lawColumns([parentStart])),
			{
				kind: "Unique",
				relation: member,
				columns: familyKeyColumns,
				entry: plannedEntry(
					familyKeyColumns,
					`the UNIQUE of ${member.name} that ${familyText(this.#shape())} numbers its members by`,
					this.#loc
				)
			},
			...(treeKey === undefined
				? []
				: [
						{
							kind: "Unique" as const,
							relation: member,
							columns: treeKey,
							entry: plannedEntry(
								treeKey,
								`the UNIQUE of ${member.name} over the root and start of ${familyText(this.#shape())}`,
								this.#loc
							)
						}
					]),
			...(["owner", "predecessor", "last"] as const).flatMap((a) => [
				...axes[a].natives,
				axes[a].foreignKey
			])
		]
		return {
			family: f,
			law: this.#law,
			member,
			owner,
			natives,
			axes,
			conditions: this.#conditions,
			folds
		}
	}

	/** A drawn law column of the family, `ident` the identifier the theory named it by, `named` what it is at the
	 * naming door. */
	#draw(
		ident: ColumnIdent,
		relation: RelationInfo,
		field: LawField,
		draws: Drawn,
		named: DrawnStatement
	): LawColumnPlan {
		const column: LawColumnPlan = { kind: "drawn", relation, field, draws, named }
		this.#drawn.set(ident, column)
		return column
	}

	/** A drawn column of the family that is no fold's, at the naming door. */
	#familyNamed(kind: "copy" | "index" | "parentStart"): DrawnStatement {
		const id = this.#family.id
		switch (kind) {
			case "copy":
				return { kind: "copy", owner: id.owner, count: id.count }
			case "index":
				return { kind: "index", owner: id.owner, count: id.count }
			case "parentStart":
				return { kind: "parentStart", owner: id.owner, count: id.count }
		}
	}

	/** A tree's members as a resolved selection: every row whose start is above 0 (φ₀). */
	#members(start: LawField): ResolvedSelection {
		const conjuncts = membersSelection({
			...this.#family,
			owner: this.#owner,
			member: this.#member
		})
		return {
			conjuncts: conjuncts.map((predicate): ResolvedConjunct => {
				const text = descText(predicate)
				if (!text.ok) {
					throw defect("a tree's member selection has a canonical text")
				}
				return { kind: "general", predicate, text: text.value, reads: [start] }
			})
		}
	}

	/** A fold's hidden accumulators, drawn law columns of the member, each holding its plane's end's values. */
	#foldColumns(fold: FamilyFold, at: number): ReadonlyArray<NativePlan> {
		const id = this.#family.id
		const law = this.#recognizer.foldLaw(familyKey(id), at).law.id
		return fold.planes.flatMap((plane, p) => {
			const index: 0 | 1 = p === 0 ? 0 : 1
			return (["before", "after"] as const).flatMap((kind): ReadonlyArray<NativePlan> => {
				const c = plane[kind]
				if (c.kind === "field") {
					return []
				}
				const column = this.#draw(
					c.column,
					this.#member,
					plane.end,
					{ kind, family: id, fold: at, plane: index },
					{ kind, owner: id.owner, count: id.count, fold: law, plane: index }
				)
				if (kind === "before") {
					this.#hidden.set(c.column, { start: plane.identity, type: plane.end.type })
				}
				return [{ kind: "LawColumn", column }]
			})
		})
	}

	/** A native column of the family as planned: a field, or one of the family's drawn law columns. */
	#planned(c: NativeColumn): PlannedColumn {
		if (c.kind === "field") {
			return fieldColumn(c.field)
		}
		const column = this.#drawn.get(c.column)
		if (column === undefined) {
			return refuse(
				"UnsupportedLawFamily",
				this.#loc,
				`a family axis carrying fields and its family's drawn columns; ${familyText(this.#shape())} carries the law column ${c.column}, which is neither`
			)
		}
		return lawColumn(column)
	}

	/**
	 * The fold whose accumulator one of `columns` is, as a refusal names it: its monoid and its end, and the accumulator;
	 * none where the columns carry no fold's.
	 */
	#foldCarried(columns: ReadonlyArray<PlannedColumn>): string | undefined {
		for (const [at, fold] of this.#family.folds.entries()) {
			for (const plane of fold.planes) {
				for (const side of ["before", "after"] as const) {
					const native = plane[side]
					const carried = columns.find((c) =>
						native.kind === "field"
							? c.kind === "field" && c.field.name === native.field.name
							: c.kind === "law" &&
								c.column.kind === "drawn" &&
								c.column.draws.kind === side &&
								c.column.draws.fold === at
					)
					if (carried !== undefined) {
						return `the ${side} accumulator ${plannedText(carried)} of the ${fold.monoid} fold into ${this.#owner.name}.${plane.end.name}`
					}
				}
			}
		}
		return undefined
	}

	/** The family as its refusals describe it. */
	#shape() {
		return { ...this.#family, owner: this.#owner, member: this.#member }
	}

	/**
	 * The pairs `axis` carries beyond its key columns `base` → `targetBase`, each once, in the order of their target
	 * columns, so two axes carrying one set reference one UNIQUE. A pair that repeats a key column is the key itself; a
	 * target column carried twice, or a key column carried from another source, is refused: a reference names each
	 * referenced column once.
	 */
	#carried(
		axis: AxisKind,
		pairs: ReadonlyArray<AxisPair>,
		base: NonEmptyReadonlyArray<PlannedColumn>,
		targetBase: NonEmptyReadonlyArray<PlannedColumn>
	): ReadonlyArray<CarriedPair> {
		const textOf = plannedText
		const keyOf = (c: PlannedColumn): string => `${c.kind === "field" ? "f" : "l"} ${textOf(c)}`
		const baseKeys = base.map(keyOf)
		const targetKeys = targetBase.map(keyOf)
		const out: Array<CarriedPair> = []
		for (const p of pairs) {
			const from = this.#planned(p.from)
			const to = this.#planned(p.to)
			const fromKey = keyOf(from)
			const toKey = keyOf(to)
			const at = targetKeys.indexOf(toKey)
			if (at !== -1 && baseKeys[at] === fromKey) {
				continue
			}
			if (at !== -1 || out.some((q) => q.toKey === toKey)) {
				return refuse(
					"UnsupportedLawFamily",
					this.#loc,
					`a family axis whose foreign key references each column once; the ${axis} axis of ${familyText(this.#shape())} carries ${textOf(to)} twice`
				)
			}
			out.push({ from, to, fromKey, toKey, laws: p.laws })
		}
		return out.toSorted((a, b) => (a.toKey < b.toKey ? -1 : a.toKey > b.toKey ? 1 : 0))
	}

	/**
	 * One axis's foreign key, its law columns and the UNIQUE over its target columns, which the foreign key references:
	 * a key like any declared one, so INDEX_MAX_KEYS bounds its columns and its B-tree entry must be representable for
	 * every value they admit (`plannedEntry`), or the axis is UnrepresentableKey, naming the fold whose accumulator it
	 * carries; PostgreSQL would refuse the write that outgrows it (54000).
	 */
	#axis(
		kind: AxisKind,
		pairs: ReadonlyArray<CarriedPair>,
		source: {
			readonly relation: RelationInfo
			readonly base: NonEmptyReadonlyArray<PlannedColumn>
		},
		target: {
			readonly relation: RelationInfo
			readonly base: NonEmptyReadonlyArray<PlannedColumn>
		},
		onUpdate: "cascade" | "noAction",
		deferral: ForeignKeyDeferral
	): AxisPlan {
		const columns = extendNonEmpty(
			source.base,
			pairs.map((p) => p.from)
		)
		const targetColumns = extendNonEmpty(
			target.base,
			pairs.map((p) => p.to)
		)
		const generated = columns.find(isGenerated)
		if (onUpdate === "cascade" && generated !== undefined) {
			return refuse(
				"UnsupportedLawFamily",
				this.#loc,
				`a family's owner axis over columns the caller or grizzle writes, which its ON UPDATE CASCADE rewrites; the owner axis of ${familyText(this.#shape())} carries ${generated.kind === "field" ? generated.field.name : "a generated law column"}, which PostgreSQL generates and no cascade may write (42601): copy a written field instead`
			)
		}
		if (targetColumns.length > indexMaxKeys.value) {
			return refuse(
				"UnsupportedLawFamily",
				this.#loc,
				`a family axis of at most ${indexMaxKeys.value} columns, which one UNIQUE holds (INDEX_MAX_KEYS); the ${kind} axis of ${familyText(this.#shape())} carries ${targetColumns.length}: carry fewer copies on it`
			)
		}
		const fold = this.#foldCarried(targetColumns)
		const entry = plannedEntry(
			targetColumns,
			`the UNIQUE of ${target.relation.name} the ${kind} axis of ${familyText(this.#shape())} references${fold === undefined ? "" : `, which carries ${fold}`}`,
			this.#loc
		)
		const own = this.#law.id
		const laws = [...new Set(pairs.flatMap((p) => p.laws))].filter((l) => l !== own)
		return {
			foreignKey: {
				kind: "ForeignKey",
				relation: source.relation,
				columns,
				target: target.relation,
				targetColumns,
				onUpdate,
				deferral,
				laws: [own, ...laws]
			},
			natives: [
				...lawColumns(columns),
				...lawColumns(targetColumns),
				{ kind: "Unique", relation: target.relation, columns: targetColumns, entry }
			]
		}
	}

	/** The row conditions `law` states on `relation`, gathered into its one CHECK there. */
	#conditionsFor(law: LawId, relation: RelationInfo): RowConditions {
		const own = this.#conditions.get(law) ?? new Map<string, RowConditions>()
		this.#conditions.set(law, own)
		const known = own.get(relation.name)
		if (known !== undefined) {
			return known
		}
		const made = new RowConditions(relation)
		own.set(relation.name, made)
		return made
	}

	/** A tree's own CHECK conjuncts on its relation: the family bound, T2, the root pin, T3 and T6. */
	#treeConditions(
		own: RowConditions,
		tree: Extract<Family["members"], { readonly kind: "tree" }>,
		index: PlannedColumn,
		copy: PlannedColumn,
		parentStart: PlannedColumn
	): void {
		const [g0] = this.#family.group
		const field = (f: LawField): ExprDesc => own.column(fieldColumn(f))
		const start = field(tree.start)
		const end = field(tree.end)
		const at = own.column(index)
		const n = own.column(copy)
		const ps = own.column(parentStart)
		const children = field(this.#family.count)
		const zero = naturalLiteral(0n)
		const one = naturalLiteral(1n)
		const plus = (x: ExprDesc): ExprDesc => ({ kind: "compute", fn: "add", args: [x, one] })
		own.add(or([cmp("eq", start, zero), cmp("lt", at, n)]))
		own.add(
			or([
				and([cmp("eq", field(g0.member), field(g0.owner)), cmp("eq", start, zero)]),
				and([cmp("ne", field(g0.member), field(g0.owner)), cmp("gt", start, zero)])
			])
		)
		own.add(or([cmp("gt", start, zero), cmp("eq", at, zero)]))
		own.add(or([cmp("eq", start, zero), cmp("gt", at, zero), cmp("eq", start, plus(ps))]))
		own.add(
			and([cmp("gt", end, start), or([cmp("gt", children, zero), cmp("eq", end, plus(start))])])
		)
	}

	/**
	 * The base pin of a carried copy, where its source has a start: on its axis's source relation, under the copy's
	 * first law, `at > 0 OR f = s` (predecessor, the index at its first slot, a tree's root included, which the root
	 * pin holds at slot 0) or `n > 0 OR f = s` (last, an empty family). The owner axis has no base: every member has an
	 * owner, and a tree's root references itself, so the axis's own foreign key holds its copy at its own value.
	 */
	#pin(axis: AxisKind, pair: CarriedPair, index: PlannedColumn): void {
		const start = this.#startOf(pair.from)
		if (start === undefined || axis === "owner") {
			return
		}
		const at = axis === "predecessor" ? index : fieldColumn(this.#family.count)
		const relation = axis === "last" ? this.#owner : this.#member
		const conditions = this.#conditionsFor(pair.laws[0], relation)
		conditions.add(
			or([
				cmp("gt", conditions.column(at), naturalLiteral(0n)),
				cmp("eq", conditions.column(pair.from), conditions.literal(start.start, start.type))
			])
		)
	}

	/** A copy source's start: an accumulated field's, or a hidden accumulator's identity. */
	#startOf(c: PlannedColumn): CopyStart | undefined {
		if (c.kind === "field") {
			const w = c.field.writing
			return w.kind === "accumulated" ? { start: w.start, type: c.field.type } : undefined
		}
		const column = c.column
		if (column.kind !== "drawn" || column.draws.kind !== "before") {
			return undefined
		}
		const plane = this.#family.folds[column.draws.fold]?.planes[column.draws.plane]
		return plane === undefined ? undefined : { start: plane.identity, type: plane.end.type }
	}

	/**
	 * A fold's combine CHECK on the member, under the fold's law: every plane's after is `combine(befores, x)` where the
	 * step side's selection holds, and its before where it does not, compared in exact arithmetic.
	 */
	#combine(fold: FamilyFold, at: number): void {
		const { law, detail } = this.#recognizer.foldLaw(familyKey(this.#family.id), at)
		const conditions = this.#conditionsFor(law.id, this.#member)
		const befores = mapNonEmpty(fold.planes, (p) => conditions.column(this.#planned(p.before)))
		const afters = mapNonEmpty(fold.planes, (p) => conditions.column(this.#planned(p.after)))
		const step =
			fold.step.kind === "one"
				? { kind: "one" as const }
				: { kind: "value" as const, expr: conditions.column(fieldColumn(fold.step.field)) }
		const combined = monoidSpecs[fold.monoid].combine(befores, step, combineBuild)
		const stepped = and(
			mapNonEmpty(afters, (a, p) => cmp("eq", a, combined[p] ?? missing("a combine per plane")))
		)
		const where = detail.step.selection.conjuncts.map((c) => c.predicate)
		if (!isNonEmpty(where)) {
			conditions.add(stepped)
			return
		}
		const phi = and(where)
		conditions.add(
			or([
				and([phi, stepped]),
				and([
					{ kind: "not", arg: phi },
					and(
						mapNonEmpty(afters, (a, p) => cmp("eq", a, befores[p] ?? missing("a before per plane")))
					)
				])
			])
		)
	}
}

/** A law column's plan as a key within its relation: what it is, each handle by its name. */
const lawColumnText = (c: LawColumnPlan): string => {
	switch (c.kind) {
		case "constant":
			return `constant ${c.target.name}.${c.field.name}`
		case "term":
			return `${c.term.kind} ${c.term.field} ${c.selection.conjuncts.map((k) => k.text).join(" and ")}`
		case "drawn":
			return `${c.draws.kind} ${c.draws.family.owner}.${c.draws.family.count}${
				c.draws.kind === "before" || c.draws.kind === "after"
					? ` ${c.draws.fold} ${c.draws.plane}`
					: ""
			}`
		case "indexPred":
			return `indexPred ${c.family.owner}.${c.family.count}`
	}
}
