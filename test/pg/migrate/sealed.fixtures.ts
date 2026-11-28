/** What the property of sealed.test.ts reads: the installation each case migrates, and the writes after it. */

import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { int4 } from "#compiler/public/fields.ts"
import { relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { type Version } from "#test/support/install-migrate.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { draftNext, installFirst } from "#test/support/pg/closed/codes.fixtures.ts"
import { apply, noFurther, openMigrator } from "#test/support/pg/migrate/support.ts"
import { refusalOf } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A sheet, keyed by the unit's key alone. */
const Sheet = relation("Sheet", { sheet: int4, label: int4 }, ["sheet"])
/** A sheet's cells, each at a place. */
const Cell = relation("Cell", { sheet: int4, place: int4 }, ["sheet", "place"])

/** The version over Sheet and Cell under the unit Sheet, sealed or not, written by no login. */
const versionOf = (name: string, sealedUnit: boolean): Version => {
	const declared = unit("Sheet", { sheet: int4 })
	return {
		schema: schema(name, [Sheet, Cell], [sealedUnit ? sealed(declared) : declared]),
		logins: []
	}
}

/** How a case's migration turns the unit: sealed over the rows its installation stores, or unsealed. */
export const turns = ["sealed over stored rows", "unsealed"] as const
export type Turn = (typeof turns)[number]

/**
 * One case: the unit installed unsealed, or sealed for `unsealed`, its first version storing Cell's rows at sheet 1 in
 * one statement, which founds the sealed unit there; then the migration to the other way, drafted as `grizzle generate`
 * drafts it and applied through the runner as the installation's owner; then the writes after it, each a transaction of
 * its own:
 *
 * - sealed over stored rows: a row of Cell at sheet 1, a unit the installation stored before its seal, refused under
 *   23503 naming Cell's seal trigger, which the next snapshot's constraint map maps to Sheet's seal law, the migration
 *   having founded every unit it found stored; a row of Cell at sheet 2 commits, founding it, and a row of Sheet there
 *   in a later transaction is refused alike;
 * - unsealed: a row of Cell at sheet 1 commits, and no seal trigger stands.
 */
export const migrateTurn = (turn: Turn) =>
	Effect.gen(function* () {
		const sealedFirst = turn === "unsealed"
		const { m } = yield* installFirst("sealed_turn", (name) => ({
			version: versionOf(name, sealedFirst)
		}))
		const sheet = printObjectName(m.names.relation("Sheet"))
		const cell = printObjectName(m.names.relation("Cell"))
		yield* m.owner.query(`INSERT INTO ${cell} (sheet, place) VALUES (1, 1), (1, 2)`, [])
		const next = yield* draftNext(
			m,
			m.snapshot,
			versionOf(m.declared, !sealedFirst),
			m.folders.length + 1,
			noDeclarations
		)
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		yield* apply(
			migrator,
			{ snapshot: next.snapshot, folders: [...m.folders, next.folder] },
			noFurther
		)
		const sealLaw = identifierOf(identity.sealLaw("Sheet"))
		/** Whether `sql`, run alone, is refused by Sheet's seal on `relation`'s table, through the snapshot's map. */
		const refusedBySeal = (sql: string, relation: "Sheet" | "Cell") =>
			Effect.map(refusalOf(m.owner.query(sql, [])), (refused) =>
				Option.exists(refused, (fields) => {
					const table = m.names.relation(relation).name
					const laws =
						fields.constraint === undefined
							? undefined
							: lawsOfConstraint(
									next.snapshot.constraintToLaw,
									{ kind: "table", name: table },
									fields.constraint
								)
					return (
						fields.code === "23503" &&
						Option.getOrUndefined(fields.table) === table &&
						laws !== undefined &&
						Arr.contains(laws, sealLaw)
					)
				})
			)
		const triggers = yield* Effect.map(
			m.owner.values(
				`SELECT count(*)::text FROM pg_catalog.pg_trigger WHERE tgname = '__sealed'`,
				[]
			),
			(rows) => Arr.map(rows, (r) => String(r[0]))
		)
		switch (turn) {
			case "sealed over stored rows": {
				const stored = yield* refusedBySeal(
					`INSERT INTO ${cell} (sheet, place) VALUES (1, 3)`,
					"Cell"
				)
				assert.ok(stored, "a row of a unit stored before its seal is refused by the seal")
				yield* m.owner.query(`INSERT INTO ${cell} (sheet, place) VALUES (2, 1)`, [])
				const later = yield* refusedBySeal(
					`INSERT INTO ${sheet} (sheet, label) VALUES (2, 0)`,
					"Sheet"
				)
				assert.ok(
					later,
					"a later transaction's row of a unit founded after the seal is refused by the seal"
				)
				return
			}
			case "unsealed":
				assert.deepEqual(triggers, ["0"], "no seal trigger stands once the unit is unsealed")
				yield* m.owner.query(`INSERT INTO ${cell} (sheet, place) VALUES (1, 3)`, [])
				return
		}
	})
