import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import type { DagTemplates } from "#compiler/ir/dag-digest.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { FilledRows, LogicalQuery, PageFill, ParamDecl } from "#compiler/ir/products.ts"
import type {
	CompletedOrder,
	DeltaSide,
	Heading,
	RelNode,
	TakeBound,
	ValidDag
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { StatementRole, StatementRoots, StatementTree } from "#compiler/runtime/lower/tree.ts"
import type {
	ArrayCheck,
	ColumnDefinition,
	Cte,
	EmittedSql,
	Expr,
	FromItem,
	FromSource,
	ObjectName,
	Select,
	TypeRef,
	ValuePlaceholder
} from "#compiler/sql/ast.ts"
import type { CarrierName, NameSupply, NameSupplyStart } from "#compiler/sql/naming.ts"

/** One field of a delta's heading and the column of its relation (DeltaRelation) that holds it. */
export interface DeltaColumn {
	readonly field: string
	readonly column: string
}

/**
 * The relation a Delta node reads, each field of its relation's delta heading with the column that holds it, so a Delta
 * node reads the fields it delivers, whichever of them pruning leaves it (lower/optimize/prune). In a read-back: a CTE
 * of the statement the read-back rides, over the rows that statement's RETURNING returns (write/readback/deltas.ts
 * deltaCte); a carrier, read through its reader, every column of its table in `table`'s order: the one the statement
 * making the side whole fills from its RETURNING for a read-back after the last stratum (write/readback/deltas.ts
 * carriedFill), or the write oracle's conservative realization's, filled by comparing the states before and after the
 * change (test/support/oracle/write/realize.ts); or the empty relation, a side of a delta no statement makes. In a rule
 * probe over its region: a CTE named by the session's delta of the relation's side, a table of pg_temp that the
 * relation's rule captures fill, which the judge reads each read of through the reader of the selection the statement
 * reads it under (physical/ddl/deltas.ts headed); or, in a rule's check over every row,
 * the relation's own table, every row of which the transaction that writes every row adds (physical/ddl/rules.ts
 * everyRow), beside the empty relation it removes.
 */
export type DeltaRelation =
	| { readonly kind: "cte"; readonly cte: string; readonly columns: ReadonlyArray<DeltaColumn> }
	| {
			readonly kind: "carrier"
			readonly carrier: CarrierName
			readonly table: ReadonlyArray<string>
			readonly columns: ReadonlyArray<DeltaColumn>
	  }
	| {
			readonly kind: "table"
			readonly table: ObjectName
			readonly columns: ReadonlyArray<DeltaColumn>
	  }
	| { readonly kind: "empty" }

/**
 * One breach of an attachment's delivered type a statement detects: each row of `from` that `when` holds of is a parent
 * key, `key`, at which the attachment delivered as `delivered` has another count of children.
 */
export interface DeliveredBreach {
	readonly from: FromItem
	readonly when: Expr
	readonly delivered: "one" | "option"
	readonly key: ReadonlyArray<{
		readonly field: string
		readonly expr: Expr
		readonly type: ScalarType
	}>
}

/**
 * The CTE and the guard through which a statement raises the first of its breaches inside itself, the guard false
 * exactly when one raises (write/refusal.ts breachGuard).
 */
export type BreachGuard = (
	supply: NameSupply,
	breaches: readonly [DeliveredBreach, ...ReadonlyArray<DeliveredBreach>]
) => { readonly cte: Cte; readonly guard: Expr }

/**
 * What lowering a read-back adds to lowering a query: the relations its Delta nodes read, the guard each statement
 * delivering an attachment as a bare child or an option checks that type through, inside the statement, and how its
 * statements are named. A read-back runs in its write's one flight, whose COMMIT goes before the host decodes a row, so
 * a breach the host found would surface only after the write committed; raised by the statement, it aborts the write
 * instead.
 */
export interface ReadBackLowering {
	readonly kind: "readBack"
	readonly deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined
	/** Where its InputSets of the relation parameters its ChangeSet binds to queries read their rows (BoundCarrier). */
	readonly bound: BoundCarrierOf
	readonly breach: BreachGuard
	/**
	 * Where its first statement's names start: r1 and c1 for a statement of its own (sql/naming.ts freshNames), and past
	 * every name a write statement defines for a read-back riding it as a part, so no name is defined twice in that
	 * statement. Each later statement names past the one before (context.ts beginStatement).
	 */
	readonly start: NameSupplyStart
	/** The templates of its write's compile, which its keys and digests read (WriteLowering `templates`). */
	readonly templates: DagTemplates
}

/**
 * What lowering a write program's members adds to lowering a query: the store of the templates every key and digest of
 * its compile reads (ir/dag-digest.ts DagTemplates), its share planning's, its own and its read-backs' (ReadBackLowering
 * `templates`), each node's written once for all of them (write/program/compile.ts compileAt).
 */
interface WriteLowering {
	readonly kind: "write"
	readonly templates: DagTemplates
	/** Where its InputSets of the relation parameters its ChangeSet binds to queries read their rows (BoundCarrier). */
	readonly bound: BoundCarrierOf
}

/**
 * Where an InputSet of a relation parameter its ChangeSet binds to a query (ir/rel.ts InputSetInput `bound`) reads its
 * rows: the write program's carrier its call fills once before the first stratum of the part that bound it, scanned
 * under an alias by the
 * carrier's own reading (write/carriers carrierScan), and the carrier's column of each field of the parameter's heading.
 */
export interface BoundCarrier {
	/** The carrier's name, which a read-back's kept lowering keys its surroundings by. */
	readonly carrier: CarrierName
	readonly scan: (alias: string) => FromSource
	readonly column: (field: string) => string
}

/** The carrier of each relation parameter a write's ChangeSet binds to a query, by the parameter, none for another. */
export type BoundCarrierOf = (param: ParamId) => BoundCarrier | undefined

/**
 * What lowering a rule probe over its region adds to lowering a query (analysis/theory/query.ts regionProbe): the
 * relation each of its Delta nodes reads, a CTE named by the session's delta of that relation's side, each read of which
 * the judge reads through a reader of the delta (physical/ddl/deltas.ts headed), where the rows the transaction wrote
 * of it stand as their images after each
 * statement (`added`) and before it (`removed`).
 */
export interface RegionLowering {
	readonly kind: "ruleRegion"
	readonly deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined
}

/**
 * What lowering a write filter's membership adds to lowering a query: the value of each field of the row it is asked
 * at, by the field's name, as the membership's caller names it (write/entry/render.ts): a stored row's column, a filter
 * function's argument, or a precheck's submitted value. The row's InputSet lowers to the one-row VALUES of them.
 */
export interface MembershipLowering {
	readonly kind: "membership"
	readonly row: (field: string) => Expr
}

/**
 * What a conservative lowering lowers: a query, which reads no delta (a Delta node in one is UnsupportedOperation), as a
 * derived relation's definition does; a write program's members (`write`), queries whose roots' rows are the facts
 * the write states (check/checker.ts RowsOf), so every boundary on a member's fact spine is a set of facts by their
 * identity (context.ts factSpine, LowerContext.setOf); a rule's probe over its region (physical/ddl/rules.ts), which
 * reads the session's delta of its relation (RegionLowering) and no parameter; a write program's read-back; a
 * write filter's membership, which reads its row; or a law's full violation query, the migration's probe
 * (deploy/diff) of a law over closed relations alone, a query over declared values only, which types a text refinement
 * no `__text_` domain names (a contract's base pattern no stored column carries) as text, where any other query refuses
 * it.
 */
type ConservativeSubject =
	| { readonly kind: "query" }
	| WriteLowering
	| RegionLowering
	| { readonly kind: "violationProbe" }
	| ReadBackLowering
	| MembershipLowering

/**
 * Whether a lowering judges a law: a law's full violation probe or a rule's probe over its region, whose rows the
 * database reads to judge the law and whose values its relations already hold. Its outputs are no claim to a reader
 * that trusts their refinements, as a query's, a read-back's and a membership's are, which the host decodes, so a
 * judgement casts no delivered value to its domain, and types a text refinement no `__text_` domain names by its base.
 */
export const judgesLaw = (subject: ConservativeSubject): boolean => {
	switch (subject.kind) {
		case "violationProbe":
		case "ruleRegion":
			return true
		case "query":
		case "write":
		case "readBack":
		case "membership":
			return false
	}
}

export interface ConservativeOptions {
	readonly names: PhysicalNames
	/** The declared parameters: a take or page bound parameter has the type its declaration gives. */
	readonly params: ReadonlyArray<ParamDecl>
	readonly subject: ConservativeSubject
}

/**
 * The DAG the conservative lowering reads and the root whose result it delivers: a query's root, or one read-back of a
 * write's DAG, which roots every read-back beside its sources.
 */
export interface ConservativeInput {
	/** Valid by construction, so every column reference it holds names a node in scope. */
	readonly dag: ValidDag
	readonly root: RelNode
}

/** The conservative input of a query: its DAG, delivering its root. */
export const conservativeInput = (query: Pick<LogicalQuery, "dag">): ConservativeInput => ({
	dag: query.dag,
	root: query.dag.roots[0]
})

/**
 * One column of a relation input: the heading column, the column of the input's arrays it travels as, given at
 * allocation, whose name is the column the input's rows deliver it under and whose type is its base type, the
 * element type of its array, and what checks its array as it is bound (sql/ast.ts ArrayCheck).
 */
export interface RelationColumn extends SlotColumn {
	readonly definition: ColumnDefinition
	readonly check: ArrayCheck
}

/** A relation input's column as its placeholder's encoder reads it: the column its arrays travel as, and its type. */
export interface SlotColumn {
	readonly name: string
	readonly type: ScalarType
}

/**
 * A placeholder as a served file holds it: each column of a relation input a SlotColumn, all its encoder reads
 * (runtime/lower/slots.ts), its definition left to the compile that allocated it.
 */
export type ServedSlot<S> = S extends { readonly columns: ReadonlyArray<RelationColumn> }
	? Omit<S, "columns"> & { readonly columns: ReadonlyArray<SlotColumn> }
	: S

/** A declared scalar parameter's placeholder, cast to `sqlType`: the base type for a comparison, the domain for a write or an emitted refined value. */
export interface ScalarParamSlot extends ValuePlaceholder {
	readonly kind: "scalar"
	readonly param: ParamId
	readonly type: ScalarType
	readonly sqlType: TypeRef
}

/**
 * Which array of a relation input one of its placeholders carries: the values of the input's column at `index`, one
 * per fact in the input's fact order; or, for an input of no column, its count of facts.
 */
export type ArrayPart =
	| { readonly kind: "column"; readonly index: number }
	| { readonly kind: "count" }

/**
 * One placeholder of a declared relation-valued parameter: one array of the input over `columns`, the columns every
 * placeholder of the parameter in its statement reads, in their order (sql/ast.ts ArraysSource). The placeholders of
 * one input in one statement are allocated together, one per column or one count, and share `columns`.
 */
export interface RelationParamSlot extends ValuePlaceholder {
	readonly kind: "relation"
	readonly param: ParamId
	readonly columns: ReadonlyArray<RelationColumn>
	readonly part: ArrayPart
}

/**
 * One placeholder of a write's enumerated member slot, one array of its facts over `columns`, as a relation
 * parameter's is; `relation` names the written relation an encoding refusal names.
 */
export interface MemberParamSlot extends ValuePlaceholder {
	readonly kind: "member"
	readonly slot: ParamId
	readonly relation: string
	readonly columns: ReadonlyArray<RelationColumn>
	readonly part: ArrayPart
}

/**
 * One placeholder of a stratum's host-filled rows of `relation` (ir/products.ts FilledRows), one array of the rows over
 * `columns`, their layout's columns, key first: the walk's nested rows' sent layout (nesting.ts sentLayout), or a fresh
 * fill's members' fresh layout (write/program/decide.ts freshLayoutOf).
 */
export interface NestedRowsParamSlot extends ValuePlaceholder {
	readonly kind: "nestedRows"
	readonly stratum: StratumAt
	readonly relation: StoredRelationName
	readonly rows: FilledRows
	readonly columns: ReadonlyArray<RelationColumn>
	readonly part: ArrayPart
}

/**
 * A placeholder the page request fills with one of `F`, cast where the page compiler places it
 * (lower/shapes/page/seek.ts CountSlot, BoundarySlots): a size or an offset to bigint, a boundary to its comparator's
 * base type. A plain request's statement holds size fills alone, so no binding of it reads a boundary or an offset.
 */
export interface PageParamSlot<F extends PageFill = PageFill> extends ValuePlaceholder {
	readonly kind: "page"
	readonly fill: F
}

/** A declared parameter's placeholder, which every lowering allocates: every placeholder of a query's statement. */
export type DeclaredParamSlot = ScalarParamSlot | RelationParamSlot

/** A placeholder only its own lowering allocates: a write statement's member slot or nested rows, a page statement's
 * fill. */
export type OwnParamSlot = MemberParamSlot | NestedRowsParamSlot | PageParamSlot

/** A placeholder of a relation input's arrays: a relation parameter's, a write's member slot's or its nested rows'. */
export type ArraySlot = RelationParamSlot | MemberParamSlot | NestedRowsParamSlot

/** The placeholders of a write statement: its declared parameters', its member slots' and its nested rows'. */
export type WriteParamSlot = DeclaredParamSlot | MemberParamSlot | NestedRowsParamSlot

/** The placeholders of a page statement: its declared parameters' and the page request's fills, each one of `F`. */
export type PageStatementSlot<F extends PageFill = PageFill> = DeclaredParamSlot | PageParamSlot<F>

/** What fills one placeholder $n of a statement of any lowering. */
export type ConservativeParamSlot = DeclaredParamSlot | OwnParamSlot

/** A lowered statement whose placeholders are of `Slot`: a query's declared parameters', a write's or a page's own besides. */
export interface ConservativeStatement<Slot extends ConservativeParamSlot = DeclaredParamSlot> {
	readonly role: StatementRole
	/** The AST, for post-processing; `sql` is its emission. */
	readonly ast: Select
	readonly sql: EmittedSql
	/** Its slots in number order: params[n - 1] is the slot of number n, which each placeholder $n of `ast` holds. */
	readonly params: ReadonlyArray<Slot>
	/**
	 * The heading of the relation the statement delivers, the rows or an attachment's child, whose columns are its
	 * output columns after the ones its role puts first (statementOutput). A zero-column relation, of no columns here,
	 * delivers one private boolean column `true` named __unit, one row for the unit tuple.
	 */
	readonly heading: Heading
}

/**
 * A program's statements in part order, the order its one statement holds them as parts (shapes/index.ts
 * partedConservative) and every part's position names: each delivered statement, then the attachment statements under
 * it, depth first in emission order.
 */
export const flight = <S>(roots: StatementRoots<S>): NonEmptyReadonlyArray<S> => {
	const [first, ...rest] = roots
	const out: [S, ...Array<S>] = [first.statement]
	const under = (tree: StatementTree<S>): void => {
		for (const attached of tree.attachments) {
			out.push(attached.statement)
			under(attached)
		}
	}
	under(first)
	for (const tree of rest) {
		out.push(tree.statement)
		under(tree)
	}
	return out
}

/**
 * A program's statements, its delivered ones each with the attachment statements under it.
 *
 * The conservative lowering's inputs and products.
 *
 * The conservative lowering is the oracle baseline: it deduplicates at every set boundary and uses no rewrite
 * certificate. Its product is a program of SQL statements, each kept as its AST beside the emitted text,
 * so the mutant suite can post-process the AST and reprint it, and the runner can execute the text and compare
 * raw text multisets. Codecs are not part of it: a statement says which parameter fills each placeholder and what its
 * output columns are, and the caller encodes and decodes.
 *
 * The physical names of relations, columns, domains and closed constants, and the installation's codes, come from the
 * caller through PhysicalNames, because the naming door (core/identity.ts) mints them and the snapshot records them.
 */
export interface ConservativeProgram<Slot extends ConservativeParamSlot = DeclaredParamSlot> {
	readonly roots: StatementRoots<ConservativeStatement<Slot>>
	readonly delivery: ProgramDelivery
}

/**
 * How the runtime combines the heading-group statements of a heterogeneous union: every group's facts, unordered; or
 * in `order`, which each group statement delivers its rows in. With a take, each group statement holds its first k
 * under `take`, the runtime merges the groups on `take` and keeps the first k overall, delivered in that order, or in
 * `order` where the query's order differs from the take's.
 */
export type GroupMerge =
	| { readonly kind: "concat" }
	| { readonly kind: "order"; readonly order: CompletedOrder }
	| { readonly kind: "take"; readonly bound: TakeBound; readonly take: CompletedOrder }
	| {
			readonly kind: "takeThenOrder"
			readonly bound: TakeBound
			readonly take: CompletedOrder
			readonly order: CompletedOrder
	  }

/**
 * How the runtime delivers a program's result: the rows of its one delivering statement, or the heading-group
 * statements of a heterogeneous union, which it merges; `heading` is the union's, the columns common to every group,
 * each of the one type every group delivers it as.
 */
export type ProgramDelivery =
	| { readonly kind: "rows" }
	| {
			readonly kind: "headingGroups"
			readonly discriminant: ReadonlyArray<string>
			readonly heading: Heading
			readonly merge: GroupMerge
	  }
