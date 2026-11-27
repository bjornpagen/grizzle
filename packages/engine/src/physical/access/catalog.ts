import type { PhysicalNames } from "#compiler/ir/physical.ts"
/**
 * What the binding reads of an installation (sql/bind.ts ReadCatalog): each stored table, its relation, the installed
 * columns a B-tree holds with the field each is and how many values it holds, and its keys, each its installed
 * columns; and each role's view. One derivation of these facts, from the law model and the installed names
 * (`catalogOf`), serves every statement bound against the installation: its routines', which the installation binds
 * (`installCatalog`), and its served programs', which compile before it plans its indexes (`artifactsCatalog`).
 *
 * What a column holds (`holdsOf`): a span, a search document, a byte string and a text of no byte bound are no
 * B-tree's key, so an equality on one is a filter beside a read's binding; a roster's handle and a boolean hold few
 * values, the share of the rows they pick bounded whatever the store holds; every other column many, a vector among
 * them, which pgvector's B-tree class (vector_ops) keys, as a key of one does, by its own `=`.
 */
import {
	baseOf,
	fewValued,
	isSpanCarrier,
	nativeNames,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { InstallBuilder, TargetField } from "#compiler/physical/ddl/context.ts"
import { datumBound } from "#compiler/schema/representability.ts"
import { type NameKey, nameKey } from "#compiler/sql/ast.ts"
import type { BindColumn, BindTable, ReadCatalog } from "#compiler/sql/bind.ts"

/** What a field holds for a B-tree (see the header): many values, few, or none it keys by. */
const holdsOf = (field: TargetField): BindColumn["holds"] | undefined => {
	const carrier = baseOf(field.type).carrier
	if (
		isSpanCarrier(carrier) ||
		carrier === "tsvector" ||
		field.desc.kind === "bytes" ||
		datumBound(field.desc) === undefined
	) {
		return undefined
	}
	return fewValued[carrier] ? "few" : "many"
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
 * The stored tables of the law model `model` under the installed names `names` (see the header), each by its name's
 * key: an ordinary relation's and a stored derived relation's, each column a B-tree holds by its installed name, each
 * key of no span by its installed columns; and which names are views, `view`.
 */
const catalogOf = (
	model: LawModel,
	names: PhysicalNames,
	view: (key: NameKey, tables: ReadonlyMap<NameKey, BindTable>) => boolean,
	fired: ReadCatalog["fired"]
): ReadCatalog => {
	const tables = new Map<NameKey, BindTable>()
	for (const [relation, r] of Object.entries(model.theory.relations)) {
		if (r.kind === "closed") {
			continue
		}
		const columns = new Map<string, BindColumn>()
		for (const f of r.fields) {
			const holds = holdsOf(f)
			if (holds !== undefined) {
				columns.set(names.column(relation, f.name), { field: f.name, holds })
			}
		}
		const keys = r.keyNames.flatMap((k) =>
			k.span === undefined ? [k.fields.map((f) => names.column(relation, f.name))] : []
		)
		tables.set(nameKey(names.relation(relation)), { relation, columns, keys })
	}
	return { table: (key) => tables.get(key), view: (key) => view(key, tables), fired }
}

/**
 * The catalog of the installation `b` builds (see the header), its views every view its statements create, and each
 * trigger function's table's columns, each its type, by the function every trigger the statements create on a table
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
export const servedCatalog = (model: LawModel, names: PhysicalNames): ReadCatalog =>
	catalogOf(
		model,
		names,
		(key, tables) => {
			const schema = key.slice(0, key.indexOf("\u0000"))
			return !tables.has(key) && !noViews.has(schema)
		},
		() => undefined
	)
