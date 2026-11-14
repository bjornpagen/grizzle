/**
 * indexesOf (packages/grizzle/src/adapter/public/compile.ts, deploy/snapshot/served.ts snapshotIndexes): over the JSON
 * value of a snapshot.json generate writes, it names each index the installation holds under the relation whose table
 * or materialized view holds it and the index's name, with exactly the reasons the snapshot's manifest records for it
 * and its key columns in the order its statement lists them, each mapped through the relation's fields.
 *
 * The box, exhausted: a relation R declared at the root or at a level over it, with or without a candidate key over two
 * of its fields, with no containment out of it, a containment of a field in another relation's key, or one out of R's
 * rows a selection picks, which the law model carries in a law column, and with or without a materialized derived
 * relation over R in a level above, whose view is uniquely indexed on the key it proves. The oracle is the manifest
 * itself, read apart from the derived facts: each index object, a created or a derived relation's unique index by its
 * CREATE INDEX's key list, a primary key's and a unique key's by its constraint as its table's CREATE TABLE declares it
 * or its own ALTER TABLE adds it (its identity read by physical/obligations/graph.ts parseIdent, the manifest's one
 * reader of an identity), with the reasons it records, under the relation the snapshot's theory records for that table
 * (a stored one at its level's schema, a derived one by its view's identifier); each key column a field where the theory records one at that column, the fixture's derived
 * relation's view columns being its fields' own names, and otherwise a law column with the laws its manifest object
 * records; each with a B-tree's direction, or none for a span key's GiST.
 *
 * Plants (~/.cache/grizzle-release/EXPLAIN/plants): index-reasons-dropped.patch (the derived facts record each index
 * with its first reason alone); index-columns-reversed.patch (an index's key columns recorded in reverse order).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { indexesOf } from "#adapter/public/compile.ts"
import {
	derivedOf,
	finishSnapshot,
	noWorkload,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { type SqlStatement, type TableConstraint, tableConstraints } from "#compiler/sql/ast.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

const B = relation("B", { id: uuid }, ["id"])
const R = relation("R", { id: uuid, other: uuid, rank: pg.integer, flag: pg.boolean }, ["id"])

const placements = ["root", "level"] as const
const containments = ["none", "whole", "selected"] as const

interface Case {
	readonly placement: (typeof placements)[number]
	readonly keyed: boolean
	readonly containment: (typeof containments)[number]
	readonly derived: boolean
}

const caseGen: Gen<Case> = (source) => ({
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

/** The case's schema: R at the root beside B or at a level over a root of B, and a derived level above it. */
const schemaOf = (c: Case): AnySchema => {
	if (c.placement === "root") {
		const root = schema("Root", [B, R], lawsOf(c))
		return c.derived
			? schema.extend(
					root,
					"Upper",
					[
						derived.materialized(
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
	const mid = schema.extend(schema("Root", [B], []), "Mid", [R], lawsOf(c))
	return c.derived
		? schema.extend(
				mid,
				"Upper",
				[
					derived.materialized(
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
	snapshot: DeploySnapshot,
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
	const declared = Arr.findFirst(snapshot.manifest.objects, (o) => {
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

/** Each index object of the manifest, read off its own statement or its constraint. */
const manifestIndexes = (snapshot: DeploySnapshot): ReadonlyArray<ManifestIndex> =>
	Arr.flatMap(snapshot.manifest.objects, (o): ReadonlyArray<ManifestIndex> => {
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
								constraintOf(snapshot, o.ddl[0], ident.schema, ident.relation, ident.name)
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
const relationAt = (
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

/** The laws each law column's manifest object records, by its table's schema, its table and its column. */
const lawColumnLaws = (snapshot: DeploySnapshot): ReadonlyMap<string, ReadonlyArray<string>> =>
	new Map(
		Arr.flatMap(snapshot.manifest.objects, (o) => {
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
type Projected =
	| { readonly kind: "field"; readonly field: string; readonly direction: string }
	| { readonly kind: "law"; readonly laws: ReadonlyArray<string>; readonly direction: string }

/** One index as the comparison reads it: its relation, its name, its projected columns and its reasons. */
interface Compared {
	readonly relation: string
	readonly name: string
	readonly columns: ReadonlyArray<Projected>
	readonly reasons: ReadonlyArray<PhysicalReason>
}

const byPlace = Order.mapInput(Order.String, (c: Compared) => `${c.relation}.${c.name}`)

type Feature =
	| "a level"
	| "a key of two columns"
	| "a referencing index"
	| "a law column"
	| "a derived key"

describe("indexesOf", () => {
	it.effect(
		"names each index's reasons and key columns, in order and mapped through its relation's fields, as the snapshot's manifest records them",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/indexes-of",
						generator: caseGen,
						literal: Formatter.format,
						box: "R at the root or a level, with or without a two-column candidate key, no containment, a whole one or a selected one out of it, and with or without a materialized derived relation over it",
						oracle: {
							kind: "second-implementation",
							name: "the manifest's index objects, their reasons and their statements' key columns, each under the relation the theory records for its table and mapped through its fields"
						},
						coverage: requiredInSpace<Feature>([
							"a level",
							"a key of two columns",
							"a referencing index",
							"a law column",
							"a derived key"
						]),
						caseHang,
						concurrency: 1
					},
					(c, k) =>
						Effect.sync(() => {
							const owned = succeeded(
								own(defined(schemaDescOf(schemaOf(c)), "the case's description"))
							)
							const installation = succeeded(
								compileInstallation(
									owned,
									completeInstallOptions(
										owned,
										installationsOf(owned),
										[],
										[],
										firstCodebook(rostersOf(owned))
									)
								)
							)
							const snapshot = succeeded(
								finishSnapshot(
									succeeded(
										targetState({
											installation,
											workload: noWorkload,
											checks: lawChecks(installation)
										})
									)
								)
							)
							const files = succeeded(writeSnapshot(snapshot, derivedOf(installation)))
							const read = succeeded(readSnapshot(files)).snapshot
							const laws = lawColumnLaws(read)
							const expected = Arr.sort(
								Arr.map(manifestIndexes(read), (index): Compared => {
									const r = relationAt(read, index.schema, index.table)
									return {
										relation: r.name,
										name: index.name,
										columns: Arr.map(index.keys, (key): Projected => {
											const field = r.fields.get(key.column)
											return field === undefined
												? {
														kind: "law",
														laws: defined(
															laws.get(`${index.schema}.${index.table}.${key.column}`),
															`the law column ${key.column}`
														),
														direction: key.direction
													}
												: { kind: "field", field, direction: key.direction }
										}),
										reasons: index.reasons
									}
								}),
								byPlace
							)
							const indexes = succeeded(indexesOf(snapshotJson(files.snapshot)))
							const actual = Arr.sort(
								Arr.flatMap([...indexes], ([relationName, named]) =>
									Arr.map([...named], ([name, index]): Compared => ({
										relation: relationName,
										name,
										columns: Arr.map(index.columns, (column): Projected =>
											column.kind === "field"
												? { kind: "field", field: column.field, direction: column.direction }
												: { kind: "law", laws: column.laws, direction: column.direction }
										),
										reasons: index.reasons
									}))
								),
								byPlace
							)
							assert.deepEqual(actual, expected, "each index's columns and reasons")
							if (c.placement === "level") {
								k.note("a level")
							}
							if (c.keyed) {
								k.note("a key of two columns")
							}
							if (c.containment === "whole") {
								k.note("a referencing index")
							}
							if (Arr.some(actual, (i) => Arr.some(i.columns, (col) => col.kind === "law"))) {
								k.note("a law column")
							}
							if (c.derived) {
								k.note("a derived key")
							}
						})
				)
			)
	)
})
