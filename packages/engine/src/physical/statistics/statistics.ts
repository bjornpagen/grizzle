import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { refuse } from "#compiler/analysis/theory/build.ts"
import type { RegionFacts } from "#compiler/analysis/theory/unit.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { BuiltTarget, IndexColumn, InstallBuilder } from "#compiler/physical/ddl/context.ts"
import type { KeyIndex } from "#compiler/physical/ddl/tables.ts"
import { type IndexKey, keyTermText, type PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import type { Node } from "#compiler/physical/obligations/graph.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import {
	type Binding,
	type ColumnValues,
	type CrossingBound,
	type Declaration,
	type Determined,
	declarationOf,
	type RelationShape
} from "#compiler/physical/statistics/declared.ts"
import type { DeclareStatistics } from "#compiler/sql/ast.ts"

/** How many values a column of `type` may hold: a closed id one of its subset's or its roster's live handles, a boolean
 * one of two, any other type any number. */
const valuesOf = (type: ScalarType): ColumnValues => {
	const base = baseOf(type)
	if (base.carrier === "code") {
		return { kind: "few", handles: (base.only ?? base.roster.handles).length }
	}
	return base.carrier === "bool" ? { kind: "few", handles: 2 } : { kind: "many" }
}

/** A native column's text, as an index's key names it (physical/indexes/engine.ts keyTermText). */
const nativeText = (c: NativeColumn): string => (c.kind === "field" ? c.field.name : c.column)

/** The columns a request binds by equality: a workload path's fixed keys; a law's lookups of a unit, each; or every key
 * of a law's other request but a suffix key, which its seek matches a prefix of. */
const requestBindings = (r: IndexRequest): ReadonlyArray<Binding> => {
	if (r.role === "access") {
		return [
			{
				columns: r.keys
					.slice(0, r.fixed)
					.flatMap((k) => (typeof k.expr === "string" ? [k.expr] : [])),
				by: `${r.use} of ${r.relation}`
			}
		]
	}
	if (r.reads.kind === "unit") {
		return r.reads.lookups.map((lookup) => ({
			columns: lookup.map(nativeText),
			by: `${r.use} of ${r.relation}`
		}))
	}
	return [
		{
			columns: r.blocks
				.flat()
				.flatMap((k) => (k.column.kind === "suffix" ? [] : [nativeText(k.column)])),
			by: `${r.use} of ${r.relation}`
		}
	]
}

/** The columns an index's equalities may bind, in key order: its keys up to the first a suffix seek reads. */
const equalityKeys = (keys: ReadonlyArray<IndexKey>): ReadonlyArray<string> => {
	const out: Array<string> = []
	for (const k of keys) {
		if (k.column.kind === "suffix") {
			break
		}
		out.push(keyTermText(k.column))
	}
	return out
}

/**
 * The dependencies of one field of a relation on another its containments over every row prove (declared.ts
 * Determined), from `containments`, the containments over every row of the relation: where a containment pairs the
 * relation's fields with fields of another relation holding one of its keys of one field, the field paired with that
 * key determines each other field the containment pairs.
 */
const determinedOf = (
	facts: RegionFacts,
	containments: ReadonlyArray<RegionFacts["containments"][number]>
): ReadonlyArray<Determined> =>
	containments.flatMap((c) =>
		(facts.keys.get(c.to) ?? []).flatMap(([field, ...more]) => {
			const determinant = more.length === 0 ? c.pairs.find((p) => p.to === field)?.from : undefined
			return determinant === undefined
				? []
				: c.pairs.flatMap((p) =>
						p.from === determinant ? [] : [{ determinant, dependent: p.from }]
					)
		})
	)

/** A crossing's bound as a refusal names it. */
const boundText = (b: CrossingBound): string => {
	switch (b.kind) {
		case "key":
			return `key (${b.columns.join(", ")}) binds one row`
		case "pair":
			return `the pair (${b.columns.join(", ")}), which a dependency ties, binds two rows or more`
		case "apart":
			return `(${b.columns.join(", ")}), where ${b.binding.by} stops on an index short of (${b.binding.columns.join(", ")}), binds two rows or more`
	}
}

/** The refusal of a relation whose statements no declared statistics rank. */
const declarationRefused = (
	relation: string,
	d: Exclude<Declaration, { readonly kind: "declared" }>
): never => {
	const label = `declared statistics of ${relation}`
	switch (d.kind) {
		case "crossing":
			return refuse(
				"UnsupportedOperation",
				SourceLoc(label, []),
				`declared statistics that rank every statement's access path of ${relation}; no number of distinct values per column meets these together, since PostgreSQL multiplies columns as independent:\n${d.bounds.map((b) => `  = ${boundText(b)}`).join("\n")}\n  = help: give one of the crossed keys a column the other sets do not hold, or ask the index of one set for the other's columns too`
			)
		case "unsettled":
			return refuse(
				"UnsupportedOperation",
				SourceLoc(label, []),
				`declared statistics that rank every statement's access path of ${relation}; grizzle's raise of their exponents did not settle these together:\n${d.bounds.map((b) => `  = ${boundText(b)}`).join("\n")}\n  = help: this is a limitation of grizzle's declared statistics, not of the schema: report it with the schema, and change nothing to work around it`
			)
	}
}

/**
 * What a relation's shape reads of the installation, each by the relation it is of, grouped once for the installation
 * (`grouped`): its indexed view, its law columns among the model's natives, its key indexes, its planned indexes and its
 * containments over every row, each group in the order the installation holds them. A shape reads its relation's
 * groups alone, so the shapes of r relations read O(r + n) for the n natives, keys, indexes and containments, where
 * each scanned them all, O(r · n) (the compile bench's 120 relations: 201,360 tests of a native where 60 made 50,280).
 */
interface Grouped {
	readonly views: ReadonlyMap<string, ReturnType<InstallBuilder["indexedViews"]>[number]>
	readonly lawColumns: ReadonlyMap<string, ReadonlyArray<readonly [IndexColumn, ScalarType]>>
	readonly keyIndexes: ReadonlyMap<string, ReadonlyArray<KeyIndex>>
	readonly indexes: ReadonlyMap<string, ReadonlyArray<PlannedIndex>>
	readonly containments: ReadonlyMap<string, ReadonlyArray<RegionFacts["containments"][number]>>
}

/** The installation's natives, keys, indexes, views and containments over every row, by relation (Grouped). */
const grouped = (
	b: InstallBuilder,
	keyIndexes: ReadonlyArray<KeyIndex>,
	indexes: ReadonlyArray<PlannedIndex>
): Grouped => {
	const lawColumns = new Map<string, Array<readonly [IndexColumn, ScalarType]>>()
	for (const n of b.model.natives) {
		if (n.namespace === "column") {
			lawColumns
				.getOrInsertComputed(n.object.relation.name, () => [])
				.push([{ kind: "law", column: n.object.column }, n.object.field.type])
		}
	}
	return {
		views: new Map(
			b
				.indexedViews()
				.map((v) => [v.relation, v] as const)
				.toReversed()
		),
		lawColumns,
		keyIndexes: Map.groupBy(keyIndexes, (k) => k.relation),
		indexes: Map.groupBy(indexes, (i) => i.relation),
		containments: Map.groupBy(
			b.model.theory.regionFacts.containments.filter((c) => c.selection.length === 0),
			(c) => c.from
		)
	}
}

/**
 * Every table's declared statistics, a stored derived relation's registered table among them (declared.ts), each one
 * object of kind `statistics` built after its relation and every law column of it, which it names, in Indexes: its
 * shape read off the builder (the relation's columns, its unit's key, its keys, the planned indexes, the bindings of
 * every request each serves and of each key's probe, and the dependencies its containments prove), its declaration
 * derived, and a relation no declaration ranks refused (`declarationRefused`).
 */
export const planDeclarations = (
	b: InstallBuilder,
	keyIndexes: ReadonlyArray<KeyIndex>,
	lawColumns: ReadonlyMap<string, ReadonlyArray<Node<"structure">>>,
	indexes: ReadonlyArray<PlannedIndex>
): void => {
	const groups = grouped(b, keyIndexes, indexes)
	const relations = [
		...Object.values(b.model.theory.relations).flatMap((r) =>
			r.kind === "relation" ? [r.name] : []
		),
		...b.indexedViews().map((v) => v.relation)
	].toSorted(compareStrings)
	for (const relation of relations) {
		const target = b.target(relation)
		if (target.kind !== "built") {
			continue
		}
		const shape = shapeOf(b, relation, target, groups)
		const declaration = declarationOf(shape.shape)
		if (declaration.kind !== "declared") {
			declarationRefused(relation, declaration)
			continue
		}
		const columns = declaration.columns.map((c) => ({
			column: defined(shape.installed.get(c.column), `the installed column of ${c.column}`),
			distinct: c.distinct
		}))
		if (!isNonEmpty(columns)) {
			continue
		}
		const table = b.names.relation(relation)
		const installedColumn = (c: string): string =>
			defined(shape.installed.get(c), `the installed column of ${c}`)
		const ddl: DeclareStatistics = {
			kind: "declareStatistics",
			table,
			columns: mapNonEmpty(columns, (c) => c),
			dependencies: declaration.dependencies.map((d) => ({
				name: {
					schema: table.schema,
					name: b.name(identity.dependencies(relation, d.determinant, d.dependent))
				},
				determinant: installedColumn(d.determinant),
				dependent: installedColumn(d.dependent),
				exponent: d.exponent
			}))
		}
		b.add(
			{
				kind: "statistics",
				ident: b.qualifiedOf("statistics", relation, b.names.relationNamed(relation)),
				ddl: [ddl],
				reasons: [enforcement(`the declared statistics of ${relation}`)],
				phase: "indexes"
			},
			[target.object, ...(lawColumns.get(relation) ?? [])]
		)
	}
}

/**
 * A relation's shape (declared.ts RelationShape) and each of its columns' installed names by their texts, read from the
 * installation's groups by relation (Grouped).
 */
const shapeOf = (
	b: InstallBuilder,
	relation: string,
	target: BuiltTarget,
	groups: Grouped
): { readonly shape: RelationShape; readonly installed: ReadonlyMap<string, string> } => {
	const stored = b.model.theory.relations[relation]
	const view = groups.views.get(relation)
	const fields: ReadonlyArray<readonly [IndexColumn, ScalarType]> =
		view === undefined
			? [
					...(stored?.kind === "relation" ? stored.fields : []).map(
						(f) => [{ kind: "field", field: f.name }, f.type] as const
					),
					...(groups.lawColumns.get(relation) ?? [])
				]
			: [...view.fields.entries()].map(([field, f]) => [{ kind: "field", field }, f.type] as const)
	const unit = b.owned.unitOf.get(relation)
	const keys = [
		...(groups.keyIndexes.get(relation) ?? []).map((k) => k.columns.map(nativeText)),
		...(view === undefined ? [] : [[...view.primaryKey]]),
		...(view?.uniqueIndexes ?? []).map((u) => [...u.columns])
	]
	const planned = groups.indexes.get(relation) ?? []
	return {
		shape: {
			relation,
			columns: fields.map(([c, type]) => ({ column: keyTermText(c), values: valuesOf(type) })),
			unit: unit === undefined ? [] : unit.fields,
			keys,
			indexes: planned.map((i) => equalityKeys(i.keys)),
			bindings: [
				...keys.map((k) => ({ columns: k, by: `the probe of key (${k.join(", ")})` })),
				...planned.flatMap((i) => i.requests.flatMap(requestBindings))
			],
			determined:
				view === undefined
					? determinedOf(b.model.theory.regionFacts, groups.containments.get(relation) ?? [])
					: []
		},
		installed: new Map(fields.map(([c]) => [keyTermText(c), target.column(c)] as const))
	}
}
