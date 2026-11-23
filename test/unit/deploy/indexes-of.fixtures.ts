/** What the properties of indexes-of.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { DeploySnapshot, SnapshotContent } from "#compiler/deploy/snapshot/types.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	key,
	on,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { type SqlStatement, type TableConstraint, tableConstraints } from "#compiler/sql/ast.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { Id } from "#test/support/ids.ts"

const B = relation("B", { id: Id }, ["id"])

const R = relation("R", { id: Id, other: Id, rank: pg.integer, flag: pg.boolean }, ["id"])

const placements = ["root", "level"] as const

const containments = ["none", "whole", "selected"] as const

interface Case {
	readonly placement: (typeof placements)[number]
	readonly keyed: boolean
	readonly containment: (typeof containments)[number]
	readonly derived: boolean
}

export const caseGen: Gen<Case> = (source) => ({
	placement: source.draw(element(placements)),
	keyed: source.draw(boolean),
	containment: source.draw(element(containments)),
	derived: source.draw(boolean)
})

/** The case's laws over R: its candidate key over two fields, and a containment of `other` in B's key. */
const lawsOf = (c: Case) => [
	...(c.keyed ? [key(on(R, "other", "rank"))] : []),
	...(c.containment === "whole" ? [contained(on(R, "other"), on(B, "id"))] : []),
	...(c.containment === "selected"
		? [
				contained(
					on(
						select(R, (r) => r.eq(r.flag, true)),
						"other"
					),
					on(B, "id")
				)
			]
		: [])
]

/** The unit of an id, declared at the root, which B and R sit in, so a stored relation over R sits in it too. */
const Item = unit("Item", { id: Id })

/** The case's schema: R at the root beside B or at a level over a root of B, and a stored derived level above it. */
export const schemaOf = (c: Case): AnySchema => {
	if (c.placement === "root") {
		const root = schema("Root", [B, R], [...lawsOf(c), Item])
		return c.derived
			? schema.extend(
					[root],
					"Upper",
					[
						derived.stored(
							"Pairs",
							query(root).rule((r) => {
								const { id, other } = v(R, "r")
								return r.match(R, { id, other }).find({ id, other })
							})
						)
					],
					[]
				)
			: root
	}
	const mid = schema.extend([schema("Root", [B], [Item])], "Mid", [R], lawsOf(c))
	return c.derived
		? schema.extend(
				[mid],
				"Upper",
				[
					derived.stored(
						"Pairs",
						query(mid).rule((r) => {
							const { id, other } = v(R, "r")
							return r.match(R, { id, other }).find({ id, other })
						})
					)
				],
				[]
			)
		: mid
}

/** A key column as the oracle reads it off the manifest: the column it names and its direction. */
interface KeyColumn {
	readonly column: string
	readonly direction: "asc" | "desc" | "none"
}

/** An index the manifest records: the table it is on, its name, its key columns in order, and its reasons. */
interface ManifestIndex {
	readonly schema: string
	readonly table: string
	readonly name: string
	readonly keys: ReadonlyArray<KeyColumn>
	readonly reasons: ReadonlyArray<PhysicalReason>
}

/** A constraint's key columns: a primary key's or a unique key's, ascending, or a span key's, under GiST, none. */
const constraintKeys = (constraint: TableConstraint): ReadonlyArray<KeyColumn> => {
	switch (constraint.kind) {
		case "primaryKey":
		case "unique": {
			const direction = Arr.some(constraint.columns, (c) => c.withoutOverlaps) ? "none" : "asc"
			return Arr.map(constraint.columns, (c) => ({ column: c.column, direction }))
		}
		case "exclude":
			return Arr.map(constraint.elements, (e) => ({ column: e.column, direction: "none" }))
		case "check":
		case "foreignKey":
			return assert.fail(`the constraint ${constraint.name}, a key`)
	}
}

/**
 * The constraint `name` of the table `schemaName`.`table`: the one its object's own ALTER TABLE adds, or else the one
 * its table's CREATE TABLE declares.
 */
const constraintOf = (
	content: SnapshotContent,
	ownStatement: SqlStatement | undefined,
	schemaName: string,
	table: string,
	name: string
): TableConstraint => {
	if (ownStatement?.kind === "alterTable") {
		const [action] = ownStatement.actions
		return action.kind === "addConstraint"
			? action.constraint
			: assert.fail(`the constraint ${name} added`)
	}
	const declared = Arr.findFirst(content.manifest.objects, (o) => {
		const [create] = o.ddl
		return (
			o.kind === "table" &&
			create?.kind === "createTable" &&
			create.table.schema === schemaName &&
			create.table.name === table
		)
	}).pipe(
		Option.flatMap((o) => Option.fromNullishOr(o.ddl[0])),
		Option.flatMap((statement) =>
			statement.kind === "createTable"
				? Arr.findFirst(tableConstraints(statement), (c) => c.name === name)
				: Option.none()
		)
	)
	return defined(
		Option.getOrUndefined(declared),
		`the constraint ${name} of ${schemaName}.${table}`
	)
}

/** Each index object of a snapshot's content, read off its own statement or its constraint, with the reasons the
 * compile states for it. */
export const manifestIndexes = (content: SnapshotContent): ReadonlyArray<ManifestIndex> =>
	Arr.flatMap(content.manifest.objects, (o): ReadonlyArray<ManifestIndex> => {
		if (o.kind === "index" || o.kind === "uniqueIndex") {
			const [create] = o.ddl
			return create?.kind === "createIndex"
				? [
						{
							schema: create.table.schema,
							table: create.table.name,
							name: create.name,
							keys: Arr.map(create.keys, (k) => ({
								column: k.key.kind === "column" ? k.key.column : assert.fail("a column key"),
								direction:
									create.method !== "btree" ? "none" : k.direction === "ASC" ? "asc" : "desc"
							})),
							reasons: o.reasons
						}
					]
				: assert.fail(`the index ${o.ident} by its CREATE INDEX`)
		}
		if (o.kind === "primaryKey" || o.kind === "unique") {
			const ident = parseIdent(o.ident)
			return ident.kind === "constraint"
				? [
						{
							schema: ident.schema,
							table: ident.relation,
							name: ident.name,
							keys: constraintKeys(
								constraintOf(content, o.ddl[0], ident.schema, ident.relation, ident.name)
							),
							reasons: o.reasons
						}
					]
				: assert.fail(`the key ${o.ident} by its constraint's identity`)
		}
		return []
	})

/**
 * The relation the snapshot's theory records for a table, with its fields by column: a stored relation at its level's
 * schema and its identifier, a derived relation by its view's identifier alone, since the level the theory records for
 * a derived relation is the one over what it reads, not the one whose schema holds its view.
 */
export const relationAt = (
	snapshot: DeploySnapshot,
	schemaName: string,
	table: string
): { readonly name: string; readonly fields: ReadonlyMap<string, string> } => {
	const [name, r] = defined(
		Option.getOrUndefined(
			Arr.findFirst(
				Rec.toEntries(snapshot.theory.relations),
				([, candidate]) =>
					candidate.ident === table &&
					(candidate.kind === "derived" ||
						(candidate.kind === "relation" &&
							snapshot.levels[candidate.level]?.schema === schemaName))
			)
		),
		`the relation of ${schemaName}.${table}`
	)
	return {
		name,
		fields:
			r.kind === "relation"
				? new Map(Arr.map(r.fields, (f) => [f.column, f.name] as const))
				: new Map(Arr.map(["id", "other"], (f) => [f, f] as const))
	}
}

/** The laws each law column's object of a snapshot's content states, by its table's schema, its table and its
 * column. */
export const lawColumnLaws = (
	content: SnapshotContent
): ReadonlyMap<string, ReadonlyArray<string>> =>
	new Map(
		Arr.flatMap(content.manifest.objects, (o) => {
			const ident = parseIdent(o.ident)
			return o.kind === "lawColumn" && ident.kind === "column"
				? [
						[
							`${ident.schema}.${ident.relation}.${ident.name}`,
							Arr.flatMap(o.reasons, (r) => (r.kind === "law" ? [r.law] : []))
						] as const
					]
				: []
		})
	)

/** An index column as the comparison reads it: a field by name, or a law column by its laws, with its direction. */
export type Projected =
	| { readonly kind: "field"; readonly field: string; readonly direction: string }
	| { readonly kind: "law"; readonly laws: ReadonlyArray<string>; readonly direction: string }
	| { readonly kind: "suffix"; readonly direction: string }

/** One index as the comparison reads it: its relation, its name, its projected columns and its reasons. */
export interface Compared {
	readonly relation: string
	readonly name: string
	readonly columns: ReadonlyArray<Projected>
	readonly reasons: ReadonlyArray<PhysicalReason>
}

export const byPlace = Order.mapInput(Order.String, (c: Compared) => `${c.relation}.${c.name}`)

export type Feature =
	| "a level"
	| "a key of two columns"
	| "a referencing index"
	| "a law column"
	| "a derived key"
