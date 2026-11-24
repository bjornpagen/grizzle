/**
 * Sealing or unsealing a unit between migrations adds or drops its seal (deploy/diff/diff.ts structure.foundings,
 * physical/ddl/seal.ts): a migration that seals a unit creates its founding table and fills it from every member's
 * stored rows, each unit it finds founded by the migration's transaction, so no later transaction adds a row under a
 * unit stored before the seal, and creates each member's seal trigger; one that unseals it drops them. On PostgreSQL 19,
 * the unit Sheet over Sheet and Cell (sealed.fixtures.ts), its first version storing Cell's rows at one sheet, migrated
 * to the other way as `grizzle generate` drafts it.
 *
 * Oracle: specification, the seal's meaning across a migration: a unit stored before its seal is founded, a later row
 * of it refused under 23503 and Sheet's seal law through the next snapshot's constraint map, a unit founded after it
 * sealed as any is; once unsealed, no seal trigger stands and a later row commits. Features: each way of the turn.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { migrateTurn, type Turn, turns } from "#test/pg/migrate/sealed.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** Each way of the turn, drawn. */
const turnGen: Gen<Turn> = (s) => s.draw(element(turns))

/** A migration that seals a unit founds every unit it finds stored and seals it, and one that unseals it drops the seal. */
export const aMigrationThatSealsAUnitFoundsEveryUnitItFindsStoredAndOneThatUnsealsItDropsTheSeal =
	property.exhaust(finite(turnGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: turns satisfies ReadonlyArray<Reached<Turn>>,
		check:
			({ substrate }, c: Case<Turn>) =>
			(turn) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							c.note(turn)
							yield* migrateTurn(turn)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the seal's meaning across a migration: a unit stored before its seal founded by the migration and sealed, a unit founded after it sealed, and no seal once unsealed"
		},
		box: "a unit sealed over stored rows, and one unsealed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					"this.mayHoldRows(names.relation(m.relation)) ? [foundingFill(names, checked, unit, m)] : []",
				replacement: "[]",
				why: "A migration that seals a unit creates its founding table empty: the first row a later transaction inserts at a unit stored before the seal founds it, and commits."
			}
		]
	})
