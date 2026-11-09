import type { ParamId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery, PageFill, ParamDecl } from "#compiler/ir/products.ts"
import type { CompletedOrder, Heading, RelNode, TakeBound, ValidDag } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { StatementRole, StatementRoots, StatementTree } from "#compiler/runtime/lower/tree.ts"
import type {
	ColumnDefinition,
	Cte,
	EmittedSql,
	Expr,
	FromItem,
	Select,
	TypeRef,
	ValuePlaceholder
} from "#compiler/sql/ast.ts"
import type { CarrierName, NameSupply } from "#compiler/sql/naming.ts"

/**
 * The SQL a Delta node reads in a read-back: the carrier the write program built, whose columns are the delta's
 * heading, position by position.
 */
export interface DeltaSource {
	readonly carrier: CarrierName
	readonly columns: ReadonlyArray<string>
}

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
 * What lowering a read-back adds to lowering a query: the relations its Delta nodes read, and the guard each statement
 * delivering an attachment as a bare child or an option checks that type through, inside the statement. A read-back
 * runs in its write's one flight, whose COMMIT goes before the host decodes a row, so a breach the host found would
 * surface only after the write committed; raised by the statement, it aborts the write instead.
 */
export interface ReadBackLowering {
	readonly kind: "readBack"
	readonly deltas: (relation: string, side: "added" | "removed") => DeltaSource | undefined
	readonly breach: BreachGuard
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
 * derived relation's definition does; a write program's read-back; a write filter's membership, which reads its row;
 * or a law's full violation query, the migration's probe (deploy/diff) of a law over closed relations alone, a query
 * over declared values only, which types a text refinement no `__text_` domain names (a contract's base pattern no
 * stored column carries) as text, where any other query refuses it.
 */
type ConservativeSubject =
	| { readonly kind: "query" }
	| { readonly kind: "violationProbe" }
	| ReadBackLowering
	| MembershipLowering

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
 * One column of a relation input: the heading column, and the column of the input's arrays it travels as, given at
 * allocation, whose name is the column the input's rows deliver it under and whose type is its base type, the
 * element type of its array.
 */
export interface RelationColumn {
	readonly name: string
	readonly type: ScalarType
	readonly definition: ColumnDefinition
}

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
 * One placeholder of a stratum's nested rows of `relation` (write/family/nesting.ts NestedRow), one array of the rows
 * over `columns`, the columns of the relation's row layout its nesting fills, key first (nesting.ts sentLayout).
 */
export interface NestedRowsParamSlot extends ValuePlaceholder {
	readonly kind: "nestedRows"
	readonly stratum: StratumAt
	readonly relation: string
	readonly columns: ReadonlyArray<RelationColumn>
	readonly part: ArrayPart
}

/**
 * A placeholder the page request fills with one of `F`, cast where the page compiler places it
 * (lower/shapes/page/seek.ts SizeSlots, BoundarySlots): a limit or a size to bigint, a boundary to its comparator's base
 * type. A plain request's statement holds size fills alone, so no binding of it reads a boundary.
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

export const noColumns: Heading = Object.freeze([])

/**
 * A statement's role and the statements of its program that must run first: none. An attachment recomputes its
 * parent's rows in its own statement (deliver.ts), so every statement of a query program goes in one flight; only a
 * write program's statements depend on earlier ones.
 */
export interface StatementPlacement {
	readonly role: StatementRole
	readonly dependsOn: readonly []
}

/** A lowered statement whose placeholders are of `Slot`: a query's declared parameters', a write's or a page's own besides. */
export interface ConservativeStatement<
	Slot extends ConservativeParamSlot = DeclaredParamSlot
> extends StatementPlacement {
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
 * A program's statements in flight order, the order the runtime sends them and every position names: each delivered
 * statement, then the attachment statements under it, depth first in emission order.
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
