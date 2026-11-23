import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { alterationStatement, type Draft } from "#compiler/deploy/diff/plan.ts"
import { runnerStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { DraftFile } from "#compiler/deploy/phases/files.ts"
import type { RecordedStatement } from "#compiler/deploy/snapshot/recorded.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import {
	type AlterTableAction,
	type ColumnDef,
	type CteBody,
	type Expr,
	nameKey,
	type ObjectName,
	type OperandSelect,
	type PlBlock,
	type PlStatement,
	type SqlStatement,
	type TableConstraint,
	tableConstraints,
	type TypeRef
} from "#compiler/sql/ast.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"

/**
 * The locks a migration's transaction holds: what one transaction of `grizzle migrate` takes in PostgreSQL 19's shared
 * lock table and keeps until it ends, counted from its statements before any of them runs.
 *
 * PostgreSQL 19's lock table holds max_locks_per_transaction × (MaxBackends + max_prepared_transactions) locked objects
 * for every transaction of the server at once, and no more (lock.c NLOCKENTS, which sizes the LOCK hash with no margin
 * past it): a transaction that locks one object past what is left is refused with SQLSTATE 53200, "out of shared
 * memory", and rolls back. A transaction holds one entry per object it locks, whatever its modes on it (lock.c LOCK,
 * keyed by its LOCKTAG alone; the modes are one PROCLOCK's holdMask), and keeps every lock a statement took until it
 * ends, but a system catalog's, which the code that reads or writes a catalog takes and releases at once
 * (table_close(rel, RowExclusiveLock)). So a transaction's demand is the number of distinct objects its statements lock
 * and keep: what pg_locks lists of its backend, each object once, between any two of its statements.
 *
 * What a statement locks, by REL_19_0's code:
 *
 * - A relation it creates, ACCESS EXCLUSIVE (tablecmds.c DefineRelation, index.c index_create), with the TOAST table and
 *   TOAST index a table of a column that may be stored out of line is given (toasting.c create_toast_table); and the
 *   relation's row type, which its array type is recorded as depending on (heap.c AddNewRelationType, then
 *   pg_depend.c recordMultipleDependencies).
 * - Every object a catalog row it writes depends on, ACCESS SHARE, held to the end: PostgreSQL 19 locks the object of
 *   each dependency it records that is not pinned (pg_depend.c recordMultipleDependencies, dependencyLockAndCheckObject;
 *   pg_shdepend.c shdepAddDependency for the role that owns it). So a column's domain, a CHECK's function, a trigger's
 *   function, a key's index's constraint, a foreign key's target and its key's index, the schema an object lives in,
 *   the role that owns it: each is locked by the statement that makes the row naming it. Builtins are pinned
 *   (catalog.c IsPinnedObject: every object of an OID below FirstUnpinnedObjectId) and take no lock.
 * - A relation its query reads, or a relation it writes, with every index of it, which the planner opens to choose a
 *   path (plancat.c get_relation_info) and the executor opens to maintain (execIndexing.c ExecOpenIndices); a view it
 *   reads, with what the view reads (rewriteHandler.c AcquireRewriteLocks); and what each trigger of a table it writes
 *   runs, a statement trigger firing even for no row (trigger.c ExecBSInsertTriggers).
 * - A table it alters, and every index of it where the alteration rebuilds them; a table it rewrites, with the
 *   transient table PostgreSQL copies its rows into, that table's TOAST relations and row types, which outlive their
 *   drop as locks (cluster.c make_new_heap, finish_heap_swap's performDeletion of the transient table).
 * - An object it drops, ACCESS EXCLUSIVE, with every object its drop takes with it (dependency.c AcquireDeletionLock
 *   over findDependentObjects' targets): a table's indexes, TOAST relations, row types, constraints, triggers, policies,
 *   column defaults and statistics.
 * - A function it replaces (pg_proc.c ProcedureCreate locks the old one ACCESS EXCLUSIVE), and an object a COMMENT
 *   names (objectaddress.c get_object_address).
 * - A system catalog's TOAST relation where it stores a datum long enough to move out of line, a function's body, a
 *   rule's view definition, a CHECK's or a default's expression, which the insert keeps locked (heaptoast.c
 *   heap_toast_insert_or_update leaves its TOAST relation open), and pg_class's index on relfilenodes, which a new
 *   relation's storage is checked against (catalog.c GetNewRelFileNumber); the database setting a database's or a
 *   role's default writes (pg_db_role_setting).
 *
 * The count is an upper bound of what a statement's every path locks: a CREATE OR REPLACE counts its function whether
 * it replaces one or creates it, a table counts its TOAST relations where a column may be stored out of line whatever
 * its width, a query counts every index of every table it names. A lock a statement takes and releases within itself,
 * a catalog's, is no part of it: a backend holds a few at once, which the fast-path entries a transaction's weak
 * relation locks occupy instead of the shared table outnumber (lock.c FastPathLockGroupsPerBackend, one group of 16
 * per 16 of max_locks_per_transaction). Not counted, since grizzle reads no name of them: a declared function's body,
 * which PostgreSQL's SQL validator parses (pg_proc.c fmgr_sql_validator), and the objects CREATE EXTENSION creates.
 */

declare const lockTargetBrand: unique symbol

/**
 * One object a transaction locks, by what PostgreSQL's LOCKTAG names: its kind and its names, as one text. Two
 * statements that lock one object lock one target. Minted only here.
 */
export type LockTarget = string & { readonly [lockTargetBrand]: true }

/**
 * The kinds of object a migration's transaction locks: a relation (a table, view, materialized view, index or composite
 * type's relation), a table's TOAST table and its index, a type and the array type PostgreSQL makes beside it, a
 * function, a table's or a domain's constraint, a schema, a role, the database, a publication, a statistics object, a
 * trigger, a policy, a column's default, an operator class, an operator, the PL/pgSQL language, an extension, a
 * relation a rewrite copies a table into and drops (with its TOAST relations and row types), a system catalog's
 * relation the transaction keeps, its own transaction id, and an advisory lock.
 */
const lockKinds = [
	"relation",
	"toast",
	"toastIndex",
	"type",
	"arrayType",
	"function",
	"constraint",
	"domainConstraint",
	"namespace",
	"role",
	"database",
	"publication",
	"statistics",
	"trigger",
	"policy",
	"columnDefault",
	"operatorClass",
	"operator",
	"rule",
	"language",
	"extension",
	"transient",
	"catalog",
	"transaction",
	"advisory"
] as const
type LockKind = (typeof lockKinds)[number]

const mint = nominal<string, LockTarget>()

const target = (kind: LockKind, ...names: ReadonlyArray<string>): LockTarget =>
	mint([kind, ...names].join("\u0000"))

const named = (name: ObjectName): string => nameKey(name)

/** The relation `name` names: a table, view, materialized view, index or a composite type's relation. */
const relation = (name: ObjectName): LockTarget => target("relation", named(name))

/** An index, a relation of its table's schema. */
const indexOf = (table: ObjectName, index: string): LockTarget =>
	relation({ schema: table.schema, name: index })

const typeOf = (name: ObjectName): LockTarget => target("type", named(name))

const functionOf = (name: ObjectName): LockTarget => target("function", named(name))

const namespace = (schema: string): LockTarget => target("namespace", schema)

/** The role that owns what the transaction creates: the migration identity, the session's role. */
const owner = target("role", "")

/** A system catalog relation the transaction keeps locked, by its PostgreSQL name. */
const catalog = (name: string): LockTarget => target("catalog", name)

/**
 * pg_class's index on (reltablespace, relfilenode), which a new relation's storage number is checked unique against
 * (catalog.c GetNewRelFileNumber, through GetNewOidWithIndex), kept locked to the end.
 */
const relfilenodeIndex = catalog("pg_class_tblspc_relfilenode_index")

/**
 * A system catalog whose datum a statement may store out of line: the catalog's TOAST table and its index, which the
 * insert keeps locked (heaptoast.c heap_toast_insert_or_update): pg_proc's for a function's body, pg_rewrite's for a
 * view's rule, pg_constraint's for a CHECK, pg_attrdef's for a default or a generation, pg_policy's for a policy's
 * expression, pg_index's for an index's expressions and predicate, pg_statistic_ext's, pg_trigger's and pg_description's.
 */
const toastedCatalog = (
	catalogName:
		| "pg_proc"
		| "pg_rewrite"
		| "pg_constraint"
		| "pg_attrdef"
		| "pg_policy"
		| "pg_index"
		| "pg_description"
): ReadonlyArray<LockTarget> => [
	target("toast", named({ schema: "pg_catalog", name: catalogName })),
	target("toastIndex", named({ schema: "pg_catalog", name: catalogName }))
]

/** The transaction's own id, which every transaction that writes locks in the shared table (xact.c AssignTransactionId). */
const transactionLock: LockTarget = target("transaction")

/**
 * What a relation's query, body or expression names: the relations it reads, the relations it writes, the functions it
 * calls, the named types it names, whether array or not, and the schemas of the operators it names.
 */
interface Names {
	readonly reads: Array<ObjectName>
	readonly writes: Array<ObjectName>
	readonly functions: Array<ObjectName>
	readonly types: Array<ObjectName>
	readonly arrays: Array<ObjectName>
	readonly operators: Array<string>
	readonly regclasses: Array<ObjectName>
	/** The functions a body arms as a trigger of a session table it writes (PlStatement createSessionTrigger). */
	readonly sessionTriggers: Array<ObjectName>
	/** The session tables a body creates (PlStatement createSessionTable): each a new temporary relation. */
	readonly sessionTables: Array<string>
}

const noNames = (): Names => ({
	reads: [],
	writes: [],
	functions: [],
	types: [],
	arrays: [],
	operators: [],
	regclasses: [],
	sessionTriggers: [],
	sessionTables: []
})

/** The writes of a query's data-modifying CTEs. */
const cteWrites = (body: CteBody, into: Names): void => {
	switch (body.kind) {
		case "insert":
		case "delete":
			if (typeof body.table !== "string") {
				into.writes.push(body.table)
			}
			return
		case "update":
		case "merge":
			into.writes.push(body.table)
			return
		case "select":
			return
	}
}

/** A walk of what a node names, through the AST's one traversal (sql/transform.ts), each name recorded once met. */
const collector = (into: Names): Transform =>
	new Transform({
		...identityHooks,
		objectName: (name, space) => {
			if (space === "relation") {
				into.reads.push(name)
			} else if (space === "function") {
				into.functions.push(name)
			}
			return name
		},
		typeRef: (type) => {
			if (type.kind === "named") {
				const name = { schema: type.schema, name: type.name }
				;(type.array ? into.arrays : into.types).push(name)
				if (type.typmod.length > 0) {
					into.functions.push(name)
				}
			}
			return type
		},
		functionRef: (fn) => {
			into.functions.push({ schema: fn.schema, name: fn.name })
			return fn
		},
		expr: (e) => {
			if ((e.kind === "binary" || e.kind === "equalsAny") && e.schema !== undefined) {
				into.operators.push(e.schema)
			} else if (e.kind === "regclass") {
				into.regclasses.push(e.relation)
			}
			return e
		},
		select: (s) => {
			for (const cte of s.with?.ctes ?? []) {
				cteWrites(cte.query, into)
			}
			return s
		}
	})

const exprNames = (exprs: ReadonlyArray<Expr>): Names => {
	const into = noNames()
	const walk = collector(into)
	for (const e of exprs) {
		walk.expr(e)
	}
	return into
}

const queryNames = (query: OperandSelect): Names => {
	const into = noNames()
	collector(into).select(query)
	return into
}

/** The writes and session objects of a PL/pgSQL block's statements, nested ones included. */
const plWrites = (statements: ReadonlyArray<PlStatement>, into: Names): void => {
	for (const s of statements) {
		switch (s.kind) {
			case "if":
				for (const b of s.branches) {
					plWrites(b.body, into)
				}
				plWrites(s.else, into)
				break
			case "forQuery":
				plWrites(s.body, into)
				break
			case "whenFound":
				plWrites(s.body, into)
				break
			case "case":
				for (const w of s.whens) {
					plWrites(w.body, into)
				}
				break
			case "modify":
				cteWrites(s.statement, into)
				break
			case "createSessionTable":
				into.sessionTables.push(s.name)
				break
			case "createSessionTrigger":
				into.sessionTriggers.push(s.function)
				break
			case "assign":
			case "perform":
			case "raise":
			case "return":
			case "returnQuery":
			case "truncateSessionTable":
				break
		}
	}
}

const blockNames = (block: PlBlock): Names => {
	const into = noNames()
	collector(into).plBlock(block)
	plWrites(block.body, into)
	return into
}

/** Whether a builtin type's values are of one width, stored in the row whatever they hold: no TOAST table is made for
 * them (toasting.c needs_toast_table counts only a varlena of non-plain storage). */
const fixedBuiltins: ReadonlySet<string> = new Set([
	"smallint",
	"integer",
	"bigint",
	"real",
	"double precision",
	"boolean",
	"uuid",
	"date",
	"money",
	"name"
])

/** What a migration's statements know of the installation, before and after: each table's indexes, which relations
 * hold a TOAST table, each view's and function's names, each table's triggers' functions and the tables its foreign
 * keys join, each domain's base and the tables whose columns it types, each table's constraints, policies, defaults and
 * statistics, each publication's tables. Built once from every statement the previous and the target installation
 * hold (lockCatalog), and grown by the statements of the transaction as they are counted. */
export interface LockCatalog {
	readonly indexes: Map<string, Set<string>>
	readonly toasted: Set<string>
	readonly views: Map<string, Names>
	readonly bodies: Map<string, Names>
	readonly triggers: Map<string, Set<string>>
	readonly triggerNames: Map<string, Set<string>>
	readonly references: Map<string, Set<string>>
	readonly domains: Map<string, TypeRef>
	readonly domainColumns: Map<string, Set<string>>
	readonly columnTypes: Map<string, Map<string, TypeRef>>
	readonly constraints: Map<string, Map<string, TableConstraint["kind"]>>
	readonly domainConstraints: Map<string, Set<string>>
	readonly policies: Map<string, Set<string>>
	readonly defaults: Map<string, Set<string>>
	readonly publications: Map<string, Set<string>>
	readonly names: Map<string, ObjectName>
}

const emptyCatalog = (): LockCatalog => ({
	indexes: new Map(),
	toasted: new Set(),
	views: new Map(),
	bodies: new Map(),
	triggers: new Map(),
	triggerNames: new Map(),
	references: new Map(),
	domains: new Map(),
	domainColumns: new Map(),
	columnTypes: new Map(),
	constraints: new Map(),
	domainConstraints: new Map(),
	policies: new Map(),
	defaults: new Map(),
	publications: new Map(),
	names: new Map()
})

const member = <K, V>(map: Map<K, Set<V>>, key: K): Set<V> => {
	const known = map.get(key)
	if (known !== undefined) {
		return known
	}
	const made = new Set<V>()
	map.set(key, made)
	return made
}

/** Whether a column of `type` may be stored out of line, so its table holds a TOAST table. */
const mayToast = (catalogOf: LockCatalog, type: TypeRef): boolean => {
	if (type.array) {
		return true
	}
	switch (type.kind) {
		case "builtin":
			return !fixedBuiltins.has(type.name)
		case "named": {
			const base = catalogOf.domains.get(named({ schema: type.schema, name: type.name }))
			return base === undefined || mayToast(catalogOf, base)
		}
	}
}

/** A table's or a materialized view's key, its name remembered. */
const relationKey = (catalogOf: LockCatalog, name: ObjectName): string => {
	const key = named(name)
	catalogOf.names.set(key, name)
	return key
}

const addColumns = (
	catalogOf: LockCatalog,
	table: ObjectName,
	columns: ReadonlyArray<ColumnDef>
): void => {
	const key = relationKey(catalogOf, table)
	let types = catalogOf.columnTypes.get(key)
	if (types === undefined) {
		types = new Map()
		catalogOf.columnTypes.set(key, types)
	}
	for (const c of columns) {
		types.set(c.name, c.type)
		if (mayToast(catalogOf, c.type)) {
			catalogOf.toasted.add(key)
		}
		if (c.type.kind === "named") {
			member(catalogOf.domainColumns, named({ schema: c.type.schema, name: c.type.name })).add(key)
		}
	}
}

/** The index a key constraint is built under: the constraint's own name (index.c index_create via ATExecAddIndex). */
const addConstraint = (catalogOf: LockCatalog, table: ObjectName, c: TableConstraint): void => {
	const key = relationKey(catalogOf, table)
	let owned = catalogOf.constraints.get(key)
	if (owned === undefined) {
		owned = new Map()
		catalogOf.constraints.set(key, owned)
	}
	owned.set(c.name, c.kind)
	switch (c.kind) {
		case "primaryKey":
		case "unique":
		case "exclude":
			member(catalogOf.indexes, key).add(c.name)
			return
		case "foreignKey": {
			const to = relationKey(catalogOf, c.references)
			member(catalogOf.references, key).add(to)
			member(catalogOf.references, to).add(key)
			return
		}
		case "check":
			return
	}
}

const addAlteration = (
	catalogOf: LockCatalog,
	table: ObjectName,
	actions: ReadonlyArray<AlterTableAction>
): void => {
	for (const a of actions) {
		switch (a.kind) {
			case "addColumn":
			case "addColumnPlaceholder":
			case "addColumnDefault":
			case "addColumnUnchecked":
				addColumns(catalogOf, table, [a.column])
				if (a.kind === "addColumnPlaceholder" || a.kind === "addColumnDefault") {
					member(catalogOf.defaults, relationKey(catalogOf, table)).add(a.column.name)
				}
				break
			case "alterColumnType":
				addColumns(catalogOf, table, [
					{ name: a.column, type: a.type, collation: a.collation, generated: undefined }
				])
				break
			case "addConstraint":
				addConstraint(catalogOf, table, a.constraint)
				break
			case "addConstraintUsingIndex":
				member(catalogOf.indexes, relationKey(catalogOf, table)).add(a.name)
				break
			case "setNotNull":
			case "dropColumn":
			case "dropDefault":
			case "validateConstraint":
			case "alterConstraintDeferral":
			case "dropConstraint":
			case "enableRowSecurity":
			case "disableRowSecurity":
			case "replicaIdentity":
			case "setExpression":
				break
		}
	}
}

/** One statement's facts, added to `catalogOf`: what a later statement's locks read of the installation. */
const learn = (catalogOf: LockCatalog, s: SqlStatement | RecordedStatement): void => {
	switch (s.kind) {
		case "createTable":
			addColumns(catalogOf, s.table, s.columns)
			for (const c of tableConstraints(s)) {
				addConstraint(catalogOf, s.table, c)
			}
			for (const c of s.columns) {
				if (c.generated !== undefined) {
					member(catalogOf.defaults, relationKey(catalogOf, s.table)).add(c.name)
				}
			}
			return
		case "alterTable":
			addAlteration(catalogOf, s.table, s.actions)
			return
		case "createIndex":
			member(catalogOf.indexes, relationKey(catalogOf, s.table)).add(s.name)
			return
		case "createMaterializedView": {
			const key = relationKey(catalogOf, s.name)
			catalogOf.toasted.add(key)
			catalogOf.views.set(key, queryNames(s.query))
			return
		}
		case "createView":
			catalogOf.views.set(relationKey(catalogOf, s.name), queryNames(s.query))
			return
		case "createLiveSecret":
			catalogOf.toasted.add(relationKey(catalogOf, s.table))
			return
		case "createDomain":
			catalogOf.domains.set(named(s.name), s.base)
			for (const c of s.constraints) {
				member(catalogOf.domainConstraints, named(s.name)).add(c.name)
			}
			return
		case "alterDomain":
			if (s.action.kind === "addConstraint") {
				member(catalogOf.domainConstraints, named(s.name)).add(s.action.constraint.name)
			}
			return
		case "createFunction":
			catalogOf.bodies.set(
				named(s.name),
				s.language === "plpgsql" ? blockNames(s.body) : exprNames([s.body])
			)
			return
		case "createConstant":
			catalogOf.bodies.set(named(s.name), exprNames([s.body]))
			return
		case "replaceConstant":
			catalogOf.bodies.set(named(s.constant.name), exprNames([s.constant.body]))
			return
		case "createGuardTrigger":
		case "createUpdateGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger": {
			const key = relationKey(catalogOf, s.table)
			member(catalogOf.triggers, key).add(named(s.function))
			member(catalogOf.triggerNames, key).add(s.name)
			return
		}
		case "createPolicy":
			member(catalogOf.policies, relationKey(catalogOf, s.table)).add(s.name)
			return
		case "createPublication":
			catalogOf.publications.set(
				s.name,
				new Set(s.tables.map((t) => relationKey(catalogOf, t.table)))
			)
			return
		case "rename":
			if (s.object === "TABLE" || s.object === "MATERIALIZED VIEW") {
				renamedRelation(catalogOf, s.name, { schema: s.name.schema, name: s.to })
			} else if (s.object === "FUNCTION") {
				const body = catalogOf.bodies.get(named(s.name))
				if (body !== undefined) {
					catalogOf.bodies.delete(named(s.name))
					catalogOf.bodies.set(named({ schema: s.name.schema, name: s.to }), body)
				}
			} else if (s.object === "INDEX") {
				for (const held of catalogOf.indexes.values()) {
					if (held.has(s.name.name)) {
						held.add(s.to)
					}
				}
			}
			return
		case "renameConstraint": {
			const owned = catalogOf.constraints.get(named(s.table))
			const kind = owned?.get(s.from)
			if (owned !== undefined && kind !== undefined) {
				owned.set(s.to, kind)
				if (kind === "primaryKey" || kind === "unique" || kind === "exclude") {
					member(catalogOf.indexes, named(s.table)).add(s.to)
				}
			}
			return
		}
		case "renameColumn": {
			const types = catalogOf.columnTypes.get(named(s.table))
			const type = types?.get(s.from)
			if (types !== undefined && type !== undefined) {
				types.set(s.to, type)
			}
			return
		}
		case "adoptRole":
		case "resetDatabaseDefault":
		case "alterDefaultPrivileges":
		case "alterRole":
		case "comment":
		case "declareStatistics":
		case "createCarrier":
		case "createDeclaredFunction":
		case "createExtension":
		case "createRole":
		case "createRowType":
		case "createSchema":
		case "drop":
		case "dropFunction":
		case "dropIndex":
		case "dropPolicy":
		case "dropPublication":
		case "dropTrigger":
		case "grant":
		case "grantColumns":
		case "grantRole":
		case "handOverFunction":
		case "lockTable":
		case "packConstant":
		case "recordedConstant":
		case "recordedDeclaredFunction":
		case "recordedFunction":
		case "refresh":
		case "revoke":
		case "revokeRole":
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "stubConstant":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
			return
	}
}

/**
 * The facts of a relation renamed `to` learned under its new name as well, which PostgreSQL keeps under the relation's
 * OID whatever it is called: a later statement that names it so reads them. Its old name keeps them, so a statement
 * counted under either reads it whole.
 */
const renamedRelation = (catalogOf: LockCatalog, from: ObjectName, to: ObjectName): void => {
	const was = named(from)
	const now = relationKey(catalogOf, to)
	const copy = <V>(map: Map<string, V>, fresh: (v: V) => V): void => {
		const known = map.get(was)
		if (known !== undefined) {
			map.set(now, fresh(known))
		}
	}
	copy(catalogOf.indexes, (v) => new Set(v))
	copy(catalogOf.views, (v) => v)
	copy(catalogOf.triggers, (v) => new Set(v))
	copy(catalogOf.triggerNames, (v) => new Set(v))
	copy(catalogOf.references, (v) => new Set(v))
	copy(catalogOf.columnTypes, (v) => new Map(v))
	copy(catalogOf.constraints, (v) => new Map(v))
	copy(catalogOf.policies, (v) => new Set(v))
	copy(catalogOf.defaults, (v) => new Set(v))
	if (catalogOf.toasted.has(was)) {
		catalogOf.toasted.add(now)
	}
	for (const tables of [...catalogOf.domainColumns.values(), ...catalogOf.references.values()]) {
		if (tables.has(was)) {
			tables.add(now)
		}
	}
}

/**
 * The catalog a migration's transactions start from (LockCatalog): every fact of the installation `installed` holds,
 * the previous snapshot's, before any of its files runs, and the body of every function `bodies` creates, the target's,
 * which a statement may run though no file of the migration creates it again (a recorded function holds its header
 * alone). What a file creates is learned as its statements are counted (transactionLocks), so count the files of a
 * migration in their order over one catalog.
 */
const lockCatalog = (input: {
	readonly installed: Iterable<SqlStatement | RecordedStatement>
	readonly bodies: Iterable<SqlStatement>
}): LockCatalog => {
	const catalogOf = emptyCatalog()
	for (const s of input.installed) {
		learn(catalogOf, s)
	}
	for (const s of input.bodies) {
		if (s.kind === "createFunction" || s.kind === "createConstant") {
			learn(catalogOf, s)
		}
	}
	return catalogOf
}

/**
 * The locks of one transaction, counted as its statements run: each statement's targets added (lockStatement), its
 * facts learned so the next statement reads them, and the functions already counted for their bodies remembered, so a
 * body run twice is read once.
 */
class Locks {
	readonly held = new Set<LockTarget>()
	readonly #catalog: LockCatalog
	readonly #ran = new Set<string>()
	readonly #read = new Set<string>()
	#transients = 0

	constructor(catalogOf: LockCatalog) {
		this.#catalog = catalogOf
	}

	/** The objects each name has stood for before the one it stands for now: a drop ends one, its locks kept. */
	readonly #ended = new Map<LockTarget, number>()

	/** The object each name a rename gave stands for: the one its old name stood for, of the same OID. */
	readonly #renamed = new Map<LockTarget, LockTarget>()

	/** The target a name locks now: a name dropped and made again is another object, of another OID; a name a rename
	 * gave, the object renamed. */
	#live(t: LockTarget): LockTarget {
		const renamed = this.#renamed.get(t)
		if (renamed !== undefined) {
			return renamed
		}
		const ended = this.#ended.get(t) ?? 0
		return ended === 0 ? t : mint(`${t}\u0000#${ended}`)
	}

	/** An object renamed from `from` to `to`: `to` stands for it from now on, and `from` for nothing until something of
	 * its name is made. */
	rename(from: LockTarget, to: LockTarget): void {
		const object = this.#live(from)
		this.#renamed.delete(from)
		this.#ended.set(from, (this.#ended.get(from) ?? 0) + 1)
		this.#renamed.set(to, object)
	}

	/** A relation renamed, with what is named after it: its row type, array type, TOAST relations and rule, and each
	 * constraint, trigger, policy and column default of it, keyed by its name. */
	renameRelation(from: ObjectName, to: ObjectName): void {
		const was = named(from)
		const now = named(to)
		this.rename(relation(from), relation(to))
		for (const kind of ["type", "arrayType", "toast", "toastIndex", "rule"] as const) {
			this.rename(target(kind, was), target(kind, now))
		}
		for (const c of this.#catalog.constraints.get(was)?.keys() ?? []) {
			this.rename(target("constraint", was, c), target("constraint", now, c))
		}
		for (const t of this.#catalog.triggerNames.get(was) ?? []) {
			this.rename(target("trigger", was, t), target("trigger", now, t))
		}
		for (const p of this.#catalog.policies.get(was) ?? []) {
			this.rename(target("policy", was, p), target("policy", now, p))
		}
		for (const d of this.#catalog.defaults.get(was) ?? []) {
			this.rename(target("columnDefault", was, d), target("columnDefault", now, d))
		}
	}

	add(targets: ReadonlyArray<LockTarget>): void {
		for (const t of targets) {
			this.held.add(this.#live(t))
		}
	}

	/**
	 * Objects a statement drops: each locked, ACCESS EXCLUSIVE, and its lock kept to the end, the object gone, so a later
	 * statement that makes one of its name makes another (dependency.c AcquireDeletionLock).
	 */
	dropped(targets: ReadonlyArray<LockTarget>): void {
		for (const t of targets) {
			this.add([t])
			this.#renamed.delete(t)
			this.#ended.set(t, (this.#ended.get(t) ?? 0) + 1)
		}
	}

	/** Every index of a table, each dropped and built again under its name, of a new OID (tablecmds.c ATPostAlterTypeParse). */
	rebuilt(table: ObjectName): void {
		const key = named(table)
		for (const index of this.#catalog.indexes.get(key) ?? []) {
			this.dropped([indexOf(table, index)])
			this.add([indexOf(table, index)])
		}
		for (const [c, kind] of this.#catalog.constraints.get(key) ?? []) {
			if (kind === "primaryKey" || kind === "unique" || kind === "exclude") {
				this.dropped([target("constraint", key, c)])
				this.add([target("constraint", key, c)])
			}
		}
	}

	/** A dependency recorded on a named type: the type, and its array type where the array is named. */
	type(type: TypeRef): void {
		if (type.kind === "named") {
			const name = { schema: type.schema, name: type.name }
			this.add([type.array ? target("arrayType", named(name)) : typeOf(name)])
		}
	}

	/** A relation the transaction creates: it, its TOAST relations where it has them, its row type, its schema. */
	created(name: ObjectName, toasted: boolean): void {
		this.add([relation(name), typeOf(name), namespace(name.schema), owner, relfilenodeIndex])
		if (toasted) {
			this.add([target("toast", named(name)), target("toastIndex", named(name))])
		}
	}

	/**
	 * The types of the columns of what a view reads, each of its own columns typed by one of them, which its row type's
	 * attributes record a dependency on (heap.c AddNewAttributeTuples): every column type of each relation it reads, a
	 * view's through what it reads in turn.
	 */
	viewColumnTypes(reads: ReadonlyArray<ObjectName>, seen: Set<string>): void {
		for (const r of reads) {
			const key = named(r)
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			for (const t of this.#catalog.columnTypes.get(key)?.values() ?? []) {
				this.type(t)
			}
			const view = this.#catalog.views.get(key)
			if (view !== undefined) {
				this.viewColumnTypes(view.reads, seen)
			}
		}
	}

	/** Every index the catalog knows of a table, created before or by this transaction. */
	indexes(table: ObjectName): void {
		for (const index of this.#catalog.indexes.get(named(table)) ?? []) {
			this.add([indexOf(table, index)])
		}
	}

	/** A relation a query reads: it and its indexes, and a view's own reads. */
	read(name: ObjectName): void {
		const key = named(name)
		this.add([relation(name)])
		this.indexes(name)
		if (this.#read.has(key)) {
			return
		}
		this.#read.add(key)
		const view = this.#catalog.views.get(key)
		if (view !== undefined) {
			this.names(view, "run")
		}
	}

	/** A table a statement writes: it read, every trigger on it run, and every table a foreign key joins it to read. */
	write(name: ObjectName): void {
		this.read(name)
		const key = named(name)
		for (const fn of this.#catalog.triggers.get(key) ?? []) {
			this.run(fn)
		}
		for (const other of this.#catalog.references.get(key) ?? []) {
			const otherName = this.#catalog.names.get(other)
			if (otherName !== undefined) {
				this.read(otherName)
			}
		}
	}

	/** A function run: what its body reads, writes and calls, once. */
	run(fn: string): void {
		if (this.#ran.has(fn)) {
			return
		}
		this.#ran.add(fn)
		const body = this.#catalog.bodies.get(fn)
		if (body !== undefined) {
			this.names(body, "run")
		}
	}

	/**
	 * What a statement's expressions, query or body name: `run`, a query planned and run, each relation it reads or
	 * writes with its indexes and every function it calls run; or `stored`, an expression stored in the catalog, each
	 * object it names locked as a dependency, its relations parsed (parse_relation.c parserOpenTable) and no index.
	 */
	names(n: Names, how: "run" | "stored"): void {
		switch (how) {
			case "stored":
				for (const t of n.types) {
					this.add([typeOf(t)])
				}
				for (const t of n.arrays) {
					this.add([target("arrayType", named(t))])
				}
				for (const op of n.operators) {
					this.add([target("operator", op)])
				}
				for (const r of [...n.reads, ...n.writes, ...n.regclasses]) {
					this.add([relation(r)])
				}
				for (const f of n.functions) {
					this.add([functionOf(f)])
				}
				return
			case "run":
				for (const r of n.reads) {
					this.read(r)
				}
				for (const w of n.writes) {
					this.write(w)
				}
				for (const f of [...n.functions, ...n.sessionTriggers]) {
					this.run(named(f))
				}
				for (const table of n.sessionTables) {
					this.transient(`session table ${table}`, true)
				}
				return
		}
	}

	/**
	 * A relation PostgreSQL creates and drops within the transaction, which leaves its locks behind: a rewrite's
	 * transient table (cluster.c make_new_heap) or a session table, with its row type and array type, and its TOAST
	 * relations where its table has them. Each is a relation of its own, never one before it.
	 */
	transient(what: string, toasted: boolean): void {
		const n = String(++this.#transients)
		this.add([
			target("transient", n, what, "relation"),
			target("transient", n, what, "type"),
			target("transient", n, what, "array type"),
			relfilenodeIndex
		])
		if (toasted) {
			this.add([target("transient", n, what, "toast"), target("transient", n, what, "toast index")])
		}
	}

	/**
	 * A table rewritten: its rows copied into a transient table that takes its storage (transient), its own row type
	 * and array type locked, and every index rebuilt.
	 */
	rewrite(table: ObjectName): void {
		this.transient(`rewrite of ${named(table)}`, this.#catalog.toasted.has(named(table)))
		this.add([typeOf(table), target("arrayType", named(table)), namespace(table.schema)])
		this.indexes(table)
	}

	/**
	 * A column added to a table: its row type and array type, which the added attribute changes, and its TOAST
	 * relations where a column of it may be stored out of line, which the alteration makes where the table had none
	 * (tablecmds.c ATExecAddColumn, AlterTableCreateToastTable).
	 */
	addedColumn(table: ObjectName): void {
		this.add([typeOf(table), target("arrayType", named(table))])
		if (this.#catalog.toasted.has(named(table))) {
			this.add([target("toast", named(table)), target("toastIndex", named(table))])
		}
	}

	/** Every object a table's drop takes with it (dependency.c findDependentObjects). */
	dropTable(table: ObjectName): void {
		const key = named(table)
		this.dropped([
			relation(table),
			typeOf(table),
			target("arrayType", key),
			target("toast", key),
			target("toastIndex", key),
			target("rule", key)
		])
		for (const index of this.#catalog.indexes.get(key) ?? []) {
			this.dropped([indexOf(table, index)])
		}
		for (const c of this.#catalog.constraints.get(key)?.keys() ?? []) {
			this.dropped([target("constraint", key, c)])
		}
		for (const t of this.#catalog.triggerNames.get(key) ?? []) {
			this.dropped([target("trigger", key, t)])
		}
		for (const p of this.#catalog.policies.get(key) ?? []) {
			this.dropped([target("policy", key, p)])
		}
		for (const d of this.#catalog.defaults.get(key) ?? []) {
			this.dropped([target("columnDefault", key, d)])
		}
	}

	/**
	 * The operator classes an index over `columns` of `table` takes by its method's default for each column's type,
	 * which its index records a dependency on (index.c index_create): a builtin's is pinned, an extension type's is not,
	 * a domain's its base's.
	 */
	keyClasses(table: ObjectName, columns: ReadonlyArray<string>, method: string): void {
		const types = this.#catalog.columnTypes.get(named(table))
		for (const column of columns) {
			const base = this.baseType(types?.get(column))
			if (base !== undefined) {
				this.add([target("operatorClass", named(base), method)])
			}
		}
	}

	/** The named type a type is of, through its domains, where it is no builtin: an extension's. */
	baseType(type: TypeRef | undefined): ObjectName | undefined {
		if (type?.kind !== "named") {
			return undefined
		}
		const name = { schema: type.schema, name: type.name }
		const base = this.#catalog.domains.get(named(name))
		return base === undefined ? name : this.baseType(base)
	}

	/** A constraint a statement makes or drops on `table`, with what PostgreSQL locks for it. */
	constraint(table: ObjectName, c: TableConstraint, notValid: boolean): void {
		const key = named(table)
		switch (c.kind) {
			case "primaryKey":
			case "unique":
			case "exclude":
				this.add([indexOf(table, c.name), target("constraint", key, c.name), relfilenodeIndex])
				this.keyClasses(
					table,
					c.kind === "exclude" ? c.elements.map((e) => e.column) : c.columns.map((k) => k.column),
					c.kind === "exclude" ? "gist" : "btree"
				)
				return
			case "foreignKey":
				this.add([target("constraint", key, c.name), relation(c.references)])
				this.indexes(c.references)
				if (!notValid) {
					this.read(table)
					this.read(c.references)
				}
				return
			case "check":
				this.names(exprNames([c.predicate]), "stored")
				this.add([...toastedCatalog("pg_constraint")])
				return
		}
	}

	/** The kind of `table`'s constraint `name`, as the catalog knows it. */
	constraintKind(table: ObjectName, name: string): TableConstraint["kind"] | undefined {
		return this.#catalog.constraints.get(named(table))?.get(name)
	}

	/** A constraint dropped, or kept and redefined in place, with what it holds: its index, or a foreign key's target. */
	ownedBy(table: ObjectName, name: string, fate: "drops" | "keeps"): void {
		const key = named(table)
		const kind = this.constraintKind(table, name)
		const owned = [
			target("constraint", key, name),
			...(kind === "primaryKey" || kind === "unique" || kind === "exclude"
				? [indexOf(table, name)]
				: [])
		]
		if (fate === "drops") {
			this.dropped([...owned])
		} else {
			this.add([...owned])
		}
		if (kind === "foreignKey") {
			for (const other of this.#catalog.references.get(key) ?? []) {
				const otherName = this.#catalog.names.get(other)
				if (otherName !== undefined) {
					this.add([relation(otherName)])
				}
			}
		}
	}

	/**
	 * What validating a domain's constraint locks (typecmds.c validateDomainCheckConstraint over get_rels_with_domain):
	 * the domain's array type, and every relation a column of the domain types, a view's among them, with the row type and
	 * array type of each, which a value of the domain may be stored inside (find_composite_type_dependencies).
	 */
	domainTables(domain: ObjectName): void {
		this.add([target("arrayType", named(domain))])
		const tables = this.#catalog.domainColumns.get(named(domain)) ?? new Set<string>()
		const typed = (key: string): boolean => tables.has(key)
		const viewed = [...this.#catalog.views].flatMap(([key, view]) =>
			view.reads.some((r) => typed(named(r))) ? [key] : []
		)
		for (const t of [...tables, ...viewed]) {
			const name = this.#catalog.names.get(t)
			if (name !== undefined) {
				this.add([relation(name), typeOf(name), target("arrayType", t)])
			}
		}
	}

	/** A value coerced to a type of a type modifier, which PostgreSQL does by the type's length coercion function, of the
	 * type's own name (parse_coerce.c coerce_type_typmod): a dependency of the expression that coerces. */
	typmodCast(type: TypeRef): void {
		if (type.kind === "named" && type.typmod.length > 0) {
			this.add([functionOf({ schema: type.schema, name: type.name })])
		}
	}

	toasted(name: ObjectName): boolean {
		return this.#catalog.toasted.has(named(name))
	}

	publication(name: string): ReadonlyArray<ObjectName> {
		return [...(this.#catalog.publications.get(name) ?? [])].flatMap((t) => {
			const n = this.#catalog.names.get(t)
			return n === undefined ? [] : [n]
		})
	}

	domainConstraints(domain: ObjectName): ReadonlyArray<string> {
		return [...(this.#catalog.domainConstraints.get(named(domain)) ?? [])]
	}

	learn(s: SqlStatement | RecordedStatement): void {
		learn(this.#catalog, s)
	}
}

/** An ALTER TABLE subcommand's locks beyond its table's (lockStatement's alterTable). */
const alterationLocks = (
	locks: Locks,
	table: ObjectName,
	a: AlterTableAction
): "rewrites" | "keeps" => {
	const key = named(table)
	switch (a.kind) {
		case "addColumn":
		case "addColumnUnchecked":
			locks.type(a.column.type)
			locks.addedColumn(table)
			if (a.column.generated === undefined) {
				return "keeps"
			}
			locks.typmodCast(a.column.type)
			locks.names(
				exprNames(
					a.column.generated.kind === "partial"
						? [a.column.generated.when, a.column.generated.expr]
						: [a.column.generated.expr]
				),
				"stored"
			)
			locks.add(toastedCatalog("pg_attrdef"))
			return "rewrites"
		case "addColumnPlaceholder":
			locks.type(a.column.type)
			locks.typmodCast(a.column.type)
			locks.addedColumn(table)
			locks.add(toastedCatalog("pg_attrdef"))
			return "keeps"
		case "addColumnDefault":
			locks.type(a.column.type)
			locks.typmodCast(a.column.type)
			locks.addedColumn(table)
			locks.names(exprNames([a.default]), "stored")
			locks.add(toastedCatalog("pg_attrdef"))
			return "keeps"
		case "setNotNull":
		case "enableRowSecurity":
		case "disableRowSecurity":
		case "replicaIdentity":
			return "keeps"
		case "dropColumn":
			locks.rebuilt(table)
			locks.dropped([target("columnDefault", key, a.column)])
			return "keeps"
		case "dropDefault":
			locks.dropped([target("columnDefault", key, a.column)])
			return "keeps"
		case "alterColumnType":
			locks.type(a.type)
			locks.rebuilt(table)
			if (a.using.kind === "expr") {
				locks.names(exprNames([a.using.expr]), "stored")
			}
			return "rewrites"
		case "setExpression":
			locks.rebuilt(table)
			locks.names(
				exprNames(
					a.generation.kind === "partial"
						? [a.generation.when, a.generation.expr]
						: [a.generation.expr]
				),
				"stored"
			)
			locks.add(toastedCatalog("pg_attrdef"))
			return "rewrites"
		case "addConstraint":
			locks.constraint(table, a.constraint, a.notValid)
			return "keeps"
		case "addConstraintUsingIndex":
			locks.add([indexOf(table, a.index), target("constraint", key, a.name)])
			return "keeps"
		case "validateConstraint":
			if (locks.constraintKind(table, a.name) === "foreignKey") {
				locks.read(table)
				locks.ownedBy(table, a.name, "keeps")
				locks.indexes(table)
			}
			return "keeps"
		case "alterConstraintDeferral":
			locks.ownedBy(table, a.name, "keeps")
			return "keeps"
		case "dropConstraint":
			locks.ownedBy(table, a.name, "drops")
			return "keeps"
	}
}

/** What one statement locks and keeps, by kind (see the header), added to `locks`: a recorded function or constant as
 * the drift check replays it, its header with a stub body (deploy/snapshot/recorded.ts replayedStatement). */
const lockStatement = (locks: Locks, s: SqlStatement | RecordedStatement): void => {
	switch (s.kind) {
		case "recordedFunction":
			locks.add([
				functionOf(s.header.name),
				namespace(s.header.name.schema),
				owner,
				target("language", "plpgsql"),
				...toastedCatalog("pg_proc")
			])
			for (const p of s.header.params) {
				locks.type(p.type)
			}
			if (typeof s.header.returns !== "string") {
				locks.type(s.header.returns.setOf)
			}
			return
		case "recordedDeclaredFunction":
			locks.add([
				functionOf(s.header.name),
				namespace(s.header.name.schema),
				owner,
				target("language", "plpgsql"),
				...toastedCatalog("pg_proc")
			])
			for (const p of s.header.params) {
				locks.type(p.type)
			}
			locks.type("setOf" in s.header.returns ? s.header.returns.setOf : s.header.returns)
			return
		case "recordedConstant":
			locks.add([
				functionOf(s.header.name),
				namespace(s.header.name.schema),
				owner,
				...toastedCatalog("pg_proc")
			])
			for (const p of s.header.params) {
				locks.type(p.type)
			}
			locks.type(s.header.returns)
			return
		case "stubConstant":
			locks.add([functionOf(s.name), namespace(s.name.schema), owner, ...toastedCatalog("pg_proc")])
			for (const p of s.params) {
				locks.type(p.type)
			}
			locks.type(s.returns)
			return
		case "createSchema":
			locks.add([owner])
			return
		case "createTable": {
			locks.created(s.table, locks.toasted(s.table))
			for (const c of s.columns) {
				locks.type(c.type)
				if (c.generated === undefined) {
					continue
				}
				locks.typmodCast(c.type)
				locks.names(
					exprNames(
						c.generated.kind === "partial"
							? [c.generated.when, c.generated.expr]
							: [c.generated.expr]
					),
					"stored"
				)
				locks.add(toastedCatalog("pg_attrdef"))
			}
			for (const c of tableConstraints(s)) {
				locks.constraint(s.table, c, true)
			}
			return
		}
		case "createCarrier":
			locks.transient(`carrier ${s.name}`, true)
			return
		case "alterTable": {
			locks.add([relation(s.table)])
			let rewrites = false
			for (const a of s.actions) {
				rewrites = alterationLocks(locks, s.table, a) === "rewrites" || rewrites
			}
			if (rewrites) {
				locks.rewrite(s.table)
			}
			return
		}
		case "rename":
			switch (s.object) {
				case "TABLE":
				case "MATERIALIZED VIEW":
					locks.add([relation(s.name)])
					locks.renameRelation(s.name, { schema: s.name.schema, name: s.to })
					return
				case "INDEX":
					locks.add([relation(s.name)])
					locks.rename(relation(s.name), relation({ schema: s.name.schema, name: s.to }))
					return
				case "DOMAIN": {
					const to = { schema: s.name.schema, name: s.to }
					locks.add([typeOf(s.name)])
					locks.rename(typeOf(s.name), typeOf(to))
					locks.rename(target("arrayType", named(s.name)), target("arrayType", named(to)))
					for (const c of locks.domainConstraints(s.name)) {
						locks.rename(
							target("domainConstraint", named(s.name), c),
							target("domainConstraint", named(to), c)
						)
					}
					return
				}
				case "ROLE":
					locks.add([target("role", s.name)])
					locks.rename(target("role", s.name), target("role", s.to))
					return
				case "SCHEMA":
					locks.add([namespace(s.name)])
					locks.rename(namespace(s.name), namespace(s.to))
					return
				case "FUNCTION": {
					const to = functionOf({ schema: s.name.schema, name: s.to })
					locks.add([functionOf(s.name), namespace(s.name.schema), ...toastedCatalog("pg_proc")])
					locks.rename(functionOf(s.name), to)
					for (const t of s.args) {
						locks.type(t)
					}
					return
				}
			}
		case "renameColumn":
			locks.add([relation(s.table)])
			locks.rename(
				target("columnDefault", named(s.table), s.from),
				target("columnDefault", named(s.table), s.to)
			)
			return
		case "renameConstraint": {
			locks.add([relation(s.table)])
			const kind = locks.constraintKind(s.table, s.from)
			const key = named(s.table)
			if (kind === "primaryKey" || kind === "unique" || kind === "exclude") {
				locks.add([indexOf(s.table, s.from)])
				locks.rename(indexOf(s.table, s.from), indexOf(s.table, s.to))
			}
			locks.rename(target("constraint", key, s.from), target("constraint", key, s.to))
			return
		}
		case "createDomain":
			locks.add([typeOf(s.name), namespace(s.name.schema), owner])
			locks.type(s.base)
			locks.names(exprNames(s.constraints.map((c) => c.predicate)), "stored")
			if (s.constraints.length > 0) {
				locks.add(toastedCatalog("pg_constraint"))
			}
			return
		case "alterDomain":
			locks.add([typeOf(s.name)])
			switch (s.action.kind) {
				case "addConstraint":
					locks.names(exprNames([s.action.constraint.predicate]), "stored")
					locks.add(toastedCatalog("pg_constraint"))
					if (!s.action.notValid) {
						locks.domainTables(s.name)
					}
					return
				case "validateConstraint":
					locks.domainTables(s.name)
					return
				case "dropConstraint":
					locks.dropped([target("domainConstraint", named(s.name), s.action.name)])
					return
			}
		case "createIndex":
			locks.add([relation(s.table), indexOf(s.table, s.name), relfilenodeIndex])
			locks.keyClasses(
				s.table,
				s.keys.flatMap((k) =>
					k.key.kind === "column" && k.opclass === undefined ? [k.key.column] : []
				),
				s.method
			)
			for (const k of s.keys) {
				if (k.key.kind === "expr") {
					locks.names(exprNames([k.key.expr]), "stored")
				}
				if (k.opclass !== undefined) {
					locks.add([target("operatorClass", named(k.opclass))])
				}
			}
			if (s.where !== undefined || s.keys.some((k) => k.key.kind === "expr")) {
				locks.names(exprNames(s.where === undefined ? [] : [s.where]), "stored")
				locks.add(toastedCatalog("pg_index"))
			}
			return
		case "dropIndex":
			locks.dropped([relation(s.name)])
			return
		case "createMaterializedView":
		case "createView": {
			const read = queryNames(s.query)
			locks.created(s.name, s.kind === "createMaterializedView")
			locks.names(read, "stored")
			locks.viewColumnTypes(read.reads, new Set())
			locks.add(toastedCatalog("pg_rewrite"))
			return
		}
		case "createPolicy":
			locks.add([relation(s.table), target("role", s.role), ...toastedCatalog("pg_policy")])
			locks.names(exprNames([s.filter]), "stored")
			return
		case "dropPolicy":
			locks.add([relation(s.table)])
			locks.dropped([target("policy", named(s.table), s.name)])
			return
		case "drop":
			switch (s.object) {
				case "TABLE":
					locks.dropTable(s.name)
					return
				case "MATERIALIZED VIEW":
				case "VIEW":
					locks.dropTable(s.name)
					return
				case "DOMAIN":
				case "TYPE":
					locks.dropped([typeOf(s.name), target("arrayType", named(s.name))])
					for (const c of locks.domainConstraints(s.name)) {
						locks.dropped([target("domainConstraint", named(s.name), c)])
					}
					return
				case "STATISTICS":
					locks.dropped([target("statistics", named(s.name))])
					return
				case "FUNCTION":
					locks.dropped([functionOf(s.name)])
					return
				case "ROLE":
					locks.dropped([target("role", s.name)])
					return
				case "SCHEMA":
					locks.dropped([namespace(s.name)])
					return
			}
		case "dropFunction":
			locks.dropped([functionOf(s.name)])
			for (const t of s.name.args) {
				locks.type(t)
			}
			return
		case "dropTrigger":
			locks.add([relation(s.table)])
			locks.dropped([target("trigger", named(s.table), s.name)])
			return
		case "createFunction":
			locks.add([functionOf(s.name), namespace(s.name.schema), owner, ...toastedCatalog("pg_proc")])
			for (const p of s.params) {
				locks.type(p.type)
			}
			if (typeof s.returns !== "string") {
				locks.type(s.returns.setOf)
			}
			switch (s.language) {
				case "plpgsql":
					locks.add([target("language", "plpgsql")])
					return
				case "sql":
					locks.names(exprNames([s.body]), "stored")
					return
			}
		case "createDeclaredFunction":
			locks.add([functionOf(s.name), namespace(s.name.schema), owner, ...toastedCatalog("pg_proc")])
			for (const p of s.params) {
				locks.type(p.type)
			}
			if ("setOf" in s.returns) {
				locks.type(s.returns.setOf)
			} else {
				locks.type(s.returns)
			}
			if (s.language === "plpgsql") {
				locks.add([target("language", "plpgsql")])
			}
			return
		case "handOverFunction":
			locks.add([functionOf(s.name), namespace(s.name.schema), target("role", s.owner), owner])
			return
		case "createRowType":
			locks.created(s.name, false)
			for (const a of s.attributes) {
				locks.type(a.type)
			}
			return
		case "adoptRole":
			locks.add([target("role", s.role), owner, catalog("pg_auth_members")])
			return
		case "packConstant":
			locks.add([
				functionOf(s.function),
				namespace(s.function.schema),
				owner,
				...toastedCatalog("pg_proc")
			])
			return
		case "createConstant":
			locks.add([functionOf(s.name), namespace(s.name.schema), owner, ...toastedCatalog("pg_proc")])
			for (const p of s.params) {
				locks.type(p.type)
			}
			locks.type(s.returns)
			locks.names(exprNames([s.body]), "stored")
			return
		case "replaceConstant":
			locks.add([
				functionOf(s.constant.name),
				namespace(s.constant.name.schema),
				...toastedCatalog("pg_proc")
			])
			for (const p of s.constant.params) {
				locks.type(p.type)
			}
			locks.type(s.constant.returns)
			locks.names(exprNames([s.constant.body]), "stored")
			return
		case "createGuardTrigger":
		case "createUpdateGuardTrigger":
		case "createTransitionTrigger":
			locks.add([relation(s.table), functionOf(s.function)])
			return
		case "createConstraintTrigger":
			locks.add([
				relation(s.table),
				functionOf(s.function),
				target("constraint", named(s.table), s.name)
			])
			return
		case "createPublication":
			locks.add([target("publication", s.name), owner])
			for (const t of s.tables) {
				locks.add([relation(t.table)])
			}
			return
		case "dropPublication":
			locks.dropped([target("publication", s.name)])
			for (const t of locks.publication(s.name)) {
				locks.add([relation(t)])
			}
			return
		case "createLiveSecret":
			locks.created(s.table, true)
			return
		case "resetDatabaseDefault":
			locks.add([target("advisory", "database"), target("database"), catalog("pg_db_role_setting")])
			return
		case "createRole":
			locks.add([target("role", s.name), owner, catalog("pg_authid"), catalog("pg_auth_members")])
			return
		case "alterRole":
			locks.add([target("role", s.name), catalog("pg_db_role_setting")])
			return
		case "grantRole":
			locks.add([target("role", s.role), target("role", s.to), owner, catalog("pg_auth_members")])
			return
		case "revokeRole":
			locks.add([target("role", s.role), target("role", s.from), owner, catalog("pg_auth_members")])
			return
		case "grant":
		case "revoke": {
			const grantees = s.kind === "grant" ? s.to : s.from
			for (const g of grantees) {
				if (g.kind === "role") {
					locks.add([target("role", g.name)])
				}
			}
			grantedLocks(locks, s.on)
			return
		}
		case "grantColumns":
			locks.add([target("role", s.to), relation(s.table)])
			return
		case "alterDefaultPrivileges":
			locks.add([target("advisory", "database")])
			for (const g of s.from) {
				if (g.kind === "role") {
					locks.add([target("role", g.name)])
				}
			}
			return
		case "createExtension":
			locks.add([target("advisory", "database"), target("extension", s.name), namespace(s.schema)])
			return
		case "declareStatistics":
			locks.add([
				relation(s.table),
				target("language", "plpgsql"),
				...(locks.toasted(s.table) ? [target("toast", named(s.table))] : [])
			])
			return
		case "lockTable":
			for (const t of s.tables) {
				locks.add([relation(t)])
			}
			return
		case "comment":
			commentLocks(locks, s.on)
			locks.add(toastedCatalog("pg_description"))
			return
		case "select":
			locks.names(queryNames(s), "run")
			return
		case "insert":
		case "update":
		case "delete":
		case "merge": {
			const into = noNames()
			collector(into).dml(s)
			locks.names(into, "run")
			if (typeof s.table !== "string") {
				locks.write(s.table)
			}
			return
		}
		case "refresh":
			locks.read(s.view)
			locks.transient(`refresh of ${named(s.view)}`, true)
			return
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
			return
	}
}

/**
 * The objects a GRANT or REVOKE names, each locked ACCESS SHARE as it is resolved (aclchk.c objectNamesToOids, through
 * get_object_address or RangeVarGetRelid); one on the database or a schema runs after the database lock.
 */
const grantedLocks = (
	locks: Locks,
	on: Extract<SqlStatement, { readonly kind: "grant" }>["on"]
): void => {
	switch (on.kind) {
		case "TABLE":
			for (const n of on.names) {
				locks.add([relation(n)])
			}
			return
		case "SCHEMA":
			locks.add([target("advisory", "database")])
			for (const n of on.names) {
				locks.add([namespace(n)])
			}
			return
		case "DOMAIN":
		case "TYPE":
			for (const n of on.names) {
				locks.add([typeOf(n)])
			}
			return
		case "FUNCTION":
			for (const n of on.names) {
				locks.add([functionOf(n)])
			}
			return
		case "DATABASE":
			locks.add([target("advisory", "database"), target("database")])
			return
	}
}

/** The object a COMMENT locks, and the relation it lives on (objectaddress.c get_object_address, which locks the
 * relation of a relation's part and then the object itself, ShareUpdateExclusiveLock). */
const commentLocks = (
	locks: Locks,
	on: Extract<SqlStatement, { readonly kind: "comment" }>["on"]
): void => {
	switch (on.kind) {
		case "SCHEMA":
			locks.add([namespace(on.name)])
			return
		case "ROLE":
			locks.add([target("role", on.name)])
			return
		case "TABLE":
		case "VIEW":
		case "MATERIALIZED VIEW":
		case "INDEX":
			locks.add([relation(on.name)])
			return
		case "DOMAIN":
		case "TYPE":
			locks.add([typeOf(on.name)])
			return
		case "COLUMN":
			locks.add([relation(on.relation)])
			return
		case "CONSTRAINT":
			locks.add([relation(on.on), target("constraint", named(on.on), on.name)])
			return
		case "TRIGGER":
			locks.add([relation(on.on), target("trigger", named(on.on), on.name)])
			return
		case "POLICY":
			locks.add([relation(on.on), target("policy", named(on.on), on.name)])
			return
		case "DOMAIN CONSTRAINT":
			locks.add([typeOf(on.domain), target("domainConstraint", named(on.domain), on.name)])
			return
		case "FUNCTION":
			locks.add([functionOf(on.name)])
			return
	}
}

/**
 * One step of a migration's transaction as its locks are counted: a statement; a table's fill, an UPDATE of it at the
 * reviewer's values (deploy/diff/plan.ts Action fill); or a law's violation check, its query planned and run.
 */
type LockedStep =
	| { readonly kind: "statement"; readonly statement: SqlStatement | RecordedStatement }
	| { readonly kind: "fill"; readonly table: ObjectName }
	| { readonly kind: "check"; readonly query: OperandSelect }

/**
 * The locks a transaction of `steps` holds at its end, its most (see the header), under the installation `catalogOf`
 * knows: every target each step locks, its own transaction id among them. The catalog grows by what each statement
 * creates, so a statement after it reads it.
 */
const transactionLocks = (
	steps: Iterable<LockedStep>,
	catalogOf: LockCatalog
): ReadonlySet<LockTarget> => {
	const locks = new Locks(catalogOf)
	locks.add([transactionLock])
	for (const step of steps) {
		switch (step.kind) {
			case "statement":
				locks.learn(step.statement)
				lockStatement(locks, step.statement)
				break
			case "fill":
				locks.write(step.table)
				break
			case "check":
				locks.names(queryNames(step.query), "run")
				break
		}
	}
	return locks.held
}

/** The text a lock target is spelled in by a diagnostic: its kind and its names. */
export const lockTargetText = (t: LockTarget): string => {
	const [kind, ...names] = t.split("\u0000")
	if (kind === undefined) {
		throw defect("a lock target of no kind")
	}
	return `${kind} ${names.map((n) => quoteIdent(n)).join(".")}`
}

const statementStep = (statement: SqlStatement | RecordedStatement): LockedStep => ({
	kind: "statement",
	statement
})

/** The steps a draft holds, as its file spells them (render/sql.ts spellAction): a table's alteration is its ALTER TABLE
 * and the DROP DEFAULT of each column it adds at a placeholder, a loss its statement, which runs once written in. */
const draftSteps = (d: Draft): ReadonlyArray<LockedStep> => {
	switch (d.kind) {
		case "statement":
			return [statementStep(d.statement)]
		case "alteration": {
			const dropped = d.actions.flatMap((a) =>
				a.kind === "addColumnPlaceholder" ? [a.column.name] : []
			)
			return [
				statementStep(alterationStatement(d.table, d.actions)),
				...(isNonEmpty(dropped)
					? [
							statementStep({
								kind: "alterTable",
								table: d.table,
								actions: mapNonEmpty(dropped, (column) => ({ kind: "dropDefault", column }))
							})
						]
					: [])
			]
		}
		case "fill":
			return [{ kind: "fill", table: d.table }]
		case "violation":
			return [{ kind: "check", query: d.query }]
		case "zones":
			return []
		case "loss":
			return [statementStep(d.statement)]
		case "confirm":
			return d.keep.map(statementStep)
	}
}

/** The largest of `sets`, by size: the transaction of the most locks. */
const largest = (sets: ReadonlyArray<ReadonlySet<LockTarget>>): ReadonlySet<LockTarget> =>
	sets.reduce((most, set) => (set.size > most.size ? set : most), new Set<LockTarget>())

/**
 * The locks of the transaction of each file of a migration of `schema` that holds the most of them, in file order, its
 * drafts counted as drafted: a transactional file's one transaction, the ledger's lock first and its rows last, as the
 * apply runner sends it (adapter/migrate/apply.ts runFile); of a no-transaction file's statements each alone and its
 * rows' transaction, the largest. The files are counted in their order over `catalogOf`, so a file reads what the files
 * before it create.
 */
export const fileLockSets = (input: {
	readonly schema: string
	readonly catalog: LockCatalog
	readonly files: ReadonlyArray<DraftFile>
}): ReadonlyArray<{ readonly file: DraftFile; readonly locks: ReadonlySet<LockTarget> }> => {
	const runner = runnerStatements(input.schema)
	const fence = statementStep(runner.fence)
	const rows = runner.rows.map(statementStep)
	return input.files.map((file) => {
		const steps = file.drafts.flatMap(draftSteps)
		const locks = file.transaction
			? transactionLocks([fence, ...steps, ...rows], input.catalog)
			: largest([
					transactionLocks([fence, ...rows], input.catalog),
					...steps.map((step) => transactionLocks([step], input.catalog))
				])
		return { file, locks }
	})
}

/**
 * The catalog a migration from `previous` to the installation whose statements are `target` counts its files over
 * (lockCatalog): the previous snapshot's every recorded statement, and the target's functions' bodies.
 */
export const migrationCatalog = (
	previous: DeploySnapshot,
	installing: ReadonlyArray<SqlStatement>
): LockCatalog =>
	lockCatalog({
		installed: [
			...previous.manifest.objects.flatMap((o) => o.ddl),
			...previous.manifest.publicRevokes,
			...previous.manifest.roleDefaults
		],
		bodies: installing
	})

/**
 * The locks the drift check's transaction holds where it replays every object of `snapshot` into its scratch schemas,
 * as the check of a schema's first migration does, no object proven yet (adapter/admission/drift.ts): each object's
 * statements as the snapshot records them, a function by its header, created over an empty catalog in install order.
 */
export const replayLocks = (snapshot: DeploySnapshot): number =>
	transactionLocks(
		snapshot.manifest.objects.flatMap((o) => o.ddl.map(statementStep)),
		lockCatalog({ installed: [], bodies: [] })
	).size
