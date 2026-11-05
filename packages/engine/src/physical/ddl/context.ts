import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { compareText, Refusal } from "#compiler/core/canonical.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import { type DeclaredName, type Identity, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, Identifier, IdentityKind } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { tableMaxColumns } from "#compiler/core/policy.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { DeployPhase, PhysicalReason } from "#compiler/ir/products.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"
import { addIsolation } from "#compiler/physical/ddl/isolation.ts"
import { snapshotGuardDdl } from "#compiler/physical/ddl/ledger.ts"
import { type InstallNames, missing, worldNames } from "#compiler/physical/ddl/names.ts"
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
import type { ObjectName, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { refusalFunctionDdl } from "#compiler/write/refusal.ts"

export interface InstallSettings {
	/** The owner a fresh-install script names, which owns the schema and every object in it, and which its
	 * default-privilege resets name. Undefined for a migration: the migration identity is
	 * whoever connects, so the schema is created without AUTHORIZATION and the resets name no role. */
	readonly owner: string | undefined
	/** The identity of the PostgreSQL schema the objects are created in, which every role installed beside it embeds
	 * (roles are cluster-wide): the declared schema's (Owned.installation), or a test's unique one. */
	readonly installation: Identity<"schema">
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

/** A field an index or statistics object of a relation may name: its descriptor and its type. */
export interface TargetField {
	readonly desc: FieldDesc
	readonly type: ScalarType
}

/** What a relation's indexes and statistics are built on once every extension has run: a stored relation's table or a
 * derived relation's registered view, with the fields an object on it may name and the graph object the object is
 * created after; a derived relation no extension installs, whose objects are deferred with it, as the installation
 * reports it (Installation.deferred); or no stored or derived relation at all. */
type RelationTarget = BuiltTarget | { readonly kind: "deferred" } | { readonly kind: "none" }

/** A relation an object can be built on: a stored relation's table or a registered view. */
export interface BuiltTarget {
	readonly kind: "built"
	readonly field: (field: string) => TargetField | undefined
	readonly object: Node<"structure">
}

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

/** What every DDL generator of one installation shares: the owned schema, its law model, the installed names, the
 * obligation graph the objects go into, and the identities the installation names its own objects by (`name`).
 *
 * It adds the objects every installation holds when it is made: the schema, the refusal function every write statement
 * that can refuse and every context source raises through, the isolation default and guard, and the snapshot guard,
 * each after the schema. Each
 * later stage adds its objects after the objects it reads, named by the handles their stages returned; an enum or a
 * domain a column or a declaration names by its identifier (`addType`, `typeNode`), a table by its relation
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
	/** The installed schema, which every object of it is created after. */
	readonly schemaNode: Node<"setup">
	/** The refusal function every write statement that can refuse and every context source calls. */
	readonly refusal: Node<"setup">
	/** The guard function every table's isolation trigger calls. */
	readonly isolation: Node<"setup">
	/** The snapshot guard every Db transaction and Db.open call behind the ledger's fence. */
	readonly snapshotGuard: Node<"setup">
	readonly #named: Array<Identity<IdentityKind>> = []
	readonly #providers = new Map<Capability, Node<"setup">>()
	readonly #types = new Map<string, Node<"setup">>()
	readonly #tables = new Map<string, Node<"structure">>()
	readonly #views = new Map<string, IndexedView>()
	readonly #qualified = new Map<QualifiedKind, Map<string, Map<string, Node<DeployPhase>>>>()
	/** The columns each table, view and materialized view the objects so far create holds, by its qualified name. */
	readonly #columns = new Map<string, number>()

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
		const installation = input.settings.installation
		this.schemaNode = this.add(
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
				reasons: [enforcement(`schema ${input.owned.name}`)],
				phase: "setup"
			},
			[]
		)
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

	/** Every identity `name` minted, in order. */
	named(): ReadonlyArray<Identity<IdentityKind>> {
		return [...this.#named]
	}

	/** The graph identity of an object `name` names in the installed schema. */
	qualified(kind: QualifiedKind, name: Identity<IdentityKind>): NodeIdent {
		return { kind, schema: this.settings.installation, name }
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
		}
		const node = this.graph.add(spec, after)
		const ident = spec.ident
		switch (ident.kind) {
			case "enum":
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

	/** Adds an enum or a domain of the installed schema, which a column, a cast or a declaration names by its
	 * identifier (`typeNode`). */
	addType(
		kind: "enum" | "domain",
		name: Identity<IdentityKind>,
		spec: Omit<ObjectSpec<"setup">, "kind" | "ident" | "phase">,
		after: ReadonlyArray<Node<"setup">>
	): Node<"setup"> {
		const node = this.add(
			{
				kind,
				ident: this.qualified(kind, name),
				ddl: spec.ddl,
				reasons: spec.reasons,
				phase: "setup"
			},
			after
		)
		this.#types.set(name.identifier, node)
		return node
	}

	/** The enum or domain of the installed schema `type` names; none for a type the installation creates no object for
	 * (a builtin type, the vector extension's). */
	typeNode(type: TypeRef): Node<"setup"> | undefined {
		return type.kind === "named" ? this.typeNamed(type) : undefined
	}

	/** The enum or domain the installation creates under `name`; none for another type. */
	typeNamed(name: { readonly schema: string; readonly name: string }): Node<"setup"> | undefined {
		return name.schema === this.schema ? this.#types.get(name.name) : undefined
	}

	/** The domain of the contract `contract`; none when the installation creates none for it. */
	domainOf(contract: DeclaredName): Node<"setup"> | undefined {
		return this.#types.get(this.names.contractDomain(contract).name)
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

	/** The object a read of `relation` waits for: its table, its closed relation's enum, or its derived relation's
	 * materialized view; none for a relation the installation does not hold (a derived relation no extension installs). */
	readObject(relation: string): Node<"setup" | "structure"> | undefined {
		const r = this.owned.relations[relation]
		switch (r?.kind) {
			case "relation":
				return this.#tables.get(relation)
			case "closed":
				return this.#types.get(this.names.enumType(r.name).name)
			case "derived":
				return this.materializedView(relation)
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
	 * absent one undefined to the request's own refusal: a stored relation's by its theory relation's field handles. */
	target(relation: string): RelationTarget {
		const view = this.#views.get(relation)
		if (view !== undefined) {
			return { kind: "built", field: (f) => view.fields.get(f), object: view.object }
		}
		const relations = this.model.theory.relations
		const stored = Object.hasOwn(relations, relation) ? relations[relation] : undefined
		if (stored?.kind === "relation") {
			return {
				kind: "built",
				field: (f) => stored.fields.find((field) => field.name === f),
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

	/** The theory roles holding `relation` whole, in role name order: the roles a law function reports the witness keys
	 * of a violation of that relation to (`raiseViolation`). */
	wholeHolders(relation: string): ReadonlyArray<string> {
		return this.settings.logins
			.flatMap((l) => l.roles)
			.filter((r) => r.relations[relation]?.kind === "whole")
			.toSorted((x, y) => compareText(x.name, y.name))
			.map((r) => worldNames(r, this.settings.installation).role)
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
