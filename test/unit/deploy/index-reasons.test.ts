/**
 * indexReasonsOf (packages/grizzle/src/adapter/public/compile.ts, deploy/snapshot/served.ts snapshotIndexReasons): over
 * the JSON value of a snapshot.json generate writes, it names exactly the reasons the snapshot's manifest records for
 * each index the installation holds, under the relation whose table or materialized view holds it and the index's name.
 *
 * The box, exhausted: a relation R declared at the root or at a level over it, with or without a candidate key over a
 * field, with or without a containment of that field in another relation's key, and with or without a materialized
 * derived relation over R in a level above, whose view is uniquely indexed on the key it proves. The oracle is the
 * manifest itself, read apart from the derived facts: each index object, a created or a derived relation's unique
 * index by its CREATE INDEX, a primary key's and a unique key's by its constraint's identity (physical/obligations/
 * graph.ts parseIdent, the manifest's one reader of an identity), with the reasons it records, under the relation the
 * snapshot's theory records at that table's level and identifier.
 *
 * Plant (~/.cache/grizzle-release/EXPLAIN/plants): index-reasons-dropped.patch (the derived facts record each index
 * with its first reason alone).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { indexReasonsOf } from "#adapter/public/compile.ts"
import {
	derivedOf,
	finishSnapshot,
	noWorkload,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

const B = relation("B", { id: uuid }, ["id"])
const R = relation("R", { id: uuid, other: uuid }, ["id"])

const placements = ["root", "level"] as const

interface Case {
	readonly placement: (typeof placements)[number]
	readonly keyed: boolean
	readonly contained: boolean
	readonly derived: boolean
}

const caseGen: Gen<Case> = (source) => ({
	placement: source.draw(element(placements)),
	keyed: source.draw(boolean),
	contained: source.draw(boolean),
	derived: source.draw(boolean)
})

/** The case's laws over R: its candidate key over `other`, and `other`'s containment in B's key. */
const lawsOf = (c: Case) => [
	...(c.keyed ? [key(on(R, "other"))] : []),
	...(c.contained ? [contained(on(R, "other"), on(B, "id"))] : [])
]

/** The case's schema: R at the root beside B or at a level over a root of B, and a derived level above it. */
const schemaOf = (c: Case): AnySchema => {
	if (c.placement === "root") {
		const root = schema("Root", { B, R }, lawsOf(c))
		return c.derived
			? schema.extend(root, "Upper", {
					Pairs: derived.materialized(
						"Pairs",
						query(root).rule((r) => {
							const { id, other } = v(R, "r")
							return r.match(R, { id, other }).find({ id, other })
						})
					)
				}, [])
			: root
	}
	const mid = schema.extend(schema("Root", { B }, []), "Mid", { R }, lawsOf(c))
	return c.derived
		? schema.extend(mid, "Upper", {
				Pairs: derived.materialized(
					"Pairs",
					query(mid).rule((r) => {
						const { id, other } = v(R, "r")
						return r.match(R, { id, other }).find({ id, other })
					})
				)
			}, [])
		: mid
}

/** An index the manifest records: the table it is on, its name, and its reasons. */
interface ManifestIndex {
	readonly schema: string
	readonly table: string
	readonly name: string
	readonly reasons: ReadonlyArray<PhysicalReason>
}

/** Each index object of the manifest, read off its own statement or identity. */
const manifestIndexes = (snapshot: DeploySnapshot): ReadonlyArray<ManifestIndex> =>
	Arr.flatMap(snapshot.manifest.objects, (o): ReadonlyArray<ManifestIndex> => {
		if (o.kind === "index" || o.kind === "uniqueIndex") {
			const [create] = o.ddl
			return create?.kind === "createIndex"
				? [{ schema: create.table.schema, table: create.table.name, name: create.name, reasons: o.reasons }]
				: assert.fail(`the index ${o.ident} by its CREATE INDEX`)
		}
		if (o.kind === "primaryKey" || o.kind === "unique") {
			const ident = parseIdent(o.ident)
			return ident.kind === "constraint"
				? [{ schema: ident.schema, table: ident.relation, name: ident.name, reasons: o.reasons }]
				: assert.fail(`the key ${o.ident} by its constraint's identity`)
		}
		return []
	})

/** The relation the snapshot's theory records at a table's level schema and identifier. */
const relationAt = (snapshot: DeploySnapshot, schemaName: string, table: string): string =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				Rec.toEntries(snapshot.theory.relations),
				([, r]) =>
					r.kind !== "closed" &&
					r.ident === table &&
					snapshot.levels[r.level]?.schema === schemaName
			)
		),
		`the relation of ${schemaName}.${table}`
	)[0]

/** A map of reasons by relation, then index name, as entries in code-unit order: a value two maps compare by. */
const entriesOf = (
	byRelation: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<PhysicalReason>>>
): ReadonlyArray<readonly [string, string, ReadonlyArray<PhysicalReason>]> =>
	Arr.sort(
		Arr.flatMap([...byRelation], ([relation, indexes]) =>
			Arr.map([...indexes], ([name, reasons]) => [relation, name, reasons] as const)
		),
		Order.mapInput(Order.String, ([relation, name]: readonly [string, string, unknown]) => `${relation}.${name}`)
	)

type Feature = "a level" | "a unique key" | "a referencing index" | "a derived key"

describe("indexReasonsOf", () => {
	it.effect(
		"names exactly the reasons the snapshot's manifest records for each index, by relation and index name",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/index-reasons",
						generator: caseGen,
						literal: Formatter.format,
						limit: placements.length * 8,
						box: "R at the root or a level, with or without a candidate key, a containment out of it and a materialized derived relation over it",
						oracle: {
							kind: "second-implementation",
							name: "the manifest's index objects and their reasons, each under the relation the theory records for its table"
						},
						coverage: requiredInSpace<Feature>([
							"a level",
							"a unique key",
							"a referencing index",
							"a derived key"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const owned = succeeded(own(defined(schemaDescOf(schemaOf(c)), "the case's description")))
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
										targetState({ installation, workload: noWorkload, checks: lawChecks(installation) })
									)
								)
							)
							const files = succeeded(writeSnapshot(snapshot, derivedOf(installation)))
							const read = succeeded(readSnapshot(files)).snapshot
							const expected = new Map<string, Map<string, ReadonlyArray<PhysicalReason>>>()
							for (const index of manifestIndexes(read)) {
								const relation = relationAt(read, index.schema, index.table)
								const named = expected.get(relation) ?? new Map<string, ReadonlyArray<PhysicalReason>>()
								named.set(index.name, index.reasons)
								expected.set(relation, named)
							}
							const reasons = succeeded(indexReasonsOf(snapshotJson(files.snapshot)))
							assert.deepEqual(
								entriesOf(reasons),
								entriesOf(expected),
								"each index's reasons, by relation and name"
							)
							if (c.placement === "level") {
								k.note("a level")
							}
							if (c.keyed) {
								k.note("a unique key")
							}
							if (c.contained) {
								k.note("a referencing index")
							}
							if (c.derived) {
								k.note("a derived key")
							}
						})
				)
			)
	)
})
