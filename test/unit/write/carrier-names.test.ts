/**
 * A carrier's name fixes its declaration (sql/naming.ts carrierName): a session keeps each served statement under its
 * text, and a statement over a carrier reads the carrier its program's call creates, so two programs one session runs
 * whose texts name one carrier must declare it alike, or the second meets the plan the first cached with another row
 * type ("cached plan must not change result type").
 *
 * The programs: a put of R from a query over a relation parameter, which the optimized realization carries from the
 * put's deletion to its insert, with a read-back of its added facts, which the conservative realization reads from
 * carriers of state, in both realizations, under one schema name for every layout of R, whose fields are named alike
 * and whose v is a pattern's text, of a domain over text naming pg_catalog.pg_c_utf8, or a bigint, a boolean or a
 * uuid. The oracle, a
 * specification: over every carrier of every program of the layouts drawn together, one name stands for one CREATE
 * TEMPORARY TABLE, its text with the name set aside. Exhausted over every set of layouts.
 *
 * Features: one layout; two layouts whose programs create, at one position of one realization, carriers declared
 * otherwise, the situation a name drawn from a carrier's place alone collides at. The feature reads the programs'
 * order, never a carrier name's spelling.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	carriers,
	layoutsGen,
	placedApart,
	type Situation
} from "#test/unit/write/carrier-names.fixtures.ts"

/** A write program's carriers name one declaration each, across every program a session may run. */
export const aWriteProgramsCarriersNameOneDeclarationEachAcrossEveryProgramASessionMayRun =
	property.exhaust(finite(layoutsGen), {
		needs: {},
		situations: [
			"one layout",
			"layouts of one carrier position and two declarations"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (drawnLayouts) =>
			Effect.sync(() => {
				const all = Arr.flatMap(drawnLayouts, (layout) => [
					...carriers[layout].optimized,
					...carriers[layout].conservative
				])
				if (drawnLayouts.length === 1) {
					c.note("one layout")
				}
				const declared = new Map<string, string>()
				for (const [name, declaration] of all) {
					const held = declared.get(name)
					assert.ok(
						held === undefined || held === declaration,
						`the carrier ${name} is declared ${held ?? ""} and ${declaration}`
					)
					declared.set(name, declaration)
				}
				if (placedApart(drawnLayouts)) {
					c.note("layouts of one carrier position and two declarations")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the CREATE TEMPORARY TABLE text of each carrier, its name set aside"
		},
		box: "every set of R's layouts, v text, bigint, boolean or uuid, each a put from a query read back by its added facts, in both realizations",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/naming.ts",
				original:
					"\tCarrierName(identifierOf(identity.carrier(ordinal, canonicalTextOf(declaration))))",
				replacement: '\tCarrierName(identifierOf(identity.carrier(ordinal, "")))',
				why: "A carrier named by its ordinal alone, never its declaration's digest (sql/naming.ts carrierName)."
			}
		]
	})
