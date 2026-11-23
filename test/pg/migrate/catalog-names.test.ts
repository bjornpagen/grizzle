/**
 * Objects named like PostgreSQL's own types, migrated under every search path an owner's sessions can start under.
 *
 * A relation, a closed relation, a contract or a derived relation declared under a name a pg_catalog type holds
 * creates a type of that name in the installation's schema: the relation's and the derived relation's row types, the
 * closed relation's enum, the contract's domain. Where that schema comes before pg_catalog on a session's path, the
 * bare name resolves to the installation's type, so every type and function grizzle prints, migrates, replays or reads
 * must name pg_catalog's own absolutely, whatever the path.
 *
 * The box: every pg_catalog type grizzle names in the qualified spelling (sql/ast.ts catalogSpelling) that a declared
 * name converts to, each taken by each of the four objects once, the four of a case each named after a different type,
 * under the owner's ordinary path and under the installation's schemas first (test/support/ambient.ts), the second
 * migrate as the installation's own owner login, under the same path. A case's schema holds the named objects and the
 * types they shadow: a holder relation of text, uuid, money, numeric, real, double precision, a span and a handle of the closed relation, mutable, with a contract field; a relation contained in it, keyed by its holder first, in a unit of the holder; and, a level up in a
 * schema of its own, the stored derived relation counting each holder's entries, each entry matched by its key, so the
 * count folds over keyed rows. Its login's writer and reader hold every relation whole. Properties, for every case:
 *
 * - its first migration applies, and migrate's drift check after it matches the catalog against the snapshot;
 * - the migrated catalog holds the installed-catalog checker's posture, its columns' types pg_catalog's own;
 * - migrating its folders again applies nothing, and the drift check after it matches again.
 *
 * Oracle: PostgreSQL, which resolves every name the migration prints under the session's path and refuses a statement
 * that names a type it does not mean; the drift check and the installed-catalog checker against the snapshot; and
 * idempotence, a second migrate applying nothing.
 *
 * Features: each object kind under the installation-first path, and every catalog type's name taken.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	type Feature,
	loginOf,
	required,
	schemaOf,
	targets
} from "#test/pg/migrate/catalog-names.fixtures.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { ambientFeatures } from "#test/support/ambient.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Objects named like PostgreSQL's own types every catalog type's name on every object, under every path: migrate and drift match, and a second migrate applies nothing. */
export const catalogNames = property.exhaust(finite(caseGen), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: required satisfies ReadonlyArray<Reached<Feature>>,
	check:
		({ caseSubstrate }, k: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					for (const feature of ambientFeatures(c.ambient)) {
						k.note(feature)
					}
					for (const t of targets) {
						k.note(t)
						k.note(`named ${c.names[t].type}`)
						for (const feature of ambientFeatures(c.ambient)) {
							k.pair(t, feature)
						}
					}
					const substrate = yield* Substrate
					const desc = schemaOf(c.names)
					const installed = yield* installMigrated(desc, {
						ambient: c.ambient,
						label: "catalog_names",
						logins: [loginOf(desc, c.names)],
						extensions: []
					})
					const m = yield* openMigrator(substrate, installed.ambientOwner.credentials)
					const again = yield* apply(
						m,
						{ snapshot: installed.snapshot, folders: installed.folders },
						noFurther
					)
					assert.deepEqual(again.applied, [], "a second migrate applies nothing")
				}).pipe(Effect.scoped),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL resolves every printed name under the session's path; drift and the installed-catalog checker match; a second migrate applies nothing"
	},
	box: "every qualified catalog type's declared name on each of a relation, a closed relation, a contract and a derived relation, under the ordinary and the installation-first path",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original: "\t\t\treturn inCatalog(name)",
			replacement: "\t\t\treturn quoteIdent(name)",
			why: "The printer spells every pg_catalog type it should qualify bare, so the installation's own type of that name answers under the installation-first path."
		}
	]
})
