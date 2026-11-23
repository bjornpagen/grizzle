import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { familyText, membersSelection } from "#compiler/analysis/theory/families.ts"
import {
	fieldDatum,
	fixedSelection,
	type ResolvedConjunct,
	type ResolvedSelection,
	type ResolvedSelector,
	type ResolvedSide,
	type ResolvedTerm,
	type TheoryLaw
} from "#compiler/analysis/theory/laws.ts"
import {
	type LawSide,
	type LiveEnv,
	liveReading,
	type QueryRule,
	type RuleLaw,
	type RuleSide,
	storedSideArm,
	violationQuery
} from "#compiler/analysis/theory/query.ts"
import { type RefillDeferral, refillDeferral } from "#compiler/analysis/theory/refill.ts"
import { type RegionFacts, wholeRule } from "#compiler/analysis/theory/unit.ts"
import { type KeyLedger, Refusal } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { CompileError, type KeyRefusal, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { DeclaredName, Identity, LawColumnStatement } from "#compiler/core/identity.ts"
import type { ColumnIdent, LawId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { type CellSide, sideOf } from "#compiler/ir/cells.ts"
import {
	type CompareOp,
	descText,
	type ExprDesc,
	fieldTermsOf,
	termText
} from "#compiler/ir/desc.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type {
	AxisKind,
	AxisPair,
	Family,
	FamilyFold,
	FoldPlane,
	TreeMembers
} from "#compiler/ir/family.ts"
import {
	type ClosedTheoryRelation,
	columnKey,
	declaredKeyOf,
	type Drawn,
	type FamilyId,
	familyKey,
	isSpanField,
	type KeyName,
	type LawField,
	type NativeColumn,
	type OnUpdate,
	type RelationInfo,
	sameNativeColumn,
	scalarKeySet,
	type SpanField,
	spanKeySet,
	type TheoryRelation,
	fieldColumn,
	type FieldColumn
} from "#compiler/ir/law.ts"
import { type CombineFn, combine, monoidSpecs } from "#compiler/ir/monoid.ts"
import { closedCell } from "#compiler/ir/rel.ts"
import { baseOf, rosterOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { keyOf, literalKey } from "#compiler/laws/model/names.ts"
import type { OwnedContract } from "#compiler/schema/own.ts"
import {
	type BtreeEntryBytes,
	btreeEntry,
	btreeEntryBytes,
	btreeMaxItemSize,
	type DatumBound,
	datumBound,
	type EntryColumn,
	type GistEntryBytes,
	gistEntry,
	exactKeyFault,
	indexMaxKeys,
	textRoomBeside
} from "#compiler/schema/representability.ts"

/** A refusal deep inside recognition is a core Refusal, which the model's boundary returns (`catchRefusal`). */
const refuse = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/**
 * Judges an index the law model plans, `subject` over `key`, by `verdict`, its entry's: one whose entry no index holds is
 * refused in `keys` as UnrepresentableKey, at `loc`, and planned all the same, so the model goes on to meet every other
 * such index and the compile refuses them all where it ends (core/canonical.ts KeyLedger).
 */
const judge = (
	keys: KeyLedger,
	loc: SourceLoc,
	subject: string,
	key: ReadonlyArray<string>,
	verdict: Result.Result<unknown, KeyFault>
): void => {
	if (!verdict.ok) {
		keys.refuse({ at: loc, subject, key, fault: verdict.error })
	}
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
			/** What it is at the naming door: its family's predecessor. */
			readonly named: DrawnStatement & { readonly kind: "predecessor" }
			/** The family's count, whose values the index and its predecessor hold. */
			readonly field: LawField
			/** The drawn index the predecessor is pred of. */
			readonly index: LawColumnPlan
	  }

/** A family's law column as the naming door states it (core/identity.ts LawColumnStatement): a drawn one's, by its
 * family and what it draws. */
export type DrawnStatement = Exclude<LawColumnStatement, { readonly kind: "constant" | "term" }>

/** A column a planned native reads: a field, or a law column. */
export type PlannedColumn =
	| { readonly kind: "field"; readonly field: LawField }
	| { readonly kind: "law"; readonly column: LawColumnPlan }

/**
 * A column a side lowers to (`sideColumns`), which a containment's target is referenced at and a reverse probe reads: a
 * field, or the law column of a term under its side's selection.
 */
type SideColumn =
	| { readonly kind: "field"; readonly field: LawField }
	| { readonly kind: "law"; readonly column: Extract<LawColumnPlan, { readonly kind: "term" }> }

/** Whether two selections are one, conjunct for conjunct in order, as a term's law column is known by its selection's
 * conjuncts (laws/model/model.ts lawColumnIdentity). */
const sameSelection = (a: ResolvedSelection, b: ResolvedSelection): boolean =>
	a.conjuncts.length === b.conjuncts.length &&
	a.conjuncts.every((c, i) => b.conjuncts[i]?.text === c.text)

/** Whether two side columns of one relation are one column: one field, or the law column of one term under one
 * selection. */
const sameSideColumn = (a: SideColumn, b: SideColumn): boolean => {
	switch (a.kind) {
		case "field":
			return b.kind === "field" && a.field === b.field
		case "law":
			return (
				b.kind === "law" &&
				a.column.term.kind === b.column.term.kind &&
				a.column.term.column === b.column.term.column &&
				sameSelection(a.column.selection, b.column.selection)
			)
	}
}

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
const plannedDatum = (c: PlannedColumn): DatumBound | undefined => fieldDatum(plannedField(c))

/** A planned column as a refusal names it: a field by its name, a law column by what it holds. */
const plannedText = (c: PlannedColumn): string =>
	c.kind === "field" ? c.field.name : lawColumnText(c.column)

/**
 * The B-tree entry of an index the law model plans over `columns`, a UNIQUE, proved within BTMaxItemSize for every
 * value its columns admit (schema/representability.ts btreeEntry), or its fault: past INDEX_MAX_KEYS columns, over a
 * text of no byte bound, or over an entry that can outgrow the limit, where PostgreSQL would refuse the write whose
 * entry outgrows it (54000). A field is NOT NULL; a law column may hold NULL, which gives the entry its null bitmap.
 */
const plannedEntry = (
	columns: NonEmptyReadonlyArray<PlannedColumn>
): Result.Result<BtreeEntryBytes, KeyFault> => {
	if (columns.length > indexMaxKeys) {
		return Result.err({ kind: "columns", limit: indexMaxKeys })
	}
	const entry: Array<EntryColumn> = []
	for (const c of columns) {
		const datum = plannedBound(c)
		if (!datum.ok) {
			return datum
		}
		entry.push(entryColumn(c, datum.value))
	}
	return btreeEntry(entry)
}

/**
 * A planned column's datum in an index the law model plans (`plannedDatum`), or its fault: an exact field, which no key
 * holds (schema/representability.ts exactKeyFault), or a text of no byte bound.
 */
const plannedBound = (c: PlannedColumn): Result.Result<DatumBound, KeyFault> => {
	const exact = exactKeyFault(plannedText(c), plannedField(c).desc)
	if (exact !== undefined) {
		return Result.err(exact)
	}
	const datum = plannedDatum(c)
	return datum === undefined
		? Result.err({ kind: "unboundedText", field: plannedText(c) })
		: Result.ok(datum)
}

/**
 * Judges a UNIQUE the law model plans over `columns` by its B-tree entry (`plannedEntry`), `subject` naming it and the
 * law that plans it (`judge`).
 */
const judgeEntry = (
	keys: KeyLedger,
	columns: NonEmptyReadonlyArray<PlannedColumn>,
	subject: string,
	loc: SourceLoc
): void => judge(keys, loc, subject, columns.map(plannedText), plannedEntry(columns))

/** A planned column as an index entry holds it: a field NOT NULL, a law column possibly NULL. */
const entryColumn = (c: PlannedColumn, datum: DatumBound): EntryColumn => ({
	name: plannedText(c),
	datum,
	nullable: c.kind === "law"
})

/** A planned column with its datum, where its datum is bounded. */
interface BoundedColumn<C extends PlannedColumn> {
	readonly column: C
	readonly datum: DatumBound
}

/**
 * The most bytes a planned column's datum takes in an index the index engine creates, for every installation: its
 * field's datumBound (schema/representability.ts), as physical/indexes/engine.ts createIndex counts each key
 * (keyDatums), a set at the most codes a roster numbers, its holes included (bitsBytes); none for text of no bound. A
 * set is its roster's bit(n), n every code the installation has minted, which the law model does not hold and a later
 * installation grows, so plannedDatum's count at the roster's handles, the fewest codes it can have, is a bound from
 * below that only refuses an entry certainly past the limit. A reverse index is chosen to fit (`btreeRun`,
 * `plannedPeriodReverse`), so its run reads this bound from above: the index engine never refuses the run it picks.
 */
const createdDatum = (c: PlannedColumn): DatumBound | undefined => datumBound(plannedField(c).desc)

/** The columns of `columns` whose datum is bounded in an index the engine creates (`createdDatum`), in their order. */
const boundedColumns = <C extends PlannedColumn>(
	columns: ReadonlyArray<C>
): ReadonlyArray<BoundedColumn<C>> =>
	columns.flatMap((column) => {
		const datum = createdDatum(column)
		return datum === undefined ? [] : [{ column, datum }]
	})

/**
 * The columns of the B-tree a reverse probe over `columns` reads (`plannedReverse`): the longest leading run of the
 * columns whose datum is bounded, in their order, whose entry btreeEntry proves within BTMaxItemSize; none where no
 * bounded column's entry is.
 */
const btreeRun = <C extends PlannedColumn>(
	columns: ReadonlyArray<C>
): NonEmptyReadonlyArray<C> | undefined => {
	const bounded = boundedColumns(columns)
	for (let n = Math.min(bounded.length, indexMaxKeys); n > 0; n--) {
		const run = bounded.slice(0, n)
		const [first, ...rest] = run
		if (first !== undefined && btreeEntry(run.map((b) => entryColumn(b.column, b.datum))).ok) {
			return [first.column, ...rest.map((b) => b.column)]
		}
	}
	return undefined
}

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
		case "inet":
		case "cidr":
		case "text":
		case "sha256":
		case "code":
		case "range4":
		case "range8":
		case "rangeDate":
		case "exactInteger":
			return true
		case "money":
		case "exactMoney":
		case "bits":
		case "bytes":
		case "vector":
		case "tsvector":
			return false
	}
}

/**
 * The index a containment's reverse probe reads over its referencing columns `columns`, which binds every one of them by
 * equality: an index over a leading run of them serves it, PostgreSQL rechecking the rest on the rows it finds, so the
 * width of a referencing column never refuses a containment. The probe is PostgreSQL's RI query (ri_triggers.c,
 * RI_FKey_noaction_del), which states the referencing columns' equalities alone: its run is of columns. A B-tree over the
 * longest leading run of the columns
 * whose datum is bounded, in their order, whose entry btreeEntry proves within BTMaxItemSize; where that run is empty,
 * a hash index on one hashable column, a field before a law column, whose entry is a 4-byte hash code (a text with no
 * byte bound is hashable, texteq under pg_c_utf8 being deterministic). Only referencing columns none of which a B-tree
 * entry holds and none of which hashes, wide sets and vectors and money, are refused, as UnrepresentableKey naming
 * `subject` (`judge`), their index a hash on the first of them all the same, which the index engine creates unjudged.
 */
const plannedReverse = (
	keys: KeyLedger,
	columns: NonEmptyReadonlyArray<PlannedColumn>,
	subject: string,
	loc: SourceLoc
): PlannedReverse => {
	const run = btreeRun(columns)
	if (run !== undefined) {
		return { method: "btree", columns: run }
	}
	const hashed = [
		...columns.filter((c) => c.kind === "field"),
		...columns.filter((c) => c.kind === "law")
	].find(hashable)
	if (hashed !== undefined) {
		return { method: "hash", columns: [hashed] }
	}
	const [widest] = boundedColumns(columns)
	const fault =
		widest === undefined ? undefined : btreeEntry([entryColumn(widest.column, widest.datum)])
	if (fault === undefined || fault.ok) {
		throw defect(`a referencing column of ${subject} a B-tree entry holds or a hash index hashes`)
	}
	judge(keys, loc, subject, columns.map(plannedText), fault)
	return { method: "hash", columns: [columns[0]] }
}

/**
 * The GiST index a PERIOD reference's reverse probe reads over its referencing scalars and then its span: the longest
 * leading run of the scalars whose datum is bounded, in their order, whose entry gistEntry proves with the span within a
 * GiST page, else the span alone, which a GiST entry always holds, or else is refused (`judge`) and planned all the same.
 */
const plannedPeriodReverse = (
	keys: KeyLedger,
	scalars: ReadonlyArray<PlannedColumn>,
	span: PlannedColumn,
	subject: string,
	loc: SourceLoc
): PlannedReverse => {
	const spanDatum = defined(createdDatum(span), `the bounded datum of the span of ${subject}`)
	const spanEntry = { field: plannedText(span), datum: spanDatum }
	const bounded = boundedColumns(scalars)
	for (let n = Math.min(bounded.length, indexMaxKeys - 1); n >= 0; n--) {
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
				)
			}
		}
	}
	judge(keys, loc, subject, [plannedText(span)], gistEntry([], spanEntry))
	return { method: "gist", columns: [span] }
}

/**
 * The GiST entry of a span key the law model plans, its scalar columns and then its span, proved within a GiST page for
 * every value its columns admit (schema/representability.ts gistEntry), or its fault: past INDEX_MAX_KEYS columns, over
 * a text of no byte bound, over a column btree_gist has no operator class for, or over an entry past the page.
 */
const plannedGist = (
	scalars: ReadonlyArray<PlannedColumn>,
	span: PlannedColumn
): Result.Result<GistEntryBytes, KeyFault> => {
	if (scalars.length + 1 > indexMaxKeys) {
		return Result.err({ kind: "columns", limit: indexMaxKeys })
	}
	const datums: Array<{ readonly field: string; readonly datum: DatumBound }> = []
	for (const c of [...scalars, span]) {
		const datum = plannedBound(c)
		if (!datum.ok) {
			return datum
		}
		datums.push({ field: plannedText(c), datum: datum.value })
	}
	return gistEntry(datums.slice(0, -1), defined(datums.at(-1), "the span's datum"))
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
 * How a planned foreign key is deferred:
 * - `rule`: by the schema-wide rule, deferred on a cycle of the foreign keys that order a write's statements or into a
 *   replaceable target (laws/model/model.ts compileLaws);
 * - `cycle`: a family's owner axis, which its family's writes order, its members after their owner: deferred exactly
 *   when it lies on a cycle of the foreign keys that order a write's statements, which a law's key can close with it;
 * - `immediate`, `deferred`: as its family axis fixes it.
 */
export type ForeignKeyDeferral = "rule" | "cycle" | "immediate" | "deferred"

/**
 * How the law model discharges a rule over a query that lowers to foreign keys (analysis/theory/laws.ts RuleLowering):
 * by its foreign keys, as every installation and every login's runtime does, or by its deferred constraint triggers, as
 * the law oracle's conservative installation keeps it (physical/install/compile.ts conservativeInstallation).
 */
export type RuleDischarge = "native" | "triggers"

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
			/** A UNIQUE, its B-tree entry judged where it was planned (`judgeEntry`), a declared key's by ownership. */
			readonly kind: "Unique"
			readonly relation: RelationInfo
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
	  }
	| { readonly kind: "Domain"; readonly contract: OwnedContract }
	| {
			readonly kind: "TableCheck"
			readonly relation: RelationInfo
			readonly name: string
			readonly named: Identity<"check">
			/** The predicate as the check states it, which specialization lowers over the relation's row. */
			readonly predicate: ExprDesc
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
			readonly onUpdate: OnUpdate
			readonly deferral: ForeignKeyDeferral
			/**
			 * The laws it discharges, the reported one first, where it is a family axis whose pairs state several (its
			 * former's and every containment that rides it); undefined for a foreign key of one law, the law that plans it.
			 */
			readonly laws: NonEmptyReadonlyArray<LawId> | undefined
			/** The index its reverse probe reads on its referencing side, which every foreign key carries (`Reversed`). */
			readonly reverse: PlannedReverse
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
	  }
	| {
			readonly kind: "PeriodForeignKey"
			readonly relation: RelationInfo
			readonly columns: NonEmptyReadonlyArray<PlannedColumn>
			readonly span: PlannedColumn
			readonly target: RelationInfo
			readonly targetColumns: NonEmptyReadonlyArray<PlannedColumn>
			readonly targetSpan: PlannedColumn
			/** The GiST index its reverse probe reads on its referencing side (`Reversed`). */
			readonly reverse: PlannedReverse
	  }

/**
 * A foreign key, plain or PERIOD, with the index its reverse probe reads on its referencing side, which it carries: no
 * foreign key is planned without one. Before a referenced row is deleted or its key updated, PostgreSQL's RI trigger
 * (ri_triggers.c, RI_FKey_noaction_del) probes the referencing relation for a row that still references it, `SELECT 1
 * FROM ONLY <relation> x WHERE $1 = <column> AND ... FOR KEY SHARE OF x`, once per referenced row; with no index the
 * referencing columns lead, each probe reads every row a shorter prefix selects, the whole relation or a family's every
 * member, so a statement deleting n rows reads n times as many. The law model installs the index wherever its slice
 * writes the referencing relation (`reverseIndexOf`); the index engine serves the probe by it (physical/indexes/engine.ts
 * reverseRequests): by an index whose leading columns are the referencing ones, or by a unique one all of whose columns
 * are among them, such as the key a family states of each member's one successor, or else creates the index.
 */
export type Reversed = Extract<NativePlan, { readonly kind: "ForeignKey" | "PeriodForeignKey" }>

/** A foreign key's reverse index as the native the law model installs on its referencing relation (`reverseIndexOf`). */
export type ReverseIndexPlan = {
	readonly kind: "ReverseIndex"
	readonly relation: RelationInfo
} & PlannedReverse

/** The reverse index a foreign key carries, as the native the law model installs on its referencing relation. */
export const reverseIndexOf = (fk: Reversed): ReverseIndexPlan => ({
	kind: "ReverseIndex",
	relation: fk.relation,
	...fk.reverse
})

/**
 * The index of a reverse probe as planned (ir/law.ts ReverseIndexOn): a B-tree's or a GiST's over a run of its columns
 * chosen to fit its limit, or a hash index's, whose entry is a 4-byte hash code (`plannedReverse`).
 */
export type PlannedReverse =
	| { readonly method: "btree" | "gist"; readonly columns: NonEmptyReadonlyArray<PlannedColumn> }
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
 * The columns a side lowers to, one per term (§ partial projections): its guarded term (`guardTerm`) under its
 * selection, and every other term over every row. A field term over every row is its field; the guarded term of a
 * selected side, and every pred term, is a law column generated `CASE WHEN φ THEN t END` (pred(x)'s own guard x > 0
 * beside φ), null wherever the side reads no tuple. One guarded column per side is exact: UNIQUE NULLS DISTINCT and
 * MATCH SIMPLE both pass over a row with any null column, so a key over the columns holds apart only the rows the side
 * reads and a reference from them references only from those, whichever of them is null there; every other term is its
 * field's own column or the one law column of its pred, which every side shares. So a relation holds one generated
 * column per selection its sides read, never one per term, and a write computes each selection once per row where it
 * would compute it once per term.
 */
const sideColumns = (side: ResolvedSide): NonEmptyReadonlyArray<SideColumn> => {
	const relation = tableOf(side.rel)
	const guarded = guardTerm(relation, side.terms)
	return mapNonEmpty(side.terms, (term) =>
		termColumn(relation, term, term === guarded ? side.selection : everyRow)
	)
}

/**
 * The term a side of `relation` guards by its selection (`sideColumns`): the one over its earliest field, the primary
 * key's fields first in key order and every other field after them in field order, a field term before pred of that
 * field. So two sides of one selection over one set of terms, in whatever order, lower to one set of columns, and the
 * sides of one selection that share a primary key field, as a family's group and the keys and references over it do,
 * share that field's one generated column.
 */
const guardTerm = (
	relation: RelationInfo,
	terms: NonEmptyReadonlyArray<ResolvedTerm>
): ResolvedTerm => {
	const keyed = relation.primaryFields.length
	const rank = (t: ResolvedTerm): number => {
		const inKey = relation.primaryFields.findIndex((f) => f.name === t.column.name)
		return (inKey === -1 ? keyed + t.column.position : inKey) * 2 + (t.kind === "pred" ? 1 : 0)
	}
	return terms.reduce((held, t) => (rank(t) < rank(held) ? t : held))
}

/** The column the side `key` of `relation` lowers its term over `field` to (`sideColumns`): its guarded term's under
 * its selection, any other field's its own. */
const keyColumn = (relation: RelationInfo, key: TargetKey, field: LawField): SideColumn => {
	const guarded = guardTerm(relation, key.terms)
	return termColumn(
		relation,
		{ kind: "field", field: field.name, column: field },
		guarded.kind === "field" && guarded.column === field ? key.selection : everyRow
	)
}

/** One term of a side over `relation` under `selection` as a column (`sideColumns`). */
const termColumn = (
	relation: RelationInfo,
	term: ResolvedTerm,
	selection: ResolvedSelection
): SideColumn =>
	term.kind === "field" && selection.conjuncts.length === 0
		? fieldColumn(term.column)
		: { kind: "law", column: { kind: "term", relation, term, selection } }

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
	| (Omit<Extract<NativePlan, { readonly kind: "WithoutOverlaps" }>, "span" | "key"> & {
			readonly span: FieldColumn<SpanField>
			readonly key: {
				readonly kind: "primary"
				readonly scalars: NonEmptyReadonlyArray<FieldColumn>
			}
			readonly named: Identity<"primaryKey" | "key">
	  })

/**
 * The native object of the primary key `key` of `r`: a PRIMARY KEY over a scalar key, or its span field last WITHOUT
 * OVERLAPS. Ownership judged its entry (schema/own.ts ownKey): a primary key whose only field is a span, which has no
 * native lowering, PostgreSQL's PRIMARY KEY needing a column before WITHOUT OVERLAPS (42601) and an exclusion
 * constraint being no primary key, it refused (KeyFault `spanAlone`), and it is planned a PRIMARY KEY over the span all
 * the same, so the compile goes on to meet every other unrepresentable key.
 */
export const primaryKeyPlan = (r: RelationInfo, key: KeyName): PrimaryKeyPlan => {
	const { fields, span, named } = key
	const scalars = fields.filter((f) => f !== span)
	if (span === undefined || !isNonEmpty(scalars)) {
		return { kind: "PrimaryKey", relation: r, columns: fields, named }
	}
	return {
		kind: "WithoutOverlaps",
		relation: r,
		span: fieldColumn(span),
		key: { kind: "primary", scalars: mapNonEmpty(scalars, (f) => fieldColumn(f)) },
		named
	}
}

/**
 * A law's plan: its native objects, and where the law is discharged: on every write, by its natives; for a law that
 * reads closed relations alone, once by PostgreSQL in the migration that installs them, as its violation query over
 * their rows, so it installs nothing; or at every COMMIT by the rule judge (physical/ddl/rules.ts addRules) as `rule`
 * states it, and once by its violation query in the migration that adds it: a rule over a query, or a containment the
 * law model discharges to the rule judge (`ContainmentDischarge`), either installing nothing.
 */
export type LawPlan = {
	readonly law: TheoryLaw
	readonly natives: ReadonlyArray<NativePlan>
} & (
	| { readonly discharge: "write" | "migration" }
	| { readonly discharge: "trigger"; readonly rule: QueryRule }
)

/** A law that reads closed relations alone, discharged by the migration: no native. */
const migrationPlan = (law: TheoryLaw): LawPlan => ({ law, natives: [], discharge: "migration" })

/** A law the rule judge discharges at every COMMIT as `rule` states it: no native. */
const judgedPlan = (law: TheoryLaw, rule: QueryRule): LawPlan => ({
	law,
	natives: [],
	discharge: "trigger",
	rule
})

/** A containment law's detail. */
type ContainmentDetail = Extract<TheoryLaw["detail"], { readonly kind: "containment" }>

/**
 * How the law model discharges a scalar containment between sides of ordinary relations that rides no family axis,
 * decided once when the schema compiles (`containmentDischarge`), the law itself the same either way, its identity,
 * its evidence and its violation query the theory's:
 *
 * - `native`: at every write, by its foreign key (`#scalarContainment`), the UNIQUE it references, the reverse index
 *   over its source's columns, and the law columns either side lowers to;
 * - `whole`: at every COMMIT, by the rule judge, its violation read over the units a transaction wrote, as every
 *   unit-local rule over a query is (analysis/theory/unit.ts wholeRule, physical/ddl/rules.ts addRules), installing
 *   nothing on either relation.
 */
type ContainmentDischarge =
	| { readonly kind: "native" }
	| { readonly kind: "judged"; readonly rule: QueryRule }

const nativeDischarge: ContainmentDischarge = { kind: "native" }

/**
 * A side of a containment law as the rule judge's probes read it (query.ts RuleSide): its stored relation's one arm,
 * its variables under `prefix`, apart from the other side's.
 */
const probedSideOf = (side: LawSide, prefix: string, loc: SourceLoc): RuleSide => ({
	...side,
	arms: [storedSideArm(side.relation, side.terms, side.selection, prefix, loc)]
})

/** Whether a containment law's side reads a mutable relation, whose rows change in place (`containmentDischarge`). */
const mutableSide = (side: ResolvedSide): boolean =>
	side.rel.kind === "relation" && side.rel.mutable

/** A containment law's sides read no definition: each is a stored relation's. */
const storedSides: LiveEnv["definition"] = () => undefined

/** A side of a containment law as the violation query of a rule over a query reads it (query.ts LawSide). */
const lawSideOf = (side: ResolvedSide): LawSide => ({
	relation: side.relation,
	terms: mapNonEmpty(side.terms, (t) => ({ kind: t.kind, field: t.field })),
	selection: { conjuncts: side.selection.conjuncts.map((c) => c.predicate) },
	texts: side.selection.conjuncts.map((c) => c.text),
	heading: mapNonEmpty(side.rel.heading, (f) => f.name)
})

/**
 * Whether a predicate reads alike in a query and in a generated column: a field, a literal, a closed relation's
 * constants at such terms, and comparisons, ranges and literal lists of them under and, or and not. A predicate that
 * computes, casts or branches may not: a query refuses some a generated column admits, such as a pattern's match over
 * a text no pattern bounds (check/checker.ts), and a generated column some a query admits, such as an IEEE 754
 * rounding.
 */
const readsAlike = (e: ExprDesc): boolean => {
	switch (e.kind) {
		case "field":
		case "literal":
			return true
		case "compare":
			return readsAlike(e.left) && readsAlike(e.right)
		case "between":
			return readsAlike(e.arg) && readsAlike(e.low) && readsAlike(e.high)
		case "in":
		case "not":
			return readsAlike(e.arg)
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return e.args.every(readsAlike)
		case "var":
		case "value":
		case "parent":
		case "param":
		case "compute":
		case "cast":
		case "base":
		case "retype":
		case "guarded":
		case "cond":
		case "when":
		case "allen":
		case "pointIn":
		case "absent":
		case "exists":
		case "call":
			return false
	}
}

/** Whether a containment is plain, neither side selected: its foreign key references its target's own fields and
 * adds no law column to either relation. */
const isPlain = (d: ContainmentDetail): boolean =>
	d.from.selection.conjuncts.length === 0 && d.to.selection.conjuncts.length === 0

/** Whether every term of a side is a field and every conjunct of its selection reads alike in a query and in a
 * generated column (`readsAlike`). */
const sideReadsAlike = (side: ResolvedSide): boolean =>
	side.terms.every((t) => t.kind === "field") &&
	side.selection.conjuncts.every((c) => readsAlike(c.predicate))

/**
 * The discharge of the scalar containment `d`, the detail of `law` (`ContainmentDischarge`), from what the schema
 * states, in order:
 *
 * - a plain containment (`isPlain`) into a target a key holds apart (`keyHolds`), at a declared key's fields or a
 *   superkey's, is native, its foreign key the same law, which generate proves here: its referencing columns are its
 *   source's fields, each NOT NULL as every column of a relation is, so MATCH SIMPLE checks every source row, and its
 *   referenced columns are its target's fields under that key's UNIQUE or one over the superkey, which the key
 *   implies, so the rows a source row's values find are exactly the target facts the law asks for: it refuses exactly
 *   the states the law's violation query finds broken, at the statement where it is immediate and at COMMIT where it
 *   is deferred (test/pg/laws/plain-native). It adds no law column, a written row costs one probe of an index where
 *   the judge would read a range of the unit at every COMMIT that writes either side, its writers keep the isolation a
 *   foreign key admits, and its existence evidence, which every evidence catalog reads (catalog.ts
 *   existenceConstraints), holds at every statement where its key is immediate and at a committed snapshot where it
 *   is deferred;
 * - a containment with a pred term, or a side whose selection computes, casts or branches (`readsAlike`), is native:
 *   its law columns compute the term or the selection in a generated column, where a judged query would negate the
 *   target at a computed value, which the checker refuses, or evaluate the selection at a query's site, which may
 *   refuse it;
 * - any other containment of field terms, one with a selected side or into a target no key holds apart, is the rule
 *   judge's where its violation query is unit-local, both sides joined within one unit, and every relation it reads
 *   immutable or all of them in one declared unit (unit.ts wholeRule, whose admission it is), its law columns, their
 *   UNIQUE and their index gone with its key, and native where it is not, which `#reference` refuses into a target no
 *   key holds: no UNIQUE the law model may add holds it apart. Over immutable relations the judge reads it by its
 *   probes (`probedSideOf`), key by key: each row a transaction gained of its source, and each source row at the fields
 *   of a row it lost of its target, probes the target at that row's fields, each side a stored relation's, so every
 *   written row binds the other side's fields itself. Read whole, every source row of each unit written was read and
 *   the target joined beside it at the unit's key alone, the rest of its fields a filter of the pairs: LC-WRITERS'
 *   outline within its standard's children, 280,000 rows of one unit, compared with every one of 280,000 at each COMMIT
 *   (23 minutes). Over a mutable relation it is read whole (unit.ts wholeRule), under its unit's exclusive borrow: a
 *   row of a mutable member changes in place, and the side of olds captures an UPDATE only where the row's image at the
 *   columns a rule reads there changed (physical/ddl/deltas.ts captured), so a probe of the lost side, which reads that
 *   side alone, sees no loss for an update in place that keeps the image but moves the row out of a fact another
 *   occurrence reads through it, where the whole judgement reads every row of each unit written again
 *   (test/pg/laws/rule-open-unit's kept case: a seat's cap lowered in place under a presence's score). Probing a
 *   mutable member takes every update of a column any occurrence reads captured as a loss and a gain on both sides, and
 *   the probes' proofs reading no witness through a mutable relation (unit.ts witnessesOf).
 */
const containmentDischarge = (
	law: TheoryLaw,
	d: ContainmentDetail,
	projected: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>,
	relations: ReadonlyMap<string, TheoryRelation>,
	facts: RegionFacts
): ContainmentDischarge => {
	if (
		(isPlain(d) && keyHolds(projected, d.to)) ||
		!(sideReadsAlike(d.from) && sideReadsAlike(d.to))
	) {
		return nativeDischarge
	}
	const stated: RuleLaw<LawSide> = {
		kind: "contained",
		from: lawSideOf(d.from),
		to: lawSideOf(d.to)
	}
	const whole = wholeRule(
		stated,
		violationQuery(stated, liveReading(storedSides), law.loc),
		relations,
		facts,
		law.loc
	)
	if (whole === undefined) {
		return nativeDischarge
	}
	return {
		kind: "judged",
		rule:
			mutableSide(d.from) || mutableSide(d.to)
				? whole
				: {
						kind: "contained",
						from: probedSideOf(stated.from, "from.", law.loc),
						to: probedSideOf(stated.to, "to.", law.loc)
					}
	}
}

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

/**
 * A key of a relation as a containment's target reads it, and as a generated UNIQUE's conflicts are judged against it
 * (`breaksKey`): the selection its side reads, none for a declared key, and its terms.
 */
export type TargetKey = Pick<ResolvedSide, "selection" | "terms">

/** The selection of every row, a declared key's: no conjunct. */
const everyRow: ResolvedSelection = { conjuncts: [] }

/** Whether every conjunct of `key`'s selection is one of `target`'s, which so reads only facts the key holds apart. */
const selectsWithin = (key: TargetKey, target: TargetKey): boolean =>
	key.selection.conjuncts.every((k) => target.selection.conjuncts.some((c) => c.text === k.text))

/** Whether a key over `key` keys `target`: it selects within it, and the target's terms hold every term of the key, each
 * of one kind over one field. */
const keyedBy = (key: TargetKey, target: TargetKey): boolean =>
	selectsWithin(key, target) &&
	key.terms.every((k) => target.terms.some((t) => t.kind === k.kind && t.column === k.column))

/**
 * A field a containment's target's selection fixes beyond its terms, by one conjunct: to a literal, which the source
 * meets by a constant law column; or to the target's term at `term`, which the source meets by its own column paired
 * with that term.
 */
type Fixing =
	| {
			readonly kind: "literal"
			readonly conjunct: ResolvedConjunct
			readonly field: LawField
			readonly value: TypedLiteral
	  }
	| {
			readonly kind: "term"
			readonly conjunct: ResolvedConjunct
			readonly field: LawField
			readonly term: number
	  }

/** The two fields a conjunct `left = right` equates, each way round; none for any other conjunct. */
const equatedFields = (c: ResolvedConjunct): ReadonlyArray<readonly [LawField, LawField]> => {
	const p = c.predicate
	if (
		p.kind !== "compare" ||
		p.op !== "eq" ||
		p.left.kind !== "field" ||
		p.right.kind !== "field"
	) {
		return []
	}
	const leftName = p.left.field
	const rightName = p.right.field
	const left = c.reads.find((f) => f.name === leftName)
	const right = c.reads.find((f) => f.name === rightName)
	return left === undefined || right === undefined
		? []
		: [
				[left, right],
				[right, left]
			]
}

/**
 * The field a conjunct of a target's selection fixes beyond its field terms `terms`: `field = literal` over a field
 * none of them is, or `field = term` between a field none of them is and one of them, of one type. None for any other
 * conjunct, which stays the target's guard.
 */
const fixingOf = (c: ResolvedConjunct, terms: ReadonlyArray<LawField>): ReadonlyArray<Fixing> => {
	switch (c.kind) {
		case "fixed":
			return terms.includes(c.selector.col)
				? []
				: [{ kind: "literal", conjunct: c, field: c.selector.col, value: c.selector.value }]
		case "general":
			return equatedFields(c).flatMap(([field, term]): ReadonlyArray<Fixing> => {
				const at = terms.indexOf(term)
				return at !== -1 && !terms.includes(field) && sameScalarType(field.type, term.type)
					? [{ kind: "term", conjunct: c, field, term: at }]
					: []
			})
	}
}

/**
 * The fields `to`'s selection fixes beyond its field terms `terms`, outside the conjuncts `key` selects by, which stay
 * guards: each fixed by one conjunct (fixingOf), in field order. A field two conjuncts fix stays guarded by both.
 */
const fixingsOf = (
	to: ResolvedSide,
	terms: ReadonlyArray<LawField>,
	key: TargetKey
): ReadonlyArray<Fixing> => {
	const found = to.selection.conjuncts.flatMap((c) =>
		key.selection.conjuncts.some((k) => k.text === c.text) ? [] : fixingOf(c, terms)
	)
	return found
		.filter((f) => found.filter((g) => g.field === f.field).length === 1)
		.toSorted((a, b) => a.field.position - b.field.position)
}

/**
 * The source's column that meets a fixed field: a constant law column on `fromRel` holding the literal the field is fixed
 * to, or `source`'s column paired with the term the field equals.
 */
const fixingSource = (
	f: Fixing,
	source: NonEmptyReadonlyArray<PlannedColumn>,
	fromRel: RelationInfo,
	toRel: RelationInfo
): PlannedColumn => {
	switch (f.kind) {
		case "literal":
			return lawColumn({
				kind: "constant",
				relation: fromRel,
				target: toRel,
				field: f.field,
				value: f.value
			})
		case "term":
			return defined(source[f.term], "the source's column paired with a fixed field's term")
	}
}

/** How a containment references its target: the source's columns and the target's columns each meets, in order. */
interface Reference {
	readonly columns: NonEmptyReadonlyArray<PlannedColumn>
	readonly targetColumns: NonEmptyReadonlyArray<SideColumn>
}

/** A containment from one side of an ordinary relation into another's, as `#scalarContainment` lowers it: a stated one,
 * or a part of a rule over a query. */
interface ScalarPart {
	readonly from: ResolvedSide
	readonly to: ResolvedSide
}

/** How a rule over a query is discharged (LawPlan): by the migration, by its parts' foreign keys, or by its triggers. */
type RuleRoute =
	| { readonly kind: "migration" }
	| { readonly kind: "write"; readonly parts: NonEmptyReadonlyArray<ScalarPart> }
	| { readonly kind: "trigger"; readonly rule: QueryRule }

/**
 * A rule's route: once by the migration, where it reads no ordinary relation; at every write by the foreign keys of its
 * parts, where it lowers to them and the model discharges it natively (RuleDischarge); else at every COMMIT by its
 * deferred constraint triggers.
 */
const ruleRoute = (
	law: TheoryLaw,
	d: Extract<TheoryLaw["detail"], { readonly kind: "rule" }>,
	relations: Readonly<Record<string, TheoryRelation>>,
	discharge: RuleDischarge
): RuleRoute => {
	if (!law.reads.some((r) => relations[r]?.kind === "relation")) {
		return { kind: "migration" }
	}
	return d.lowering.kind === "foreignKeys" && discharge === "native"
		? { kind: "write", parts: d.lowering.parts }
		: { kind: "trigger", rule: d.rule }
}

/**
 * The containments a law lowers by `#scalarContainment` (`plan`), each to a foreign key, the UNIQUE it references and
 * the reverse index over its source's columns: a stated containment of scalar pairs between ordinary relations that
 * rides no family axis and that the law model discharges natively (`containmentDischarge`), and each part of a rule
 * over a query its foreign keys discharge.
 */
const scalarParts = (
	law: TheoryLaw,
	relations: Readonly<Record<string, TheoryRelation>>,
	relationMap: ReadonlyMap<string, TheoryRelation>,
	projected: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>,
	discharge: RuleDischarge,
	facts: RegionFacts
): ReadonlyArray<ScalarPart> => {
	const d = law.detail
	switch (d.kind) {
		case "containment":
			if (
				d.from.rel.kind === "closed" ||
				d.to.rel.kind === "closed" ||
				d.lowers.kind === "rides" ||
				d.pairing.kind === "span"
			) {
				return []
			}
			switch (containmentDischarge(law, d, projected, relationMap, facts).kind) {
				case "native":
					return [d]
				case "judged":
					return []
			}
		case "rule": {
			const route = ruleRoute(law, d, relations, discharge)
			return route.kind === "write" ? route.parts : []
		}
		case "key":
		case "projectedKey":
		case "check":
		case "contract":
		case "family":
		case "tree":
		case "fold":
			return []
	}
}

/**
 * Whether every two rows a UNIQUE over `columns` holds apart break `key` (laws/model/model.ts #implyingKey). Both rows hold
 * every column NULL on neither and equal: so each satisfies every conjunct of each of its law columns' selections, and
 * they agree at each field a column reads, a pred term's field among them, at each field one of those conjuncts fixes
 * to a literal, and at each field one equates to a field they agree at. They break the key where its selection's
 * conjuncts are all among those, so the key holds both apart, and they agree at each of its terms: a field term at its
 * field, a pred term where the UNIQUE reads that same pred, which is then NULL on neither.
 */
export const breaksKey = (columns: ReadonlyArray<PlannedColumn>, key: TargetKey): boolean => {
	const read = columns.flatMap((c): ReadonlyArray<ResolvedTerm> => {
		if (c.kind === "field") {
			return [{ kind: "field", field: c.field.name, column: c.field }]
		}
		return c.column.kind === "term" ? [c.column.term] : []
	})
	const conjuncts = columns.flatMap((c) =>
		c.kind === "law" && c.column.kind === "term" ? c.column.selection.conjuncts : []
	)
	const equated = conjuncts.flatMap(equatedFields)
	const closed = (known: ReadonlySet<LawField>): ReadonlySet<LawField> => {
		const more = equated.filter(([field, other]) => known.has(other) && !known.has(field))
		return more.length === 0 ? known : closed(new Set([...known, ...more.map(([field]) => field)]))
	}
	const agreed = closed(
		new Set([
			...read.map((t) => t.column),
			...conjuncts.flatMap((c) => (c.kind === "fixed" ? [c.selector.col] : []))
		])
	)
	return (
		key.selection.conjuncts.every((k) => conjuncts.some((c) => c.text === k.text)) &&
		key.terms.every((t) =>
			t.kind === "field"
				? agreed.has(t.column)
				: read.some((u) => u.kind === "pred" && u.column === t.column)
		)
	)
}

/** Whether two lists of side columns hold one set of columns, each in the other. */
/** Whether two lists of columns are one list: the same columns in the same order. */
const sameOrder = (a: ReadonlyArray<SideColumn>, b: ReadonlyArray<SideColumn>): boolean =>
	a.length === b.length &&
	a.every((c, i) => {
		const d = b[i]
		return d !== undefined && sameSideColumn(c, d)
	})

const sameColumns = (a: ReadonlyArray<SideColumn>, b: ReadonlyArray<SideColumn>): boolean =>
	a.length === b.length &&
	a.every((c) => b.some((d) => sameSideColumn(c, d))) &&
	b.every((d) => a.some((c) => sameSideColumn(c, d)))

/** A constant law column a reference's source holds (`fixingSource`). */
type ConstantColumn = Extract<LawColumnPlan, { readonly kind: "constant" }>

/** The constant law columns a reference's source holds: each value its target's selection fixes a field to. */
const constantsOf = (r: Reference): ReadonlyArray<ConstantColumn> =>
	r.columns.flatMap((c) => (c.kind === "law" && c.column.kind === "constant" ? [c.column] : []))

/** Whether two constant law columns are one: of one source and target, meeting one field, holding one value. */
const sameConstant = (a: ConstantColumn, b: ConstantColumn): boolean =>
	a.relation.name === b.relation.name &&
	a.target.name === b.target.name &&
	a.field === b.field &&
	literalKey(a.value) === literalKey(b.value)

/**
 * What a relation holds whatever reference each fixed target takes (`#reference`): the column sets its keys and the
 * references into its targets keyed by their terms hold unique, the columns each reverse probe's B-tree reads
 * (`btreeRun`), and the law columns some side lowers to, a key's, a containment's source's, or a target's keyed by its
 * terms.
 */
interface Planned {
	readonly uniques: ReadonlyArray<NonEmptyReadonlyArray<SideColumn>>
	readonly probes: ReadonlyArray<NonEmptyReadonlyArray<SideColumn>>
	readonly columns: ReadonlyArray<SideColumn>
}

/** A relation that plans nothing a reference's UNIQUE could reuse. */
const plansNothing: Planned = { uniques: [], probes: [], columns: [] }

/** Whether every column of `columns` is one of `within`'s. */
const within = (columns: ReadonlyArray<SideColumn>, outer: ReadonlyArray<SideColumn>): boolean =>
	columns.every((c) => outer.some((o) => sameSideColumn(c, o)))

/**
 * Whether a B-tree over `index`, in its order, serves a reverse probe over `probe`, columns compared by `same`, as the
 * index engine places a law's (physical/indexes/engine.ts reversePlacements): a unique one whose every column the probe
 * binds, finding at most one row, or one whose leading columns are the probe's, in any order; never one led by a probe
 * column that holds the rest further in, which reads that column's every row for each probe. `index` is unique wherever
 * this reads it.
 */
const servesProbeBy =
	<C>(same: (a: C, b: C) => boolean) =>
	(index: NonEmptyReadonlyArray<C>, probe: NonEmptyReadonlyArray<C>): boolean => {
		const holds = (columns: ReadonlyArray<C>, outer: ReadonlyArray<C>): boolean =>
			columns.every((c) => outer.some((o) => same(c, o)))
		const lead = index.slice(0, probe.length)
		return (
			holds(index, probe) ||
			(lead.length === probe.length && holds(lead, probe) && holds(probe, lead))
		)
	}

/** servesProbeBy over the columns a side lowers to. */
const servesProbe = servesProbeBy(sameSideColumn)

/**
 * The order a UNIQUE over one column set is installed in, of the orders `orders` the plans landing on that set name, in
 * their order: the first that serves the most of its relation's distinct reverse probes `probes` (servesProbeBy), the
 * first plan's where none serves more. A UNIQUE holds its rows apart in any order of its columns and a foreign key
 * references its column set in any order, so the order is the law model's to choose, and the one that leads a probe
 * saves the B-tree the probe would take of its own: two fixed targets over (a, b) and (b, a) under one selection land
 * on one UNIQUE, which a probe out of that selection over (a) reads only in the order (a, b). The law model installs
 * each such UNIQUE in this order (model.ts), and the reference choice counts each configuration's UNIQUEs in it
 * (`takingShared`), so the two agree.
 */
export const uniqueOrder =
	<C>(same: (a: C, b: C) => boolean) =>
	(
		orders: NonEmptyReadonlyArray<NonEmptyReadonlyArray<C>>,
		probes: ReadonlyArray<NonEmptyReadonlyArray<C>>
	): NonEmptyReadonlyArray<C> => {
		const serves = servesProbeBy(same)
		const served = (order: NonEmptyReadonlyArray<C>): number =>
			probes.filter((probe) => serves(order, probe)).length
		const [first, ...rest] = orders
		return rest.reduce((best, order) => (served(order) > served(best) ? order : best), first)
	}

/**
 * The B-trees the index engine creates for reverse probes no index serves: it plans the widest request first and drafts
 * each index to serve every later request it can (physical/indexes/engine.ts draftFor), so a probe over a subset of a
 * wider probe's columns leads that probe's index instead of taking one of its own, and a chain of probes, each over a
 * subset of the one before it, shares one index. Each probe, widest first, joins the first chain whose narrowest probe
 * holds its columns, or starts one.
 */
const probeIndexes = (probes: ReadonlyArray<NonEmptyReadonlyArray<SideColumn>>): number => {
	const narrowest: Array<NonEmptyReadonlyArray<SideColumn>> = []
	for (const probe of probes.toSorted((a, b) => b.length - a.length)) {
		const at = narrowest.findIndex((tail) => within(probe, tail))
		if (at === -1) {
			narrowest.push(probe)
		} else {
			narrowest[at] = probe
		}
	}
	return narrowest.length
}

/** The items of `items` with no earlier one `same` holds of, in their order. */
const distinct = <A>(items: ReadonlyArray<A>, same: (a: A, b: A) => boolean): ReadonlyArray<A> =>
	items.filter((a, i) => !items.slice(0, i).some((b) => same(a, b)))

/**
 * A containment into a fixed target as the choice of its reference reads it (`referenceChoice`): the target's relation,
 * its own columns, the columns of the UNIQUE its shared reference lands on, and the constants that reference adds to
 * the containment's source.
 */
interface FixedUse {
	readonly part: PartRef
	readonly relation: string
	readonly own: NonEmptyReadonlyArray<SideColumn>
	readonly shared: NonEmptyReadonlyArray<SideColumn>
	readonly constants: ReadonlyArray<ConstantColumn>
}

/**
 * A UNIQUE a reference may land on, as the choice counts what it adds to its relation beyond what the relation holds
 * (`Planned`): its columns, in the order the first reference names them, every order its references name, and its law
 * columns no side lowers to. Which reverse probes it serves is no fact of the landing: landings over one column set are
 * one UNIQUE, installed once in the order of theirs that serves the most probes (`uniqueOrder`), so only a configuration
 * knows the UNIQUEs it installs (`takingShared`).
 */
interface Landing {
	readonly columns: NonEmptyReadonlyArray<SideColumn>
	/** Every order the references landing here name, `columns` first, each once. */
	readonly orders: NonEmptyReadonlyArray<NonEmptyReadonlyArray<SideColumn>>
	readonly fresh: ReadonlyArray<SideColumn>
}

/** A fixed target of one relation: its two landings, and the constants every containment into it adds to its sources
 * where it takes the shared one. */
interface FixedTarget {
	readonly own: Landing
	readonly shared: Landing
	readonly constants: ReadonlyArray<ConstantColumn>
}

/**
 * One step of the reference choice (`takingShared`): the targets taking the shared reference after it, the objects
 * that configuration plans, and which way it moved a target, to its shared UNIQUE or back to its own columns.
 */
interface Step {
	readonly next: ReadonlySet<FixedTarget>
	readonly objects: number
	readonly toward: "shared" | "own"
}

/**
 * The fixed targets of one relation that take the shared reference: a choice by what each configuration adds to the
 * whole schema, counted exactly. A configuration's objects are the UNIQUEs it installs, one per column set its targets
 * land on that no planned UNIQUE holds, in the order of theirs that serves the most reverse probes, as the law model
 * installs them (`uniqueOrder`); the B-trees the reverse probes no planned UNIQUE and no
 * installed UNIQUE serves need, each UNIQUE serving by the order it is installed in, a chain of them over nested column
 * sets sharing one (`probeIndexes`); the distinct law columns its landings add; and the distinct constants its shared
 * references add to their sources. From every target
 * at its own columns, which is what keys restated over the targets would plan, it steps: a move of targets to their
 * shared UNIQUE, all of one shared UNIQUE's targets at once or one alone, or of one target back to its own columns,
 * taking the step that leaves the fewest objects while that is fewer than before, or as many and toward the shared
 * UNIQUE (`Step`). So it never plans more objects than the own columns would, keeps the superkey where both cost the
 * same, and stops only where no one step lowers the count: a target a group move took to the shared UNIQUE goes back
 * where its own columns cost less. Each step lowers the count or, at the same count, takes one target more to its shared
 * UNIQUE, so the steps end.
 */
const takingShared = (
	uses: ReadonlyArray<FixedUse>,
	planned: Planned
): ReadonlyArray<NonEmptyReadonlyArray<SideColumn>> => {
	const every = distinct(planned.probes, sameColumns)
	const probes = every.filter((probe) => !planned.uniques.some((u) => servesProbe(u, probe)))
	const ordered = uniqueOrder(sameSideColumn)
	const landing = (orders: NonEmptyReadonlyArray<NonEmptyReadonlyArray<SideColumn>>): Landing => ({
		columns: orders[0],
		orders,
		fresh: orders[0].filter(
			(c) => c.kind === "law" && !planned.columns.some((p) => sameSideColumn(p, c))
		)
	})
	/** `first`, then each other order of `all`, each once. */
	const ordersOf = (
		first: NonEmptyReadonlyArray<SideColumn>,
		all: ReadonlyArray<NonEmptyReadonlyArray<SideColumn>>
	): NonEmptyReadonlyArray<NonEmptyReadonlyArray<SideColumn>> => [
		first,
		...distinct(all, sameOrder).filter((o) => !sameOrder(o, first))
	]
	const owns = distinct(uses, (a, b) => sameColumns(a.own, b.own))
	const targets: ReadonlyArray<FixedTarget> = owns.map((use) => {
		const alike = uses.filter((u) => sameColumns(u.own, use.own))
		return {
			own: landing(
				ordersOf(
					use.own,
					alike.map((u) => u.own)
				)
			),
			shared: landing(
				ordersOf(
					use.shared,
					alike.map((u) => u.shared)
				)
			),
			constants: distinct(
				alike.flatMap((u) => u.constants),
				sameConstant
			)
		}
	})
	const objects = (taking: ReadonlySet<FixedTarget>): number => {
		const landed = targets.map((t) => (taking.has(t) ? t.shared : t.own))
		const installed = distinct(landed, (a, b) => sameColumns(a.columns, b.columns))
			.filter((l) => !planned.uniques.some((u) => sameColumns(u, l.columns)))
			.map((l) =>
				ordered(
					[
						l.orders[0],
						...l.orders.slice(1),
						...landed
							.filter((m) => m !== l && sameColumns(m.columns, l.columns))
							.flatMap((m) => m.orders)
					],
					every
				)
			)
		return (
			installed.length +
			probeIndexes(probes.filter((probe) => !installed.some((u) => servesProbe(u, probe)))) +
			distinct(
				landed.flatMap((l) => l.fresh),
				sameSideColumn
			).length +
			distinct(
				targets.filter((t) => taking.has(t)).flatMap((t) => t.constants),
				sameConstant
			).length
		)
	}
	const moves = (taking: ReadonlySet<FixedTarget>): ReadonlyArray<ReadonlyArray<FixedTarget>> => {
		const left = targets.filter((t) => !taking.has(t))
		const groups = distinct(left, (a, b) => sameColumns(a.shared.columns, b.shared.columns)).map(
			(g) => left.filter((t) => sameColumns(t.shared.columns, g.shared.columns))
		)
		return [...groups, ...left.map((t) => [t])]
	}
	const step = (next: ReadonlySet<FixedTarget>, toward: Step["toward"]): Step => ({
		next,
		objects: objects(next),
		toward
	})
	const steps = (taking: ReadonlySet<FixedTarget>): ReadonlyArray<Step> => [
		...moves(taking).map((move) => step(new Set([...taking, ...move]), "shared")),
		...targets
			.filter((t) => taking.has(t))
			.map((t) => step(new Set([...taking].filter((x) => x !== t)), "own"))
	]
	const improved = (taking: ReadonlySet<FixedTarget>, cost: number): ReadonlySet<FixedTarget> => {
		const [first, ...rest] = steps(taking).filter(
			(s) => s.objects < cost || (s.objects === cost && s.toward === "shared")
		)
		if (first === undefined) {
			return taking
		}
		const least = rest.reduce((a, b) => (b.objects < a.objects ? b : a), first)
		return improved(least.next, least.objects)
	}
	const empty: ReadonlySet<FixedTarget> = new Set()
	const taken = improved(empty, objects(empty))
	return targets.filter((t) => taken.has(t)).map((t) => t.own.columns)
}

/**
 * A part a law lowers by `#scalarContainment` (`scalarParts`): the law, and the part's place among its parts, 0 for a
 * stated containment and each part of a rule over a query at its place.
 */
export interface PartRef {
	readonly law: LawId
	readonly part: number
}

/**
 * The parts whose fixed targets take the shared reference, each by its law and place (`PartRef`): the reference choice
 * over the whole schema (`referenceChoice`), which the installation's law model makes once and every law model of the
 * schema reads, a slice's among them, through the recognizer that takes it (`Recognizer`). A slice holds only the laws
 * its closure reads, whose uses of a target are not the schema's, so no slice chooses again: it reads the choice the
 * whole schema made, as generate records it beside the foreign key cycles.
 */
export type ReferenceChoice = ReadonlyArray<PartRef>

/** Whether a choice takes the shared reference for `part`. */
const takesShared = (choice: ReferenceChoice, part: PartRef): boolean =>
	choice.some((c) => c.law === part.law && c.part === part.part)

/**
 * The keys a target over `to`'s relation may hold (`TargetKey`), its relation's keys over projected sides `projected`
 * by relation name: each declared scalar key, over every fact, then each key over a projected side with no span term,
 * whose WITHOUT OVERLAPS holds apart no two equal empty spans.
 */
const keysOf = (
	projected: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>,
	to: ResolvedSide
): ReadonlyArray<TargetKey> => [
	...scalarKeys(to.rel).map((k): TargetKey => ({
		selection: everyRow,
		terms: mapNonEmpty(k, (f): ResolvedTerm => ({ kind: "field", field: f.name, column: f }))
	})),
	...(projected.get(to.relation) ?? []).filter((k) => !k.terms.some((t) => isSpanField(t.column)))
]

/** The key of a fixed target (see the recognition table) and the fields its selection fixes beyond its terms. */
interface FixedKey {
	readonly key: TargetKey
	readonly fixings: NonEmptyReadonlyArray<Fixing>
}

/**
 * The key that holds a fixed target apart: the first key, in `keysOf` order, that selects within it and whose terms are
 * among its field terms and the fields it fixes outside the key's selection (`fixingsOf`). Undefined for a target with a
 * term no field, or one no such key holds.
 */
const fixedKeyOf = (
	projected: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>,
	to: ResolvedSide
): FixedKey | undefined => {
	const fields = fieldTermsOf(to.terms)
	if (fields === undefined) {
		return undefined
	}
	const terms = fields.map((t) => t.column)
	const [held] = keysOf(projected, to).flatMap((key): ReadonlyArray<FixedKey> => {
		const fixed = fixingsOf(to, terms, key)
		const covered = [...terms, ...fixed.map((f) => f.field)]
		return selectsWithin(key, to) &&
			isNonEmpty(fixed) &&
			key.terms.every((k) => k.kind === "field" && covered.includes(k.column))
			? [{ key, fixings: fixed }]
			: []
	})
	return held
}

/**
 * Whether a key of `to`'s relation holds the target apart, so a UNIQUE over the columns a containment references it at
 * states exactly what the key does: a fixed target's key (`fixedKeyOf`), or a key over a selection within the target's
 * whose terms are among its terms (`keyedBy`), the target's columns that key's own or a superkey of it. A target no key
 * holds has no UNIQUE the law model may add: one over its columns would refuse facts the schema admits.
 */
const keyHolds = (
	projected: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>,
	to: ResolvedSide
): boolean =>
	fixedKeyOf(projected, to) !== undefined || keysOf(projected, to).some((k) => keyedBy(k, to))

/**
 * A fixed target (see the recognition table) referenced at its key's columns (`fixedKeyOf`): its columns are its terms
 * under its other conjuncts, then each fixed field, the key's own column where the field is a term of the key and else
 * the field, so a target that is a projected key's side widened by its fixed fields references that key's own UNIQUE;
 * the source's are its own, then for each fixed field a constant law column of its literal or its column paired with
 * the term the field equals. The key holds apart the facts the other conjuncts keep at them, its selection among those
 * conjuncts, so the UNIQUE over them refuses nothing the key admits. Undefined for any other target.
 */
const fixedTargetOf = (
	projected: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>,
	to: ResolvedSide,
	source: NonEmptyReadonlyArray<PlannedColumn>,
	fromRel: RelationInfo,
	toRel: RelationInfo
): Reference | undefined => {
	const held = fixedKeyOf(projected, to)
	if (held === undefined) {
		return undefined
	}
	const { key, fixings } = held
	const rest: ResolvedSide = {
		...to,
		selection: {
			conjuncts: to.selection.conjuncts.filter((c) => !fixings.some((f) => f.conjunct === c))
		}
	}
	return {
		columns: extendNonEmpty(
			source,
			fixings.map((f) => fixingSource(f, source, fromRel, toRel))
		),
		targetColumns: extendNonEmpty(
			sideColumns(rest),
			fixings.map((f) => keyColumn(toRel, key, f.field))
		)
	}
}

/** Each relation's keys over projected sides, by relation name, as `laws` state them. */
const projectedKeysOf = (
	laws: ReadonlyArray<TheoryLaw>
): ReadonlyMap<string, ReadonlyArray<ResolvedSide>> => {
	const keys = new Map<string, Array<ResolvedSide>>()
	for (const law of laws) {
		if (law.detail.kind === "projectedKey") {
			const side = law.detail.side
			keys.getOrInsertComputed(side.relation, () => []).push(side)
		}
	}
	return keys
}

/**
 * The reference choice of a whole schema's `laws` (`ReferenceChoice`): what each relation holds whatever the choices
 * (`Planned`), read off its keys and every part a law lowers by `#scalarContainment`, then each relation's choice over
 * the parts into its fixed targets (`takingShared`), each part whose target takes its superkey listed by its law and
 * place. Made once, by the installation's law model, over every law of the schema.
 */
export const referenceChoice = (
	laws: ReadonlyArray<TheoryLaw>,
	relations: Readonly<Record<string, TheoryRelation>>,
	discharge: RuleDischarge,
	facts: RegionFacts
): ReferenceChoice => {
	const projected = projectedKeysOf(laws)
	const planned = new Map<
		string,
		{
			uniques: Array<NonEmptyReadonlyArray<SideColumn>>
			probes: Array<NonEmptyReadonlyArray<SideColumn>>
			columns: Array<SideColumn>
		}
	>()
	const at = (relation: string) => {
		const known = planned.get(relation)
		const held = known ?? { uniques: [], probes: [], columns: [] }
		if (known === undefined) {
			planned.set(relation, held)
		}
		return held
	}
	for (const [name, r] of Object.entries(relations)) {
		for (const k of scalarKeys(r)) {
			at(name).uniques.push(mapNonEmpty(k, fieldColumn))
		}
	}
	for (const [name, sides] of projected) {
		for (const side of sides) {
			if (side.rel.kind === "closed" || side.terms.some((t) => isSpanField(t.column))) {
				continue
			}
			const columns = sideColumns(side)
			at(name).uniques.push(columns)
			appendAll(at(name).columns, columns)
		}
	}
	const fixed: Array<FixedUse> = []
	const relationMap = new Map(Object.entries(relations))
	for (const law of laws) {
		for (const [i, part] of scalarParts(
			law,
			relations,
			relationMap,
			projected,
			discharge,
			facts
		).entries()) {
			const source = sideColumns(part.from)
			appendAll(at(part.from.relation).columns, source)
			const run = btreeRun(source)
			if (run !== undefined) {
				at(part.from.relation).probes.push(run)
			}
			const own = sideColumns(part.to)
			const shared = fixedTargetOf(
				projected,
				part.to,
				source,
				tableOf(part.from.rel),
				tableOf(part.to.rel)
			)
			if (shared === undefined) {
				at(part.to.relation).uniques.push(own)
				appendAll(at(part.to.relation).columns, own)
			} else {
				fixed.push({
					part: { law: law.id, part: i },
					relation: part.to.relation,
					own,
					shared: shared.targetColumns,
					constants: constantsOf(shared)
				})
			}
		}
	}
	return distinct(
		fixed.map((u) => u.relation),
		(a, b) => a === b
	).flatMap((relation) => {
		const uses = fixed.filter((u) => u.relation === relation)
		const taking = takingShared(uses, planned.get(relation) ?? plansNothing)
		return uses.flatMap((u) => (taking.some((own) => sameColumns(own, u.own)) ? [u.part] : []))
	})
}

/** Whether `key` is exactly `side`: the same conjuncts and the same terms, each of one kind over one field. */
const sameSide = (key: ResolvedSide, side: ResolvedSide): boolean =>
	keyedBy(key, side) &&
	key.selection.conjuncts.length === side.selection.conjuncts.length &&
	key.terms.length === side.terms.length

/**
 * The span field term of a key over a side, if it has one. A key holding two has no native lowering: it is refused in
 * `keys` (`judge`), and its first span stands as its span all the same.
 */
const spanTermOf = (
	keys: KeyLedger,
	side: ResolvedSide,
	loc: SourceLoc
): ResolvedTerm | undefined => {
	const spans = side.terms.filter((t) => isSpanField(t.column))
	if (spans.length > 1) {
		judge(
			keys,
			loc,
			`the key over ${side.relation}(${side.terms.map(termText).join(", ")})`,
			side.terms.map(termText),
			Result.err({ kind: "spans", fields: spans.map((t) => t.field) })
		)
	}
	return spans[0]
}

/** The coverage refusal of an unkeyed target: a temporal reference needs the target's spans disjoint within a key. */
const coverageKeySentence =
	"a coverage target needs a `WITHOUT OVERLAPS` key over its span; coalesce the spans, or key them"

/** A literal expression of a small natural, which every comparison of a family's drawn naturals reads. */
const naturalLiteral = (value: 0n | 1n): ExprDesc => ({ kind: "literal", value })

const cmp = (op: CompareOp, left: ExprDesc, right: ExprDesc): ExprDesc => ({
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
 * The CHECK a primary key holding key generations installs with its PRIMARY KEY (ir/law.ts FieldWriting keyGenerated):
 * each such field equal to its generation over its row, `field = expr`, the generation PostgreSQL would have computed
 * for a GENERATED column, so the column grizzle writes holds exactly its generation's value; none where the key holds
 * no generation. The key's law owns it: a fact is known by its key, a key generation by its generation's reads.
 */
const keyGenerationCheck = (rel: RelationInfo): NativePlan | undefined => {
	const conditions = new RowConditions(rel)
	for (const f of rel.primaryFields) {
		if (f.writing.kind === "keyGenerated") {
			conditions.add(cmp("eq", conditions.column(fieldColumn(f)), f.writing.desc))
		}
	}
	return conditions.native()
}

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
					check: {
						predicate: and([first, ...rest]),
						leaves: new Map(this.#leaves)
					}
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
	/** The column its base pin holds at its start: `from`, or the running value whose digest `from` is. */
	readonly pinned: PlannedColumn
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
 * - A side lowers to one column per term (`sideColumns`): its guarded term (`guardTerm`), the one over its earliest
 *   field, its primary key's first, under its selection, every other over every row. A field term over every row is
 *   its field, and the guarded term of a selected side and every pred term is a law column generated `CASE WHEN φ₁
 *   AND … THEN t END` STORED over its selection's conjuncts, pred(x) being `CASE WHEN x > 0 THEN x - 1 END`
 *   (scalar/natural.ts guardedTerm). A row whose side reads no tuple holds a null in the guarded column, which is all
 *   the next two rules read: one guarded column per side is exact.
 * - A key over a side is UNIQUE NULLS DISTINCT over its columns, which holds apart only the rows the side reads; one
 *   whose terms hold a span field is WITHOUT OVERLAPS over them, the span last.
 * - A containment is FOREIGN KEY MATCH SIMPLE from the source's columns, which references nothing from a row whose side
 *   reads no tuple, into a UNIQUE over exactly the target's columns, and its source's columns are indexed. The target
 *   must contain a key (`TargetKey`): a declared scalar key of its relation, or a projected key with no span term, whose
 *   conjuncts are among the target's and whose terms are among its terms. Its UNIQUE is that key's when the columns are
 *   exactly a declared key's, and otherwise a generated superkey, exact because a superkey of a key is unique.
 * - A fixed target (`fixedTargetOf`): a target of field terms whose selection fixes fields beyond them, each by one
 *   conjunct outside a key's selection (`Fixing`), `f = literal` or `f = t` with t one of its terms, where the key's
 *   conjuncts are among the target's and its terms among the target's terms and fixed fields. The target's columns are
 *   its terms under its other conjuncts, then its fixed fields in field order, each the key's own column where it is a
 *   term of the key; the source meets each fixed field by a constant law column holding the literal or by its own
 *   column paired with t, listed again. The key implies the UNIQUE, and every containment into the same fixed fields
 *   shares it. Tried before a target keyed by its terms alone. An alternatives arm of one handle is one: its parent
 *   selected by the handle. The key implies a UNIQUE over the target's own columns too, which its selection keeps the
 *   key's fields at, with no constant on the source; a containment references whichever adds fewer indexes and columns
 *   to the whole schema, the superkey where both cost the same (`referenceChoice`, `#reference`), so a target a reverse
 *   probe out of its selection reads at its own columns, whose UNIQUE serves that probe, and a target whose superkey
 *   costs a column or a constant more, take their own columns.
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
/**
 * The roster whose domain discharges a containment into a closed relation, when one does: a lone closed-id field
 * contained in its own roster's unselected id, whatever rows the source selects (`#intoClosed`).
 */
const rosterDischarged = (
	d: Extract<TheoryLaw["detail"], { readonly kind: "containment" }>,
	toRel: ClosedTheoryRelation,
	toSelection: ReadonlyArray<ResolvedSelector>
): DeclaredName | undefined => {
	const [only, ...more] = d.pairs
	const roster = rosterOf(baseOf(only.from.column.type))
	return more.length === 0 &&
		only.to.column.name === "id" &&
		toSelection.length === 0 &&
		roster?.closed === toRel.name
		? roster.closed
		: undefined
}

/** A closed relation's side as the containments into it read it, by its relation, its fields and its fixed selection. */
const closedSideKey = (
	toRel: ClosedTheoryRelation,
	toFields: ReadonlyArray<LawField>,
	toSelection: ReadonlyArray<ResolvedSelector>
): string =>
	keyOf(
		toRel.name,
		toFields.map((f) => f.name),
		toSelection.map((s) => keyOf(String(s.col.position), literalKey(s.value)))
	)

/**
 * The side of `toRel` on `toFields` as a closed relation of its own (ir/cells.ts sideOf), its rows the facts its fixed
 * selection `toSelection` keeps.
 */
const closedSide = (
	toRel: ClosedTheoryRelation,
	toFields: NonEmptyReadonlyArray<LawField>,
	toSelection: ReadonlyArray<ResolvedSelector>
): CellSide<TypedLiteral> => {
	const selected = toSelection.map((s) => ({
		position: s.col.position,
		value: literalKey(s.value)
	}))
	const rows = toRel.rows.filter((row) =>
		selected.every((s) => literalKey(closedCell(row, s.position)) === s.value)
	)
	return sideOf(
		{ fields: mapNonEmpty(toRel.fields, (f) => f.name), keys: [toRel.primaryKey] },
		mapNonEmpty(toFields, (f) => f.name),
		rows,
		literalKey
	)
}

/** A closed side's content as two sides are one: its key and payload fields, and each row's key texts and payload. */
const sideContent = (side: CellSide<TypedLiteral>): string =>
	keyOf(
		side.key,
		side.payload,
		[...side.rows].map(([key, split]) => keyOf(key, split.payload.map(literalKey)))
	)

/**
 * The sides of closed relations the containments into them read: each by `closedSideKey`, and each distinct content
 * once, numbered in the order first built (`ordinals`), so two sides of one content are one side and one number.
 */
interface ClosedSides {
	readonly byKey: ReadonlyMap<string, CellSide<TypedLiteral>>
	readonly ordinals: ReadonlyMap<CellSide<TypedLiteral>, number>
}

/**
 * Each distinct side of a closed relation the containments into it read, by `closedSideKey`, each built once over its
 * relation's rows however many laws read it, and each of one content one side: every containment of an ordinary
 * relation's fields into a closed relation's, selected by literals, but one its roster's domain discharges. A
 * containment of any other shape reads no side, and its plan refuses it.
 */
const closedSidesOf = (laws: ReadonlyArray<TheoryLaw>): ClosedSides => {
	const sides = new Map<string, CellSide<TypedLiteral>>()
	const contents = new Map<string, CellSide<TypedLiteral>>()
	const ordinals = new Map<CellSide<TypedLiteral>, number>()
	for (const law of laws) {
		const d = law.detail
		if (
			d.kind !== "containment" ||
			d.from.rel.kind === "closed" ||
			d.to.rel.kind !== "closed" ||
			d.pairing.kind !== "scalar"
		) {
			continue
		}
		const toRel = d.to.rel
		const terms = fieldTermsOf(d.to.terms)
		const fixed = fixedSelection(d.to.selection)
		if (terms === undefined || fixed === undefined) {
			continue
		}
		const toFields = mapNonEmpty(terms, (t) => t.column)
		const toSelection = fixed.conjuncts.map((c) => c.selector)
		const key = closedSideKey(toRel, toFields, toSelection)
		if (rosterDischarged(d, toRel, toSelection) !== undefined || sides.has(key)) {
			continue
		}
		const side = closedSide(toRel, toFields, toSelection)
		const content = sideContent(side)
		const known = contents.get(content)
		if (known !== undefined) {
			sides.set(key, known)
			continue
		}
		contents.set(content, side)
		ordinals.set(side, ordinals.size)
		sides.set(key, side)
	}
	return { byKey: sides, ordinals }
}

export class Recognizer {
	/** Each relation's keys over projected sides, by relation name, which a containment's target may contain. */
	readonly #projectedKeys: ReadonlyMap<string, ReadonlyArray<ResolvedSide>>
	readonly #relations: Readonly<Record<string, TheoryRelation>>
	/** The same relations by name, as a containment's discharge reads them (`containmentDischarge`). */
	readonly #relationMap: ReadonlyMap<string, TheoryRelation>
	readonly #families: ReadonlyMap<string, Family>
	/** Each family's or tree's own law, by family key. */
	readonly #familyLaws: ReadonlyMap<string, TheoryLaw>
	/** Each family's fold laws, by family key, each at its fold's position. */
	readonly #foldLaws: ReadonlyMap<string, ReadonlyMap<number, FoldLaw>>
	/** Each family's plan, built once for every law that reads it. */
	readonly #planned = new Map<string, FamilyPlan>()
	/** The columns each relation's owner axes write by ON UPDATE CASCADE, by relation name and column key. */
	readonly #cascaded: ReadonlyMap<string, ReadonlySet<string>>
	/** The family axes a refill writes around, deferred whatever else decides them (analysis/theory/refill.ts). */
	readonly #refill: RefillDeferral
	/** Each closed relation's sides the containments into it read (closedSidesOf), each built once. */
	readonly #closedSides: ClosedSides
	/** How a rule over a query that lowers to foreign keys is discharged (model.ts RuleDischarge). */
	readonly #discharge: RuleDischarge
	/** The whole schema's reference choice (`referenceChoice`), which the recognizer reads and never makes: what a law
	 * model records for every model of its schema, a slice's among them. */
	readonly references: ReferenceChoice
	/** The containments a whole containment's region reads (analysis/theory/unit.ts RegionFacts). */
	readonly #facts: RegionFacts
	/** The unrepresentable keys the model has met, each index the recognizer plans judged into it (`judge`). */
	readonly keys: KeyLedger

	constructor(
		laws: ReadonlyArray<TheoryLaw>,
		families: ReadonlyArray<Family>,
		relations: Readonly<Record<string, TheoryRelation>>,
		discharge: RuleDischarge,
		references: ReferenceChoice,
		facts: RegionFacts,
		keys: KeyLedger
	) {
		this.keys = keys
		const familyLaws = new Map<string, TheoryLaw>()
		const foldLaws = new Map<string, Map<number, FoldLaw>>()
		for (const law of laws) {
			const d = law.detail
			switch (d.kind) {
				case "family":
				case "tree":
					familyLaws.set(familyKey(d.family.id), law)
					break
				case "fold": {
					const own = foldLaws.getOrInsertComputed(
						familyKey(d.family),
						() => new Map<number, FoldLaw>()
					)
					own.set(d.fold, { law, detail: d })
					break
				}
				case "key":
				case "projectedKey":
				case "check":
				case "contract":
				case "containment":
				case "rule":
					break
			}
		}
		this.#projectedKeys = projectedKeysOf(laws)
		this.#relations = relations
		this.#relationMap = new Map(Object.entries(relations))
		this.#facts = facts
		this.#families = new Map(families.map((f) => [familyKey(f.id), f] as const))
		this.#familyLaws = familyLaws
		this.#foldLaws = foldLaws
		const cascaded = new Map<string, Set<string>>()
		for (const f of families) {
			const own = cascaded.getOrInsertComputed(f.member.name, () => new Set<string>())
			for (const c of ownerSources(f)) {
				own.add(columnKey(c))
			}
		}
		this.#cascaded = cascaded
		this.#refill = refillDeferral(families)
		this.#closedSides = closedSidesOf(laws)
		this.#discharge = discharge
		this.references = references
	}

	/**
	 * The number of a closed side a containment's plan reads (closedSidesOf), one per content: what a ClosedCheck's
	 * identity reads of its side.
	 */
	closedSideOrdinal(side: CellSide<TypedLiteral>): number {
		return defined(
			this.#closedSides.ordinals.get(side),
			"a ClosedCheck's side, one the recognizer built"
		)
	}

	/** Whether a refill writes around `family`'s `axis`, its owner or its predecessor axis, so it is deferred. */
	refillDeferred(axis: "owner" | "predecessor", family: Family): boolean {
		return (axis === "owner" ? this.#refill.owner : this.#refill.predecessor).has(
			familyKey(family.id)
		)
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
				return d.rel.kind === "closed" ? migrationPlan(law) : done(this.#key(d, d.rel))
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
								predicate: d.predicate
							}
						])
			case "contract":
				return done([{ kind: "Domain", contract: d.owned }])
			case "containment":
				return this.#containment(law, d, loc, done)
			case "rule":
				return this.#rule(law, ruleRoute(law, d, this.#relations, this.#discharge), loc, done)
			case "family":
			case "tree":
				return done(this.#familyNatives(this.#familyPlan(d.family.id, loc), law.id))
			case "fold": {
				const planned = this.#familyPlan(d.family, loc)
				return done([
					...defined(planned.folds[d.fold], `the columns of fold ${d.fold} of its family`),
					planned.axes.predecessor.foreignKey,
					planned.axes.last.foreignKey,
					...this.#axisNatives(planned, ["predecessor", "last"]),
					...conditionsOf(planned, law.id)
				])
			}
		}
	}

	/** A rule over a query, as its route discharges it: by the migration, by its parts' foreign keys, each a containment
	 * deferred to COMMIT, which its triggers judged there, or by its triggers. */
	#rule(
		law: TheoryLaw,
		route: RuleRoute,
		loc: SourceLoc,
		done: (natives: ReadonlyArray<NativePlan>) => LawPlan
	): LawPlan {
		switch (route.kind) {
			case "migration":
				return migrationPlan(law)
			case "write":
				return done(
					route.parts.flatMap((p, i) =>
						this.#scalarContainment(p.from, p.to, "deferred", loc, { law: law.id, part: i })
					)
				)
			case "trigger":
				return judgedPlan(law, route.rule)
		}
	}

	/** A scalar key is PRIMARY KEY or UNIQUE; a span key places its span field last
	 * WITHOUT OVERLAPS, or, alone, is an exclusion constraint under the key's name. */
	#key(
		d: Extract<TheoryLaw["detail"], { readonly kind: "key" }>,
		rel: RelationInfo
	): ReadonlyArray<NativePlan> {
		const { fields, span, primary, named } = d.key
		if (primary) {
			const generations = keyGenerationCheck(rel)
			return [primaryKeyPlan(rel, d.key), ...(generations === undefined ? [] : [generations])]
		}
		if (span === undefined) {
			return [{ kind: "Unique", relation: rel, columns: mapNonEmpty(fields, fieldColumn) }]
		}
		return [
			{
				kind: "WithoutOverlaps",
				relation: rel,
				span: fieldColumn(span),
				key: { kind: "unique", scalars: fields.filter((f) => f !== span).map(fieldColumn) },
				named
			}
		]
	}

	/** A key over a projected side: UNIQUE NULLS DISTINCT over its columns, or WITHOUT OVERLAPS over them where one term
	 * is a span field, its law column last. */
	#projectedKey(side: ResolvedSide, loc: SourceLoc): ReadonlyArray<NativePlan> {
		const relation = tableOf(side.rel)
		const columns = sideColumns(side)
		const span = spanTermOf(this.keys, side, loc)
		const subject = `key ${sideText(side)}`
		if (span === undefined) {
			judgeEntry(this.keys, columns, subject, loc)
			return [...lawColumns(columns), { kind: "Unique", relation, columns }]
		}
		const at = side.terms.indexOf(span)
		const spanColumn = defined(columns[at], `the column of the span term of ${side.relation}`)
		const scalars = columns.filter((_, i) => i !== at)
		judge(
			this.keys,
			loc,
			subject,
			[...scalars, spanColumn].map(plannedText),
			plannedGist(scalars, spanColumn)
		)
		return [
			...lawColumns(columns),
			{
				kind: "WithoutOverlaps",
				relation,
				span: spanColumn,
				key: { kind: "unique", scalars },
				named: undefined
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
			case "scalar": {
				const discharge = containmentDischarge(
					law,
					d,
					this.#projectedKeys,
					this.#relationMap,
					this.#facts
				)
				switch (discharge.kind) {
					case "native":
						return done(
							this.#scalarContainment(d.from, d.to, "rule", loc, { law: law.id, part: 0 })
						)
					case "judged":
						return judgedPlan(law, discharge.rule)
				}
			}
		}
	}

	/**
	 * A containment of an open relation's side into a closed relation's: a lone closed-id field contained in its own
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
		const roster = rosterDischarged(d, toRel, toSelection)
		if (roster !== undefined) {
			return [{ kind: "RosterDomain", name: roster }]
		}
		const side = defined(
			this.#closedSides.byKey.get(closedSideKey(toRel, toFields, toSelection)),
			"the side of a containment into a closed relation, built once for every law that reads it"
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

	/**
	 * A containment from one side into another: a foreign key MATCH SIMPLE from the source's columns into the target's
	 * (`#reference`), the UNIQUE over the target's columns it references, the law columns either side reads, and the index
	 * over the source's columns. A fixed target referenced at its fixed fields too is met by constant law columns and by
	 * the source's own columns listed again, so the index over its columns alone serves every probe. Its deferral is the
	 * schema-wide rule's for a stated containment, and deferred for a part of a lowered rule over a query, which its
	 * triggers judged at COMMIT.
	 */
	#scalarContainment(
		from: ResolvedSide,
		to: ResolvedSide,
		deferral: "rule" | "deferred",
		loc: SourceLoc,
		part: PartRef
	): ReadonlyArray<NativePlan> {
		const fromRel = tableOf(from.rel)
		const toRel = tableOf(to.rel)
		const sourceColumns = sideColumns(from)
		const reference = this.#reference(to, sourceColumns, fromRel, toRel, loc, part)
		const containment = `the containment of ${sideText(from)} in ${sideText(to)}`
		return [
			...lawColumns(reference.columns),
			...lawColumns(reference.targetColumns),
			...this.#targetUnique(toRel, reference.targetColumns, containment, loc),
			{
				kind: "ForeignKey",
				relation: fromRel,
				columns: reference.columns,
				target: toRel,
				targetColumns: reference.targetColumns,
				onUpdate: "noAction",
				deferral,
				laws: undefined,
				reverse: plannedReverse(
					this.keys,
					sourceColumns,
					`the index of ${fromRel.name} over the columns ${containment} references from`,
					loc
				)
			}
		]
	}

	/**
	 * The UNIQUE a reference into `columns` of `r` needs, `containment` the law that references it: none where their
	 * KeyColumnSet is a declared scalar key's, whose own key law installs it, else a generated one, whose entry is
	 * bounded as a key's is. A generated one over a KeyColumnSet another plan states is that one key (model.ts
	 * nativeIdentity).
	 */
	#targetUnique(
		r: RelationInfo,
		columns: NonEmptyReadonlyArray<PlannedColumn>,
		containment: string,
		loc: SourceLoc
	): ReadonlyArray<NativePlan> {
		const fields = columns.flatMap((c): ReadonlyArray<NativeColumn> =>
			c.kind === "field" ? [c] : []
		)
		const declared =
			isNonEmpty(fields) &&
			fields.length === columns.length &&
			declaredKeyOf(r, scalarKeySet(r.name, fields)) !== undefined
		if (declared) {
			return []
		}
		judgeEntry(this.keys, columns, `the UNIQUE of ${r.name} ${containment} references`, loc)
		return [{ kind: "Unique", relation: r, columns }]
	}

	/**
	 * How the part `part` references its target, a target a key of its relation holds apart (`keyHolds`), into a UNIQUE
	 * that key implies: a fixed target (`fixedTargetOf`) at its terms and fixed fields where the whole schema's choice
	 * takes that shared UNIQUE for the part (`references`), else at its own columns, which the key holding it implies
	 * too, since its selection holds the key's and fixes each of the key's fields beyond its terms, or its terms hold
	 * the key's. A target no key holds is refused, a containment the judge does not hold whole: no UNIQUE the law model
	 * may add holds it apart.
	 */
	#reference(
		to: ResolvedSide,
		source: NonEmptyReadonlyArray<PlannedColumn>,
		fromRel: RelationInfo,
		toRel: RelationInfo,
		loc: SourceLoc,
		part: PartRef
	): Reference {
		if (!keyHolds(this.#projectedKeys, to)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`a containment into a side that contains a key of ${toRel.name}, or one the rule judge holds: unit-local, over immutable relations, its sides of field terms selected by comparisons; ${to.relation}(${to.terms.map(termText).join(", ")}) contains no key among its terms and the fields its selection fixes, over a selection within its own, and the containment is not unit-local`
			)
		}
		const fixed = fixedTargetOf(this.#projectedKeys, to, source, fromRel, toRel)
		return fixed !== undefined && takesShared(this.references, part)
			? fixed
			: { columns: source, targetColumns: sideColumns(to) }
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
		const sourceSpan = defined(sourceColumns[at], "a coverage source's span column")
		const targetSpan = defined(targetColumns[at], "a coverage target's span column")
		const sourceScalars = sourceColumns.filter((_, i) => i !== at)
		const targetScalars = targetColumns.filter((_, i) => i !== at)
		if (!isNonEmpty(sourceScalars) || !isNonEmpty(targetScalars)) {
			return refuse(
				"UnsupportedLawFamily",
				loc,
				`coverage grouped by at least one scalar field; ${from.relation} into ${to.relation} pairs only spans, an ungrouped span law`
			)
		}
		const toKey = spanKeySet(
			toRel.name,
			to.terms.flatMap((t) => (t.column === pairing.to ? [] : [fieldColumn(t.column)])),
			fieldColumn(pairing.to)
		)
		const declared =
			to.selection.conjuncts.length === 0 &&
			to.terms.every((t) => t.kind === "field") &&
			declaredKeyOf(toRel, toKey) !== undefined
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
				targetSpan,
				reverse: plannedPeriodReverse(
					this.keys,
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
		return defined(
			this.#foldLaws.get(key)?.get(fold),
			`the law of fold ${fold} of the family ${key}`
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
	 * A family's natives, planned once:
	 *
	 * - its columns: the index, a field when ordered and a drawn ‹i› when counted; the drawn ‹n› on each member; ‹p›,
	 *   the generated pred of the index; ‹pn›, the generated pred of the count on the owner; and for a tree ‹parent₀›,
	 *   its parent where its start is above 0, the one guarded group column, after its root fields. One guarded column
	 *   per side is exact: MATCH SIMPLE and UNIQUE NULLS DISTINCT both pass over a row with any null column;
	 * - its key, `UNIQUE (g…, i)` over its planned group, and its bound `CHECK (i < ‹n›)`, with `‹i› >= 0` beside it for
	 *   a counted index, which as a law column has no natural domain to keep it there;
	 * - its successor key, `UNIQUE (g…, ‹p›)`: each member is the predecessor of at most one, as its key implies, ‹p›
	 *   being the index's pred, NULL at slot 0. It states that law, and its index serves the predecessor axis's reverse
	 *   probe, which binds its every column;
	 * - its three axes (`#axis`), each carrying its pairs: the former's (a tree's interval copies, a fold's
	 *   accumulators) and every containment's that rides it;
	 * - every base pin of a carried copy, the copy's first law's: `i > 0 OR f = s` on a predecessor copy, `n > 0 OR
	 *   f = s` on a last copy and `start > 0 OR f = s` on a tree's owner copy, `s` the copy's start: an accumulated
	 *   field's, or a hidden accumulator's identity;
	 * - a tree's owner axis from its guarded group, (r…, ‹parent₀›) into its primary key (r…, start), so it names each
	 *   member's parent and no root, which is its axis's base: a root's copies are their starts, by their pins, and its
	 *   ‹n› its own count, by the tree's CHECK; with no action: PostgreSQL refuses a cascade over a generated column
	 *   (42601), and a tree is written whole and rewritten by deletion;
	 * - for a tree, the CHECK of the family bound, T2, the root pin (each root, outside the family, holds `at = 0`), T3
	 *   and T6; its primary key (r…, start) is T1;
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
		const family = defined(this.#families.get(key), `the family ${key}, which the theory resolved`)
		const law = defined(this.#familyLaws.get(key), `the law of the family ${key}`)
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
	f.shape.kind === "tree"
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

/** A fold's accumulator an axis carries: the column, its fold and plane, and whether it is the step's before or after. */
/** What a fold refused for its running value declares to fix it (KeyFault `foldAccumulator`). */
type FoldBound = Extract<KeyFault, { readonly kind: "foldAccumulator" }>["bound"]

interface CarriedAccumulator {
	readonly column: PlannedColumn
	readonly fold: FamilyFold
	/** The fold's number among its family's folds, which names its law. */
	readonly at: number
	readonly plane: FoldPlane
	readonly side: "before" | "after"
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
	/** The recognizer's ledger, each index the family plans judged into it (`judge`). */
	readonly #keys: KeyLedger

	constructor(recognizer: Recognizer, family: Family, law: TheoryLaw, loc: SourceLoc) {
		this.#recognizer = recognizer
		this.#keys = recognizer.keys
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
		const tree = f.shape.kind === "tree" ? f.shape : undefined
		const copy = lawColumn(
			this.#draw(f.copy, member, f.count, { kind: "copy", family: f.id }, this.#familyNamed("copy"))
		)
		const index: PlannedColumn =
			f.shape.index.kind === "field"
				? fieldColumn(f.shape.index.field)
				: lawColumn(
						this.#draw(
							f.shape.index.column,
							member,
							f.count,
							{ kind: "index", family: f.id },
							this.#familyNamed("index")
						)
					)
		const folds = f.folds.map((fold, i) => this.#foldColumns(fold, i))
		const group: NonEmptyReadonlyArray<PlannedColumn> =
			tree === undefined
				? mapNonEmpty(f.group, (g) => fieldColumn(g.member))
				: appendNonEmpty(
						tree.root.map(fieldColumn),
						lawColumn({
							kind: "term",
							relation: member,
							term: { kind: "field", field: tree.parent.name, column: tree.parent },
							selection: this.#members(tree.start)
						})
					)
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
						named: { kind: "predecessor", owner: f.id.owner, count: f.id.count, family: f.law },
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
		const successorKey = appendNonEmpty(group, pred)
		const lastBase = appendNonEmpty(ownerKey, lastPred)
		const ownerTargets = appendNonEmpty(ownerKey, fieldColumn(f.count))
		const carried = {
			owner: this.#carried("owner", f.axes.owner, extendNonEmpty(group, [copy]), ownerTargets),
			predecessor: this.#carried("predecessor", f.axes.predecessor, successorKey, familyKeyColumns),
			last: this.#carried("last", f.axes.last, lastBase, familyKeyColumns)
		}
		const ownerTargetColumns = extendNonEmpty(
			ownerTargets,
			carried.owner.map((p) => p.to)
		)
		const memberGroup = mapNonEmpty(f.group, (g) => fieldColumn(g.member))
		const axes: FamilyPlan["axes"] = {
			owner:
				tree === undefined
					? this.#axis(
							"owner",
							carried.owner,
							{ relation: member, base: extendNonEmpty(group, [copy]), keyed: memberGroup },
							{ relation: owner, base: ownerTargets },
							"cascade",
							this.#recognizer.refillDeferred("owner", f) ||
								this.#recognizer.cascadeFed(owner, ownerTargetColumns)
								? "deferred"
								: "cycle"
						)
					: this.#axis(
							"owner",
							carried.owner,
							{ relation: member, base: appendNonEmpty(group, copy), keyed: group },
							{ relation: owner, base: ownerTargets },
							"noAction",
							this.#recognizer.refillDeferred("owner", f) ? "deferred" : "immediate"
						),
			predecessor: this.#axis(
				"predecessor",
				carried.predecessor,
				{ relation: member, base: successorKey, keyed: successorKey },
				{ relation: member, base: familyKeyColumns },
				"noAction",
				index.kind === "field" && !this.#recognizer.refillDeferred("predecessor", f)
					? "immediate"
					: "deferred"
			),
			last: this.#axis(
				"last",
				carried.last,
				{ relation: owner, base: lastBase, keyed: lastBase },
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
		} else {
			this.#treeConditions(own, tree, index, copy)
		}
		for (const kind of ["owner", "predecessor", "last"] as const) {
			for (const p of carried[kind]) {
				this.#pin(kind, p, index)
			}
		}
		for (const [i, fold] of f.folds.entries()) {
			this.#combine(fold, i)
		}

		judgeEntry(
			this.#keys,
			familyKeyColumns,
			`the UNIQUE of ${member.name} that ${familyText(this.#shape())} numbers its members by`,
			this.#loc
		)
		judgeEntry(
			this.#keys,
			successorKey,
			`the UNIQUE of ${member.name} that holds each member of ${familyText(this.#shape())} the predecessor of at most one`,
			this.#loc
		)
		const natives: ReadonlyArray<NativePlan> = [
			...lawColumns([copy, index, pred, ...group, lastPred]),
			{ kind: "Unique", relation: member, columns: familyKeyColumns },
			{ kind: "Unique", relation: member, columns: successorKey },
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
	#familyNamed(kind: "copy" | "index"): DrawnStatement {
		const { id, law } = this.#family
		return { kind, owner: id.owner, count: id.count, family: law }
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
					{
						kind,
						owner: id.owner,
						count: id.count,
						family: this.#family.law,
						fold: law,
						plane: index
					}
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

	/** The first of `columns` that is a fold's accumulator, with its fold, plane and side; none where they carry none. */
	#foldCarried(columns: ReadonlyArray<PlannedColumn>): CarriedAccumulator | undefined {
		for (const [at, fold] of this.#family.folds.entries()) {
			for (const plane of fold.planes) {
				for (const side of ["before", "after"] as const) {
					const native = plane[side]
					const column = columns.find((c) =>
						native.kind === "field"
							? c.kind === "field" && c.field.name === native.field.name
							: c.kind === "law" &&
								c.column.kind === "drawn" &&
								c.column.draws.kind === side &&
								c.column.draws.fold === at
					)
					if (column !== undefined) {
						return { column, fold, at, plane, side }
					}
				}
			}
		}
		return undefined
	}

	/**
	 * The refusal of the fold `carried` is an accumulator of, where its axes' UNIQUE over `columns` fits but for that
	 * accumulator, a numeric of no precision or a text whose bound passes what the entry leaves it: the author declares
	 * the fold, never the UNIQUE grizzle keys its running values by, so the refusal names the fold, at the fold's own
	 * statement whichever law planned the family first, the field it steps and the bound its fields declare (KeyFault
	 * `foldAccumulator`): a numeric's precision, or a text's byte bound of at most the bytes a text holds beside the axes'
	 * other columns (textRoomBeside), or its digests' carriage, in place of the UNIQUE's own. None where the entry fits,
	 * or where columns overfill it without the accumulator, a text's header among them, or for an accumulator of any
	 * other carrier, each the UNIQUE's own refusal (`judgeEntry`).
	 */
	#unboundedFold(
		carried: CarriedAccumulator,
		columns: ReadonlyArray<PlannedColumn>
	): KeyRefusal | undefined {
		const entryOf = (of: ReadonlyArray<PlannedColumn>): ReadonlyArray<EntryColumn> =>
			of.flatMap((c) => {
				const datum = plannedDatum(c)
				return datum === undefined ? [] : [entryColumn(c, datum)]
			})
		const others = columns.filter((c) => c !== carried.column)
		const rest = entryOf(others)
		if (rest.length < others.length || btreeEntryBytes(rest) > btreeMaxItemSize) {
			return undefined
		}
		const datum = plannedDatum(carried.column)
		const bytes = btreeEntryBytes(entryOf(columns))
		if (datum !== undefined && bytes <= btreeMaxItemSize) {
			return undefined
		}
		const { fold, plane } = carried
		const bound = ((): FoldBound | undefined => {
			if (datum?.family === "numeric") {
				return { kind: "precision" }
			}
			if (datum !== undefined && datum.family !== "text") {
				return undefined
			}
			const largest = textRoomBeside(
				rest.map((c) => c.datum),
				rest.some((c) => c.nullable)
			)
			return largest < 0
				? undefined
				: {
						kind: "byteBound",
						largest,
						running: {
							before: plannedText(this.#planned(plane.before)),
							after: plannedText(this.#planned(plane.after)),
							end: plane.end.name
						}
					}
		})()
		if (bound === undefined) {
			return undefined
		}
		const stepped = fold.step.kind === "value" ? fold.step.field.name : undefined
		return {
			at: this.#recognizer.foldLaw(familyKey(this.#family.id), carried.at).law.loc,
			subject: `the ${fold.monoid} fold ${stepped === undefined ? "" : `of ${this.#member.name}.${stepped} `}into ${this.#owner.name}.${plane.end.name}`,
			key: [stepped ?? plane.end.name],
			fault: {
				kind: "foldAccumulator",
				accumulator: plannedText(carried.column),
				bytes: datum === undefined ? undefined : bytes,
				limit: btreeMaxItemSize,
				bound
			}
		}
	}

	/** The family as its refusals describe it. */
	#shape() {
		return { ...this.#family, owner: this.#owner, member: this.#member }
	}

	/**
	 * The pairs `axis` carries beyond its key columns `base` → `targetBase`, each once, in their axis's order
	 * (analysis/theory/families.ts PairRank), which reads their target columns' places alike on every axis, so two axes
	 * carrying one set reference one UNIQUE, and no name, so a rename keeps it. A pair that repeats a key column is the
	 * key itself; a target column carried twice, or a key column carried from another source, is refused: a reference
	 * names each referenced column once.
	 */
	#carried(
		axis: AxisKind,
		pairs: ReadonlyArray<AxisPair>,
		base: NonEmptyReadonlyArray<PlannedColumn>,
		targetBase: NonEmptyReadonlyArray<PlannedColumn>
	): ReadonlyArray<CarriedPair> {
		const textOf = plannedText
		const carriedKey = (c: PlannedColumn): string =>
			`${c.kind === "field" ? "f" : "l"} ${textOf(c)}`
		const baseKeys = base.map(carriedKey)
		const targetKeys = targetBase.map(carriedKey)
		const out: Array<CarriedPair> = []
		for (const p of pairs) {
			const native = this.#carrier(axis, p)
			const from = this.#planned(native.from)
			const to = this.#planned(native.to)
			const fromKey = carriedKey(from)
			const toKey = carriedKey(to)
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
			out.push({ from, to, fromKey, toKey, laws: p.laws, pinned: this.#planned(p.from) })
		}
		return out
	}

	/**
	 * The columns `axis` pairs for the pair `p`: its own, or, where `p` is a fold plane's copy whose axes carry its
	 * running values by their SHA-256 digests (ir/family.ts FoldCarrier), those digests: a member's before's to its
	 * predecessor's after's on the predecessor axis, the owner's end's to its last member's after's on the last axis.
	 */
	#carrier(
		axis: AxisKind,
		p: AxisPair
	): { readonly from: NativeColumn; readonly to: NativeColumn } {
		for (const fold of this.#family.folds) {
			for (const plane of fold.planes) {
				const c = plane.carrier
				if (c.kind === "values" || !sameNativeColumn(p.to, plane.after)) {
					continue
				}
				if (axis === "predecessor" && sameNativeColumn(p.from, plane.before)) {
					return { from: fieldColumn(c.before), to: fieldColumn(c.after) }
				}
				if (axis === "last" && sameNativeColumn(p.from, fieldColumn(plane.end))) {
					return { from: fieldColumn(c.end), to: fieldColumn(c.after) }
				}
			}
		}
		return p
	}

	/**
	 * One axis's foreign key, its law columns and the UNIQUE over its target columns, which the foreign key references:
	 * a key like any declared one, so INDEX_MAX_KEYS bounds its columns and its B-tree entry must be representable for
	 * every value they admit (`plannedEntry`), or the axis is UnrepresentableKey, naming the fold whose accumulator it
	 * carries; PostgreSQL would refuse the write that outgrows it (54000). The foreign key carries the index of its
	 * reverse probe (`Reversed`), as every foreign key does, over its base's columns that pair with its target's key
	 * (`keyed`): the rows equal there reference one target row, and every column it carries beyond them is a copy of that
	 * row's, equal on all of them, so an index over the copies too would narrow nothing and could outgrow a B-tree entry.
	 * Deleting a family's members probes the predecessor axis once per member, and a tree's nodes the owner axis, each
	 * probe reading every member of the family, or node of the tree, without that index.
	 */
	#axis(
		kind: AxisKind,
		pairs: ReadonlyArray<CarriedPair>,
		source: {
			readonly relation: RelationInfo
			readonly base: NonEmptyReadonlyArray<PlannedColumn>
			/**
			 * The columns of its base that pair with a key of its target, the owner's primary key or the family key, so
			 * that the rows equal at them are exactly the rows that reference one target row: its reverse probe's index.
			 */
			readonly keyed: NonEmptyReadonlyArray<PlannedColumn>
		},
		target: {
			readonly relation: RelationInfo
			readonly base: NonEmptyReadonlyArray<PlannedColumn>
		},
		onUpdate: OnUpdate,
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
		if (targetColumns.length > indexMaxKeys) {
			return refuse(
				"UnsupportedLawFamily",
				this.#loc,
				`a family axis of at most ${indexMaxKeys} columns, which one UNIQUE holds (INDEX_MAX_KEYS); the ${kind} axis of ${familyText(this.#shape())} carries ${targetColumns.length}: carry fewer copies on it`
			)
		}
		const carried = this.#foldCarried(targetColumns)
		const fold = carried === undefined ? undefined : this.#unboundedFold(carried, targetColumns)
		if (fold === undefined) {
			judgeEntry(
				this.#keys,
				targetColumns,
				`the UNIQUE of ${target.relation.name} the ${kind} axis of ${familyText(this.#shape())} references${carried === undefined ? "" : `, which carries the ${carried.side} accumulator ${plannedText(carried.column)} of the ${carried.fold.monoid} fold into ${this.#owner.name}.${carried.plane.end.name}`}`,
				this.#loc
			)
		} else {
			this.#keys.refuse(fold)
		}
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
				laws: [own, ...laws],
				reverse: plannedReverse(
					this.#keys,
					source.keyed,
					`the index of ${source.relation.name} over the columns the ${kind} axis of ${familyText(this.#shape())} references its target's key from`,
					this.#loc
				)
			},
			natives: [
				...lawColumns(columns),
				...lawColumns(targetColumns),
				{ kind: "Unique", relation: target.relation, columns: targetColumns }
			]
		}
	}

	/** The row conditions `law` states on `relation`, gathered into its one CHECK there. */
	#conditionsFor(law: LawId, relation: RelationInfo): RowConditions {
		const own = this.#conditions.getOrInsertComputed(law, () => new Map<string, RowConditions>())
		const known = own.get(relation.name)
		if (known !== undefined) {
			return known
		}
		const made = new RowConditions(relation)
		own.set(relation.name, made)
		return made
	}

	/**
	 * A tree's own CHECK conjuncts on its relation: the family bound, T2, the root pin, T3 and T6, each over its row,
	 * its parent the parent's start that the owner axis proves.
	 */
	#treeConditions(
		own: RowConditions,
		tree: TreeMembers,
		index: PlannedColumn,
		copy: PlannedColumn
	): void {
		const field = (f: LawField): ExprDesc => own.column(fieldColumn(f))
		const start = field(tree.start)
		const end = field(tree.end)
		const parent = field(tree.parent)
		const at = own.column(index)
		const n = own.column(copy)
		const children = field(this.#family.count)
		const zero = naturalLiteral(0n)
		const one = naturalLiteral(1n)
		const plus = (x: ExprDesc): ExprDesc => ({ kind: "compute", fn: "add", args: [x, one] })
		own.add(or([cmp("eq", start, zero), cmp("lt", at, n)]))
		own.add(or([cmp("gt", start, zero), cmp("eq", n, children)]))
		own.add(
			or([
				and([cmp("eq", parent, start), cmp("eq", start, zero)]),
				and([cmp("ne", parent, start), cmp("gt", start, zero)])
			])
		)
		own.add(or([cmp("gt", start, zero), cmp("eq", at, zero)]))
		own.add(or([cmp("eq", start, zero), cmp("gt", at, zero), cmp("eq", start, plus(parent))]))
		own.add(
			and([cmp("gt", end, start), or([cmp("gt", children, zero), cmp("eq", end, plus(start))])])
		)
	}

	/**
	 * The base pin of a carried copy, where its source has a start: on its axis's source relation, under the copy's
	 * first law, `at > 0 OR f = s` (predecessor, the index at its first slot, a tree's root included, which the root
	 * pin holds at slot 0), `n > 0 OR f = s` (last, an empty family) or `start > 0 OR f = s` (a tree's owner axis, its
	 * root, which the axis's foreign key leaves out). Any other owner axis has no base: every member has an owner.
	 */
	#pin(axis: AxisKind, pair: CarriedPair, index: PlannedColumn): void {
		const start = this.#startOf(pair.pinned)
		const shape = this.#family.shape
		const at = ((): PlannedColumn | undefined => {
			switch (axis) {
				case "predecessor":
					return index
				case "last":
					return fieldColumn(this.#family.count)
				case "owner":
					return shape.kind === "tree" ? fieldColumn(shape.start) : undefined
			}
		})()
		if (start === undefined || at === undefined) {
			return
		}
		const relation = axis === "last" ? this.#owner : this.#member
		const conditions = this.#conditionsFor(pair.laws[0], relation)
		conditions.add(
			or([
				cmp("gt", conditions.column(at), naturalLiteral(0n)),
				cmp("eq", conditions.column(pair.pinned), conditions.literal(start.start, start.type))
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
		const plane = defined(
			this.#family.folds[column.draws.fold]?.planes[column.draws.plane],
			`plane ${column.draws.plane} of fold ${column.draws.fold}, a drawn column of its own family`
		)
		return { start: plane.identity, type: plane.end.type }
	}

	/**
	 * A fold's combine CHECK on the member, under the fold's law: every plane's after is `combine(befores, x)` where the
	 * step side's selection holds, and its before where it does not, compared in exact arithmetic. The selection holds
	 * only where it is true: `CASE WHEN φ THEN after = combine ELSE after = before END`, so a member a closed read at an
	 * absent key leaves unknown is off the step side, as a law column's `CASE WHEN φ` and the host's fill read it.
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
		const combined = combine(monoidSpecs[fold.monoid], befores, step, combineBuild)
		const stepped = and(
			mapNonEmpty(afters, (a, p) => cmp("eq", a, defined(combined[p], "a combine per plane")))
		)
		const where = detail.step.selection.conjuncts.map((c) => c.predicate)
		if (!isNonEmpty(where)) {
			conditions.add(stepped)
			return
		}
		conditions.add({
			kind: "cond",
			pred: and(where),
			onTrue: stepped,
			onFalse: and(
				mapNonEmpty(afters, (a, p) => cmp("eq", a, defined(befores[p], "a before per plane")))
			)
		})
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
			return `indexPred ${c.named.owner}.${c.named.count}`
	}
}
