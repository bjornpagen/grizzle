import { maxOf } from "#compiler/core/array.ts"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	AlterDomain,
	AlterDomainAction,
	AlterTable,
	AlterTableAction,
	Assignment,
	Call,
	ColumnDef,
	ColumnDefinition,
	ColumnGeneration,
	CommentTarget,
	ConflictAction,
	CoreProjection,
	CountStar,
	CreateDomain,
	CreateExtension,
	CreateFunction,
	CreateIndex,
	Cte,
	CteBody,
	Ddl,
	Delete,
	Dml,
	DomainConstraint,
	DropObject,
	Expr,
	FromItem,
	FromSource,
	FunctionCall,
	FunctionName,
	FunctionParam,
	GrantObjects,
	IndexKey,
	InlineConstraint,
	Insert,
	InsertTarget,
	JoinChain,
	JoinStep,
	Merge,
	MergeInsert,
	MergeUpdate,
	MergeWhen,
	ObjectName,
	OnConflict,
	OrderItem,
	PerformQuery,
	PlBlock,
	PlDeclaration,
	PlStatement,
	ProbeBy,
	ProbeColumn,
	QualifiedFunctionRef,
	RaiseOption,
	RenameObject,
	Select,
	OperandBody,
	OperandSelect,
	SetArm,
	SelectCore,
	SetOperand,
	SetOperation,
	SqlStatement,
	TableConstraint,
	TableName,
	Target,
	TypeRef,
	Update,
	Using,
	WindowSpec,
	With
} from "#compiler/sql/ast.ts"
import { isSetBody, isSetQuery, isValuesTarget } from "#compiler/sql/ast.ts"
import type { CarrierName } from "#compiler/sql/naming.ts"

/**
 * The catalog namespace an object name is looked up in: a relation's (tables, views, sequences and indexes share
 * pg_class), a type's (a domain lives in pg_type, where each table's row type also lives, which no grizzle column is
 * of), a function's (a constant is one), an operator class's or an extended statistics object's. A rename in one namespace never renames
 * a name of another.
 */
type NameSpace = "relation" | "type" | "function" | "operatorClass" | "statistics"

/** The namespace of the schema object a RENAME or a DROP names. */
const objectSpace = (
	object: Exclude<RenameObject["object"] | DropObject["object"], "ROLE" | "SCHEMA">
): NameSpace => {
	switch (object) {
		case "TABLE":
		case "INDEX":
		case "MATERIALIZED VIEW":
		case "VIEW":
		case "SEQUENCE":
			return "relation"
		case "DOMAIN":
			return "type"
		case "STATISTICS":
			return "statistics"
	}
}

/**
 * The traversals of the SQL AST (sql/ast.ts): a typed bottom-up rewrite of every statement form, and a visit of every
 * node of a query.
 *
 * The rewrite serves the passes that change one kind of node wherever it appears: a rename of schema-qualified names
 * (deploy/snapshot/objects.ts), the move of a statement into a scratch schema (adapter/admission/drift.ts), the refined
 * placeholders' recast and output casts (lower/shapes/refined) and the renumbering of a single statement's parts'
 * placeholders (write/program/single.ts).
 * Each node is rebuilt from its children: a node none of whose children changed keeps its identity, and a node whose
 * children changed is copied with the new children in their keys' places, so its other keys and their order stay as
 * they were. A hook sees a node after its children were rewritten, with the node as it was, and returns it or its
 * replacement: `expr` every expression, `fromSource` every FROM source, a join chain's included, `core` every query
 * core, `select` every query,
 * `objectName` every schema object name (a CREATE INDEX's own name and a USING INDEX's index among them, relations of
 * their table's schema), `constraintName` every name a table's constraint takes, with the table its statement names
 * as it was, `carrier` every carrier a statement names, `typeRef` every type reference,
 * `functionRef` every qualified function reference, and `extension` every CREATE EXTENSION. `replaceSource` sees a
 * FROM source before its children and may replace it whole. `joins` sees every join chain, rebuilt around its sources. A collation is always pg_catalog's pg_c_utf8 and is never rewritten. Every hook is stated: a pass
 * spreads identityHooks and states the hooks it changes.
 */
export interface AstHooks {
	readonly expr: (e: Expr, original: Expr) => Expr
	readonly fromSource: (source: FromSource, original: FromSource) => FromSource
	readonly joins: (chain: JoinChain, original: JoinChain) => JoinChain
	readonly core: (core: SelectCore, original: SelectCore) => SelectCore
	readonly select: (select: OperandSelect, original: OperandSelect) => OperandSelect
	/** A FROM source's replacement before its children are rewritten, or undefined to rewrite it as usual. */
	readonly replaceSource: (source: FromSource) => FromSource | undefined
	readonly objectName: (name: ObjectName, namespace: NameSpace) => ObjectName
	readonly constraintName: (table: ObjectName, name: string) => string
	readonly carrier: (name: CarrierName) => CarrierName
	readonly typeRef: (type: TypeRef) => TypeRef
	readonly functionRef: (fn: QualifiedFunctionRef) => QualifiedFunctionRef
	readonly extension: (statement: CreateExtension) => CreateExtension
}

/** A list rebuilt element by element: the same list when no element changed. */
const kept = <L extends ReadonlyArray<unknown>>(list: L, out: L): L =>
	out.every((a, i) => a === list[i]) ? list : out

const mapList = <A>(list: ReadonlyArray<A>, f: (a: A) => A): ReadonlyArray<A> =>
	kept(list, list.map(f))

const mapNonEmptyKept = <A>(
	list: NonEmptyReadonlyArray<A>,
	f: (a: A) => A
): NonEmptyReadonlyArray<A> =>
	kept(
		list,
		mapNonEmpty(list, (a) => f(a))
	)

const same = <A>(a: A): A => a

/** Every hook the identity: each node as its children rebuilt it, and no FROM item replaced. */
export const identityHooks: AstHooks = {
	expr: same,
	fromSource: same,
	joins: same,
	core: same,
	select: same,
	replaceSource: () => undefined,
	objectName: same,
	constraintName: (_table, name) => name,
	carrier: same,
	typeRef: same,
	functionRef: same,
	extension: same
}

/**
 * The database default names no schema object.
 *
 * A carrier is no schema object: its names are never rewritten.
 */
export class Transform {
	readonly #expr: (e: Expr, original: Expr) => Expr
	readonly #fromSource: (source: FromSource, original: FromSource) => FromSource
	readonly #joins: (chain: JoinChain, original: JoinChain) => JoinChain
	readonly #core: (core: SelectCore, original: SelectCore) => SelectCore
	readonly #select: (select: OperandSelect, original: OperandSelect) => OperandSelect
	readonly #replaceSource: (source: FromSource) => FromSource | undefined
	readonly #objectName: (name: ObjectName, namespace: NameSpace) => ObjectName
	readonly #constraintName: (table: ObjectName, name: string) => string
	readonly #carrier: (name: CarrierName) => CarrierName
	readonly #typeRef: (type: TypeRef) => TypeRef
	readonly #functionRef: (fn: QualifiedFunctionRef) => QualifiedFunctionRef
	readonly #extension: (statement: CreateExtension) => CreateExtension

	constructor(hooks: AstHooks) {
		this.#expr = hooks.expr
		this.#fromSource = hooks.fromSource
		this.#joins = hooks.joins
		this.#core = hooks.core
		this.#select = hooks.select
		this.#replaceSource = hooks.replaceSource
		this.#objectName = hooks.objectName
		this.#constraintName = hooks.constraintName
		this.#carrier = hooks.carrier
		this.#typeRef = hooks.typeRef
		this.#functionRef = hooks.functionRef
		this.#extension = hooks.extension
	}

	readonly exprs = (list: ReadonlyArray<Expr>): ReadonlyArray<Expr> => mapList(list, this.expr)
	readonly nonEmptyExprs = (list: NonEmptyReadonlyArray<Expr>): NonEmptyReadonlyArray<Expr> =>
		mapNonEmptyKept(list, this.expr)
	readonly names = (
		list: NonEmptyReadonlyArray<ObjectName>,
		namespace: NameSpace
	): NonEmptyReadonlyArray<ObjectName> => mapNonEmptyKept(list, (n) => this.name(n, namespace))
	readonly name = (name: ObjectName, namespace: NameSpace): ObjectName =>
		this.#objectName(name, namespace)
	/** An index's bare name, a relation of its table's schema, through the name hook. */
	readonly indexName = (table: ObjectName, name: string): string =>
		this.name({ schema: table.schema, name }, "relation").name
	/** A constraint's name, of the table `table` names as the statement had it, through the constraint hook. */
	readonly constraintName = (table: ObjectName, name: string): string =>
		this.#constraintName(table, name)
	/** A stored table through the name hook, a carrier through the carrier hook. */
	readonly table = (table: TableName): TableName =>
		typeof table === "string" ? this.#carrier(table) : this.name(table, "relation")
	readonly type = (type: TypeRef): TypeRef => this.#typeRef(type)
	/** A function's name through the name hook and its argument types through the type hook. */
	readonly functionName = (fn: FunctionName): FunctionName => {
		const name = this.name({ schema: fn.schema, name: fn.name }, "function")
		const args = mapList(fn.args, this.type)
		return name.schema === fn.schema && name.name === fn.name && args === fn.args
			? fn
			: { ...name, args }
	}

	readonly expr = (e: Expr): Expr => this.#expr(this.exprChildren(e), e)

	exprChildren(e: Expr): Expr {
		switch (e.kind) {
			case "column":
			case "excluded":
			case "returning":
			case "mergeAction":
			case "domainValue":
			case "user":
			case "plVar":
			case "plSpecial":
			case "field":
				return e
			case "regclass": {
				const relation = this.name(e.relation, "relation")
				return relation === e.relation ? e : { ...e, relation }
			}
			case "param":
			case "clock":
			case "literal": {
				const type = this.type(e.type)
				return type === e.type ? e : { ...e, type }
			}
			case "cast": {
				const expr = this.expr(e.expr)
				const type = this.type(e.type)
				return expr === e.expr && type === e.type ? e : { ...e, expr, type }
			}
			case "collate":
			case "negate":
			case "not":
			case "isTrue":
			case "complement": {
				const expr = this.expr(e.expr)
				return expr === e.expr ? e : { ...e, expr }
			}
			case "nullif": {
				const expr = this.expr(e.expr)
				const absent = this.expr(e.absent)
				return expr === e.expr && absent === e.absent ? e : { ...e, expr, absent }
			}
			case "subscript": {
				const array = this.expr(e.array)
				const index = this.expr(e.index)
				return array === e.array && index === e.index ? e : { ...e, array, index }
			}
			case "binary": {
				const left = this.expr(e.left)
				const right = this.expr(e.right)
				return left === e.left && right === e.right ? e : { ...e, left, right }
			}
			case "and":
			case "or": {
				const args = mapNonEmptyKept(e.args, (a) => this.expr(a))
				return args === e.args ? e : { ...e, args }
			}
			case "greatest":
			case "least":
			case "coalesce": {
				const args = this.nonEmptyExprs(e.args)
				return args === e.args ? e : { ...e, args }
			}
			case "between": {
				const expr = this.expr(e.expr)
				const low = this.expr(e.low)
				const high = this.expr(e.high)
				return expr === e.expr && low === e.low && high === e.high ? e : { ...e, expr, low, high }
			}
			case "inList": {
				const expr = this.expr(e.expr)
				const list = this.nonEmptyExprs(e.list)
				return expr === e.expr && list === e.list ? e : { ...e, expr, list }
			}
			case "inQuery": {
				const expr = this.expr(e.expr)
				const query = this.select(e.query)
				return expr === e.expr && query === e.query ? e : { ...e, expr, query }
			}
			case "exists":
			case "subquery": {
				const query = this.select(e.query)
				return query === e.query ? e : { ...e, query }
			}
			case "array": {
				const query = this.setQuery(e.query)
				return query === e.query ? e : { ...e, query }
			}
			case "row": {
				const items = mapNonEmptyKept(e.items, (a) => this.expr(a))
				return items === e.items ? e : { ...e, items }
			}
			case "case": {
				const operand = e.operand === undefined ? undefined : this.expr(e.operand)
				const whens = mapNonEmptyKept(e.whens, (w) => {
					const when = this.expr(w.when)
					const result = this.expr(w.result)
					return when === w.when && result === w.result ? w : { ...w, when, result }
				})
				const otherwise = this.expr(e.else)
				if (operand === e.operand && whens === e.whens && otherwise === e.else) {
					return e
				}
				return { ...e, operand, whens, else: otherwise }
			}
			case "call":
				return this.call(e)
		}
	}

	call(c: FunctionCall): FunctionCall {
		return c.star ? this.countStar(c) : this.plainCall(c)
	}

	countStar(c: CountStar): CountStar {
		const filter = c.filter === undefined ? undefined : this.expr(c.filter)
		const over = c.over === undefined ? undefined : this.window(c.over)
		if (filter === c.filter && over === c.over) {
			return c
		}
		return { ...c, filter, over }
	}

	plainCall(c: Call): Call {
		const fn = c.fn.kind === "qualified" ? this.#functionRef(c.fn) : c.fn
		const args = this.exprs(c.args)
		const orderBy = this.orderItems(c.orderBy)
		const withinGroup = this.orderItems(c.withinGroup)
		const over = c.over === undefined ? undefined : this.window(c.over)
		if (
			fn === c.fn &&
			args === c.args &&
			orderBy === c.orderBy &&
			withinGroup === c.withinGroup &&
			over === c.over
		) {
			return c
		}
		return { ...c, fn, args, orderBy, withinGroup, over }
	}

	orderItems(items: ReadonlyArray<OrderItem>): ReadonlyArray<OrderItem> {
		return mapList(items, (item) => {
			const expr = this.expr(item.expr)
			return expr === item.expr ? item : { ...item, expr }
		})
	}

	window(w: WindowSpec): WindowSpec {
		const partitionBy = this.exprs(w.partitionBy)
		const orderBy = this.orderItems(w.orderBy)
		if (partitionBy === w.partitionBy && orderBy === w.orderBy) {
			return w
		}
		return { ...w, partitionBy, orderBy }
	}

	targets(list: ReadonlyArray<Target>): ReadonlyArray<Target> {
		return mapList(list, (t) => this.#target(t))
	}

	#target(t: Target): Target {
		const expr = this.expr(t.expr)
		return expr === t.expr ? t : { ...t, expr }
	}

	columnDefinition(c: ColumnDefinition): ColumnDefinition {
		const type = this.type(c.type)
		return type === c.type ? c : { ...c, type }
	}

	fromItem(item: FromItem): FromItem {
		if (item.kind !== "joins") {
			return this.source(item)
		}
		const first = this.source(item.first)
		const steps = mapNonEmptyKept(item.steps, (step): JoinStep => {
			const source = this.source(step.source)
			if (step.kind === "cross") {
				return source === step.source ? step : { ...step, source }
			}
			const on = this.expr(step.on)
			return source === step.source && on === step.on ? step : { ...step, source, on }
		})
		return this.#joins(
			first === item.first && steps === item.steps ? item : { ...item, first, steps },
			item
		)
	}

	source(source: FromSource): FromSource {
		return this.#replaceSource(source) ?? this.#fromSource(this.sourceChildren(source), source)
	}

	sourceChildren(item: FromSource): FromSource {
		switch (item.kind) {
			case "table": {
				const table = this.table(item.table)
				return table === item.table ? item : { ...item, table }
			}
			case "probe": {
				const table = this.name(item.table, "relation")
				const by = this.probeBy(item.by)
				const filter = this.exprs(item.filter)
				return table === item.table && by === item.by && filter === item.filter
					? item
					: { ...item, table, by, filter }
			}
			case "met": {
				const table = this.name(item.table, "relation")
				const filter = this.exprs(item.filter)
				return table === item.table && filter === item.filter ? item : { ...item, table, filter }
			}
			case "metRows":
				return item
			case "cte":
			case "enclosing":
				return item
			case "derived": {
				const query = this.select(item.query)
				return query === item.query ? item : { ...item, query }
			}
			case "function": {
				const call = this.plainCall(item.call)
				return call === item.call ? item : { ...item, call }
			}
			case "arrays": {
				const source = item.source
				if (source.kind === "count") {
					return item
				}
				const columns = mapNonEmptyKept(source.columns, (c) => {
					const definition = this.columnDefinition(c.definition)
					return definition === c.definition ? c : { ...c, definition }
				})
				return columns === source.columns ? item : { ...item, source: { ...source, columns } }
			}
			case "values": {
				const rows = mapNonEmptyKept(item.rows, this.exprs)
				return rows === item.rows ? item : { ...item, rows }
			}
			case "context": {
				const columns = mapNonEmptyKept(item.columns, (c) => {
					const column = this.columnDefinition(c.column)
					return column === c.column ? c : { ...c, column }
				})
				const refusal = this.#functionRef(item.refusal)
				return columns === item.columns && refusal === item.refusal
					? item
					: { ...item, columns, refusal }
			}
		}
	}

	fromItems(list: ReadonlyArray<FromItem>): ReadonlyArray<FromItem> {
		return mapList(list, (item) => this.fromItem(item))
	}

	probeColumn(c: ProbeColumn): ProbeColumn {
		const value = this.expr(c.value)
		return value === c.value ? c : { ...c, value }
	}

	probeBy(by: ProbeBy): ProbeBy {
		if (by.kind === "key") {
			const columns = mapList(by.columns, (c) => this.probeColumn(c))
			return columns === by.columns ? by : { ...by, columns }
		}
		const columns = mapNonEmptyKept(by.columns, (c) => this.probeColumn(c))
		return columns === by.columns ? by : { ...by, columns }
	}

	core(c: SelectCore): SelectCore {
		return this.#core(this.coreChildren(c), c)
	}

	coreChildren(c: SelectCore): SelectCore {
		const projection = this.#projection(c)
		const from = this.fromItems(c.from)
		const where = c.where === undefined ? undefined : this.expr(c.where)
		const groupBy = this.exprs(c.groupBy)
		const having = c.having === undefined ? undefined : this.expr(c.having)
		if (
			projection.distinct === c.distinct &&
			projection.targets === c.targets &&
			from === c.from &&
			where === c.where &&
			groupBy === c.groupBy &&
			having === c.having
		) {
			return c
		}
		return { kind: "core", ...projection, from, where, groupBy, having }
	}

	/** A core's projection as its children rebuilt it, distinct by distinct. */
	#projection(c: CoreProjection): CoreProjection {
		if (c.distinct === false) {
			return c.rows === "operand"
				? { distinct: false, rows: c.rows, targets: this.targets(c.targets) }
				: { distinct: false, rows: c.rows, targets: this.targets(c.targets) }
		}
		const d = c.distinct
		if (d === true) {
			return { distinct: d, targets: mapNonEmptyKept(c.targets, (t) => this.#target(t)) }
		}
		const on = mapNonEmptyKept(d.on, (e) => this.expr(e))
		return {
			distinct: on === d.on ? d : { ...d, on },
			targets: mapNonEmptyKept(c.targets, (t) => this.#target(t))
		}
	}

	setOp(s: SetOperation): SetOperation {
		if (s.op !== "UNION ALL") {
			const arms = this.#operands(s.arms)
			return arms === s.arms ? s : { ...s, arms }
		}
		switch (s.rows) {
			case "disjoint":
			case "certified": {
				const [first, second, ...rest] = s.arms
				const arms = kept(s.arms, [
					this.setArm(first),
					this.setArm(second),
					...rest.map((a) => this.setArm(a))
				])
				return arms === s.arms ? s : { ...s, arms }
			}
			case "oneRow":
			case "operand": {
				const arms = this.#operands(s.arms)
				return arms === s.arms ? s : { ...s, arms }
			}
		}
	}

	/** A set operation's arms rebuilt, the same array when every arm is kept. */
	#operands(
		arms: readonly [SetOperand, SetOperand, ...Array<SetOperand>]
	): readonly [SetOperand, SetOperand, ...Array<SetOperand>] {
		const [first, second, ...rest] = arms
		return kept<readonly [SetOperand, SetOperand, ...Array<SetOperand>]>(arms, [
			this.operand(first),
			this.operand(second),
			...rest.map((a) => this.operand(a))
		])
	}

	operand(o: SetOperand): SetOperand {
		return o.kind === "core" ? this.core(o) : this.select(o)
	}

	/** A set arm rebuilt, a set still: a rewrite keeps a set's rows a set. */
	setArm(a: SetArm): SetArm {
		const rebuilt = this.operand(a)
		if (rebuilt.kind === "core") {
			if (isSetBody(rebuilt)) {
				return rebuilt
			}
		} else if (isSetQuery(rebuilt)) {
			return rebuilt
		}
		throw defect("a rewrite that keeps a UNION ALL arm a set")
	}

	/** A set query rebuilt, a set still: a rewrite keeps a set's rows a set. */
	setQuery(q: Select): Select {
		const rebuilt = this.select(q)
		if (!isSetQuery(rebuilt)) {
			throw defect("a rewrite that keeps a set query a set")
		}
		return rebuilt
	}

	body(b: OperandBody): OperandBody {
		switch (b.kind) {
			case "core":
				return this.core(b)
			case "setOp":
				return this.setOp(b)
			case "select":
				return this.select(b)
		}
	}

	with(w: With): With {
		const ctes = mapNonEmptyKept(w.ctes, (c) => this.cte(c))
		return ctes === w.ctes ? w : { ...w, ctes }
	}

	cte(c: Cte): Cte {
		const query = this.cteBody(c.query)
		return query === c.query ? c : { ...c, query }
	}

	cteBody(b: CteBody): CteBody {
		switch (b.kind) {
			case "select":
				return this.select(b)
			case "insert":
				return this.insert(b)
			case "update":
				return this.update(b)
			case "delete":
				return this.delete(b)
			case "merge":
				return this.merge(b)
		}
	}

	readonly select = (s: OperandSelect): OperandSelect => this.#select(this.selectChildren(s), s)

	selectChildren(s: OperandSelect): OperandSelect {
		const w = s.with === undefined ? undefined : this.with(s.with)
		const body = this.body(s.body)
		const orderBy = this.orderItems(s.orderBy)
		const limit = s.limit === undefined ? undefined : this.expr(s.limit)
		const offset = s.offset === undefined ? undefined : this.expr(s.offset)
		if (
			w === s.with &&
			body === s.body &&
			orderBy === s.orderBy &&
			limit === s.limit &&
			offset === s.offset
		) {
			return s
		}
		return { ...s, with: w, body, orderBy, limit, offset }
	}

	performQuery(q: PerformQuery): PerformQuery {
		const body = this.core(q.body)
		const orderBy = this.orderItems(q.orderBy)
		const limit = q.limit === undefined ? undefined : this.expr(q.limit)
		const offset = q.offset === undefined ? undefined : this.expr(q.offset)
		return body === q.body && orderBy === q.orderBy && limit === q.limit && offset === q.offset
			? q
			: { body, orderBy, limit, offset }
	}

	assignments(list: NonEmptyReadonlyArray<Assignment>): NonEmptyReadonlyArray<Assignment> {
		return mapNonEmptyKept(list, (a) => {
			const value = this.expr(a.value)
			return value === a.value ? a : { ...a, value }
		})
	}

	conflictAction(a: ConflictAction): ConflictAction {
		switch (a.kind) {
			case "doNothing":
				return a
			case "doSelect": {
				if (a.where === undefined) {
					return a
				}
				const where = this.expr(a.where)
				return where === a.where ? a : { ...a, where }
			}
			case "doUpdate": {
				const set = this.assignments(a.set)
				const where = a.where === undefined ? undefined : this.expr(a.where)
				if (set === a.set && where === a.where) {
					return a
				}
				return { ...a, set, where }
			}
		}
	}

	onConflict(c: OnConflict): OnConflict {
		if (c.kind === "constraint" || c.kind === "every") {
			return c
		}
		const action = this.conflictAction(c.action)
		return action === c.action ? c : { ...c, action }
	}

	/** An INSERT's columns and source, rebuilt arm by arm, so a VALUES source keeps its columns. */
	insertTarget(t: InsertTarget): InsertTarget {
		if (isValuesTarget(t)) {
			const rows = mapNonEmptyKept(t.source.rows, this.exprs)
			return rows === t.source.rows ? t : { columns: t.columns, source: { ...t.source, rows } }
		}
		const query = this.setQuery(t.source.query)
		return query === t.source.query ? t : { columns: t.columns, source: { ...t.source, query } }
	}

	/**
	 * An INSERT rebuilt from its rebuilt parts, its target spread first: an unchanged target is the insert itself, whose
	 * own WITH, table and conflict clause the rebuilt ones then replace.
	 */
	insert(i: Insert): Insert {
		const w = i.with === undefined ? undefined : this.with(i.with)
		const table = this.table(i.table)
		const target = this.insertTarget(i)
		const onConflict = i.onConflict === undefined ? undefined : this.onConflict(i.onConflict)
		const returning = this.targets(i.returning)
		if (
			w === i.with &&
			table === i.table &&
			target === i &&
			onConflict === i.onConflict &&
			returning === i.returning
		) {
			return i
		}
		return {
			...target,
			kind: "insert",
			with: w,
			table,
			alias: i.alias,
			overriding: i.overriding,
			onConflict,
			returning
		}
	}

	update(u: Update): Update {
		const w = u.with === undefined ? undefined : this.with(u.with)
		const table = this.name(u.table, "relation")
		const set = this.assignments(u.set)
		const from = this.fromItems(u.from)
		const where = u.where === undefined ? undefined : this.expr(u.where)
		const returning = this.targets(u.returning)
		if (
			w === u.with &&
			table === u.table &&
			set === u.set &&
			from === u.from &&
			where === u.where &&
			returning === u.returning
		) {
			return u
		}
		return { ...u, with: w, table, set, from, where, returning }
	}

	delete(d: Delete): Delete {
		const w = d.with === undefined ? undefined : this.with(d.with)
		const table = this.table(d.table)
		const using = this.fromItems(d.using)
		const where = d.where === undefined ? undefined : this.expr(d.where)
		const returning = this.targets(d.returning)
		if (
			w === d.with &&
			table === d.table &&
			using === d.using &&
			where === d.where &&
			returning === d.returning
		) {
			return d
		}
		return { ...d, with: w, table, using, where, returning }
	}

	mergeUpdate(a: MergeUpdate): MergeUpdate {
		const set = this.assignments(a.set)
		return set === a.set ? a : { ...a, set }
	}

	mergeInsert(a: MergeInsert): MergeInsert {
		if (a.kind === "insertDefault") {
			return a
		}
		const row = this.assignments(a.row)
		return row === a.row ? a : { ...a, row }
	}

	mergeWhen(w: MergeWhen): MergeWhen {
		const condition = w.condition === undefined ? undefined : this.expr(w.condition)
		return w.match === "NOT MATCHED"
			? this.#when(w, condition, w.action.kind === "insert" ? this.mergeInsert(w.action) : w.action)
			: this.#when(w, condition, w.action.kind === "update" ? this.mergeUpdate(w.action) : w.action)
	}

	#when<W extends MergeWhen>(w: W, condition: Expr | undefined, action: W["action"]): W {
		if (condition === w.condition && action === w.action) {
			return w
		}
		return { ...w, condition, action }
	}

	merge(m: Merge): Merge {
		const w = m.with === undefined ? undefined : this.with(m.with)
		const table = this.name(m.table, "relation")
		const using = this.fromItem(m.using)
		const on = this.expr(m.on)
		const whens = mapNonEmptyKept(m.whens, (x) => this.mergeWhen(x))
		const returning = this.targets(m.returning)
		if (
			w === m.with &&
			table === m.table &&
			using === m.using &&
			on === m.on &&
			whens === m.whens &&
			returning === m.returning
		) {
			return m
		}
		return { ...m, with: w, table, using, on, whens, returning }
	}

	dml(s: Dml): Dml {
		switch (s.kind) {
			case "select":
				return this.setQuery(s)
			case "insert":
				return this.insert(s)
			case "update":
				return this.update(s)
			case "delete":
				return this.delete(s)
			case "merge":
				return this.merge(s)
		}
	}

	generation(g: ColumnGeneration): ColumnGeneration {
		switch (g.kind) {
			case "identity": {
				const sequence = this.name(g.sequence, "relation")
				return sequence === g.sequence ? g : { ...g, sequence }
			}
			case "uuidv7":
			case "retirement":
				return g
			case "stored": {
				const expr = this.expr(g.expr)
				return expr === g.expr ? g : { ...g, expr }
			}
			case "partial": {
				const when = this.expr(g.when)
				const expr = this.expr(g.expr)
				return when === g.when && expr === g.expr ? g : { ...g, when, expr }
			}
		}
	}

	columnDef(c: ColumnDef): ColumnDef {
		const type = this.type(c.type)
		const generated = c.generated === undefined ? undefined : this.generation(c.generated)
		if (type === c.type && generated === c.generated) {
			return c
		}
		return { ...c, type, generated }
	}

	using(u: Using): Using {
		switch (u.kind) {
			case "expr": {
				const expr = this.expr(u.expr)
				return expr === u.expr ? u : { ...u, expr }
			}
			case "placeholder":
				return u
		}
	}

	/** A constraint of the table `table` names as its statement had it. */
	constraint(c: TableConstraint, table: ObjectName): TableConstraint {
		const name = this.constraintName(table, c.name)
		switch (c.kind) {
			case "primaryKey":
				return name === c.name ? c : { ...c, name }
			case "foreignKey": {
				const references = this.name(c.references, "relation")
				return references === c.references && name === c.name ? c : { ...c, name, references }
			}
			case "unique":
			case "exclude":
			case "check":
				return this.inlineConstraint(c, table)
		}
	}

	/** A constraint declared inside the CREATE TABLE of the table `table` names as its statement had it, or added to it. */
	inlineConstraint(c: InlineConstraint, table: ObjectName): InlineConstraint {
		const name = this.constraintName(table, c.name)
		switch (c.kind) {
			case "unique":
			case "exclude":
				return name === c.name ? c : { ...c, name }
			case "check": {
				const predicate = this.expr(c.predicate)
				return predicate === c.predicate && name === c.name ? c : { ...c, name, predicate }
			}
		}
	}

	/** An action of an ALTER TABLE on the table `table` names as its statement had it. */
	alterTableAction(a: AlterTableAction, table: ObjectName): AlterTableAction {
		switch (a.kind) {
			case "addColumn":
			case "addColumnPlaceholder":
			case "addColumnUnchecked": {
				const column = this.columnDef(a.column)
				return column === a.column ? a : { ...a, column }
			}
			case "addColumnDefault": {
				const column = this.columnDef(a.column)
				const value = this.expr(a.default)
				return column === a.column && value === a.default ? a : { ...a, column, default: value }
			}
			case "addIdentity": {
				const sequence = this.name(a.sequence, "relation")
				return sequence === a.sequence ? a : { ...a, sequence }
			}
			case "addConstraint": {
				const constraint = this.constraint(a.constraint, table)
				return constraint === a.constraint ? a : { ...a, constraint }
			}
			case "addConstraintUsingIndex": {
				const name = this.constraintName(table, a.name)
				const index = this.indexName(table, a.index)
				return name === a.name && index === a.index ? a : { ...a, name, index }
			}
			case "validateConstraint":
			case "dropConstraint": {
				const name = this.constraintName(table, a.name)
				return name === a.name ? a : { ...a, name }
			}
			case "alterColumnType": {
				const type = this.type(a.type)
				const using = this.using(a.using)
				return type === a.type && using === a.using ? a : { ...a, type, using }
			}
			case "setExpression": {
				const expr = this.expr(a.expr)
				return expr === a.expr ? a : { ...a, expr }
			}
			case "dropColumn":
			case "dropDefault":
			case "setNotNull":
			case "setUuidv7Default":
			case "setRetirementDefault":
			case "dropIdentity":
			case "enableRowSecurity":
			case "disableRowSecurity":
			case "replicaIdentity":
				return a
		}
	}

	alterTable(s: AlterTable): AlterTable {
		const table = this.name(s.table, "relation")
		const actions = mapNonEmptyKept(s.actions, (a) => this.alterTableAction(a, s.table))
		return table === s.table && actions === s.actions ? s : { ...s, table, actions }
	}

	domainConstraint(c: DomainConstraint): DomainConstraint {
		const predicate = this.expr(c.predicate)
		return predicate === c.predicate ? c : { ...c, predicate }
	}

	createDomain(s: CreateDomain): CreateDomain {
		const name = this.name(s.name, "type")
		const base = this.type(s.base)
		const constraints = mapList(s.constraints, (c) => this.domainConstraint(c))
		return name === s.name && base === s.base && constraints === s.constraints
			? s
			: { ...s, name, base, constraints }
	}

	alterDomainAction(a: AlterDomainAction): AlterDomainAction {
		switch (a.kind) {
			case "addConstraint": {
				const constraint = this.domainConstraint(a.constraint)
				return constraint === a.constraint ? a : { ...a, constraint }
			}
			case "validateConstraint":
			case "dropConstraint":
				return a
		}
	}

	alterDomain(s: AlterDomain): AlterDomain {
		const name = this.name(s.name, "type")
		const action = this.alterDomainAction(s.action)
		return name === s.name && action === s.action ? s : { ...s, name, action }
	}

	indexKey(k: IndexKey): IndexKey {
		const key = k.key
		const rewritten =
			key.kind === "column"
				? key
				: (() => {
						const expr = this.expr(key.expr)
						return expr === key.expr ? key : { ...key, expr }
					})()
		const opclass = k.opclass === undefined ? undefined : this.name(k.opclass, "operatorClass")
		if (rewritten === k.key && opclass === k.opclass) {
			return k
		}
		return { ...k, key: rewritten, opclass }
	}

	readonly createIndex = (s: CreateIndex): CreateIndex => {
		const name = this.indexName(s.table, s.name)
		const table = this.name(s.table, "relation")
		const keys = mapNonEmptyKept(s.keys, (k) => this.indexKey(k))
		const where = s.where === undefined ? undefined : this.expr(s.where)
		if (name === s.name && table === s.table && keys === s.keys && where === s.where) {
			return s
		}
		return { ...s, name, table, keys, where }
	}

	grantObjects(o: GrantObjects): GrantObjects {
		switch (o.kind) {
			case "SCHEMA":
			case "DATABASE":
				return o
			case "TABLE":
			case "SEQUENCE":
			case "DOMAIN": {
				const names = this.names(
					o.names,
					o.kind === "TABLE" || o.kind === "SEQUENCE" ? "relation" : "type"
				)
				return names === o.names ? o : { ...o, names }
			}
			case "FUNCTION": {
				const names = mapNonEmptyKept(o.names, this.functionName)
				return names === o.names ? o : { ...o, names }
			}
		}
	}

	plDeclaration(d: PlDeclaration): PlDeclaration {
		const type = this.type(d.type)
		return type === d.type ? d : { ...d, type }
	}

	raiseOption(o: RaiseOption): RaiseOption {
		const value = this.expr(o.value)
		return value === o.value ? o : { ...o, value }
	}

	plStatements(list: ReadonlyArray<PlStatement>): ReadonlyArray<PlStatement> {
		return mapList(list, (s) => this.plStatement(s))
	}

	plStatement(s: PlStatement): PlStatement {
		switch (s.kind) {
			case "if": {
				const branches = mapNonEmptyKept(s.branches, (b) => {
					const condition = this.expr(b.condition)
					const body = this.plStatements(b.body)
					return condition === b.condition && body === b.body ? b : { ...b, condition, body }
				})
				const otherwise = this.plStatements(s.else)
				if (branches === s.branches && otherwise === s.else) {
					return s
				}
				return { ...s, branches, else: otherwise }
			}
			case "assign":
			case "return": {
				const value = this.expr(s.value)
				return value === s.value ? s : { ...s, value }
			}
			case "forQuery": {
				const query = this.setQuery(s.query)
				const body = this.plStatements(s.body)
				return query === s.query && body === s.body ? s : { ...s, query, body }
			}
			case "perform":
			case "lockRows": {
				const query = this.performQuery(s.query)
				return query === s.query ? s : { ...s, query }
			}
			case "modify": {
				const statement = this.update(s.statement)
				return statement === s.statement ? s : { ...s, statement }
			}
			case "whenAbsent": {
				const probe = this.performQuery(s.probe)
				const body = mapNonEmptyKept(s.body, (b) => this.plStatement(b))
				return probe === s.probe && body === s.body ? s : { ...s, probe, body }
			}
			case "case": {
				const operand = this.expr(s.operand)
				const whens = mapNonEmptyKept(s.whens, (w) => {
					const values = mapNonEmptyKept(w.values, (v) => this.expr(v))
					const body = this.plStatements(w.body)
					return values === w.values && body === w.body ? w : { ...w, values, body }
				})
				return operand === s.operand && whens === s.whens ? s : { ...s, operand, whens }
			}
			case "raise": {
				const using = mapList(s.using, (o) => this.raiseOption(o))
				return using === s.using ? s : { ...s, using }
			}
		}
	}

	plBlock(b: PlBlock): PlBlock {
		const declare = mapList(b.declare, (d) => this.plDeclaration(d))
		const body = mapNonEmptyKept(b.body, (s) => this.plStatement(s))
		return declare === b.declare && body === b.body ? b : { ...b, declare, body }
	}

	functionParam(p: FunctionParam): FunctionParam {
		const type = this.type(p.type)
		return type === p.type ? p : { ...p, type }
	}

	createFunction(s: CreateFunction): CreateFunction {
		const name = this.name(s.name, "function")
		switch (s.language) {
			case "plpgsql": {
				const body = this.plBlock(s.body)
				if (s.returns === "trigger") {
					return name === s.name && body === s.body ? s : { ...s, name, body }
				}
				const params = mapList(s.params, (p) => this.functionParam(p))
				return name === s.name && params === s.params && body === s.body
					? s
					: { ...s, name, params, body }
			}
			case "sql": {
				const params = mapList(s.params, (p) => this.functionParam(p))
				const body = this.expr(s.body)
				return name === s.name && params === s.params && body === s.body
					? s
					: { ...s, name, params, body }
			}
		}
	}

	readonly ddl = (s: Ddl): Ddl => {
		switch (s.kind) {
			case "createSchema":
			case "createRole":
			case "alterRole":
			case "grantRole":
			case "revokeRole":
			case "alterDefaultPrivileges":
				return s
			case "createTable": {
				const table = this.name(s.table, "relation")
				const columns = mapNonEmptyKept(s.columns, (c) => this.columnDef(c))
				const key = this.constraintName(s.table, s.primaryKey.name)
				const primaryKey = key === s.primaryKey.name ? s.primaryKey : { ...s.primaryKey, name: key }
				const secondary = mapList(s.secondary, (c) => this.inlineConstraint(c, s.table))
				return table === s.table &&
					columns === s.columns &&
					primaryKey === s.primaryKey &&
					secondary === s.secondary
					? s
					: { ...s, table, columns, primaryKey, secondary }
			}
			case "alterTable":
				return this.alterTable(s)
			case "rename": {
				if (s.object === "ROLE" || s.object === "SCHEMA") {
					return s
				}
				const name = this.name(s.name, objectSpace(s.object))
				return name === s.name ? s : { ...s, name }
			}
			case "renameColumn":
			case "dropTrigger": {
				const table = this.name(s.table, "relation")
				return table === s.table ? s : { ...s, table }
			}
			case "renameConstraint": {
				const table = this.name(s.table, "relation")
				const from = this.constraintName(s.table, s.from)
				const to = this.constraintName(s.table, s.to)
				return table === s.table && from === s.from && to === s.to ? s : { ...s, table, from, to }
			}
			case "createDomain":
				return this.createDomain(s)
			case "alterDomain":
				return this.alterDomain(s)
			case "dropIndex": {
				const name = this.name(s.name, "relation")
				return name === s.name ? s : { ...s, name }
			}
			case "drop": {
				if (s.object === "ROLE" || s.object === "SCHEMA") {
					return s
				}
				const name = this.name(s.name, objectSpace(s.object))
				return name === s.name ? s : { ...s, name }
			}
			case "dropFunction": {
				const name = this.functionName(s.name)
				return name === s.name ? s : { ...s, name }
			}
			case "createIndex":
				return this.createIndex(s)
			case "createMaterializedView":
			case "createView": {
				const name = this.name(s.name, "relation")
				const query = this.setQuery(s.query)
				return name === s.name && query === s.query ? s : { ...s, name, query }
			}
			case "createPolicy": {
				const table = this.name(s.table, "relation")
				const filter = this.expr(s.filter)
				return table === s.table && filter === s.filter ? s : { ...s, table, filter }
			}
			case "dropPolicy":
			case "grantColumns": {
				const table = this.name(s.table, "relation")
				return table === s.table ? s : { ...s, table }
			}
			case "createFunction":
				return this.createFunction(s)
			case "packConstant": {
				const fn = this.name(s.function, "function")
				return fn === s.function ? s : { ...s, function: fn }
			}
			case "createConstant": {
				const name = this.name(s.name, "function")
				const params = mapList(s.params, (p) => this.functionParam(p))
				const returns = this.type(s.returns)
				const body = this.expr(s.body)
				return name === s.name && params === s.params && returns === s.returns && body === s.body
					? s
					: { ...s, name, params, returns, body }
			}
			case "createGuardTrigger": {
				const table = this.name(s.table, "relation")
				const fn = this.name(s.function, "function")
				return table === s.table && fn === s.function ? s : { ...s, table, function: fn }
			}
			case "createConstraintTrigger": {
				const table = this.name(s.table, "relation")
				const fn = this.name(s.function, "function")
				return table === s.table && fn === s.function ? s : { ...s, table, function: fn }
			}
			case "createPublication": {
				const tables = mapList(s.tables, (p) => {
					const table = this.name(p.table, "relation")
					return table === p.table ? p : { ...p, table }
				})
				return tables === s.tables ? s : { ...s, tables }
			}
			case "createLiveSecret": {
				const table = this.name(s.table, "relation")
				return table === s.table ? s : { ...s, table }
			}
			case "dropPublication":
			case "alterDatabaseDefault":
				return s
			case "grant":
			case "revoke": {
				const on = this.grantObjects(s.on)
				return on === s.on ? s : { ...s, on }
			}
			case "createExtension":
				return this.#extension(s)
			case "createStatistics": {
				const name = this.name(s.name, "statistics")
				const table = this.name(s.table, "relation")
				return name === s.name && table === s.table ? s : { ...s, name, table }
			}
			case "lockTable": {
				const tables = this.names(s.tables, "relation")
				return tables === s.tables ? s : { ...s, tables }
			}
			case "comment": {
				const on = this.commentTarget(s.on)
				return on === s.on ? s : { ...s, on }
			}
		}
	}

	/** What a COMMENT names, its schema objects through the name hook. */
	readonly commentTarget = (on: CommentTarget): CommentTarget => {
		switch (on.kind) {
			case "SCHEMA":
			case "ROLE":
				return on
			case "TABLE":
			case "VIEW":
			case "MATERIALIZED VIEW":
			case "SEQUENCE":
			case "INDEX": {
				const name = this.name(on.name, "relation")
				return name === on.name ? on : { ...on, name }
			}
			case "DOMAIN": {
				const name = this.name(on.name, "type")
				return name === on.name ? on : { ...on, name }
			}
			case "STATISTICS": {
				const name = this.name(on.name, "statistics")
				return name === on.name ? on : { ...on, name }
			}
			case "COLUMN": {
				const relation = this.name(on.relation, "relation")
				return relation === on.relation ? on : { ...on, relation }
			}
			case "CONSTRAINT": {
				const table = this.name(on.on, "relation")
				const name = this.constraintName(on.on, on.name)
				return table === on.on && name === on.name ? on : { ...on, name, on: table }
			}
			case "TRIGGER":
			case "POLICY": {
				const table = this.name(on.on, "relation")
				return table === on.on ? on : { ...on, on: table }
			}
			case "DOMAIN CONSTRAINT": {
				const domain = this.name(on.domain, "type")
				return domain === on.domain ? on : { ...on, domain }
			}
			case "FUNCTION": {
				const name = this.functionName(on.name)
				return name === on.name ? on : { ...on, name }
			}
		}
	}

	readonly statement = (s: SqlStatement): SqlStatement => {
		switch (s.kind) {
			case "select":
			case "insert":
			case "update":
			case "delete":
			case "merge":
				return this.dml(s)
			case "beginRead":
			case "beginWrite":
			case "commit":
			case "rollback":
			case "setConstraintsImmediate":
				return s
			case "refresh": {
				const view = this.name(s.view, "relation")
				return view === s.view ? s : { ...s, view }
			}
			case "createCarrier": {
				const columns = mapList(s.columns, (c) => this.columnDef(c))
				return columns === s.columns ? s : { ...s, columns }
			}
			case "analyze":
				return s
			case "alterDatabaseDefault":
			case "alterDefaultPrivileges":
			case "alterDomain":
			case "alterRole":
			case "alterTable":
			case "comment":
			case "createConstant":
			case "createDomain":
			case "createExtension":
			case "createFunction":
			case "createGuardTrigger":
			case "createConstraintTrigger":
			case "createPublication":
			case "dropPublication":
			case "createLiveSecret":
			case "createIndex":
			case "createMaterializedView":
			case "createPolicy":
			case "createRole":
			case "createSchema":
			case "createStatistics":
			case "createTable":
			case "createView":
			case "drop":
			case "dropFunction":
			case "dropIndex":
			case "dropPolicy":
			case "dropTrigger":
			case "grant":
			case "grantColumns":
			case "grantRole":
			case "lockTable":
			case "packConstant":
			case "rename":
			case "renameColumn":
			case "renameConstraint":
			case "revoke":
			case "revokeRole":
				return this.ddl(s)
		}
	}
}

export const transformExpr = (e: Expr, hooks: AstHooks): Expr => new Transform(hooks).expr(e)
export const transformSelect = (s: Select, hooks: AstHooks): Select =>
	new Transform(hooks).setQuery(s)
export const transformCreateIndex = (s: CreateIndex, hooks: AstHooks): CreateIndex =>
	new Transform(hooks).createIndex(s)

export const transformStatement = (s: SqlStatement, hooks: AstHooks): SqlStatement =>
	new Transform(hooks).statement(s)

/**
 * The parameters a statement binds: its highest placeholder, a value's `$n` or a relation input's array or count, 0 for
 * none, which is the count PostgreSQL gives the statement and a Bind message must supply. A function body's placeholders are its
 * arguments, which a CREATE FUNCTION binds none of and PostgreSQL allows 100 of, so they never raise the count past any
 * bound. Every hook returns the node it sees, so nothing is rebuilt.
 */
export const statementParams = (statement: SqlStatement): number => {
	let highest = 0
	new Transform({
		...identityHooks,
		expr: (e) => {
			if (e.kind === "param") {
				highest = Math.max(highest, e.slot.number)
			}
			return e
		},
		fromSource: (source) => {
			if (source.kind === "arrays") {
				const arrays = source.source
				const numbers =
					arrays.kind === "count"
						? [arrays.count.number]
						: arrays.columns.map((c) => c.array.number)
				highest = maxOf(numbers, highest)
			}
			return source
		}
	}).statement(statement)
	return highest
}

/** A list of statements, rebuilt statement by statement: the same list when no statement changed. */
export const transformStatements = (
	list: ReadonlyArray<SqlStatement>,
	hooks: AstHooks
): ReadonlyArray<SqlStatement> => mapList(list, new Transform(hooks).statement)

/**
 * visitSelect reaches every expression, FROM item, WITH clause and set operation of a query, outermost first, data-modifying
 * CTE bodies included. Within a node it descends into the children in the order of the node's own keys, so the visit
 * order is that of a structural walk over the AST as plain data: the refined casts' agreement (lower/shapes/refined)
 * memoizes what it learns in the order it meets the sites, so the order is part of its result. Every hook is stated: a
 * visit spreads inertVisitor and states the hooks it uses.
 */
interface AstVisitor {
	readonly expr: (e: Expr) => void
	readonly fromItem: (item: FromItem) => void
	readonly with: (w: With) => void
	readonly setOp: (body: SetOperation) => void
}

const ignore = (): void => undefined

/** Every hook does nothing. */
export const inertVisitor: AstVisitor = {
	expr: ignore,
	fromItem: ignore,
	with: ignore,
	setOp: ignore
}

type Step = () => void

/** The child steps of one node, run in the order of the node's keys. */
const inKeyOrder = (
	keys: ReadonlyArray<string>,
	steps: ReadonlyArray<readonly [string, Step | undefined]>
): undefined => {
	const byKey = new Map<string, Step>()
	for (const [key, step] of steps) {
		if (step !== undefined) {
			byKey.set(key, step)
		}
	}
	for (const key of keys) {
		byKey.get(key)?.()
	}
}

const each =
	<A>(list: ReadonlyArray<A>, f: (a: A) => void): Step =>
	() => {
		for (const a of list) {
			f(a)
		}
	}

const maybe = <A>(value: A | undefined, f: (a: A) => void): Step | undefined =>
	value === undefined
		? undefined
		: () => {
				f(value)
			}

class Visit {
	readonly #v: AstVisitor
	constructor(v: AstVisitor) {
		this.#v = v
	}

	select(s: OperandSelect): undefined {
		inKeyOrder(Object.keys(s), [
			[
				"with",
				maybe(s.with, (w) => {
					this.with(w)
				})
			],
			[
				"body",
				() => {
					this.body(s.body)
				}
			],
			[
				"orderBy",
				() => {
					this.orderItems(s.orderBy)
				}
			],
			[
				"limit",
				maybe(s.limit, (e) => {
					this.expr(e)
				})
			],
			[
				"offset",
				maybe(s.offset, (e) => {
					this.expr(e)
				})
			]
		])
	}

	with(w: With): undefined {
		this.#v.with(w)
		inKeyOrder(Object.keys(w), [
			[
				"ctes",
				each(w.ctes, (c) => {
					this.cte(c)
				})
			]
		])
	}

	cte(c: Cte): undefined {
		inKeyOrder(Object.keys(c), [
			[
				"query",
				() => {
					this.cteBody(c.query)
				}
			]
		])
	}

	cteBody(b: CteBody): undefined {
		switch (b.kind) {
			case "select": {
				this.select(b)
				return
			}
			case "insert": {
				this.insert(b)
				return
			}
			case "update": {
				this.update(b)
				return
			}
			case "delete": {
				this.delete(b)
				return
			}
			case "merge": {
				this.merge(b)
				return
			}
		}
	}

	body(b: OperandBody): undefined {
		switch (b.kind) {
			case "core": {
				this.core(b)
				return
			}
			case "setOp":
				this.#v.setOp(b)
				inKeyOrder(Object.keys(b), [
					[
						"arms",
						each(b.arms, (arm) => {
							this.body(arm)
						})
					]
				])
				return
			case "select": {
				this.select(b)
				return
			}
		}
	}

	core(c: SelectCore): undefined {
		const distinct = c.distinct
		inKeyOrder(Object.keys(c), [
			[
				"distinct",
				typeof distinct === "boolean"
					? undefined
					: () => {
							inKeyOrder(Object.keys(distinct), [
								[
									"on",
									each(distinct.on, (e) => {
										this.expr(e)
									})
								]
							])
						}
			],
			[
				"targets",
				each(c.targets, (t) => {
					this.target(t)
				})
			],
			["from", this.fromItems(c.from)],
			[
				"where",
				maybe(c.where, (e) => {
					this.expr(e)
				})
			],
			["groupBy", this.exprs(c.groupBy)],
			[
				"having",
				maybe(c.having, (e) => {
					this.expr(e)
				})
			]
		])
	}

	target(t: Target): undefined {
		inKeyOrder(Object.keys(t), [
			[
				"expr",
				() => {
					this.expr(t.expr)
				}
			]
		])
	}

	orderItems(items: ReadonlyArray<OrderItem>): undefined {
		for (const o of items) {
			inKeyOrder(Object.keys(o), [
				[
					"expr",
					() => {
						this.expr(o.expr)
					}
				]
			])
		}
	}

	fromItem(item: FromItem): undefined {
		this.#v.fromItem(item)
		const keys = Object.keys(item)
		switch (item.kind) {
			case "table":
			case "cte":
			case "enclosing":
			case "arrays":
			case "context":
				return
			case "probe": {
				inKeyOrder(keys, [
					[
						"by",
						() => {
							this.probeColumns(item.by.columns)
						}
					],
					[
						"filter",
						each(item.filter, (e) => {
							this.expr(e)
						})
					]
				])
				return
			}
			case "met": {
				inKeyOrder(keys, [
					[
						"filter",
						each(item.filter, (e) => {
							this.expr(e)
						})
					]
				])
				return
			}
			case "metRows":
				return
			case "derived": {
				inKeyOrder(keys, [
					[
						"query",
						() => {
							this.select(item.query)
						}
					]
				])
				return
			}
			case "function": {
				inKeyOrder(keys, [
					[
						"call",
						() => {
							this.expr(item.call)
						}
					]
				])
				return
			}
			case "values": {
				inKeyOrder(keys, [
					[
						"rows",
						each(item.rows, (row) => {
							for (const e of row) {
								this.expr(e)
							}
						})
					]
				])
				return
			}
			case "joins": {
				inKeyOrder(keys, [
					[
						"first",
						() => {
							this.fromItem(item.first)
						}
					],
					[
						"steps",
						each(item.steps, (step) => {
							inKeyOrder(Object.keys(step), [
								[
									"source",
									() => {
										this.fromItem(step.source)
									}
								],
								[
									"on",
									step.kind === "on"
										? () => {
												this.expr(step.on)
											}
										: undefined
								]
							])
						})
					]
				])
				return
			}
		}
	}

	exprs(list: ReadonlyArray<Expr>): Step {
		return each(list, (e) => {
			this.expr(e)
		})
	}

	expr(e: Expr): undefined {
		this.#v.expr(e)
		const keys = Object.keys(e)
		switch (e.kind) {
			case "cast":
			case "collate":
			case "negate":
			case "not":
			case "isTrue":
			case "complement": {
				inKeyOrder(keys, [
					[
						"expr",
						() => {
							this.expr(e.expr)
						}
					]
				])
				return
			}
			case "nullif": {
				inKeyOrder(keys, [
					[
						"expr",
						() => {
							this.expr(e.expr)
						}
					],
					[
						"absent",
						() => {
							this.expr(e.absent)
						}
					]
				])
				return
			}
			case "subscript": {
				inKeyOrder(keys, [
					[
						"array",
						() => {
							this.expr(e.array)
						}
					],
					[
						"index",
						() => {
							this.expr(e.index)
						}
					]
				])
				return
			}
			case "binary": {
				inKeyOrder(keys, [
					[
						"left",
						() => {
							this.expr(e.left)
						}
					],
					[
						"right",
						() => {
							this.expr(e.right)
						}
					]
				])
				return
			}
			case "and":
			case "or":
			case "greatest":
			case "least":
			case "coalesce": {
				inKeyOrder(keys, [["args", this.exprs(e.args)]])
				return
			}
			case "between": {
				inKeyOrder(keys, [
					[
						"expr",
						() => {
							this.expr(e.expr)
						}
					],
					[
						"low",
						() => {
							this.expr(e.low)
						}
					],
					[
						"high",
						() => {
							this.expr(e.high)
						}
					]
				])
				return
			}
			case "inList": {
				inKeyOrder(keys, [
					[
						"expr",
						() => {
							this.expr(e.expr)
						}
					],
					["list", this.exprs(e.list)]
				])
				return
			}
			case "inQuery": {
				inKeyOrder(keys, [
					[
						"expr",
						() => {
							this.expr(e.expr)
						}
					],
					[
						"query",
						() => {
							this.select(e.query)
						}
					]
				])
				return
			}
			case "exists":
			case "subquery":
			case "array": {
				inKeyOrder(keys, [
					[
						"query",
						() => {
							this.select(e.query)
						}
					]
				])
				return
			}
			case "row": {
				inKeyOrder(keys, [["items", this.exprs(e.items)]])
				return
			}
			case "case": {
				inKeyOrder(keys, [
					[
						"operand",
						maybe(e.operand, (x) => {
							this.expr(x)
						})
					],
					[
						"whens",
						each(e.whens, (w) => {
							inKeyOrder(Object.keys(w), [
								[
									"when",
									() => {
										this.expr(w.when)
									}
								],
								[
									"result",
									() => {
										this.expr(w.result)
									}
								]
							])
						})
					],
					[
						"else",
						() => {
							this.expr(e.else)
						}
					]
				])
				return
			}
			case "call": {
				this.call(e, keys)
				return
			}
			case "column":
			case "excluded":
			case "returning":
			case "param":
			case "clock":
			case "literal":
			case "mergeAction":
			case "domainValue":
			case "user":
			case "plVar":
			case "plSpecial":
			case "field":
			case "regclass":
				return
		}
	}

	call(c: FunctionCall, keys: ReadonlyArray<string>): undefined {
		inKeyOrder(keys, [
			["args", this.exprs(c.args)],
			...(c.star
				? [
						[
							"filter",
							maybe(c.filter, (e) => {
								this.expr(e)
							})
						] as const
					]
				: [
						[
							"orderBy",
							() => {
								this.orderItems(c.orderBy)
							}
						] as const,
						[
							"withinGroup",
							() => {
								this.orderItems(c.withinGroup)
							}
						] as const
					]),
			[
				"over",
				maybe(c.over, (w) => {
					this.window(w)
				})
			]
		])
	}

	window(w: WindowSpec): undefined {
		inKeyOrder(Object.keys(w), [
			["partitionBy", this.exprs(w.partitionBy)],
			[
				"orderBy",
				() => {
					this.orderItems(w.orderBy)
				}
			]
		])
	}

	targets(list: ReadonlyArray<Target>): Step {
		return each(list, (t) => {
			this.target(t)
		})
	}

	assignments(list: ReadonlyArray<Assignment>): Step {
		return each(list, (a) => {
			inKeyOrder(Object.keys(a), [
				[
					"value",
					() => {
						this.expr(a.value)
					}
				]
			])
		})
	}

	fromItems(list: ReadonlyArray<FromItem>): Step {
		return each(list, (i) => {
			this.fromItem(i)
		})
	}

	probeColumns(list: ReadonlyArray<ProbeColumn>): undefined {
		each(list, (c) => {
			inKeyOrder(Object.keys(c), [
				[
					"value",
					() => {
						this.expr(c.value)
					}
				]
			])
		})()
	}

	conflictAction(a: ConflictAction): undefined {
		const keys = Object.keys(a)
		switch (a.kind) {
			case "doNothing":
				return
			case "doSelect": {
				inKeyOrder(keys, [
					[
						"where",
						maybe(a.where, (e) => {
							this.expr(e)
						})
					]
				])
				return
			}
			case "doUpdate": {
				inKeyOrder(keys, [
					["set", this.assignments(a.set)],
					[
						"where",
						maybe(a.where, (e) => {
							this.expr(e)
						})
					]
				])
				return
			}
		}
	}

	insert(i: Insert): undefined {
		const source = i.source
		inKeyOrder(Object.keys(i), [
			[
				"with",
				maybe(i.with, (w) => {
					this.with(w)
				})
			],
			[
				"source",
				() => {
					if (source.kind === "query") {
						inKeyOrder(Object.keys(source), [
							[
								"query",
								() => {
									this.select(source.query)
								}
							]
						])
					} else {
						inKeyOrder(Object.keys(source), [
							[
								"rows",
								each(source.rows, (row) => {
									this.exprs(row)()
								})
							]
						])
					}
				}
			],
			[
				"onConflict",
				maybe(i.onConflict, (c) => {
					inKeyOrder(Object.keys(c), [
						[
							"action",
							() => {
								this.conflictAction(c.action)
							}
						]
					])
				})
			],
			["returning", this.targets(i.returning)]
		])
	}

	update(u: Update): undefined {
		inKeyOrder(Object.keys(u), [
			[
				"with",
				maybe(u.with, (w) => {
					this.with(w)
				})
			],
			["set", this.assignments(u.set)],
			["from", this.fromItems(u.from)],
			[
				"where",
				maybe(u.where, (e) => {
					this.expr(e)
				})
			],
			["returning", this.targets(u.returning)]
		])
	}

	delete(d: Delete): undefined {
		inKeyOrder(Object.keys(d), [
			[
				"with",
				maybe(d.with, (w) => {
					this.with(w)
				})
			],
			["using", this.fromItems(d.using)],
			[
				"where",
				maybe(d.where, (e) => {
					this.expr(e)
				})
			],
			["returning", this.targets(d.returning)]
		])
	}

	mergeWhen(w: MergeWhen): undefined {
		const action = w.action
		inKeyOrder(Object.keys(w), [
			[
				"condition",
				maybe(w.condition, (e) => {
					this.expr(e)
				})
			],
			[
				"action",
				() => {
					if (action.kind === "update") {
						inKeyOrder(Object.keys(action), [["set", this.assignments(action.set)]])
					} else if (action.kind === "insert") {
						inKeyOrder(Object.keys(action), [["row", this.assignments(action.row)]])
					}
				}
			]
		])
	}

	merge(m: Merge): undefined {
		inKeyOrder(Object.keys(m), [
			[
				"with",
				maybe(m.with, (w) => {
					this.with(w)
				})
			],
			[
				"using",
				() => {
					this.fromItem(m.using)
				}
			],
			[
				"on",
				() => {
					this.expr(m.on)
				}
			],
			[
				"whens",
				each(m.whens, (w) => {
					this.mergeWhen(w)
				})
			],
			["returning", this.targets(m.returning)]
		])
	}
}

/** Every expression, FROM item, WITH clause and set operation of a query, outermost first. */
export const visitSelect = (query: OperandSelect, visitor: AstVisitor): undefined => {
	new Visit(visitor).select(query)
}
