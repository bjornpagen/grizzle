import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { appendAll } from "#compiler/core/array.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import {
	compareIdentities,
	type DeclaredName,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { ColumnIdent, ConstraintName, Identifier, IdentityKind } from "#compiler/core/ids.ts"
import { tableMaxColumns } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { headNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { InferredFieldDesc } from "#compiler/ir/desc.ts"
import type { DeployPhase, PhysicalReason } from "#compiler/ir/products.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import { addIsolation } from "#compiler/physical/ddl/isolation.ts"
import { snapshotGuardDdl } from "#compiler/physical/ddl/ledger.ts"
import { type InstallNames, missing } from "#compiler/physical/ddl/names.ts"
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
import type { Owned, OwnedLogin } from "#compiler/schema/own.ts"
import type { Expr, FunctionName, ObjectName, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	type AstHooks,
	identityHooks,
	transformExpr,
	transformStatement
} from "#compiler/sql/transform.ts"
import { refusalFunctionDdl } from "#compiler/write/refusal.ts"

export interface InstallSettings {
	/** The owner a fresh-install script names, which owns the schema and every object in it, and which its
	 * default-privilege resets name. Undefined for a migration: the migration identity is
	 * whoever connects, so the schema is created without AUTHORIZATION and the resets name no role. */
	readonly owner: string | undefined
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

/** A materialized view an extension installs that takes indexes like a table (a derived relation's): its fields,
 * the graph object its indexes are created after, and its unique indexes, each in index column order, which serve
 * index requests as a table's key indexes do. */
interface IndexedView {
	readonly relation: string
	readonly object: Node<"structure">
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
	readonly desc: InferredFieldDesc
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
	readonly column: (column: IndexColumn) => string
	readonly object: Node<"structure">
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
		const own = out.get(o.relation.name) ?? new Map<string, TargetField>()
		own.set(o.column, { desc: o.field.desc, type: o.field.type })
		out.set(o.relation.name, own)
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
	| { readonly kind: "domain"; readonly identifier: string }

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
 * a view's or a materialized view's own, an ALTER TABLE's ADD COLUMNs. Every other statement gives no relation a column
 * (a carrier, which does, is a write program's, write/carriers/carriers.ts).
 */
const widenedRelation = (
	statement: SqlStatement
): { readonly relation: ObjectName; readonly columns: number } | undefined => {
	if (statement.kind === "createTable") {
		return { relation: statement.table, columns: statement.columns.length }
	}
	if (statement.kind === "createView" || statement.kind === "createMaterializedView") {
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

/** A domain's key among the installation's: its schema and its identifier, which no identifier holds a NUL of. */
const typeKey = (schema: string, name: string): string => `${schema}\u0000${name}`

/** The key of the domain `name` among the installation's (`typeKey`). */
export const domainKey = (name: { readonly schema: string; readonly name: string }): string =>
	typeKey(name.schema, name.name)

/** What every DDL generator of one installation shares: the owned schema, its law model, the installed names, the
 * obligation graph the objects go into, and the identities the installation names its own objects by (`name`).
 *
 * It adds the objects every installation holds when it is made: the schema, the refusal function every write statement
 * that can refuse and every context source raises through, the isolation default and guard, and the snapshot guard,
 * each after the schema. Each
 * later stage adds its objects after the objects it reads, named by the handles their stages returned; a domain a column
 * or a declaration names by its identifier (`addType`, `typeNode`), a constant a statement calls (`addConstant`,
 * `constantNodes`), a table by its relation
 * (`addTable`, `table`), and an extension an object needs at the object's addition (`provider`). */
export class InstallBuilder {
	readonly owned: Owned
	/** The checker's reading of the owned schema, read once by the installation. */
	readonly checked: CheckedSchema
	readonly model: LawModel
	readonly names: InstallNames
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
	/** The guard function every table's isolation trigger calls. */
	readonly isolation: Node<"setup">
	/** The snapshot guard every Db transaction and Db.open call behind the ledger's fence. */
	readonly snapshotGuard: Node<"setup">
	readonly #named: Array<Identity<IdentityKind>> = []
	readonly #providers = new Map<Capability, Node<"setup">>()
	/** Each domain the installation creates, by its schema and identifier (`typeKey`). */
	readonly #types = new Map<string, Node<"setup">>()
	/** Each constant by identifier: its identity, its object and the constants its body calls. */
	readonly #constants = new Map<
		string,
		{
			readonly named: Identity<IdentityKind>
			readonly node: Node<"setup">
		}
	>()
	readonly #tables = new Map<string, Node<"structure">>()
	/** Each installed table's statements a write of it evaluates (`evaluatedTable`), by the table's identifier. */
	readonly #evaluatedOn = new Map<string, Array<SqlStatement>>()
	readonly #views = new Map<string, IndexedView>()
	readonly #qualified = new Map<QualifiedKind, Map<string, Map<string, Node<DeployPhase>>>>()
	/** The law columns of each stored relation an index may name (`lawColumnFields`). */
	readonly #lawColumns: ReadonlyMap<string, ReadonlyMap<string, TargetField>>
	/** The columns each table, view and materialized view the objects so far create holds, by its qualified name. */
	readonly #columns = new Map<string, number>()
	/** The identifiers of the levels' schemas, where every table of the installation is. */
	readonly #levelSchemas: ReadonlySet<string>

	constructor(input: {
		readonly owned: Owned
		readonly checked: CheckedSchema
		readonly model: LawModel
		readonly names: InstallNames
		readonly settings: InstallSettings
	}) {
		this.owned = input.owned
		this.checked = input.checked
		this.model = input.model
		this.names = input.names
		this.settings = input.settings
		this.natives = input.model.natives
		this.#lawColumns = lawColumnFields(input.model.natives)
		this.#levelSchemas = new Set(input.names.levels.map(identifierOf))
		const levelNode = (installation: Identity<"schema">, index: number): Node<"setup"> =>
			this.add(
				{
					kind: "schema",
					ident: { kind: "schema", name: installation },
					ddl: [
						{
							kind: "createSchema",
							name: this.name(installation),
							authorization: input.settings.owner
						}
					],
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

	/** The schema object of the level that declares `relation`, which every object of the relation is created after. */
	levelNode(relation: string): Node<"setup"> {
		return (
			this.levelNodes[this.names.levels.indexOf(this.names.levelOf(relation))] ??
			missing(`physical: no installed level for ${relation}`)
		)
	}

	/**
	 * Adds an object, created after each of `after`. A table its statements would give more columns than PostgreSQL's
	 * tableMaxColumns, the columns its CREATE TABLE and every ADD COLUMN after it give it together, or a view or
	 * materialized view of more, is refused here as ResourceBound (tableColumns).
	 */
	add<P extends DeployPhase>(
		spec: ObjectSpec<P>,
		after: ReadonlyArray<Node<Before<NoInfer<P>>>>
	): Node<P> {
		for (const statement of spec.ddl) {
			this.#countColumns(statement)
			const table = evaluatedTable(statement)
			if (table !== undefined && this.#levelSchemas.has(table.schema)) {
				const known = this.#evaluatedOn.get(table.name)
				if (known === undefined) {
					this.#evaluatedOn.set(table.name, [statement])
				} else {
					known.push(statement)
				}
			}
		}
		const node = this.graph.add(spec, after)
		const ident = spec.ident
		switch (ident.kind) {
			case "domain":
			case "table":
			case "materializedView":
			case "view":
			case "index":
			case "statistics":
			case "function":
			case "rowSecurity": {
				const kind =
					this.#qualified.get(ident.kind) ?? new Map<string, Map<string, Node<DeployPhase>>>()
				const schema = kind.get(ident.schema.identifier) ?? new Map<string, Node<DeployPhase>>()
				schema.set(ident.name.identifier, node)
				kind.set(ident.schema.identifier, schema)
				this.#qualified.set(ident.kind, kind)
				return node
			}
			case "schema":
			case "role":
			case "membership":
			case "privileges":
			case "extension":
			case "column":
			case "constraint":
			case "trigger":
			case "policy":
			case "text":
				return node
		}
	}

	/** The columns `statement` gives the relation it creates or adds to, counted against tableMaxColumns. */
	#countColumns(statement: SqlStatement): void {
		const widened = widenedRelation(statement)
		if (widened === undefined) {
			return
		}
		const table = printObjectName(widened.relation)
		const needed = (this.#columns.get(table) ?? 0) + widened.columns
		if (needed > tableMaxColumns.value) {
			throw new Refusal(
				resourceBound(SourceLoc(`installation of schema ${this.owned.name}`, []), {
					kind: "tableColumns",
					table,
					limit: tableMaxColumns.value,
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
		this.#types.set(typeKey(schema.identifier, name.identifier), node)
		return node
	}

	/**
	 * Adds a constant of the installed schema, a function of no argument (physical/ddl/constants.ts), which a domain's
	 * CHECK, a table's CHECK, a generated column or a view calls: its object is a function of the graph, so every object
	 * whose statements call it is created after it (`readsOf`). A constant is named by its content, so one added again
	 * is the object already added, which takes the new reasons too.
	 */
	addConstant(
		name: Identity<"closedConstant" | "rosterConstant" | "rosterLive">,
		spec: Omit<ObjectSpec<"setup">, "kind" | "ident" | "phase">,
		after: ReadonlyArray<Node<"setup">>
	): Node<"setup"> {
		const known = this.#constants.get(name.identifier)
		if (known !== undefined) {
			this.graph.addReasons(known.node, spec.reasons)
			return known.node
		}
		const node = this.add(
			{
				kind: "constant",
				ident: this.qualified("function", name),
				ddl: spec.ddl,
				reasons: spec.reasons,
				phase: "setup"
			},
			after
		)
		this.#constants.set(name.identifier, { named: name, node })
		return node
	}

	/** The installation's constants `statements` call, by identifier. */
	#constantCalls(statements: ReadonlyArray<SqlStatement>): ReadonlySet<string> {
		const called = new Set<string>()
		const hooks: AstHooks = {
			...identityHooks,
			functionRef: (fn) => {
				if (fn.schema === this.schema && this.#constants.has(fn.name)) {
					called.add(fn.name)
				}
				return fn
			}
		}
		for (const statement of statements) {
			transformStatement(statement, hooks)
		}
		return called
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
					reach({ kind: "domain", identifier: typeKey(type.schema, type.name) })
				}
				return type
			}
		}
		for (const identifier of roots.constants) {
			reach({ kind: "constant", identifier })
		}
		for (const domain of roots.domains) {
			reach({ kind: "domain", identifier: domainKey(domain) })
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
				name: { schema: this.schema, name: known.named.identifier, args: [] },
				node: known.node
			}))
	}

	/** The objects of the constants `statements` call directly, which an object holding them is created after. */
	constantNodes(statements: ReadonlyArray<SqlStatement>): ReadonlyArray<Node<"setup">> {
		return [...this.#constantCalls(statements)].flatMap((identifier) => {
			const known = this.#constants.get(identifier)
			return known === undefined ? [] : [known.node]
		})
	}

	/** The domain of the installed schema `type` names; none for a type the installation creates no object for (a
	 * builtin type, the vector extension's). */
	typeNode(type: TypeRef): Node<"setup"> | undefined {
		return type.kind === "named" ? this.typeNamed(type) : undefined
	}

	/** The domain the installation creates under `name`; none for another type. */
	typeNamed(name: { readonly schema: string; readonly name: string }): Node<"setup"> | undefined {
		return this.#types.get(typeKey(name.schema, name.name))
	}

	/** The domain of the contract `contract`; none when the installation creates none for it. */
	domainOf(contract: DeclaredName): Node<"setup"> | undefined {
		return this.#types.get(domainKey(this.names.contractDomain(contract)))
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

	/** The table of the stored relation `relation`. A name the owned schema holds no stored relation of is refused as
	 * MalformedDescription (physical/ddl/names.ts). */
	table(relation: string): Node<"structure"> {
		const table = this.#tables.get(relation)
		if (table === undefined) {
			missing(`physical: no stored relation ${relation}`)
		}
		return table
	}

	/** The object a read of `relation` waits for: its table, its roster's domain, or its derived relation's
	 * materialized view; none for a relation the installation holds no object of (a derived relation no extension
	 * installs, a closed relation, which a read reads through the constants its statements call). */
	readObject(relation: string): Node<"setup" | "structure"> | undefined {
		const r = this.owned.relations[relation]
		switch (r?.kind) {
			case "relation":
				return this.table(relation)
			case "closed":
				return (
					this.#types.get(domainKey(this.names.rosterDomain(r.name))) ??
					missing(`physical: no domain of roster ${r.name}`)
				)
			case "derived":
				return this.materializedView(relation)
			case "closedRelation":
			case undefined:
				return undefined
		}
	}

	/** The object of `kind` the installation creates under `name`, which a statement names; none for an object it does
	 * not create. */
	objectNamed(kind: QualifiedKind, name: ObjectName): Node<DeployPhase> | undefined {
		return this.#qualified.get(kind)?.get(name.schema)?.get(name.name)
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

	/** The materialized view of the derived relation `relation`; none when no extension installs it. */
	materializedView(relation: string): Node<"structure"> | undefined {
		return this.#views.get(relation)?.object
	}

	/** Registers a materialized view that takes indexes, before the indexes are planned. */
	addIndexedView(view: IndexedView): void {
		this.#views.set(view.relation, view)
	}

	/** What the relation a request names, `relation`, has its indexes and statistics built on (RelationTarget): its
	 * registered view, its table, or nothing. The request's relation and the fields it names are resolved here, each
	 * absent one undefined to the request's own refusal: a stored relation's by its theory relation's field handles, or
	 * a law column of it by its identifier, which is its installed column. */
	target(relation: string): RelationTarget {
		const view = this.#views.get(relation)
		if (view !== undefined) {
			return {
				kind: "built",
				field: (c) => (c.kind === "field" ? view.fields.get(c.field) : undefined),
				column: (c) => (c.kind === "field" ? this.names.column(relation, c.field) : c.column),
				object: view.object
			}
		}
		const relations = this.model.theory.relations
		const stored = Object.hasOwn(relations, relation) ? relations[relation] : undefined
		if (stored?.kind === "relation") {
			const lawColumns = this.#lawColumns.get(relation)
			return {
				kind: "built",
				field: (c) =>
					c.kind === "field"
						? stored.fields.find((field) => field.name === c.field)
						: lawColumns?.get(c.column),
				column: (c) => (c.kind === "field" ? this.names.column(relation, c.field) : c.column),
				object: this.table(relation)
			}
		}
		const owned = Object.hasOwn(this.owned.relations, relation)
			? this.owned.relations[relation]
			: undefined
		return owned?.kind === "derived" ? { kind: "deferred" } : { kind: "none" }
	}

	/** Every registered view, by relation name. */
	indexedViews(): ReadonlyArray<IndexedView> {
		return [...this.#views.values()].toSorted((a, b) =>
			a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0
		)
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
