/**
 * What the binding reads of an installation (sql/bind.ts ReadCatalog): each stored table, its relation, the installed
 * columns an index serves with the field each is and its kind (sql/bind.ts BindColumn), and its keys, each its
 * installed columns; and each role's view. One derivation of these facts, from the law model and the installed names
 * (`catalogOf`), serves every statement bound against the installation: its routines', which the installation binds
 * (`installCatalog`), and its served programs', which compile before it plans its indexes (`artifactsCatalog`).
 *
 * What a column is (`columnOf`): a span and a search document are no B-tree's key, so an equality on one is a filter
 * beside a read's binding, but GiST serves a span's Allen relations and GIN a document's match; of a B-tree's, a roster's
 * handle and a boolean hold few values, the share of the rows they pick bounded whatever the store holds, every other
 * many, a vector among them, which pgvector's B-tree class (vector_ops) keys, as a key of one does, by its own `=`, and
 * whose distance HNSW serves. A byte string and a text of no byte bound are columns like any other: a read that binds one
 * asks for it, and the index engine decides what serves it, a hash index for a byte string, an undigested text refused
 * UnrepresentableKey (physical/indexes/engine.ts refusedUndigested), so the rule of what no entry holds has one place.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { identifierOf, identity, parseDeclaredName } from "#compiler/core/identity.ts"
import { compareNumbers, compareStrings } from "#compiler/core/order.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import {
	baseOf,
	fewValued,
	isSpanCarrier,
	nativeNames,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { InstallBuilder, TargetField } from "#compiler/physical/ddl/context.ts"
import { type NameKey, nameKey, type ObjectName } from "#compiler/sql/ast.ts"
import type { BindColumn, BindTable, BindView, ReadCatalog } from "#compiler/sql/bind.ts"
import { type Alias, wholeViewAlias } from "#compiler/sql/naming.ts"

/**
 * A field as an index serves it (see the header), by its carrier: a span's and a search document's, which GiST and GIN
 * serve; a B-tree's for every other, of a network, a vector, whose distance HNSW serves under the installation's cosine
 * class, a text or a scalar, holding few values or many, a byte string and a text of no byte bound among them.
 */
const columnOf = (field: TargetField, name: string, vectorSchema: string): BindColumn => {
	const carrier = baseOf(field.type).carrier
	if (isSpanCarrier(carrier)) {
		return { kind: "span", field: name }
	}
	if (carrier === "tsvector") {
		return { kind: "search", field: name }
	}
	const holds = fewValued[carrier] ? "few" : "many"
	if (carrier === "vector") {
		return {
			kind: "vector",
			field: name,
			holds,
			cosine: { kind: "vectorCosine", schema: vectorSchema }
		}
	}
	if (carrier === "inet" || carrier === "cidr") {
		return { kind: "network", field: name, holds }
	}
	return { kind: carrier === "text" ? "text" : "scalar", field: name, holds }
}

/**
 * The PostgreSQL types of grizzle's carriers (ir/scalar.ts nativeNames) whose equality function is not leakproof, so no
 * qual of it passes a security barrier (allpaths.c qual_is_pushdown_safe): numeric_eq, record_eq, range_eq and
 * tsvector_eq, and pgvector's vector_eq, which its extension script (vector--0.8.7.sql) creates without LEAKPROOF;
 * every other carrier's equality, int2eq to biteq, uuid_eq, texteq and byteaeq among them, is. PostgreSQL 19.0's
 * pg_proc.proleakproof of each `=` operator's function over two operands of one type says so.
 */
const leakyTypes: ReadonlySet<string> = new Set([
	"numeric",
	"record",
	"int4range",
	"int8range",
	"daterange",
	"tsvector",
	"vector"
])

/**
 * Whether PostgreSQL's equality on a value of `type` is leaky (`leakyTypes`): the one rule of what a security barrier
 * passes, which a world view's access reads (physical/access/extract.ts WorldView).
 */
export const leakyEquality = (type: ScalarType): boolean =>
	leakyTypes.has(nativeNames[baseOf(type).carrier])

/**
 * The alias the body of each stored relation's whole view names its table by (sql/naming.ts wholeViewAlias), by the
 * relation's name: `v<n>`, n its place, from 1, among the stored relations of the law model `model`, ordered by the
 * level that declares each, then by name. A login's compile reads the model of its base, which holds every relation of
 * the levels it stands on, each at the place the installation's model gives it, so the installation's views
 * (physical/ddl/roles.ts wholeView) and every compile that reads one name each relation alike.
 */
export const wholeViewAliases = (model: LawModel): ReadonlyMap<string, Alias> =>
	new Map(
		Object.values(model.theory.relations)
			.filter((r) => r.kind !== "closed")
			.toSorted((a, b) => compareNumbers(a.level, b.level) || compareStrings(a.name, b.name))
			.map((r, at) => [r.name, wholeViewAlias(at + 1)] as const)
	)

/** A view PostgreSQL plans apart under the reference's alias, a world view's (sql/bind.ts BindView). */
const worldView: BindView = { kind: "world" }

/** The installed names the binding's catalog reads (`catalogOf`): a table's and its columns', and a whole view's. */
type CatalogNames = Pick<PhysicalNames, "relation" | "column" | "vectorSchema"> & {
	readonly wholeView: (relation: string) => ObjectName
}

/**
 * The stored tables of the law model `model` under the installed names `names` (see the header), each by its name's
 * key: an ordinary relation's and a stored derived relation's, each column by its installed name, each key of no span by
 * its installed columns; each one's whole view (InstallNames `wholeView`), its table read under the alias its body names
 * it by (`wholeViewAliases`), each of its columns the table's column it reads, a closed id's decoded column its code's
 * (physical/ddl/roles.ts viewColumns); and which other names are views PostgreSQL plans apart, `world`.
 */
const catalogOf = (
	model: LawModel,
	names: CatalogNames,
	world: (key: NameKey, tables: ReadonlyMap<NameKey, BindTable>) => boolean,
	fired: ReadCatalog["fired"]
): ReadCatalog => {
	const tables = new Map<NameKey, BindTable>()
	const views = new Map<NameKey, BindView>()
	const aliases = wholeViewAliases(model)
	for (const [relation, r] of Object.entries(model.theory.relations)) {
		if (r.kind === "closed") {
			continue
		}
		const columns = new Map(
			r.fields.map(
				(f) => [names.column(relation, f.name), columnOf(f, f.name, names.vectorSchema)] as const
			)
		)
		const viewed = new Map<string, string>()
		for (const f of r.fields) {
			const installed = names.column(relation, f.name)
			viewed.set(installed, installed)
			if (baseOf(f.type).carrier === "code") {
				const field = parseDeclaredName(f.name)
				if (!field.ok) {
					return defect(`the closed id field ${f.name} of ${relation}, a declared name`)
				}
				viewed.set(identifierOf(identity.decodedColumn(field.value)), installed)
			}
		}
		const keys = r.keyNames.flatMap((k) =>
			k.span === undefined ? [k.fields.map((f) => names.column(relation, f.name))] : []
		)
		const table: BindTable = { relation, columns, keys }
		tables.set(nameKey(names.relation(relation)), table)
		views.set(nameKey(names.wholeView(relation)), {
			kind: "whole",
			table,
			alias: aliases.get(relation) ?? defect(`the whole view alias of ${relation}`),
			columns: viewed
		})
	}
	return {
		table: (key) => tables.get(key),
		view: (key) => views.get(key) ?? (world(key, tables) ? worldView : undefined),
		fired
	}
}

/**
 * The catalog of the installation `b` builds (see the header), every other view its statements create one PostgreSQL
 * plans apart, as a world view is, and each trigger function's table's columns, each its type, by the function every trigger the statements create on a table
 * calls.
 */
export const installCatalog = (b: InstallBuilder): ReadCatalog => {
	const statements = b.graph.statements()
	const views = new Set(
		statements.flatMap((s) => (s.kind === "createView" ? [nameKey(s.name)] : []))
	)
	const columns = new Map(
		statements.flatMap((s) =>
			s.kind === "createTable"
				? [[nameKey(s.table), new Map(s.columns.map((c) => [c.name, c.type] as const))] as const]
				: []
		)
	)
	const fired = new Map(
		statements.flatMap((s) => {
			const trigger =
				s.kind === "createGuardTrigger" ||
				s.kind === "createImmutableGuardTrigger" ||
				s.kind === "createConstraintTrigger" ||
				s.kind === "createTransitionTrigger"
					? s
					: undefined
			const table = trigger === undefined ? undefined : columns.get(nameKey(trigger.table))
			return trigger === undefined || table === undefined
				? []
				: [[nameKey(trigger.function), table] as const]
		})
	)
	return catalogOf(
		b.model,
		b.names,
		(key) => views.has(key),
		(fn) => fired.get(fn)
	)
}

/** The schemas a name grizzle reads may live in that hold no view: the session's own and the catalog's. */
const noViews: ReadonlySet<string> = new Set(["pg_temp", "pg_catalog"])

/**
 * The catalog of the installation a served program compiles against (see the header), before it exists, its law model
 * `model` under its installed names `names`: every name the program reads that is no stored table, outside the
 * session's and the catalog's schemas, a role's view, as a role's programs read every relation through one
 * (physical/ddl/names.ts roleReadNames).
 */
export const servedCatalog = (model: LawModel, names: CatalogNames): ReadCatalog =>
	catalogOf(
		model,
		names,
		(key, tables) => {
			const schema = key.slice(0, key.indexOf("\u0000"))
			return !tables.has(key) && !noViews.has(schema)
		},
		() => undefined
	)
