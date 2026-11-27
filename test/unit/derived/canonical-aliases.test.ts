/**
 * Aliases of one canonical stored relation are one concept: derived relations of one definition are one canonical
 * relation (analysis/derived/canonical.ts), which has exactly one table, one key and one set of indexes, planned and
 * named once, by it, never by an alias, and every alias reads them (analysis/schema.ts CheckedSchema installedAs). Two
 * aliases' tables once failed the installation where a footprint named the second ("physical: no stored table of
 * derived relation D1", physical/ddl/context.ts storedPrimaryKey), and two aliases' reads by one key each named an index
 * of their own on the one table (page-keys' AssignmentStatus and SittingStatusOne, a duplicateIndex).
 *
 * Property: over drawn shapes (canonical-aliases.fixtures.ts), the installation of two or three aliases, each read
 * over its own alias, plans exactly the stored tables, keys, indexes and live publication of the installation of the
 * first alias alone with every read over it, each as its DDL prints it. Oracle: the installation of one alias, which
 * no alias's name can reach.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	aliasShapeGen,
	tableObjects,
	withAliases,
	withOne
} from "#test/unit/derived/canonical-aliases.fixtures.ts"

type Situation =
	| "a stored canonical relation"
	| "a live canonical relation"
	| "an index past the table's key"
	| "three aliases"

/** Aliases of one definition plan the one table, key, indexes and publication their canonical relation plans alone. */
export const aliasesOfOneDefinitionPlanTheOneTableKeyAndIndexesOfTheirCanonicalRelation =
	property.explore(aliasShapeGen, {
		needs: {},
		situations: [
			"a stored canonical relation",
			"a live canonical relation",
			"an index past the table's key",
			"three aliases"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (s) =>
			Effect.sync(() => {
				const aliased = withAliases(s)
				const one = withOne(s)
				c.note(
					aliased.checked.holdings.get("D0")?.kind === "stored"
						? "a stored canonical relation"
						: "a live canonical relation"
				)
				if (s.aliases === 3) {
					c.note("three aliases")
				}
				if (Arr.some(aliased.statements, (st) => st.kind === "createIndex")) {
					c.note("an index past the table's key")
				}
				assert.deepEqual(
					tableObjects(aliased),
					tableObjects(one),
					`the aliases of ${Formatter.format(s)} plan their canonical relation's table, key, indexes and publication once`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the installation of the first alias alone, every read over it"
		},
		budget: { runs: 48, steered: 48 },
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\tconst relation = b.checked.installedAs(r.relation)\n",
				replacement: "\t\t\tconst relation = r.relation\n",
				why: "Each alias's requests planned on its own name: an alias names an index of its own again on its canonical relation's table, beside the first's (page-keys' duplicateIndex)."
			},
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: "\t\tconst installed = checked.installedAs(relation)\n",
				replacement: "\t\tconst installed = relation\n",
				why: "An alias resolving its own table: each alias's footprint under its own name, so the live source publishes the canonical relation's one table once for each alias, and finds the second's key under a name no table is registered by (the MalformedDescription \"no stored table of derived relation D1\" of an installation that resolves no alias)."
			}
		]
	})
