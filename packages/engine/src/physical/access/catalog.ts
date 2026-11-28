/**
 * What the binding reads of an installation (sql/bind.ts ReadCatalog): each stored table, its relation, the installed
 * columns an index serves, its fields and the law columns its laws add, each by its arm and with its kind (sql/bind.ts
 * BindColumn), and its keys, each its installed columns; and each role's view. One derivation of these facts, from the law model and the installed names
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
import { catchCompileError } from "#compiler/core/canonical.ts"
import {
	type Identity,
	identifierOf,
	identity,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { compareNumbers, compareStrings } from "#compiler/core/order.ts"
import { textDigestsOf } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import {
	baseOf,
	fewValued,
	isSpanCarrier,
	nativeNames,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { IndexColumn, InstallBuilder, TargetField } from "#compiler/physical/ddl/context.ts"
import { ledgerHeadTableName } from "#compiler/physical/ddl/ledger.ts"
import {
	judgeLogColumns,
	type NameKey,
	nameKey,
	type ObjectName,
	type SqlStatement
} from "#compiler/sql/ast.ts"
import type {
	BindColumn,
	BindTable,
	BindView,
	HashRow,
	ReadCatalog,
	WorldBinding
} from "#compiler/sql/bind.ts"
import { namedType } from "#compiler/sql/build.ts"
import { type Alias, wholeViewAlias } from "#compiler/sql/naming.ts"
import { installationTypes } from "#compiler/sql/type-schemas.ts"

/**
 * A column as an index serves it (see the header), a field or a law column, `field` the field whose values it holds,
 * by its carrier: a span's and a search document's, which GiST and GIN serve; a B-tree's for every other, of a network,
 * a vector, whose distance HNSW serves under the installation's cosine class, a text or a scalar, holding few values or
 * many, a byte string and a text of no byte bound among them.
 */
const columnOf = (field: TargetField, column: IndexColumn, vectorSchema: string): BindColumn => {
	const carrier = baseOf(field.type).carrier
	if (isSpanCarrier(carrier)) {
		return { kind: "span", column }
	}
	if (carrier === "tsvector") {
		return { kind: "search", column }
	}
	const holds = fewValued[carrier] ? "few" : "many"
	if (carrier === "vector") {
		return {
			kind: "vector",
			column,
			holds,
			cosine: { kind: "vectorCosine", schema: vectorSchema }
		}
	}
	if (carrier === "inet" || carrier === "cidr") {
		return { kind: "network", column, holds }
	}
	if (field.desc.kind === "bytes") {
		return { kind: "bytes", column, holds }
	}
	return { kind: carrier === "text" ? "text" : "scalar", column, holds }
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
 * level that declares each, then by name, each name the model holds its own, an alias of another's definition among
 * them, whose relation the model holds under both names. A login's compile reads the model of its base, which holds every relation of
 * the levels it stands on, each at the place the installation's model gives it, so the installation's views
 * (physical/ddl/roles.ts wholeView) and every compile that reads one name each relation alike.
 */
export const wholeViewAliases = (model: LawModel): ReadonlyMap<string, Alias> =>
	new Map(
		Object.entries(model.theory.relations)
			.filter(([, r]) => r.kind !== "closed")
			.toSorted(([an, a], [bn, b]) => compareNumbers(a.level, b.level) || compareStrings(an, bn))
			.map(([name], at) => [name, wholeViewAlias(at + 1)] as const)
	)

/** A view PostgreSQL plans apart under the reference's alias, whose body no plan names (sql/bind.ts BindView). */
const apartView: BindView = { kind: "apart" }

/**
 * The installed names the binding's catalog reads (`catalogOf`): a table's and its columns', a whole view's, and the
 * level each relation is installed in, which holds the row type of a hash index over its byte strings.
 */
type CatalogNames = Pick<PhysicalNames, "relation" | "column" | "vectorSchema" | "library"> & {
	readonly wholeView: (relation: string) => ObjectName
	readonly levelOf: (relation: string) => Identity<"schema">
}

/**
 * The stored tables of the law model `model` under the installed names `names` (see the header), each by its name's
 * key: an ordinary relation's and a stored derived relation's, each column by its installed name, each key of no span by
 * its installed columns; each one's whole view (InstallNames `wholeView`), its table read under the alias its body names
 * it by (`wholeViewAliases`), each of its columns the table's column it reads, a closed id's decoded column its code's
 * (physical/access/world-views.ts viewColumns); each of `worlds`, a role's world views (BindView `world`); and which
 * other names are views PostgreSQL plans apart, `apart`.
 */
const catalogOf = (
	model: LawModel,
	names: CatalogNames,
	worlds: ReadonlyArray<WorldBinding>,
	apart: (key: NameKey, tables: ReadonlyMap<NameKey, BindTable>) => boolean,
	fired: ReadCatalog["fired"],
	bookkeeping: ReadonlyMap<NameKey, BindTable>
): ReadCatalog => {
	const tables = new Map<NameKey, BindTable>(bookkeeping)
	const views = new Map<NameKey, BindView>(
		worlds.map((view) => [nameKey(view.name), { kind: "world", view }] as const)
	)
	const aliases = wholeViewAliases(model)
	const lawColumns = Map.groupBy(
		model.natives.flatMap(({ object }) => (object.kind === "LawColumn" ? [object] : [])),
		(c) => c.relation.name
	)
	for (const [relation, r] of Object.entries(model.theory.relations)) {
		if (r.kind === "closed") {
			continue
		}
		/** Its fields, by their installed names, and the law columns its laws add, each by its identifier, its
		 * installed name, typed by the field whose values it holds (ir/law.ts NativeObject `LawColumn`): a family's
		 * index, successor and predecessor, a selected side's term, which every binding reads as it reads a field. */
		const columns = new Map<string, BindColumn>([
			...r.fields.map(
				(f) =>
					[
						names.column(relation, f.name),
						columnOf(f, { kind: "field", field: f.name }, names.vectorSchema)
					] as const
			),
			...(lawColumns.get(r.name) ?? []).map(
				(c) =>
					[
						c.column,
						columnOf(c.field, { kind: "law", column: c.column }, names.vectorSchema)
					] as const
			)
		])
		const viewed = new Map<string, string>()
		for (const f of r.fields) {
			const installed = names.column(relation, f.name)
			viewed.set(installed, installed)
			if (baseOf(f.type).carrier !== "code") {
				continue
			}
			const field = parseDeclaredName(f.name)
			if (!field.ok) {
				return defect(`the closed id field ${f.name} of ${relation}, a declared name`)
			}
			viewed.set(identifierOf(identity.decodedColumn(field.value)), installed)
		}
		const keys = r.keyNames.flatMap((k) =>
			k.span === undefined ? [k.fields.map((f) => names.column(relation, f.name))] : []
		)
		/** A stored derived relation's byte strings, bound together by equality, are read through the hash index the
		 * installation makes of their row, cast to its type (physical/indexes/engine.ts hashedRow), named here as there. */
		const byName: ReadonlyMap<string, BindColumn> = columns
		const hashRow: HashRow =
			r.kind === "stored"
				? {
						kind: "typed",
						type: (bound) =>
							namedType(
								installationTypes(names.levelOf(relation)),
								identifierOf(
									identity.hashRow(
										relation,
										bound.map((c) => {
											const column = byName.get(c)?.column
											return column?.kind === "field"
												? column.field
												: defect(`the field of ${c}, a byte string the row binds`)
										})
									)
								),
								[]
							)
					}
				: { kind: "none" }
		/** Each text field whose digest field holds its SHA-256 (ir/law.ts textDigestsOf), both by installed name, its
		 * digest computed by the library's textDigest, which its generation calls, so the installation installs it. */
		const digests = new Map(
			[...textDigestsOf(r.fields)].map(
				([text, digest]) =>
					[
						names.column(relation, text),
						{ column: names.column(relation, digest), digest: names.library("textDigest") }
					] as const
			)
		)
		const table: BindTable = { relation, columns, keys, hashRow, digests }
		tables.set(nameKey(names.relation(relation)), table)
		/** A relation whose whole view's name does not fit has none: a role that holds it whole is refused where it is
		 * named (physical/ddl/names.ts namedRole), so no statement reads one. */
		const whole = catchCompileError(() => names.wholeView(relation))
		if (whole.ok) {
			views.set(nameKey(whole.value), {
				kind: "whole",
				table,
				alias: aliases.get(relation) ?? defect(`the whole view alias of ${relation}`),
				columns: viewed
			})
		}
	}
	return {
		table: (key) => tables.get(key),
		view: (key) => views.get(key) ?? (apart(key, tables) ? apartView : undefined),
		fired
	}
}

/**
 * The ledger's head of the installation in `schema` as the binding reads it (physical/ddl/ledger.ts
 * ledgerHeadTableName, deploy/ledger/ledger.ts headTable), the one bookkeeping table an installed routine reads: the
 * snapshot guard's one read of its one row, whole. Its columns as every table's are (`columnOf`): its key and whether
 * its folder is complete, booleans, each of few values; the folder's name, a text; its target, a digest's bytes.
 */
const ledgerHead = (schema: string): ReadonlyMap<NameKey, BindTable> =>
	new Map([
		[
			nameKey({ schema, name: ledgerHeadTableName }),
			{
				relation: ledgerHeadTableName,
				columns: new Map<string, BindColumn>([
					["head", { kind: "scalar", column: { kind: "field", field: "head" }, holds: "few" }],
					["folder", { kind: "text", column: { kind: "field", field: "folder" }, holds: "many" }],
					["target", { kind: "scalar", column: { kind: "field", field: "target" }, holds: "many" }],
					[
						"complete",
						{ kind: "scalar", column: { kind: "field", field: "complete" }, holds: "few" }
					]
				]),
				keys: [["head"]],
				hashRow: { kind: "none" },
				digests: new Map()
			}
		]
	])

/**
 * The rule judge's log as the binding reads it (sql/ast.ts CreateJudgeLog, physical/ddl/rules.ts addRules), each of its
 * tables a bookkeeping table the judge and the captures read at the tuple ids it links: its arm, keyed by its
 * transaction's id, with the tuple id of the transaction's newest delta row; its delta log, each row's link to the one
 * before it and each delta's rows, an array. Each column is one value of a row no read binds but by tuple id.
 */
const judgeLog = (statements: ReadonlyArray<SqlStatement>): ReadonlyMap<NameKey, BindTable> =>
	new Map(
		statements.flatMap((s): ReadonlyArray<readonly [NameKey, BindTable]> => {
			if (s.kind !== "createJudgeLog") {
				return []
			}
			const scalar = (field: string): readonly [string, BindColumn] => [
				field,
				{ kind: "scalar", column: { kind: "field", field }, holds: "many" }
			]
			switch (s.log.kind) {
				case "arm":
					return [
						[
							nameKey(s.table),
							{
								relation: s.table.name,
								columns: new Map([scalar(judgeLogColumns.xact), scalar(judgeLogColumns.last)]),
								keys: [[judgeLogColumns.xact]],
								hashRow: { kind: "none" },
								digests: new Map()
							}
						]
					]
				case "deltas":
					return [
						[
							nameKey(s.table),
							{
								relation: s.table.name,
								columns: new Map([
									scalar(judgeLogColumns.prev),
									...s.log.sides.map((side) => scalar(side.column))
								]),
								keys: [],
								hashRow: { kind: "none" },
								digests: new Map()
							}
						]
					]
			}
		})
	)

/**
 * The catalog of the installation `b` builds (see the header), every other view its statements create one PostgreSQL
 * plans apart, as a world view is, and each trigger function's table's columns, each its type, by the function every trigger the statements create on a table
 * calls, and the ledger's head its snapshot guard reads (`ledgerHead`).
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
		[],
		(key) => views.has(key),
		(fn) => fired.get(fn),
		new Map([...ledgerHead(b.schema), ...judgeLog(statements)])
	)
}

/** The schemas a name grizzle reads may live in that hold no view: the session's own and the catalog's. */
const noViews: ReadonlySet<string> = new Set(["pg_temp", "pg_catalog"])

/**
 * The catalog of the installation a served program compiles against (see the header), before it exists, its law model
 * `model` under its installed names `names`, the world views of the role it compiles for `worlds`, none for reality's
 * (physical/access/world-views.ts roleWorldViews): every other name the program reads that is no stored table and no
 * whole view, outside the session's and the catalog's schemas, a view PostgreSQL plans apart.
 */
export const servedCatalog = (
	model: LawModel,
	names: CatalogNames,
	worlds: ReadonlyArray<WorldBinding>
): ReadCatalog =>
	catalogOf(
		model,
		names,
		worlds,
		(key, tables) => {
			const schema = key.slice(0, key.indexOf("\u0000"))
			return !tables.has(key) && !noViews.has(schema)
		},
		() => undefined,
		new Map()
	)
