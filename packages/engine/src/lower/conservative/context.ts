import { firstIndex } from "#compiler/core/array.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type NodeScope, nodeScopes, type OuterRefs } from "#compiler/ir/dag.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { Fold } from "#compiler/ir/fold.ts"
import { baseTypeRef as physicalBaseType, type PhysicalNames } from "#compiler/ir/physical.ts"
import {
	exprsOf,
	type Heading,
	inputsOf,
	type NodeOf,
	type RelKind,
	type RelNode,
	type TakeBound,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { contractOf, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type ArrayPart,
	type ArraySlot,
	type ConservativeOptions,
	type ConservativeParamSlot,
	type DeclaredParamSlot,
	type MemberParamSlot,
	type OwnParamSlot,
	type RelationColumn,
	type RelationParamSlot,
	type ScalarParamSlot,
	unitColumn
} from "#compiler/lower/conservative/types.ts"
import { typedEq } from "#compiler/lower/conservative/vector/equality.ts"
import type {
	ArraysSource,
	Cte,
	Expr,
	FromItem,
	FromSource,
	Select,
	Target,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	col,
	columnDefinition,
	conjunction,
	derived,
	distinctCore,
	lit,
	positionalValue,
	sameTypeRef,
	select,
	slotParam,
	target,
	types,
	unitTargets
} from "#compiler/sql/build.ts"
import { freshNames, type NameOrigin, NameSupply } from "#compiler/sql/naming.ts"

/** The SQL expressions of one node's columns, by heading name. */
export type ColumnMap = ReadonlyMap<string, Expr>
/** The nodes in scope and their columns. */
export type Env = ReadonlyMap<NodeId, ColumnMap>

export const emptyEnv: Env = new Map()

export const extendEnv = (env: Env, entries: Iterable<readonly [NodeId, ColumnMap]>): Env => {
	const next = new Map(env)
	for (const [id, columns] of entries) {
		next.set(id, columns)
	}
	return next
}

/**
 * One output column of a derived table or a CTE: the heading name it carries, paired at allocation with the fresh SQL
 * column it is read under.
 */
export interface NamedColumn {
	readonly name: string
	readonly column: string
}

/** The columns of a relation read under `alias` whose columns are `named`, by heading name. */
export const namedMap = (alias: string, named: ReadonlyArray<NamedColumn>): ColumnMap =>
	new Map(named.map(({ name, column }) => [name, col(alias, column)]))

/** One input read as a derived table: its FROM item, its alias and its columns. */
export interface InputSource {
	readonly item: FromSource
	readonly alias: string
	readonly columns: ReadonlyArray<string>
	readonly map: ColumnMap
}

/** Where a lowering step refuses: the step's label under conservative lowering. */
export const loweringAt = (at: string): SourceLoc => SourceLoc("conservative lowering", [at])

/** A refusal at `loc`, for a lowering a persistent expression shares (span and vector operators). */
export const refuseAt = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/** A refusal at the lowering step labelled `at`. */
export const refuse = (tag: ProseTag, at: string, capability: string): never =>
	refuseAt(tag, loweringAt(at), capability)

export const nodeLabel = (node: RelNode): string => `node ${node.id} (${node.kind})`

/**
 * The column `name` found in a heading, or in a column map the lowering built over one, that holds it: the one site of
 * the fact that every column a node of the valid DAG names (a binding, a correlation, an order, a key, a carried or
 * bound column) is a column of the heading it names it in (valid DAG). The DAG is data built before any lowering, and
 * each lowering mints its own SQL expression per column under its own fresh aliases, so a reference can never hold what
 * it is resolved to: it names a column, and what it reads is a runtime map from names to expressions. No TypeScript
 * type ties a runtime name to the key set of a runtime map, so an absent one is a defect.
 */
const namedColumn = <V>(found: V | undefined, name: string): V =>
	defined(found, `a column ${name} of the heading the valid DAG names it in`)

/** The column `name` of a column map the lowering built over a heading that holds it (namedColumn). */
export const columnIn = <V>(map: ReadonlyMap<string, V>, name: string): V =>
	namedColumn(map.get(name), name)

/** The inputs a node's query reads: an attachment is read as its parent, whose statement delivers the child (attach/). */
export const queryInputs = (node: RelNode): ReadonlyArray<RelNode> =>
	node.kind === "Attach" ? [node.parent] : inputsOf(node)

/**
 * The columns of a relation input of `heading`, each traveling as the array column `key` allocates (a membership's row
 * as a VALUES column of that name), of its base type `base` gives.
 */
export const relationColumns = (
	heading: Heading,
	key: () => string,
	base: (type: ScalarType) => TypeRef
): ReadonlyArray<RelationColumn> =>
	heading.map((c) => ({
		name: c.name,
		type: c.type,
		definition: columnDefinition(key(), base(c.type))
	}))

/**
 * The arrays one relation input over `columns` travels as, in placeholder order: one per column, or, for an input of no
 * column, its count of facts.
 */
const arrayParts = (columns: ReadonlyArray<RelationColumn>): NonEmptyReadonlyArray<ArrayPart> =>
	isNonEmpty(columns)
		? mapNonEmpty(columns, (_, index): ArrayPart => ({ kind: "column", index }))
		: [{ kind: "count" }]

/**
 * The arrays of a relation input as a FROM item reads them (sql/ast.ts ArraysSource), from its placeholders in part
 * order (`arrayParts`): each column's definition with its array's placeholder, or the count's.
 */
export const arraysSource = (slots: NonEmptyReadonlyArray<ArraySlot>): ArraysSource => {
	const columns = slots[0].columns
	if (!isNonEmpty(columns)) {
		return { kind: "count", count: positionalValue(slots[0].number) }
	}
	return {
		kind: "columns",
		columns: mapNonEmpty(columns, (column, index) => ({
			definition: column.definition,
			array: positionalValue(
				defined(slots[index], `the placeholder of column ${index} of a relation input`).number
			)
		}))
	}
}

/**
 * The placeholders of one statement, numbered from $1 in first-use order: its declared parameters', which every lowering
 * allocates, and those of `Own` only its own lowering allocates (a write's member slots, a page's fills). Each slot
 * carries its number, its position in `slots`, so a placeholder holding it prints it. Whoever begins a statement makes
 * its placeholders and hands the lowering their Placeholders view, so the statement it drains holds placeholders of
 * exactly the kinds its lowering can allocate.
 */
export class StatementParams<in out Own extends OwnParamSlot> {
	readonly #slots: Array<DeclaredParamSlot | Own> = []
	/** Each parameter's placeholders, one per cast type, found by the type's structure (sql/build.ts sameTypeRef). */
	readonly #scalars = new Map<
		ParamId,
		Array<{ readonly type: TypeRef; readonly slot: ScalarParamSlot }>
	>()
	readonly #relations = new Map<ParamId, NonEmptyReadonlyArray<RelationParamSlot>>()

	get slots(): ReadonlyArray<DeclaredParamSlot | Own> {
		return this.#slots
	}

	/** The slot `make` makes of the next number, appended. */
	#allocate<S extends DeclaredParamSlot | Own>(make: (number: number) => S): S {
		const slot = make(this.#slots.length + 1)
		this.#slots.push(slot)
		return slot
	}

	/** The slots of one relation input over `columns`, one per array (arrayParts), each `make` makes of its number and part. */
	protected allocateArrays<S extends DeclaredParamSlot | Own>(
		columns: ReadonlyArray<RelationColumn>,
		make: (number: number, part: ArrayPart) => S
	): NonEmptyReadonlyArray<S> {
		return mapNonEmpty(arrayParts(columns), (part) =>
			this.#allocate((number) => make(number, part))
		)
	}

	/** The scalar slot `slot` cast as `sqlType` in place of the type its first use gave it, at its number. */
	retype(slot: ScalarParamSlot, sqlType: TypeRef): ScalarParamSlot {
		const retyped = { ...slot, sqlType }
		this.#slots[slot.number - 1] = retyped
		return retyped
	}

	/**
	 * One placeholder per parameter and cast type: a parameter compared as its base and written as its domain is two
	 * placeholders, each always cast the same way (the kernel audit's param rule, test/support/oracle/verify/sql.ts).
	 */
	scalar(param: ParamId, type: ScalarType, sqlType: TypeRef): Expr {
		let casts = this.#scalars.get(param)
		if (casts === undefined) {
			casts = []
			this.#scalars.set(param, casts)
		}
		const found = casts.find((c) => sameTypeRef(c.type, sqlType))
		if (found !== undefined) {
			return slotParam(found.slot, sqlType)
		}
		const slot = this.#allocate((number): ScalarParamSlot => ({
			kind: "scalar",
			placeholder: "value",
			number,
			param,
			type,
			sqlType
		}))
		casts.push({ type: sqlType, slot })
		return slotParam(slot, sqlType)
	}

	/**
	 * The array placeholders of a relation parameter, one per column or its count, its columns those `allocate` gives at
	 * the first use: every read of it in the statement reads the same arrays.
	 */
	relation(
		param: ParamId,
		allocate: () => ReadonlyArray<RelationColumn>
	): NonEmptyReadonlyArray<RelationParamSlot> {
		const known = this.#relations.get(param)
		if (known !== undefined) {
			return known
		}
		const columns = allocate()
		const slots = this.allocateArrays(columns, (number, part): RelationParamSlot => ({
			kind: "relation",
			placeholder: "value",
			number,
			param,
			columns,
			part
		}))
		this.#relations.set(param, slots)
		return slots
	}

	/** A new placeholder of the lowering's own slot, which `make` makes of its number. */
	own<S extends Own>(make: (number: number) => S): S {
		return this.#allocate(make)
	}
}

/** The placeholders of one write statement: its declared parameters' and its member slots' arrays. */
export class WriteParams extends StatementParams<MemberParamSlot> {
	readonly #members = new Map<ParamId, NonEmptyReadonlyArray<MemberParamSlot>>()

	/**
	 * The array placeholders of an enumerated member slot of a write, one per column or its count, its columns those
	 * `allocate` gives at the first use.
	 */
	member(
		slot: ParamId,
		relation: string,
		allocate: () => ReadonlyArray<RelationColumn>
	): NonEmptyReadonlyArray<MemberParamSlot> {
		const known = this.#members.get(slot)
		if (known !== undefined) {
			return known
		}
		const columns = allocate()
		const slots = this.allocateArrays(columns, (number, part): MemberParamSlot => ({
			kind: "member",
			placeholder: "value",
			number,
			slot,
			relation,
			columns,
			part
		}))
		this.#members.set(slot, slots)
		return slots
	}
}

/**
 * What a lowering reads and allocates of the statement being lowered, whoever began it: its placeholders so far, as
 * any kind, and a declared parameter's placeholder.
 */
export interface Placeholders {
	readonly slots: ReadonlyArray<ConservativeParamSlot>
	readonly retype: (slot: ScalarParamSlot, sqlType: TypeRef) => ScalarParamSlot
	readonly scalar: (param: ParamId, type: ScalarType, sqlType: TypeRef) => Expr
	readonly relation: (
		param: ParamId,
		allocate: () => ReadonlyArray<RelationColumn>
	) => NonEmptyReadonlyArray<RelationParamSlot>
}

/**
 * The placeholders of the statement being lowered: a query's or a page's, whose own placeholders its caller allocates,
 * or a write's, whose member slots its InputSets read.
 */
type StatementPlaceholders =
	| { readonly kind: "query"; readonly params: Placeholders }
	| { readonly kind: "write"; readonly params: WriteParams }

/**
 * The feedback relation of a Recursive node being lowered: the recursive CTE its SelfRef reads, the subquery depth
 * its WITH RECURSIVE is lowered at, and how many scans of it the step has lowered so far. PostgreSQL admits one
 * self-reference in the recursive term, outside any subquery expression of it, so the SelfRef
 * plug-in refuses a second scan, or a scan deeper than its CTE, rather than emit SQL that fails with 42P19.
 */
interface Feedback {
	readonly cte: string
	readonly columns: ReadonlyArray<NamedColumn>
	readonly sublinkDepth: number
	reads: number
}

export type NodeDispatch = (node: RelNode, cx: LowerContext, env: Env) => Select

/** One kind's plug-in: its node to the query of its heading. */
export type NodeLowerer<K extends RelKind> = (node: NodeOf<K>, cx: LowerContext, env: Env) => Select

/**
 * The plug-ins of the kinds `K`, one per kind. Over every kind it is a kind table, so a kind the IR adds is a type
 * error until the table has its plug-in; a plug-in module exports its one-entry table, its lowerer staying private.
 */
export type Lowerers<K extends RelKind> = { readonly [P in K]: NodeLowerer<P> }

/**
 * What one lowering shares across every scope of it: the statement being lowered, whose names and placeholders a
 * statement accumulates and never crosses, and each node's outer references and scope as this lowering computed them,
 * the traversal's state for the life of the lowering. The scopes are a fold over the DAG, made at their first read.
 */
interface Shared {
	supply: NameSupply
	statement: StatementPlaceholders
	readonly free: Map<RelNode, OuterRefs>
	scopes: Fold<RelNode, NodeScope> | undefined
}

/**
 * A query of the conservative lowering whose WITH holds one MATERIALIZED CTE for each node in `shared`: the nodes its
 * lowering would otherwise lower more than once (dispatch.ts). Every use of such a node in the query reads its CTE, so
 * the node is lowered once, in the CTE's body, and a query's text grows with its DAG, not with the DAG's paths.
 *
 * A frame encloses the queries lowered inside its root's, and its CTEs are read from all of them. A CTE's body is
 * lowered where the frame's root was, in `cx` and `env`: the outer values it reads are bound outside the root, so they
 * are in scope at the root's WITH, and nothing lowered inside the root binds them anew.
 */
export interface ShareFrame {
	/** The frame the root was lowered in, whose CTEs the queries of this one read too. */
	readonly outer: ShareFrame | undefined
	readonly shared: ReadonlySet<RelNode>
	readonly cx: LowerContext
	readonly env: Env
	/** Each shared node's CTE, defined at its first use. */
	readonly defined: Map<RelNode, { readonly name: string; readonly columns: ReadonlyArray<string> }>
	/** The WITH entries, in definition order: each after every entry its body reads. */
	readonly ctes: Array<Cte>
}

/**
 * What the query being lowered is nested in: how many subquery expressions (EXISTS) enclose it, the feedback relations
 * of the recursions being lowered around it, and the dispatch its nodes lower through. A scope is extended for a
 * subtree, never changed and restored: PostgreSQL refuses a recursive reference inside a subquery expression of its own
 * recursive term (42P19), so a feedback scan lowered deeper than its recursive CTE is refused; a whole WITH RECURSIVE
 * inside EXISTS is fine.
 */
interface Scope {
	readonly sublinkDepth: number
	/** The feedback relation of each Recursive being lowered, by its label, the name its SelfRef holds. */
	readonly feedback: ReadonlyMap<NodeId, Feedback>
	readonly dispatch: NodeDispatch
	/** The innermost share frame the query is lowered in, if its dispatch shares (dispatch.ts). */
	readonly sharing: ShareFrame | undefined
}

/**
 * The state one conservative lowering threads through its per-kind plug-ins.
 *
 * Every node lowers to a query whose output columns are the node's heading, position by position (a zero-column
 * heading carries one private boolean `true`, so the unit tuple is a row). A consumer reads an input as a
 * derived table with a fresh r<n> alias and a fresh c<n> column list, so no generated name is ever
 * defined twice in a statement and every reference is qualified.
 *
 * A node holds its inputs and expressions themselves (ir/rel.ts), so a plug-in reads them as fields. Column references
 * in the IR name the node whose heading supplies the column by its label (ir/expr.ts). An environment maps the label
 * of each node in scope to the SQL expressions of its columns: a node's own expressions see its inputs, and a
 * correlated source also sees the outer nodes it names, which is what makes it LATERAL. A reference to a node outside
 * the environment is MalformedDescription: the IR promised a scope it does not have.
 *
 * Plug-ins report a refusal by throwing a Refusal (core/canonical.ts), which the entry point turns into a Result, so
 * the pass itself never throws.
 *
 * Set by the constructor, and by #within for an extended scope, which shares its lowering's state.
 */
export class LowerContext {
	readonly dag: ValidDag
	readonly options: ConservativeOptions
	readonly names: PhysicalNames
	#shared: Shared
	#scope: Scope

	constructor(dag: ValidDag, options: ConservativeOptions, dispatch: NodeDispatch) {
		this.dag = dag
		this.options = options
		this.names = options.names
		this.#shared = {
			supply: new NameSupply(freshNames),
			statement: { kind: "query", params: new StatementParams<never>() },
			free: new Map(),
			scopes: undefined
		}
		this.#scope = { sublinkDepth: 0, feedback: new Map(), dispatch, sharing: undefined }
	}

	/**
	 * This lowering in `scope`: the same statement and memo, so a subtree lowered in it allocates the statement's
	 * names and placeholders.
	 */
	#within(scope: Scope): LowerContext {
		const cx = new LowerContext(this.dag, this.options, scope.dispatch)
		cx.#shared = this.#shared
		cx.#scope = scope
		return cx
	}

	get supply(): NameSupply {
		return this.#shared.supply
	}

	get params(): Placeholders {
		return this.#shared.statement.params
	}

	/** The recursions being lowered around the query, by the Recursive's label. */
	get feedback(): ReadonlyMap<NodeId, Feedback> {
		return this.#scope.feedback
	}

	get sublinkDepth(): number {
		return this.#scope.sublinkDepth
	}

	/** The scope of a subquery expression (EXISTS) of the query being lowered. */
	inSublink(): LowerContext {
		return this.#within({ ...this.#scope, sublinkDepth: this.#scope.sublinkDepth + 1 })
	}

	/** The scope of a recursion's term, whose SelfRef scans `cte`, its columns paired with the state columns. */
	withFeedback(
		recursive: NodeOf<"Recursive">,
		cte: string,
		columns: ReadonlyArray<NamedColumn>
	): LowerContext {
		const feedback = new Map(this.#scope.feedback)
		feedback.set(recursive.id, { cte, columns, sublinkDepth: this.#scope.sublinkDepth, reads: 0 })
		return this.#within({ ...this.#scope, feedback })
	}

	/** The scope whose nodes lower through `dispatch`. */
	withDispatch(dispatch: NodeDispatch): LowerContext {
		return this.#within({ ...this.#scope, dispatch })
	}

	/** The innermost share frame the query being lowered is inside, undefined outside every frame. */
	get sharing(): ShareFrame | undefined {
		return this.#scope.sharing
	}

	/** The scope whose queries are lowered inside `frame`. */
	withSharing(frame: ShareFrame): LowerContext {
		return this.#within({ ...this.#scope, sharing: frame })
	}

	/**
	 * The next statement of a query or a page, its placeholders `params`, naming afresh; names and placeholders never
	 * cross statements.
	 */
	beginStatement(params: Placeholders): void {
		this.beginStatementWith(new NameSupply(freshNames), params)
	}

	/** The next statement of a query or a page, naming from `supply`, its placeholders `params`. */
	beginStatementWith(supply: NameSupply, params: Placeholders): void {
		this.#shared.supply = supply
		this.#shared.statement = { kind: "query", params }
	}

	/** The next statement of a write, naming from `supply`, its placeholders `params`, which its member slots read. */
	beginWriteStatement(supply: NameSupply, params: WriteParams): void {
		this.#shared.supply = supply
		this.#shared.statement = { kind: "write", params }
	}

	/**
	 * The array placeholders of the enumerated member slot `slot` of `relation`, its columns those `allocate` gives at
	 * the first use. A member slot is a write's: outside a write statement, which fills it, it is UnsupportedOperation,
	 * as a Delta outside a write program is.
	 */
	member(
		slot: ParamId,
		relation: string,
		allocate: () => ReadonlyArray<RelationColumn>,
		at: string
	): NonEmptyReadonlyArray<MemberParamSlot> {
		const statement = this.#shared.statement
		switch (statement.kind) {
			case "write":
				return statement.params.member(slot, relation, allocate)
			case "query":
				return refuse(
					"UnsupportedOperation",
					at,
					`the member slot ${slot} of ${relation} outside a write statement that fills it`
				)
		}
	}

	/**
	 * The value of each field of a write filter's membership row, by the field's name, as the membership's caller names
	 * it. A row is a membership's: outside the membership that names it, it is UnsupportedOperation, as a Delta outside
	 * a write program is.
	 */
	membershipRow(at: string): (field: string) => Expr {
		const subject = this.options.subject
		switch (subject.kind) {
			case "membership":
				return subject.row
			case "query":
			case "violationProbe":
			case "readBack":
				return refuse(
					"UnsupportedOperation",
					at,
					"a write filter's row outside the membership that names its values"
				)
		}
	}

	/** The query of a node, output columns in heading order, as the scope's dispatch lowers it. */
	lower(node: RelNode, env: Env): Select {
		return this.#scope.dispatch(node, this, env)
	}

	/**
	 * Whether lowering `node` would scan the working table of a Recursive being lowered: whether its inputs reach a
	 * SelfRef with an active feedback relation.
	 *
	 * The array iterator reads the length at every step, so the inputs pushed below are visited too.
	 */
	readsFeedback(node: RelNode): boolean {
		if (this.feedback.size === 0) {
			return false
		}
		const seen = new Set<RelNode>([node])
		const queue = [node]
		for (const queued of queue) {
			if (queued.kind === "SelfRef" && this.feedback.has(queued.recursive)) {
				return true
			}
			for (const input of inputsOf(queued)) {
				if (!seen.has(input)) {
					seen.add(input)
					queue.push(input)
				}
			}
		}
		return false
	}

	/**
	 * `left = right` for two values of `type`: over a vector, the extension's operator qualified by the installation's
	 * vector schema, which no role's search_path holds (vector/equality.ts); otherwise `=`. Every
	 * binding, constant, equality, correlation and stitch a lowering emits compares through it.
	 */
	equal(type: ScalarType, left: Expr, right: Expr): Expr {
		return typedEq(type, left, right, this.names.vectorSchema)
	}

	relationAlias(origin: NameOrigin): string {
		return this.supply.relation(origin)
	}

	/** One fresh column per name, paired with it. */
	freshColumns(names: ReadonlyArray<string>, origin: NameOrigin): ReadonlyArray<NamedColumn> {
		return names.map((name) => ({ name, column: this.supply.column(origin) }))
	}

	/** A lowered query read as a derived table with a fresh alias and column list. `heading` names its outputs. */
	wrap(query: Select, heading: Heading, origin: NameOrigin): InputSource {
		return this.wrapAs(query, heading, origin, false)
	}

	/** wrap, a LATERAL derived table when `lateral`. */
	wrapAs(query: Select, heading: Heading, origin: NameOrigin, lateral: boolean): InputSource {
		const named = this.freshColumns(outputNames(heading), origin)
		const columns = named.map((n) => n.column)
		const alias = this.supply.relation(origin)
		const item: FromSource = lateral
			? derived(query, alias, columns, true)
			: derived(query, alias, columns, false)
		return { item, alias, columns, map: namedMap(alias, named) }
	}

	/** A node lowered and read as a derived table. */
	source(node: RelNode, env: Env): InputSource {
		return this.sourceAs(node, env, false)
	}

	/** source, a LATERAL derived table when `lateral`. */
	sourceAs(node: RelNode, env: Env, lateral: boolean): InputSource {
		return this.wrapAs(
			this.lower(node, env),
			node.heading,
			{ kind: "node", node: node.id },
			lateral
		)
	}

	/**
	 * The stored columns a scalar expression subtree of `node` reads from nodes outside its own subtree, by the label
	 * of the node: the outer references that make a source correlated. Feedback edges are names and are not followed.
	 */
	freeRefs(node: RelNode): OuterRefs {
		const known = this.#shared.free.get(node)
		if (known !== undefined) {
			return known
		}
		const reach = new Set<RelNode>([node])
		const labels = new Set<NodeId>([node.id])
		const queue = [node]
		for (const queued of queue) {
			for (const input of inputsOf(queued).filter((i) => !reach.has(i))) {
				reach.add(input)
				labels.add(input.id)
				queue.push(input)
			}
		}
		const free = new Map<NodeId, Set<string>>()
		for (const e of exprClosure(queue.flatMap((n) => exprsOf(n)))) {
			if (e.kind !== "column" || labels.has(e.column.node)) {
				continue
			}
			const set = free.get(e.column.node) ?? new Set<string>()
			set.add(e.column.name)
			free.set(e.column.node, set)
		}
		this.#shared.free.set(node, free)
		return free
	}

	/**
	 * The scope of `node` (ir/dag.ts nodeScopes): the columns of nodes outside it that its evaluation reads, which an
	 * environment must bind wherever it is lowered.
	 */
	scopeOf(node: RelNode): NodeScope {
		this.#shared.scopes ??= nodeScopes(this.dag)
		return this.#shared.scopes.of(node)
	}

	/**
	 * The PostgreSQL type of a value of `t` (physicalTypeOf) under this lowering's subject: a violation probe reads only
	 * stored values, so it types an unnamed text refinement by its base, pg_catalog's builtin text.
	 */
	physicalType(t: ScalarType): PhysicalType {
		const p = physicalTypeOf(this.names, t)
		return p.kind === "unnamedText" && this.options.subject.kind === "violationProbe"
			? { kind: "type", ref: physicalBaseType(this.names, t) }
			: p
	}

	/** The PostgreSQL type of a value of `t` (physicalType); a refinement without a domain name is refused. */
	typeRef(t: ScalarType, at: string): TypeRef {
		return namedType(this.physicalType(t), at)
	}

	/**
	 * The type with every refinement dropped: a contract's base, unrefined text. Input arrays, VALUES lists, literals
	 * and recursive state are cast to it; a value checked at compile time or already stored
	 * needs no domain check again.
	 */
	baseTypeRef(t: ScalarType): TypeRef {
		return physicalBaseType(this.names, t)
	}

	/**
	 * The type of a take or page bound parameter: its declaration's, which the checker states for every bound parameter
	 * (integer, or the wider type another use of the parameter fixes). An undeclared one is a malformed description.
	 */
	boundParam(bound: TakeBound & { readonly kind: "param" }): Expr {
		for (const p of this.options.params) {
			if (p.id === bound.param && p.kind === "scalar") {
				return this.params.scalar(bound.param, p.type, this.baseTypeRef(p.type))
			}
		}
		return refuse(
			"MalformedDescription",
			"take bound",
			`a declared scalar parameter ${bound.param}`
		)
	}

	boundExpr(bound: TakeBound): Expr {
		return bound.kind === "literal" ? lit.int(bound.k, types.bigint) : this.boundParam(bound)
	}
}

/**
 * The PostgreSQL type of a value of `t`: a contract's domain, a regex refinement's __text_ domain, a roster's enum, an
 * extension's vector, or the builtin with its typmod; or, for a regex refinement whose __text_ domain the names do not
 * name (a contract's base pattern no stored column carries), that refinement.
 */
type PhysicalType =
	| { readonly kind: "type"; readonly ref: TypeRef }
	| { readonly kind: "unnamedText"; readonly regex: RegexRef }

const physicalTypeOf = (names: PhysicalNames, t: ScalarType): PhysicalType => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		const domain = names.contractDomain(contract.name)
		return {
			kind: "type",
			ref: { kind: "named", schema: domain.schema, name: domain.name, typmod: [], array: false }
		}
	}
	if (t.carrier === "text" && t.text.regex !== "wildcard") {
		const domain = names.textDomain(t.text.regex)
		return domain === undefined
			? { kind: "unnamedText", regex: t.text.regex }
			: {
					kind: "type",
					ref: { kind: "named", schema: domain.schema, name: domain.name, typmod: [], array: false }
				}
	}
	return { kind: "type", ref: physicalBaseType(names, t) }
}

/** The type of a physical type, a refinement without a domain name refused. */
const namedType = (p: PhysicalType, at: string): TypeRef =>
	p.kind === "type"
		? p.ref
		: refuse(
				"UnsupportedOperation",
				at,
				`the domain name of the text refinement /${p.regex.source}/${p.regex.flags}`
			)

/** The PostgreSQL type of a value of `t` (physicalTypeOf); a refinement without a domain name is refused. */
export const physicalTypeRef = (names: PhysicalNames, t: ScalarType, at: string): TypeRef =>
	namedType(physicalTypeOf(names, t), at)

/** The type of the column `name` of `heading`, a column the valid DAG names in that heading (namedColumn). */
export const columnType = (heading: Heading, name: string): ScalarType =>
	namedColumn(
		heading.find((h) => h.name === name),
		name
	).type

/** The position of the column `name` in `heading`, a column the valid DAG names in that heading (namedColumn). */
export const columnPosition = (heading: Heading, name: string): number =>
	namedColumn(
		firstIndex(heading, (h) => h.name === name),
		name
	)

/** The output names of a heading: its columns, or the unit marker. */
export const outputNames = (heading: Heading): NonEmptyReadonlyArray<string> =>
	isNonEmpty(heading) ? mapNonEmpty(heading, (c) => c.name) : [unitColumn]

/**
 * The targets that read `heading` from a column map over a heading with its columns, in heading order; the unit marker
 * for a zero-column heading.
 */
export const headingTargets = (heading: Heading, map: ColumnMap): NonEmptyReadonlyArray<Target> =>
	isNonEmpty(heading) ? mapNonEmpty(heading, (c) => target(columnIn(map, c.name))) : unitTargets

/**
 * The equalities of an attachment's correlation: each child column of heading `child`, read through `source`, equal to
 * the parent column it is correlated with, read through `parent`.
 */
export const correlationEqualities = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	child: Heading,
	source: ColumnMap,
	parent: ColumnMap
): ReadonlyArray<Expr> =>
	attach.correlation.map((c) =>
		cx.equal(columnType(child, c.child), columnIn(source, c.child), columnIn(parent, c.parent))
	)

/**
 * SELECT DISTINCT over one or more FROM items: the conservative set boundary, restricted by the conjunction of
 * `where`, which has no WHERE when it is empty.
 */
export const distinctSelect = (
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: ReadonlyArray<Expr>
): Select => select(distinctCore(targets, from, conjunction(where)))
