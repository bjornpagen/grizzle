import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	headNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { type QueryColumns, queryColumns } from "#compiler/analysis/theory/columns.ts"
import { type KeyLedger, Refusal } from "#compiler/core/canonical.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import {
	compareIdentities,
	type DeclaredName,
	type Identity,
	identity
} from "#compiler/core/identity.ts"
import type { ColumnIdent, ConstraintName, Identifier, IdentityKind } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { textDigestsOf } from "#compiler/ir/law.ts"
import { type LibraryFn, missing } from "#compiler/ir/physical.ts"
import type { DeployPhase, PhysicalReason } from "#compiler/ir/products.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import { addIsolation } from "#compiler/physical/ddl/isolation.ts"
import { digestDomainDdl, snapshotGuardDdl } from "#compiler/physical/ddl/ledger.ts"
import type { InstallNames } from "#compiler/physical/ddl/names.ts"
import {
	rowCheck,
	rowGeneration,
	type RowFunction,
	type RowScope
} from "#compiler/physical/ddl/row-functions.ts"
import {
	type Before,
	enforcement,
	type Node,
	type NodeIdent,
	type ObjectSpec,
	ObligationGraph,
	type QualifiedKind
} from "#compiler/physical/obligations/graph.ts"
import { vectorExtension } from "#compiler/physical/vector/storage.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import type { Owned, OwnedLogin } from "#compiler/schema/own.ts"
import {
	type AlterTableAction,
	type ColumnDef,
	type CreateConstant,
	type Expr,
	type FunctionName,
	nameKey,
	type NameKey,
	type ObjectName,
	type SqlStatement,
	type TableConstraint,
	type TypeRef
} from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { type StoredColumns, storedColumns } from "#compiler/sql/stored.ts"
import {
	type AstHooks,
	identityHooks,
	transformExpr,
	transformStatement
} from "#compiler/sql/transform.ts"
import { borrowFunctionDdl } from "#compiler/write/borrow/function.ts"
import { tableMaxColumns } from "#compiler/write/carriers/carriers.ts"
import { refusalFunctionDdl } from "#compiler/write/refusal.ts"

export interface InstallSettings {
	/**
	 * The identity of each level's PostgreSQL schema, root first, index for index with Owned.levels: the declared levels'
	 * own (Owned.levels' installations), or a test's unique ones. Each role and login installed over a level embeds its
	 * level's (roles are cluster-wide), and the root's holds what is the installation's own (physical/ddl/names.ts
	 * InstallNames).
	 */
	readonly levels: NonEmptyReadonlyArray<Identity<"schema">>
	/** The schema the vector extension lives in (vector_ext on the local cluster). */
	readonly vectorSchema: string
	/** The schema btree_gist is created in when a span key or a GiST index has a scalar component, if the database has
	 * none yet. It must outlive every installed schema, so it is never one of them. */
	readonly extensionSchema: string
	/** The logins over the schema, each with its roles: the worlds installed beside it. */
	readonly logins: ReadonlyArray<OwnedLogin>
}

/** A stored table an extension installs that takes indexes like a table (a stored derived relation's): its fields,
 * the graph object its indexes are created after, its primary key's fields, in key order, and its unique indexes, its
 * primary key's among them, each in index column order, which serve index requests as a table's key indexes do. */
interface IndexedView {
	readonly relation: string
	readonly object: Node<"structure">
	readonly primaryKey: NonEmptyReadonlyArray<string>
	readonly fields: ReadonlyMap<string, TargetField>
	readonly uniqueIndexes: ReadonlyArray<{
		readonly object: Node<"structure">
		readonly name: ConstraintName
		readonly columns: KeySet
	}>
}

/**
 * A field an index or statistics object of a relation may name: its descriptor, a stored relation's declared one or a
 * derived relation's inferred one, and its type. A stored relation's law column is named too (`lawColumnFields`).
 */
export interface TargetField {
	readonly desc: FieldDesc
	readonly type: ScalarType
}

/** What a relation's indexes and statistics are built on once every extension has run: a stored relation's table or a
 * derived relation's registered view, with the fields an object on it may name and the graph object the object is
 * created after; a derived relation no extension installs, whose objects are deferred with it, as the installation
 * reports it (Installation.deferred); or no stored or derived relation at all. */
type RelationTarget = BuiltTarget | { readonly kind: "deferred" } | { readonly kind: "none" }

/**
 * A column an index or statistics object of a relation names, by its arm: a field by its name, or a law column a law
 * adds to a stored relation by its identifier. The arm says which, so no name is looked up as either.
 */
export type IndexColumn =
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "law"; readonly column: ColumnIdent }

/** A relation an object can be built on: a stored relation's table or a registered view, each column an object on it
 * may name and the installed column it is. */
export interface BuiltTarget {
	readonly kind: "built"
	readonly field: (column: IndexColumn) => TargetField | undefined
	/** Every column an index of it may name, each by its text, a field's name or a law column's identifier, with its field. */
	readonly fields: ReadonlyArray<readonly [string, TargetField]>
	readonly column: (column: IndexColumn) => string
	/**
	 * The column's place in the relation's heading, which orders the columns an index holds in any order among
	 * themselves (physical/indexes/engine.ts withinBlock): a field's position among its relation's fields, a law column
	 * after every field, by its identifier.
	 */
	readonly place: (column: IndexColumn) => number
	/**
	 * Its declared text digests, each text field by its name with the field that is its SHA-256 (ir/law.ts
	 * textDigestsOf): a stored relation's, read off its fields; none for a derived relation's stored table, whose fields
	 * no writing generates. What the index engine admits a text of no byte bound into a lookup beside
	 * (physical/indexes/engine.ts refusedUndigested).
	 */
	readonly digests: ReadonlyMap<string, string>
	/**
	 * The objects an object over `columns` is created after: its table or view, and each law column among them, which
	 * its own ALTER TABLE ... ADD COLUMN adds after the table (`lawColumn`), so a replay of the object alone replays what
	 * creates each column it names (deploy/admission/proof.ts replayedOver).
	 */
	readonly after: (columns: ReadonlyArray<IndexColumn>) => ReadonlyArray<Node<"structure">>
}

/**
 * The law columns of each stored relation an index may name, by relation and identifier: each is described by the
 * field whose values it holds (ir/law.ts LawColumn), so an index entry over it is bounded as one of that field's.
 */
const lawColumnFields = (
	natives: ReadonlyArray<NamedNative>
): ReadonlyMap<string, ReadonlyMap<string, TargetField>> => {
	const out = new Map<string, Map<string, TargetField>>()
	for (const n of natives) {
		if (n.namespace !== "column") {
			continue
		}
		const o = n.object
		const own = out.getOrInsertComputed(o.relation.name, () => new Map<string, TargetField>())
		own.set(o.column, { desc: o.field.desc, type: o.field.type })
	}
	return out
}

/** The law columns of a relation the law model adds none to. */
const noLawColumns: ReadonlyMap<string, TargetField> = new Map()

/**
 * An object of the installation that evaluating a statement can run: a constant, a function of no argument whose body
 * runs where it is called, or a domain, whose base type and CHECKs run wherever a value is written or cast into it.
 */
type Evaluated =
	| { readonly kind: "constant"; readonly identifier: string }
	| { readonly kind: "domain"; readonly identifier: NameKey }

/**
 * What a role's statements evaluate of the installation, before any reachability: the statements of the objects they
 * run (the tables it writes, its views), the predicates its policies hold, the domains it names in its own statements
 * and the constants it calls in them.
 */
export interface EvaluationRoots {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly predicates: ReadonlyArray<Expr>
	readonly domains: ReadonlyArray<{ readonly schema: string; readonly name: string }>
	readonly constants: ReadonlyArray<string>
}

/**
 * The types of the parameters of the constant `ddl` creates: a literal pack's none, and a CREATE's its parameters'. A
 * constant's statements create it once, beside its revoke.
 */
const constantArgs = (ddl: ReadonlyArray<SqlStatement>): ReadonlyArray<TypeRef> => {
	for (const s of ddl) {
		if (s.kind === "createConstant") {
			return s.params.map((p) => p.type)
		}
		if (s.kind === "packConstant") {
			return []
		}
	}
	defect("a constant's statements create it")
}

/**
 * The installed table a statement creates or changes the rows' evaluation of: a CREATE TABLE's columns, defaults,
 * generated columns and constraints, an ALTER TABLE's added columns and constraints, and a CREATE INDEX's expressions
 * and predicate, which every write of the table evaluates. Any other statement's evaluation is no write's.
 */
const evaluatedTable = (statement: SqlStatement): ObjectName | undefined =>
	statement.kind === "createTable" ||
	statement.kind === "alterTable" ||
	statement.kind === "createIndex"
		? statement.table
		: undefined

/** An extension an object needs the operator classes or the type of: btree_gist's for the scalar components of a GiST
 * key, pgvector's vector type. */
export type Capability = "btree_gist" | "vector"

/**
 * The relation a statement of the installation creates or adds columns to, and the columns it gives it: a CREATE TABLE's,
 * a view's own, an ALTER TABLE's ADD COLUMNs. Every other statement gives no relation a column.
 */
const widenedRelation = (
	statement: SqlStatement
): { readonly relation: ObjectName; readonly columns: number } | undefined => {
	if (statement.kind === "createTable") {
		return { relation: statement.table, columns: statement.columns.length }
	}
	if (statement.kind === "createView" || statement.kind === "createStoredTable") {
		return { relation: statement.name, columns: statement.columns.length }
	}
	if (statement.kind === "alterTable") {
		return {
			relation: statement.table,
			columns: statement.actions.filter((a) => a.kind === "addColumn").length
		}
	}
	return undefined
}

/** A constant of parameters' revoke from PUBLIC, which holds EXECUTE on every new function: a library function's and a
 * row function's (physical/ddl/row-functions.ts). */
export const constantRevoke = (create: CreateConstant): SqlStatement => ({
	kind: "revoke",
	privileges: ["ALL"],
	on: { kind: "FUNCTION", names: [{ ...create.name, args: create.params.map((p) => p.type) }] },
	from: [{ kind: "PUBLIC" }]
})

/** What every DDL generator of one installation shares: the owned schema, its law model, the installed names, the
 * obligation graph the objects go into, and the identities the installation names its own objects by (`name`).
 *
 * It adds the objects every installation holds when it is made: the schema, the refusal function every write statement
 * that can refuse and every context source raises through, the isolation default and guard, and the snapshot guard,
 * each after the schema. Each
 * later stage adds its objects after the objects it reads that its statements do not name, named by the handles their
 * stages returned: a table by its relation (`addTable`, `table`), a column a law adds, a key a reference names, and an
 * extension an object needs at the object's addition (`provider`); every object its statements name, a domain, a type,
 * a constant, a function, a relation or a schema, the graph adds on its own (physical/obligations/graph.ts namedEdges). */
export class InstallBuilder {
	readonly owned: Owned
	/** The checker's reading of the owned schema, read once by the installation. */
	readonly checked: CheckedSchema
	/**
	 * The columns of each query the installation's judges and probes import (analysis/theory/columns.ts queryColumns),
	 * each query checked once however many statements navigation reads it in.
	 */
	readonly columns: QueryColumns
	readonly model: LawModel
	readonly names: InstallNames
	/**
	 * The unrepresentable keys the compile has met, its law model's first: each index the installation judges, a UNIQUE
	 * over a set its codes size (physical/ddl/tables.ts setUniqueBound) and an index the engine creates
	 * (physical/indexes/engine.ts createIndex), is refused here where its entry no index holds, and built all the same.
	 */
	readonly keys: KeyLedger
	readonly graph = new ObligationGraph()
	readonly settings: InstallSettings
	/** Every native object of the law model, by kind. */
	readonly natives: ReadonlyArray<NamedNative>
	/** The root's schema, which every object of the installation's own is created after. */
	readonly schemaNode: Node<"setup">
	/** Each level's schema, root first, by level index: every object of a level's relations is created after its own. */
	readonly levelNodes: NonEmptyReadonlyArray<Node<"setup">>
	/** The refusal function every write statement that can refuse and every context source calls. */
	readonly refusal: Node<"setup">
	/** The borrow function every role's borrow statements call (write/borrow/function.ts). */
	readonly borrow: Node<"setup">
	/** The guard function every guarded table's isolation trigger calls. */
	readonly isolation: Node<"setup">
	/** The relations whose tables take no isolation trigger (physical/ddl/isolation.ts readCommittedRelations). */
	readonly readCommitted: ReadonlySet<string>
	/** The library functions the installation installs (physical/ddl/library.ts libraryCalls), in name order. */
	readonly library: ReadonlyArray<LibraryFn>
	/** The snapshot guard every Db transaction and Db.open call behind the ledger's fence. */
	readonly snapshotGuard: Node<"setup">
	/** The digest domain every SHA-256 digest column is typed by (ir/physical.ts PhysicalNames digestDomain). */
	readonly digestDomain: Node<"setup">
	readonly #named: Array<Identity<IdentityKind>> = []
	readonly #providers = new Map<Capability, Node<"setup">>()
	/** Each domain the installation creates, by its name's key (sql/ast.ts nameKey). */
	readonly #types = new Map<NameKey, Node<"setup">>()
	/** Each constant by identifier: its identity, its object and the types of its parameters, by which a GRANT names
	 * it. */
	readonly #constants = new Map<
		string,
		{
			readonly named: Identity<IdentityKind>
			readonly node: Node<"setup">
			readonly args: ReadonlyArray<TypeRef>
		}
	>()
	readonly #tables = new Map<string, Node<"structure">>()
	/** Each law column's object, by its relation and its identifier (`addLawColumn`). */
	readonly #lawColumnObjects = new Map<string, Map<string, Node<"structure">>>()
	/** Each installed table's statements a write of it evaluates (`evaluatedTable`), by the table's identifier. */
	readonly #evaluatedOn = new Map<string, Array<SqlStatement>>()
	readonly #views = new Map<string, IndexedView>()
	/** The law columns of each stored relation an index may name (`lawColumnFields`). */
	readonly #lawColumns: ReadonlyMap<string, ReadonlyMap<string, TargetField>>
	/** Each pattern language the installation spells, by the ARE of its spelling (ir/pattern.ts InstalledSpellings): what
	 * a row function's identity reads a pattern it matches as (physical/ddl/row-functions.ts). */
	readonly #languages: ReadonlyMap<string, string>
	/** The type of each column of each installed table the objects so far give it, by the table's qualified name and the
	 * column's identifier: what a row function's parameter reading the column is typed by. */
	readonly #columnTypes = new Map<string, Map<string, TypeRef>>()
	/** The columns each table and view the objects so far create holds, by its qualified name. */
	readonly #columns = new Map<string, number>()
	/** Every text column of the installation's stored tables (`texts`), read once on first use. */
	#texts: StoredColumns | undefined = undefined
	/** The identifiers of the levels' schemas, where every table of the installation is. */

	constructor(input: {
		readonly owned: Owned
		readonly checked: CheckedSchema
		readonly model: LawModel
		readonly names: InstallNames
		readonly settings: InstallSettings
		readonly readCommitted: ReadonlySet<string>
		readonly library: ReadonlyArray<LibraryFn>
		readonly keys: KeyLedger
	}) {
		this.owned = input.owned
		this.keys = input.keys
		this.readCommitted = input.readCommitted
		this.library = input.library
		this.checked = input.checked
		this.columns = queryColumns(input.checked, SourceLoc("the installation", []))
		this.model = input.model
		this.names = input.names
		this.settings = input.settings
		this.natives = input.model.natives
		this.#lawColumns = lawColumnFields(input.model.natives)
		this.#languages = new Map(
			[...input.names.spellings.table].map(([language, spelling]) => [matchAre(spelling), language])
		)
		const levelNode = (installation: Identity<"schema">, index: number): Node<"setup"> =>
			this.add(
				{
					kind: "schema",
					ident: { kind: "schema", name: installation },
					ddl: [{ kind: "createSchema", name: this.name(installation) }],
					reasons: [enforcement(`schema ${input.owned.levels[index]?.name ?? input.owned.name}`)],
					phase: "setup"
				},
				[]
			)
		this.levelNodes = mapNonEmpty(input.settings.levels, levelNode)
		this.schemaNode = headNonEmpty(this.levelNodes)
		this.name(identity.refusal())
		this.refusal = this.add(
			{
				kind: "refusalFunction",
				ident: this.qualified("function", identity.refusal()),
				ddl: refusalFunctionDdl(this.schema),
				reasons: [enforcement(`the refusals of schema ${input.owned.name}`)],
				phase: "setup"
			},
			[this.schemaNode]
		)
		this.name(identity.borrow())
		this.borrow = this.add(
			{
				kind: "borrowFunction",
				ident: this.qualified("function", identity.borrow()),
				ddl: borrowFunctionDdl(this.schema),
				reasons: [enforcement(`the borrows of schema ${input.owned.name}`)],
				phase: "setup"
			},
			[this.schemaNode]
		)
		this.isolation = addIsolation(this)
		this.name(identity.snapshotGuard())
		this.snapshotGuard = this.add(
			{
				kind: "snapshotGuard",
				ident: this.qualified("function", identity.snapshotGuard()),
				ddl: snapshotGuardDdl(this.schema),
				reasons: [enforcement(`the snapshot every Db of schema ${input.owned.name} runs against`)],
				phase: "setup"
			},
			[this.schemaNode]
		)
		const digestNamed = identity.digestDomain()
		this.name(digestNamed)
		this.name(identity.domainCheck(digestNamed))
		this.digestDomain = this.addType(
			"domain",
			this.names.installation,
			digestNamed,
			{
				ddl: [digestDomainDdl(this.schema)],
				reasons: [enforcement("the length of every SHA-256 digest, 32 bytes")]
			},
			[this.schemaNode]
		)
	}

	get schema(): string {
		return this.names.schema
	}

	/** The identifier of an object the installation names, minted at the naming door: its identity is kept for the
	 * installation's census and its object's COMMENT (physical/install/comments.ts). */
	name<K extends IdentityKind>(of: Identity<K>): Identifier<K> {
		this.#named.push(of)
		return of.identifier
	}

	/** The law columns the law model adds to `relation`, by identifier (`lawColumnFields`): none for a relation it adds
	 * none to. */
	lawColumnsOf(relation: string): ReadonlyMap<string, TargetField> {
		return this.#lawColumns.get(relation) ?? noLawColumns
	}

	/** Every identity `name` minted, in order. */
	named(): ReadonlyArray<Identity<IdentityKind>> {
		return [...this.#named]
	}

	/** The graph identity of an object `name` names in the root's schema. */
	qualified(kind: QualifiedKind, name: Identity<IdentityKind>): NodeIdent {
		return { kind, schema: this.names.installation, name }
	}

	/** The graph identity of an object `name` names in the schema of the level that declares `relation`. */
	qualifiedOf(kind: QualifiedKind, relation: string, name: Identity<IdentityKind>): NodeIdent {
		return { kind, schema: this.names.levelOf(relation), name }
	}

	/** The graph identity of the constraint or column `named` of `relation`'s table. */
	constraintOf(relation: string, named: Identity<IdentityKind>): NodeIdent {
		return {
			kind: "constraint",
			schema: this.names.levelOf(relation),
			relation: this.names.relationNamed(relation),
			name: named
		}
	}

	/** The schema object of the level that declares `relation`, which every object of the relation is created after. */
	levelNode(relation: string): Node<"setup"> {
		return (
			this.levelNodes[this.names.levels.indexOf(this.names.levelOf(relation))] ??
			missing(`physical: no installed level for ${relation}`)
		)
	}

	/**
	 * Adds an object, created after each of `after`. A table its statements would give more columns than PostgreSQL's
	 * tableMaxColumns, the columns its CREATE TABLE and every ADD COLUMN after it give it together, or a view of more, is
	 * refused here as ResourceBound (tableColumns).
	 */
	add<P extends DeployPhase>(
		spec: ObjectSpec<P>,
		after: ReadonlyArray<Node<Before<NoInfer<P>>>>
	): Node<P> {
		const ddl = spec.ddl.map((statement) => this.#withRowFunctions(statement, spec.reasons))
		for (const statement of ddl) {
			this.#countColumns(statement)
			const table = evaluatedTable(statement)
			if (table !== undefined && this.names.installed.has(table.schema)) {
				this.#evaluatedOn.getOrInsertComputed(table.name, () => []).push(statement)
			}
		}
		return this.graph.add({ ...spec, ddl }, after)
	}

	/**
	 * The columns of the stored table `table` with their types, which its CREATE TABLE ... AS states none of (sql/ast.ts
	 * CreateStoredTable): kept as a CREATE TABLE's are (`#withRowFunctions`), so a CHECK over the stored relation, which
	 * its own ALTER TABLE adds, reads its columns' types where a row function of it hoists.
	 */
	storedColumns(
		table: ObjectName,
		columns: ReadonlyArray<{ readonly name: string; readonly type: TypeRef }>
	): void {
		const known = this.#columnTypes.getOrInsertComputed(
			printObjectName(table),
			() => new Map<string, TypeRef>()
		)
		for (const c of columns) {
			known.set(c.name, c.type)
		}
	}

	/**
	 * A statement on an installed table with each CHECK it adds and each generation of a column it adds its row
	 * function's call where the expression hoists (physical/ddl/row-functions.ts), each row function added as a constant
	 * (`addConstant`) for `reasons`, the table's object's: every CHECK and stored generation of the installation's tables
	 * is added through here, whatever adds it. Each column the statement gives its table is kept, by the table's name,
	 * for the types of the parameters a later row function of the table reads it by.
	 */
	/** The language of the pattern whose installed spelling's ARE is `are`, none for a text no installed spelling's ARE
	 * is (row-functions.ts RowScope languageOf). */
	languageOf(are: string): string | undefined {
		return this.#languages.get(are)
	}

	#withRowFunctions(statement: SqlStatement, reasons: ReadonlyArray<PhysicalReason>): SqlStatement {
		if (
			(statement.kind !== "createTable" && statement.kind !== "alterTable") ||
			!this.names.installed.has(statement.table.schema)
		) {
			return statement
		}
		const table = printObjectName(statement.table)
		const columns = this.#columnTypes.getOrInsertComputed(table, () => new Map<string, TypeRef>())
		const scope: RowScope = {
			schema: this.schema,
			installed: this.names.installed,
			readsConstant: (fn) => fn.schema === this.schema && this.#readsData(fn.name),
			columnType: (column) =>
				columns.get(column) ?? missing(`physical: no column ${column} of ${table}`),
			languageOf: (are) => this.languageOf(are)
		}
		const install = (fn: RowFunction): void => {
			this.name(fn.named)
			this.addConstant(fn.named, { ddl: () => [fn.create, constantRevoke(fn.create)], reasons }, [
				this.schemaNode
			])
		}
		const column = (c: ColumnDef): ColumnDef => ({
			...c,
			generated: rowGeneration(scope, c.generated, c.type, install)
		})
		const check = <C extends TableConstraint>(c: C): C | (C & { readonly kind: "check" }) =>
			c.kind === "check" ? { ...c, predicate: rowCheck(scope, c.predicate, install) } : c
		if (statement.kind === "createTable") {
			for (const c of statement.columns) {
				columns.set(c.name, c.type)
			}
			return {
				...statement,
				columns: mapNonEmpty(statement.columns, column),
				secondary: statement.secondary.map(check)
			}
		}
		for (const a of statement.actions) {
			if (a.kind === "addColumn") {
				columns.set(a.column.name, a.column.type)
			}
		}
		return {
			...statement,
			actions: mapNonEmpty(statement.actions, (a): AlterTableAction =>
				a.kind === "addColumn"
					? { ...a, column: column(a.column) }
					: a.kind === "addConstraint"
						? { ...a, constraint: check(a.constraint) }
						: a
			)
		}
	}

	/** Whether the installed function `name` is a constant of the installation's data, a closed relation's, a roster's
	 * or a dictionary's, whose value a call reads: neither a library function nor a row function. */
	#readsData(name: string): boolean {
		const kind = this.#constants.get(name)?.named.kind
		return kind === "closedConstant" || kind === "rosterConstant" || kind === "rosterLive"
	}

	/** The columns `statement` gives the relation it creates or adds to, counted against tableMaxColumns. */
	#countColumns(statement: SqlStatement): void {
		const widened = widenedRelation(statement)
		if (widened === undefined) {
			return
		}
		const table = printObjectName(widened.relation)
		const needed = (this.#columns.get(table) ?? 0) + widened.columns
		if (needed > tableMaxColumns) {
			throw new Refusal(
				resourceBound(SourceLoc(`installation of schema ${this.owned.name}`, []), {
					kind: "tableColumns",
					table,
					limit: tableMaxColumns,
					needed
				})
			)
		}
		this.#columns.set(table, needed)
	}

	/** Adds a domain of the installation in `schema`, the root's or a level's, which a column, a cast or a declaration
	 * names by its schema and identifier (`typeNode`). */
	addType(
		kind: "domain",
		schema: Identity<"schema">,
		name: Identity<IdentityKind>,
		spec: Omit<ObjectSpec<"setup">, "kind" | "ident" | "phase">,
		after: ReadonlyArray<Node<"setup">>
	): Node<"setup"> {
		const node = this.add(
			{
				kind,
				ident: { kind, schema, name },
				ddl: spec.ddl,
				reasons: spec.reasons,
				phase: "setup"
			},
			after
		)
		this.#types.set(nameKey({ schema: schema.identifier, name: name.identifier }), node)
		return node
	}

	/**
	 * Adds a constant of the installed schema, a function of no argument (physical/ddl/constants.ts) or a library
	 * function of its parameters (physical/ddl/library.ts), which a domain's CHECK, a table's CHECK, a generated column
	 * or a view calls: its object is a function of the graph, so every object whose statements call it is created after
	 * it (physical/obligations/graph.ts namedEdges). A constant is named by its content, so one added again is the object already added, which takes
	 * the new reasons too.
	 */
	addConstant(
		name: Identity<
			"closedConstant" | "rosterConstant" | "rosterLive" | "libraryFunction" | "rowFunction"
		>,
		spec: {
			/** Its statements, built only where the constant is new: one added again builds none, so a constant many
			 * objects read, a closed side many containments read among them, is built once. */
			readonly ddl: () => ReadonlyArray<SqlStatement>
			readonly reasons: ReadonlyArray<PhysicalReason>
		},
		after: ReadonlyArray<Node<"setup">>
	): Node<"setup"> {
		const known = this.#constants.get(name.identifier)
		if (known !== undefined) {
			this.graph.addReasons(known.node, spec.reasons)
			return known.node
		}
		const ddl = spec.ddl()
		const node = this.add(
			{
				kind: "constant",
				ident: this.qualified("function", name),
				ddl,
				reasons: spec.reasons,
				phase: "setup"
			},
			after
		)
		this.#constants.set(name.identifier, { named: name, node, args: constantArgs(ddl) })
		return node
	}

	/** The statements of the installed table of `relation` that a write of it evaluates (`evaluatedTable`). */
	evaluatedOn(relation: string): ReadonlyArray<SqlStatement> {
		const statements = this.#evaluatedOn.get(this.names.relation(relation).name)
		if (statements === undefined) {
			missing(`physical: no stored relation ${relation}`)
		}
		return statements
	}

	/**
	 * Every constant of the installation that evaluating `roots` runs, ordered by the identities they were named by, each
	 * with its object: one reachability over the installation's constants and domains alike (`Evaluated`). A statement
	 * or a predicate runs each constant it calls and each domain it names, as a column's type or a cast's, a typed
	 * literal's or a parameter's target, since writing or coercing a value into a domain runs its CHECKs; a constant
	 * runs what its body does, and a domain what its base type, a contract's base chain among them, and its CHECKs do.
	 * These are what a role whose statements evaluate `roots` is granted EXECUTE on, and nothing else: PostgreSQL checks
	 * EXECUTE against the invoker on every function a plan runs, a view's, a policy's, a table CHECK's, a generated
	 * column's, a default's and a domain CHECK's included, and on a function body's calls as that body runs.
	 */
	evaluated(
		roots: EvaluationRoots
	): ReadonlyArray<{ readonly name: FunctionName; readonly node: Node<"setup"> }> {
		const constants = new Set<string>()
		const domains = new Set<string>()
		const pending: Array<SqlStatement> = [...roots.statements]
		const reach = (object: Evaluated): void => {
			const seen = object.kind === "constant" ? constants : domains
			if (seen.has(object.identifier)) {
				return
			}
			const node =
				object.kind === "constant"
					? this.#constants.get(object.identifier)?.node
					: this.#types.get(object.identifier)
			if (node === undefined) {
				return
			}
			seen.add(object.identifier)
			appendAll(pending, node.ddl)
		}
		const hooks: AstHooks = {
			...identityHooks,
			functionRef: (fn) => {
				if (fn.schema === this.schema) {
					reach({ kind: "constant", identifier: fn.name })
				}
				return fn
			},
			typeRef: (type) => {
				if (type.kind === "named") {
					reach({ kind: "domain", identifier: nameKey(type) })
				}
				return type
			}
		}
		for (const identifier of roots.constants) {
			reach({ kind: "constant", identifier })
		}
		for (const domain of roots.domains) {
			reach({ kind: "domain", identifier: nameKey(domain) })
		}
		for (const predicate of roots.predicates) {
			transformExpr(predicate, hooks)
		}
		for (let statement = pending.pop(); statement !== undefined; statement = pending.pop()) {
			transformStatement(statement, hooks)
		}
		return [...constants]
			.flatMap((identifier) => {
				const known = this.#constants.get(identifier)
				return known === undefined ? [] : [known]
			})
			.toSorted((a, b) => compareIdentities(a.named, b.named))
			.map((known) => ({
				name: { schema: this.schema, name: known.named.identifier, args: known.args },
				node: known.node
			}))
	}

	/** The domain the installation creates under `name`; none for another type. */
	typeNamed(name: { readonly schema: string; readonly name: string }): Node<"setup"> | undefined {
		return this.#types.get(nameKey(name))
	}

	/** The domain of the contract `contract`; none when the installation creates none for it. */
	domainOf(contract: DeclaredName): Node<"setup"> | undefined {
		return this.#types.get(nameKey(this.names.contractDomain(contract)))
	}

	/** Adds the table of the stored relation `relation`, which every object on it is created after (`table`). */
	addTable(
		relation: string,
		spec: ObjectSpec<"structure">,
		after: ReadonlyArray<Node<"setup" | "structure">>
	): Node<"structure"> {
		const node = this.add(spec, after)
		this.#tables.set(relation, node)
		return node
	}

	/** Adds the law column `column` of the stored relation `relation`, which every object over it is created after
	 * (`lawColumn`). */
	addLawColumn(
		relation: string,
		column: string,
		spec: ObjectSpec<"structure">,
		after: ReadonlyArray<Node<"setup" | "structure">>
	): Node<"structure"> {
		const node = this.add(spec, after)
		this.#lawColumnObjects.getOrInsertComputed(relation, () => new Map()).set(column, node)
		return node
	}

	/** The object of the law column `column` of `relation`, which the law model plans and the tables add before any
	 * object over it (physical/ddl/tables.ts addNatives). */
	lawColumn(relation: string, column: string): Node<"structure"> {
		return defined(
			this.#lawColumnObjects.get(relation)?.get(column),
			`the law column ${column} of ${relation}, which the law model plans`
		)
	}

	/** The table of the stored relation `relation`. A name the owned schema holds no stored relation of is refused as
	 * MalformedDescription (ir/physical.ts missing). */
	table(relation: string): Node<"structure"> {
		const table = this.#tables.get(relation)
		if (table === undefined) {
			missing(`physical: no stored relation ${relation}`)
		}
		return table
	}

	/** The object a read of `relation` waits for: its table, its roster's domain, or the stored table of the canonical
	 * relation it names, a derived relation's or an anonymous one's (analysis/derived/canonical.ts); none for a relation
	 * the installation holds no object of (a canonical relation no extension installs, a closed relation, which a read
	 * reads through the constants its statements call). */
	readObject(relation: string): Node<"setup" | "structure"> | undefined {
		const r = this.owned.relations[relation]
		switch (r?.kind) {
			case "relation":
				return this.table(relation)
			case "closed":
				return (
					this.#types.get(nameKey(this.names.rosterDomain(r.name))) ??
					missing(`physical: no domain of roster ${r.name}`)
				)
			case "derived":
			case undefined:
				return this.storedTable(relation)
			case "closedRelation":
				return undefined
		}
	}

	/** The extension that provides `capability`, added the first time an object needs it, so the installation holds it
	 * exactly when some object does, before each. */
	provider(capability: Capability): Node<"setup"> {
		const known = this.#providers.get(capability)
		if (known !== undefined) {
			return known
		}
		const node = this.add(
			{
				kind: "extension",
				ident: { kind: "extension", name: capability },
				ddl: [
					{ kind: "createExtension", name: capability, schema: this.#providerSchema(capability) }
				],
				reasons: [providerReasons[capability]],
				phase: "setup"
			},
			[]
		)
		this.#providers.set(capability, node)
		return node
	}

	#providerSchema(capability: Capability): string {
		switch (capability) {
			case "btree_gist":
				return this.settings.extensionSchema
			case "vector":
				return this.settings.vectorSchema
		}
	}

	/**
	 * The registered stored table `relation` reads: its canonical relation's (analysis/schema.ts CheckedSchema
	 * installedAs), which every alias of one definition reads, registered once by it (addIndexedView); none when no
	 * extension installs it. Index requests and footprints reach it as installed relations already, so its alias
	 * resolution is reached only by a role's whole view of an alias, where it carries the view's dependency edge on the
	 * table: no property's kill can see it undone, which is why none declares one.
	 */
	#viewOf(relation: string): IndexedView | undefined {
		return this.#views.get(this.checked.installedAs(relation))
	}

	/** The stored table of the derived relation `relation` (`#viewOf`); none when no extension installs it. */
	storedTable(relation: string): Node<"structure"> | undefined {
		return this.#viewOf(relation)?.object
	}

	/** The fields of the primary key of the stored derived relation `relation`'s table (`#viewOf`), in key order, as its
	 * extension registered it. A relation of no registered stored table is refused as MalformedDescription. */
	storedPrimaryKey(relation: string): NonEmptyReadonlyArray<string> {
		const view = this.#viewOf(relation)
		if (view === undefined) {
			missing(`physical: no stored table of derived relation ${relation}`)
		}
		return view.primaryKey
	}

	/** Registers a stored table that takes indexes, before the indexes are planned. */
	addIndexedView(view: IndexedView): void {
		this.#views.set(view.relation, view)
	}

	/** What the relation a request names, `relation`, has its indexes and statistics built on (RelationTarget): its
	 * registered view, its table, or nothing. The request's relation and the fields it names are resolved here, each
	 * absent one undefined to the request's own refusal: a stored relation's by its theory relation's field handles, or
	 * a law column of it by its identifier, which is its installed column. */
	/**
	 * Every text column of every stored table of the installation, an ordinary relation's and a stored derived
	 * relation's, by the table and column a statement reads it through: what a judged read reads each suffix test of as
	 * its text's suffix key's range (physical/ddl/rules.ts loweredJudged, sql/suffix.ts seekingSuffixes), which its
	 * routine's binding reads as a range of that key wherever the suffix is fixed beside the row (sql/bind.ts), so the
	 * B-tree its plan asks for serves it.
	 */
	get texts(): StoredColumns {
		this.#texts ??= storedColumns(
			Object.entries(this.model.theory.relations).flatMap(([relation, r]) =>
				r.kind === "closed"
					? []
					: r.fields.flatMap((f) =>
							baseOf(f.type).carrier === "text"
								? [
										{
											table: this.names.relation(relation),
											column: this.names.column(relation, f.name)
										}
									]
								: []
						)
			)
		)
		return this.#texts
	}

	target(relation: string): RelationTarget {
		const view = this.#viewOf(relation)
		if (view !== undefined) {
			const heading = [...view.fields.keys()]
			return {
				kind: "built",
				field: (c) => (c.kind === "field" ? view.fields.get(c.field) : undefined),
				fields: [...view.fields],
				column: (c) => (c.kind === "field" ? this.names.column(relation, c.field) : c.column),
				place: (c) => (c.kind === "field" ? heading.indexOf(c.field) : heading.length),
				digests: new Map(),
				after: () => [view.object]
			}
		}
		const relations = this.model.theory.relations
		const stored = Object.hasOwn(relations, relation) ? relations[relation] : undefined
		if (stored?.kind === "relation") {
			const lawColumns = this.#lawColumns.get(relation)
			const lawOrder = [...(lawColumns?.keys() ?? [])].toSorted(compareStrings)
			return {
				kind: "built",
				field: (c) =>
					c.kind === "field"
						? stored.fields.find((field) => field.name === c.field)
						: lawColumns?.get(c.column),
				fields: [
					...stored.fields.map((field) => [field.name, field] as const),
					...(lawColumns ?? noLawColumns)
				],
				column: (c) => (c.kind === "field" ? this.names.column(relation, c.field) : c.column),
				place: (c) =>
					c.kind === "field"
						? stored.fields.findIndex((field) => field.name === c.field)
						: stored.fields.length + lawOrder.indexOf(c.column),
				digests: textDigestsOf(stored.fields),
				after: (columns) => [
					this.table(relation),
					...new Set(
						columns.flatMap((c) => (c.kind === "law" ? [this.lawColumn(relation, c.column)] : []))
					)
				]
			}
		}
		const owned = Object.hasOwn(this.owned.relations, relation)
			? this.owned.relations[relation]
			: undefined
		return owned?.kind === "derived" || this.checked.canonicalNamed(relation) !== undefined
			? { kind: "deferred" }
			: { kind: "none" }
	}

	/** Every registered view, by relation name. */
	indexedViews(): ReadonlyArray<IndexedView> {
		return [...this.#views.values()].toSorted((a, b) => compareStrings(a.relation, b.relation))
	}
}

/** Why each extension is installed. */
const providerReasons = {
	btree_gist: enforcement("btree_gist operator classes for the scalar components of GiST keys"),
	vector: enforcement(
		`pgvector ${vectorExtension.version}: the vector type, vector_norm and cosine_distance`
	)
} as const satisfies Record<Capability, PhysicalReason>

/** Whether `type` is the vector extension's type, which an object naming it needs the extension for. */
export const isVectorRef = (b: InstallBuilder, type: TypeRef): boolean =>
	type.kind === "named" &&
	type.schema === b.settings.vectorSchema &&
	type.name === vectorExtension.name
