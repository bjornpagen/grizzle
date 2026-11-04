import type {
	AlterDomainAction,
	AlterTableAction,
	Assignment,
	Collation,
	ColumnDef,
	ColumnDefinition,
	ColumnGeneration,
	CommentTarget,
	ConflictAction,
	CreateFunction,
	Cte,
	CteBody,
	Delete,
	DomainConstraint,
	Expr,
	ForeignKeyColumn,
	FrameBound,
	FromItem,
	FunctionCall,
	FunctionName,
	FunctionRef,
	GrantObjects,
	Grantee,
	IndexKey,
	Insert,
	InsertSource,
	KeyColumn,
	Merge,
	MergeWhen,
	ObjectName,
	OnConflict,
	OrderItem,
	PerformQuery,
	PlBlock,
	PlRecord,
	PlStatement,
	RoleSetting,
	Select,
	SelectBody,
	SelectCore,
	SqlStatement,
	TableConstraint,
	TableName,
	Target,
	TriggerEvent,
	TypeRef,
	Update,
	Using,
	WindowSpec,
	With
} from "#compiler/sql/ast.ts"

/**
 * The JSON form of a SQL statement, as a committed snapshot.json records its DDL (deploy/snapshot): the form the
 * shell's codec (adapter/boundary/sql.ts) decodes. An int literal's value and a frame offset stay bigints, which the
 * snapshot's JSON writer spells.
 */
export type SqlForm = string | number | boolean | bigint | ReadonlyArray<SqlForm> | SqlFormObject

/** A form's object: its keys in the order the codec declares them. */
export interface SqlFormObject {
	readonly [key: string]: SqlForm
}

/**
 * The form leaves out every clause that is none: an empty list, a false flag, an undefined clause and the default
 * ascending order, so a statement has exactly one spelling. Each object's keys are in the codec's declaration order,
 * and only the keys the codec declares are written. These helpers each write one clause's key, or nothing.
 */
const nothing: SqlFormObject = {}

/** A list clause: written when nonempty. */
const list = <A>(key: string, items: ReadonlyArray<A>, form: (item: A) => SqlForm): SqlFormObject =>
	items.length === 0 ? nothing : { [key]: items.map((item) => form(item)) }

/** A single clause: written when stated. */
const maybe = <A>(key: string, value: A | undefined, form: (value: A) => SqlForm): SqlFormObject =>
	value === undefined ? nothing : { [key]: form(value) }

/** A flag: written only when true. */
const flag = (key: string, value: boolean): SqlFormObject => (value ? { [key]: true } : nothing)

/** An order direction: DESC written, ASC, the default, left out. */
const direction = (value: "ASC" | "DESC"): SqlFormObject =>
	value === "DESC" ? { direction: value } : nothing

/** A function's parallel safety: SAFE written, UNSAFE, PostgreSQL's default, left out. */
const parallel = (value: CreateFunction["parallel"]): SqlFormObject =>
	value === "SAFE" ? { parallel: value } : nothing

/** A value the form holds as it is: an identifier, a label, a number. */
const same = (value: string | number): SqlForm => value

const objectName = (name: ObjectName): SqlForm => ({ schema: name.schema, name: name.name })

const tableName = (name: TableName): SqlForm => (typeof name === "string" ? name : objectName(name))

const collation = (c: Collation): SqlForm => ({ schema: c.schema, name: c.name })

const roleSetting = (setting: RoleSetting): SqlForm =>
	setting.parameter === "search_path"
		? { parameter: setting.parameter }
		: { parameter: setting.parameter, value: setting.value }

/** The type a recordset's placeholder is cast to, jsonb, as typeRef writes it. */
const jsonbForm: SqlForm = { kind: "builtin", name: "jsonb" }

const typeRef = (t: TypeRef): SqlForm => {
	if (t.kind === "named") {
		return {
			kind: t.kind,
			schema: t.schema,
			name: t.name,
			...list("typmod", t.typmod, same),
			...flag("array", t.array)
		}
	}
	if (t.precision === undefined) {
		return { kind: t.kind, name: t.name, ...flag("array", t.array) }
	}
	return {
		kind: t.kind,
		name: t.name,
		precision: t.precision,
		...maybe("scale", t.scale, same),
		...flag("array", t.array)
	}
}

const functionRef = (fn: FunctionRef): SqlForm =>
	fn.kind === "builtin"
		? { kind: fn.kind, name: fn.name }
		: { kind: fn.kind, schema: fn.schema, name: fn.name }

const orderItem = (item: OrderItem): SqlForm => ({
	expr: expr(item.expr),
	...direction(item.direction)
})

const frameBound = (bound: FrameBound): SqlForm =>
	bound.kind === "offset"
		? { kind: bound.kind, offset: bound.offset, direction: bound.direction }
		: { kind: bound.kind }

const windowSpec = (w: WindowSpec): SqlForm => ({
	...list("partitionBy", w.partitionBy, expr),
	...list("orderBy", w.orderBy, orderItem),
	...maybe("frame", w.frame, (frame) => ({
		start: frameBound(frame.start),
		end: frameBound(frame.end)
	}))
})

const functionCall = (call: FunctionCall): SqlForm => {
	if (call.star) {
		return {
			kind: call.kind,
			fn: { kind: call.fn.kind, name: call.fn.name },
			args: [],
			star: true,
			...maybe("filter", call.filter, expr),
			...maybe("over", call.over, windowSpec)
		}
	}
	return {
		kind: call.kind,
		fn: functionRef(call.fn),
		args: call.args.map(expr),
		...flag("distinct", call.distinct),
		...list("orderBy", call.orderBy, orderItem),
		...list("withinGroup", call.withinGroup, orderItem),
		...maybe("over", call.over, windowSpec)
	}
}

const plRecord = (record: PlRecord): SqlForm => ({ kind: record.kind, name: record.name })

const expr = (e: Expr): SqlForm => {
	switch (e.kind) {
		case "column":
			return { kind: e.kind, ...maybe("table", e.table, same), column: e.column }
		case "excluded":
			return { kind: e.kind, column: e.column }
		case "returning":
			return { kind: e.kind, side: e.side, column: e.column }
		case "param":
			return { kind: e.kind, index: e.slot.number, type: typeRef(e.type) }
		case "literal":
			return {
				kind: e.kind,
				value: { kind: e.value.kind, value: e.value.value },
				type: typeRef(e.type)
			}
		case "cast":
			return { kind: e.kind, expr: expr(e.expr), type: typeRef(e.type) }
		case "collate":
			return { kind: e.kind, expr: expr(e.expr), collation: collation(e.collation) }
		case "binary":
			return {
				kind: e.kind,
				op: e.op,
				left: expr(e.left),
				right: expr(e.right),
				...maybe("schema", e.schema, same)
			}
		case "negate":
		case "not":
		case "isTrue":
			return { kind: e.kind, expr: expr(e.expr) }
		case "and":
		case "or":
		case "greatest":
		case "least":
			return { kind: e.kind, args: e.args.map(expr) }
		case "between":
			return {
				kind: e.kind,
				expr: expr(e.expr),
				low: expr(e.low),
				high: expr(e.high),
				...flag("not", e.not)
			}
		case "inList":
			return { kind: e.kind, expr: expr(e.expr), list: e.list.map(expr), ...flag("not", e.not) }
		case "inQuery":
			return { kind: e.kind, expr: expr(e.expr), query: select(e.query), ...flag("not", e.not) }
		case "exists":
			return { kind: e.kind, query: select(e.query), ...flag("not", e.not) }
		case "subquery":
		case "array":
			return { kind: e.kind, query: select(e.query) }
		case "row":
			return { kind: e.kind, items: e.items.map(expr) }
		case "case":
			return {
				kind: e.kind,
				...maybe("operand", e.operand, expr),
				whens: e.whens.map((w) => ({ when: expr(w.when), result: expr(w.result) })),
				else: expr(e.else)
			}
		case "call":
			return functionCall(e)
		case "mergeAction":
		case "domainValue":
			return { kind: e.kind }
		case "user":
			return { kind: e.kind, name: e.name }
		case "plVar":
		case "plSpecial":
			return { kind: e.kind, name: e.name }
		case "field":
			return { kind: e.kind, record: plRecord(e.record), field: e.field }
		case "regclass":
			return { kind: e.kind, relation: objectName(e.relation) }
	}
}

const target = (t: Target): SqlForm => ({ expr: expr(t.expr), ...maybe("alias", t.alias, same) })

const columnDefinition = (c: ColumnDefinition): SqlForm => ({
	name: c.name,
	type: typeRef(c.type),
	...maybe("collation", c.collation, collation)
})

const rows = (values: ReadonlyArray<ReadonlyArray<Expr>>): SqlForm =>
	values.map((row) => row.map(expr))

const fromItem = (item: FromItem): SqlForm => {
	switch (item.kind) {
		case "table":
			return { kind: item.kind, table: tableName(item.table), alias: item.alias }
		case "cte":
			return { kind: item.kind, name: item.name, ...maybe("alias", item.alias, same) }
		case "enclosing":
			return { kind: item.kind, name: item.name, alias: item.alias }
		case "derived":
			return {
				kind: item.kind,
				query: select(item.query),
				alias: item.alias,
				columns: item.columns,
				...flag("lateral", item.lateral)
			}
		case "function":
			return {
				kind: item.kind,
				call: functionCall(item.call),
				alias: item.alias,
				columns: item.columns,
				...flag("lateral", item.lateral)
			}
		case "recordset":
			return {
				kind: item.kind,
				source: { kind: "param", index: item.source.number, type: jsonbForm },
				alias: item.alias,
				columns: item.columns.map(columnDefinition)
			}
		case "values":
			return { kind: item.kind, rows: rows(item.rows), alias: item.alias, columns: item.columns }
		case "context":
			return {
				kind: item.kind,
				context: item.context,
				columns: item.columns.map((c) => ({ field: c.field, column: columnDefinition(c.column) })),
				refusal: functionRef(item.refusal),
				alias: item.alias
			}
		case "joins":
			return {
				kind: item.kind,
				first: fromItem(item.first),
				steps: item.steps.map((step): SqlForm =>
					step.kind === "on"
						? { kind: step.kind, source: fromItem(step.source), on: expr(step.on) }
						: { kind: step.kind, source: fromItem(step.source) }
				)
			}
	}
}

/** DISTINCT, DISTINCT ON its expressions, or neither, which is left out. */
const distinct = (value: SelectCore["distinct"]): SqlFormObject =>
	value === false ? nothing : { distinct: value === true ? true : { on: value.on.map(expr) } }

const selectCore = (core: SelectCore): SqlForm => ({
	kind: core.kind,
	...distinct(core.distinct),
	targets: core.targets.map(target),
	...list("from", core.from, fromItem),
	...maybe("where", core.where, expr),
	...list("groupBy", core.groupBy, expr),
	...maybe("having", core.having, expr)
})

const selectBody = (body: SelectBody): SqlForm => {
	switch (body.kind) {
		case "core":
			return selectCore(body)
		case "setOp":
			return { kind: body.kind, op: body.op, arms: body.arms.map(selectBody) }
		case "select":
			return select(body)
	}
}

const cte = (c: Cte): SqlForm => ({
	name: c.name,
	...list("columns", c.columns, same),
	...maybe("materialized", c.materialized, same),
	query: cteBody(c.query)
})

const withClause = (w: With): SqlForm => ({
	...flag("recursive", w.recursive),
	ctes: w.ctes.map(cte)
})

const select = (s: Select): SqlForm => ({
	kind: s.kind,
	...maybe("with", s.with, withClause),
	body: selectBody(s.body),
	...list("orderBy", s.orderBy, orderItem),
	...maybe("limit", s.limit, expr),
	...maybe("offset", s.offset, expr)
})

/** A PERFORM's query: its core and its tail clauses, with no kind, since it is always one core. */
const performQuery = (q: PerformQuery): SqlForm => ({
	body: selectCore(q.body),
	...list("orderBy", q.orderBy, orderItem),
	...maybe("limit", q.limit, expr),
	...maybe("offset", q.offset, expr)
})

const assignment = (a: Assignment): SqlForm => ({ column: a.column, value: expr(a.value) })

const conflictAction = (action: ConflictAction): SqlForm => {
	switch (action.kind) {
		case "doNothing":
			return { kind: action.kind }
		case "doSelect":
			return { kind: action.kind, ...maybe("where", action.where, expr) }
		case "doUpdate":
			return {
				kind: action.kind,
				set: action.set.map(assignment),
				...maybe("where", action.where, expr)
			}
	}
}

const onConflict = (c: OnConflict): SqlForm =>
	c.kind === "columns"
		? { kind: c.kind, columns: c.columns, action: conflictAction(c.action) }
		: { kind: c.kind, constraint: c.constraint, action: { kind: c.action.kind } }

const insertSource = (source: InsertSource): SqlForm =>
	source.kind === "query"
		? { kind: source.kind, query: select(source.query) }
		: { kind: source.kind, rows: rows(source.rows) }

const insert = (s: Insert): SqlForm => ({
	kind: s.kind,
	...maybe("with", s.with, withClause),
	table: tableName(s.table),
	...maybe("alias", s.alias, same),
	columns: s.columns,
	...maybe("overriding", s.overriding, same),
	source: insertSource(s.source),
	...maybe("onConflict", s.onConflict, onConflict),
	...list("returning", s.returning, target)
})

const update = (s: Update): SqlForm => ({
	kind: s.kind,
	...maybe("with", s.with, withClause),
	table: objectName(s.table),
	alias: s.alias,
	set: s.set.map(assignment),
	...list("from", s.from, fromItem),
	...maybe("where", s.where, expr),
	...list("returning", s.returning, target)
})

const deleteStatement = (s: Delete): SqlForm => ({
	kind: s.kind,
	...maybe("with", s.with, withClause),
	table: tableName(s.table),
	alias: s.alias,
	...list("using", s.using, fromItem),
	...maybe("where", s.where, expr),
	...list("returning", s.returning, target)
})

const mergeAction = (action: MergeWhen["action"]): SqlForm => {
	switch (action.kind) {
		case "update":
			return { kind: action.kind, set: action.set.map(assignment) }
		case "insert":
			return {
				kind: action.kind,
				...maybe("overriding", action.overriding, same),
				row: action.row.map(assignment)
			}
		case "insertDefault":
		case "delete":
		case "doNothing":
			return { kind: action.kind }
	}
}

const mergeWhen = (when: MergeWhen): SqlForm => ({
	match: when.match,
	...maybe("condition", when.condition, expr),
	action: mergeAction(when.action)
})

const merge = (s: Merge): SqlForm => ({
	kind: s.kind,
	...maybe("with", s.with, withClause),
	table: objectName(s.table),
	alias: s.alias,
	using: fromItem(s.using),
	on: expr(s.on),
	whens: s.whens.map(mergeWhen),
	...list("returning", s.returning, target)
})

const cteBody = (body: CteBody): SqlForm => {
	switch (body.kind) {
		case "select":
			return select(body)
		case "insert":
			return insert(body)
		case "update":
			return update(body)
		case "delete":
			return deleteStatement(body)
		case "merge":
			return merge(body)
	}
}

const columnGeneration = (g: ColumnGeneration): SqlForm =>
	g.kind === "identity"
		? { kind: g.kind, sequence: objectName(g.sequence) }
		: { kind: g.kind, expr: expr(g.expr) }

const columnDef = (c: ColumnDef): SqlForm => ({
	name: c.name,
	type: typeRef(c.type),
	...maybe("collation", c.collation, collation),
	...maybe("generated", c.generated, columnGeneration)
})

const using = (u: Using): SqlForm =>
	u.kind === "expr" ? { kind: u.kind, expr: expr(u.expr) } : { kind: u.kind }

const keyColumn = (c: KeyColumn): SqlForm => ({
	column: c.column,
	...flag("withoutOverlaps", c.withoutOverlaps)
})

const foreignKeyColumn = (c: ForeignKeyColumn): SqlForm => ({
	column: c.column,
	...flag("period", c.period)
})

const tableConstraint = (c: TableConstraint): SqlForm => {
	switch (c.kind) {
		case "primaryKey":
		case "unique":
			return { kind: c.kind, name: c.name, columns: c.columns.map(keyColumn) }
		case "check":
			return { kind: c.kind, name: c.name, predicate: expr(c.predicate) }
		case "exclude":
			return {
				kind: c.kind,
				name: c.name,
				method: c.method,
				elements: c.elements.map((e) => ({ column: e.column, operator: e.operator }))
			}
		case "foreignKey":
			return {
				kind: c.kind,
				name: c.name,
				columns: c.columns.map(foreignKeyColumn),
				references: objectName(c.references),
				referencedColumns: c.referencedColumns.map(foreignKeyColumn),
				...maybe("deferrable", c.deferrable, same)
			}
	}
}

const domainConstraint = (c: DomainConstraint): SqlForm => ({
	name: c.name,
	predicate: expr(c.predicate)
})

const indexKey = (k: IndexKey): SqlForm => ({
	key:
		k.key.kind === "column"
			? { kind: k.key.kind, column: k.key.column }
			: { kind: k.key.kind, expr: expr(k.key.expr) },
	...maybe("collation", k.collation, collation),
	...maybe("opclass", k.opclass, objectName),
	...direction(k.direction)
})

const functionName = (name: FunctionName): SqlForm => ({
	schema: name.schema,
	name: name.name,
	args: name.args.map(typeRef)
})

/** What a COMMENT names, as data. */
const commentTarget = (on: CommentTarget): SqlForm => {
	switch (on.kind) {
		case "SCHEMA":
		case "ROLE":
			return { kind: on.kind, name: on.name }
		case "TABLE":
		case "VIEW":
		case "MATERIALIZED VIEW":
		case "TYPE":
		case "DOMAIN":
		case "SEQUENCE":
		case "INDEX":
		case "STATISTICS":
			return { kind: on.kind, name: objectName(on.name) }
		case "COLUMN":
			return { kind: on.kind, relation: objectName(on.relation), column: on.column }
		case "CONSTRAINT":
		case "TRIGGER":
		case "POLICY":
			return { kind: on.kind, name: on.name, on: objectName(on.on) }
		case "DOMAIN CONSTRAINT":
			return { kind: on.kind, name: on.name, domain: objectName(on.domain) }
		case "FUNCTION":
			return { kind: on.kind, name: functionName(on.name) }
	}
}

const triggerEvent = (event: TriggerEvent): SqlForm =>
	event.kind === "UPDATE" ? { kind: event.kind, of: event.of } : { kind: event.kind }

const grantObjects = (on: GrantObjects): SqlForm => {
	switch (on.kind) {
		case "TABLE":
		case "SEQUENCE":
		case "TYPE":
		case "DOMAIN":
			return { kind: on.kind, names: on.names.map(objectName) }
		case "SCHEMA":
			return { kind: on.kind, names: on.names }
		case "FUNCTION":
			return { kind: on.kind, names: on.names.map(functionName) }
	}
}

const grantee = (g: Grantee): SqlForm =>
	g.kind === "role" ? { kind: g.kind, name: g.name } : { kind: g.kind }

const plBody = (body: ReadonlyArray<PlStatement>): SqlForm => body.map(plStatement)

const plStatement = (s: PlStatement): SqlForm => {
	switch (s.kind) {
		case "if":
			return {
				kind: s.kind,
				branches: s.branches.map((b) => ({ condition: expr(b.condition), body: plBody(b.body) })),
				...list("else", s.else, plStatement)
			}
		case "assign":
			return { kind: s.kind, target: s.target, value: expr(s.value) }
		case "forQuery":
			return { kind: s.kind, variable: s.variable, query: select(s.query), body: plBody(s.body) }
		case "perform":
			return { kind: s.kind, query: performQuery(s.query) }
		case "whenAbsent":
			return { kind: s.kind, probe: performQuery(s.probe), body: plBody(s.body) }
		case "case":
			return {
				kind: s.kind,
				operand: expr(s.operand),
				whens: s.whens.map((w) => ({ values: w.values.map(expr), body: plBody(w.body) }))
			}
		case "raise":
			return {
				kind: s.kind,
				message: s.message,
				using: s.using.map((o) => ({ option: o.option, value: expr(o.value) }))
			}
		case "return":
			return { kind: s.kind, value: expr(s.value) }
	}
}

const plBlock = (block: PlBlock): SqlForm => ({
	declare: block.declare.map((d) => ({ name: d.name, type: typeRef(d.type) })),
	body: plBody(block.body)
})

const createFunction = (f: CreateFunction): SqlForm => {
	const params = f.params.map((p) => ({ name: p.name, type: typeRef(p.type) }))
	if (f.language === "plpgsql") {
		return {
			kind: f.kind,
			language: f.language,
			name: objectName(f.name),
			volatility: f.volatility,
			...parallel(f.parallel),
			security: f.security,
			planCacheMode: f.planCacheMode,
			body: plBlock(f.body),
			returns: f.returns,
			params
		}
	}
	return {
		kind: f.kind,
		language: f.language,
		name: objectName(f.name),
		volatility: f.volatility,
		...parallel(f.parallel),
		security: f.security,
		planCacheMode: f.planCacheMode,
		returns: f.returns,
		params,
		body: expr(f.body)
	}
}

/** A schema, role or schema-qualified object's name, as a rename or drop names it. */
const namedObject = (name: ObjectName | string): SqlForm =>
	typeof name === "string" ? name : objectName(name)

/**
 * A statement's JSON form: what the shell's codec encodes it to, written natively so the snapshot's fingerprint and
 * text stay engine functions. Total over every statement the AST admits.
 */
export const statementForm = (s: SqlStatement): SqlForm => {
	switch (s.kind) {
		case "select":
			return select(s)
		case "insert":
			return insert(s)
		case "update":
			return update(s)
		case "delete":
			return deleteStatement(s)
		case "merge":
			return merge(s)
		case "createSchema":
			return { kind: s.kind, name: s.name, ...maybe("authorization", s.authorization, same) }
		case "createTable":
			return {
				kind: s.kind,
				table: objectName(s.table),
				columns: s.columns.map(columnDef),
				primaryKey: tableConstraint(s.primaryKey),
				secondary: s.secondary.map(tableConstraint)
			}
		case "alterTable":
			return { kind: s.kind, table: objectName(s.table), actions: s.actions.map(alterTableAction) }
		case "rename":
			return { kind: s.kind, object: s.object, name: namedObject(s.name), to: s.to }
		case "renameColumn":
		case "renameConstraint":
			return { kind: s.kind, table: objectName(s.table), from: s.from, to: s.to }
		case "createDomain":
			return {
				kind: s.kind,
				name: objectName(s.name),
				base: typeRef(s.base),
				...maybe("collation", s.collation, collation),
				constraints: s.constraints.map(domainConstraint)
			}
		case "alterDomain":
			return { kind: s.kind, name: objectName(s.name), action: alterDomainAction(s.action) }
		case "createEnum":
			return { kind: s.kind, name: objectName(s.name), labels: s.labels }
		case "alterEnumAddValue":
			return {
				kind: s.kind,
				name: objectName(s.name),
				label: s.label,
				...flag("ifNotExists", s.ifNotExists),
				...maybe("position", s.position, (p) => ({ kind: p.kind, label: p.label }))
			}
		case "alterEnumRenameValue":
			return { kind: s.kind, name: objectName(s.name), from: s.from, to: s.to }
		case "createIndex":
			return {
				kind: s.kind,
				name: s.name,
				table: objectName(s.table),
				...flag("unique", s.unique),
				...flag("concurrently", s.concurrently),
				method: s.method,
				keys: s.keys.map(indexKey),
				...list("include", s.include, same),
				...maybe("where", s.where, expr)
			}
		case "dropIndex":
			return {
				kind: s.kind,
				name: objectName(s.name),
				...flag("concurrently", s.concurrently),
				...flag("ifExists", s.ifExists)
			}
		case "createMaterializedView":
			return { kind: s.kind, name: objectName(s.name), columns: s.columns, query: select(s.query) }
		case "createView":
			return {
				kind: s.kind,
				name: objectName(s.name),
				columns: s.columns,
				barrier: s.barrier,
				query: select(s.query)
			}
		case "createPolicy":
			return {
				kind: s.kind,
				name: s.name,
				table: objectName(s.table),
				role: s.role,
				filter: expr(s.filter)
			}
		case "dropPolicy":
			return { kind: s.kind, name: s.name, table: objectName(s.table) }
		case "drop":
			return {
				kind: s.kind,
				object: s.object,
				name: namedObject(s.name),
				...flag("ifExists", s.ifExists)
			}
		case "dropFunction":
			return { kind: s.kind, name: functionName(s.name), ...flag("ifExists", s.ifExists) }
		case "dropTrigger":
			return {
				kind: s.kind,
				name: s.name,
				table: objectName(s.table),
				...flag("ifExists", s.ifExists)
			}
		case "createFunction":
			return createFunction(s)
		case "createConstraintTrigger":
			return {
				kind: s.kind,
				name: s.name,
				table: objectName(s.table),
				event: triggerEvent(s.event),
				...maybe("when", s.when, expr),
				function: objectName(s.function)
			}
		case "createGuardTrigger":
			return {
				kind: s.kind,
				name: s.name,
				table: objectName(s.table),
				function: objectName(s.function)
			}
		case "alterDatabaseDefault":
			return { kind: s.kind, parameter: s.parameter, value: s.value }
		case "createRole":
			return { kind: s.kind, name: s.name, login: s.login }
		case "alterRole":
			return {
				kind: s.kind,
				name: s.name,
				action:
					s.action.kind === "set"
						? { kind: s.action.kind, setting: roleSetting(s.action.setting) }
						: { kind: s.action.kind, parameter: s.action.parameter }
			}
		case "grantRole":
			return { kind: s.kind, role: s.role, to: s.to }
		case "revokeRole":
			return { kind: s.kind, role: s.role, from: s.from }
		case "grant":
			return {
				kind: s.kind,
				privileges: s.privileges,
				on: grantObjects(s.on),
				to: s.to.map(grantee)
			}
		case "revoke":
			return {
				kind: s.kind,
				privileges: s.privileges,
				on: grantObjects(s.on),
				from: s.from.map(grantee)
			}
		case "grantColumns":
			return {
				kind: s.kind,
				privilege: s.privilege,
				table: objectName(s.table),
				columns: s.columns,
				to: s.to
			}
		case "alterDefaultPrivileges":
			return {
				kind: s.kind,
				...maybe("forRole", s.forRole, same),
				...maybe("inSchema", s.inSchema, same),
				privileges: s.privileges,
				on: s.on,
				from: s.from.map(grantee)
			}
		case "createExtension":
			return { kind: s.kind, name: s.name, schema: s.schema }
		case "createStatistics":
			return {
				kind: s.kind,
				name: objectName(s.name),
				statistics: s.statistics,
				columns: s.columns,
				table: objectName(s.table)
			}
		case "lockTable":
			return { kind: s.kind, tables: s.tables.map(objectName), mode: s.mode, wait: s.wait }
		case "comment":
			return { kind: s.kind, on: commentTarget(s.on), text: s.text }
		case "createCarrier":
			return { kind: s.kind, name: s.name, columns: s.columns.map(columnDef) }
		case "begin":
			return { kind: s.kind, ...flag("readOnly", s.readOnly) }
		case "commit":
		case "rollback":
			return { kind: s.kind }
		case "refresh":
			return { kind: s.kind, view: objectName(s.view), concurrently: s.concurrently }
		case "analyze":
			return { kind: s.kind, carriers: s.carriers }
	}
}

const alterTableAction = (action: AlterTableAction): SqlForm => {
	switch (action.kind) {
		case "addColumn":
		case "addColumnPlaceholder":
			return { kind: action.kind, column: columnDef(action.column) }
		case "dropColumn":
		case "dropDefault":
		case "dropIdentity":
			return { kind: action.kind, column: action.column }
		case "alterColumnType":
			return {
				kind: action.kind,
				column: action.column,
				type: typeRef(action.type),
				...maybe("collation", action.collation, collation),
				using: using(action.using)
			}
		case "addIdentity":
			return { kind: action.kind, column: action.column, sequence: objectName(action.sequence) }
		case "addConstraint":
			return {
				kind: action.kind,
				constraint: tableConstraint(action.constraint),
				...flag("notValid", action.notValid)
			}
		case "addConstraintUsingIndex":
			return {
				kind: action.kind,
				name: action.name,
				constraint: action.constraint,
				index: action.index
			}
		case "validateConstraint":
		case "dropConstraint":
			return { kind: action.kind, name: action.name }
		case "enableRowSecurity":
		case "disableRowSecurity":
			return { kind: action.kind }
	}
}

const alterDomainAction = (action: AlterDomainAction): SqlForm => {
	switch (action.kind) {
		case "addConstraint":
			return {
				kind: action.kind,
				constraint: domainConstraint(action.constraint),
				...flag("notValid", action.notValid)
			}
		case "validateConstraint":
		case "dropConstraint":
			return { kind: action.kind, name: action.name }
	}
}
