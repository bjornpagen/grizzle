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

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	carriers,
	layoutGen,
	layoutsGen,
	roleCarriersOf,
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
					"\tCarrierName(identifierOf(identity.carrier(scope, ordinal, canonicalTextOf(declaration))))",
				replacement: '\tCarrierName(identifierOf(identity.carrier(scope, ordinal, "")))',
				why: "A carrier named by its ordinal alone, never its declaration's digest (sql/naming.ts carrierName)."
			}
		]
	})

/**
 * Two roles of one login never name one carrier: a login's pooled session runs every role of the login, each
 * transaction under one, and a carrier is a session table every COMMIT keeps (sql/ast.ts CreateCarrier), owned by the
 * role whose stand-up made it, which alone may truncate it. So the put of each layout compiled for two roles of one
 * login, the same program and the same declaration at every position, names each position's carrier apart by role, and
 * alike within a role, in both realizations; where the names were one, the second role's stand-up met the first role's
 * table and its TRUNCATE was refused with 42501 (den's worker login, 24 roles on one pool, at grizzle 28ffbfcdc).
 *
 * Oracle: a specification, read off the compiled programs: per position, the declarations agree and the names differ.
 */
export const twoRolesOfOneLoginNameEveryCarrierApart = property.exhaust(finite(layoutGen), {
	needs: {},
	situations: ["a layout's put for two roles"] satisfies ReadonlyArray<
		Reached<"a layout's put for two roles">
	>,
	check: (_, c: Case<"a layout's put for two roles">) => (layout) =>
		Effect.sync(() => {
			const { writer, clerk } = roleCarriersOf(layout)
			for (const realization of ["optimized", "conservative"] as const) {
				const a = writer[realization]
				const b = clerk[realization]
				assert.equal(
					a.length,
					b.length,
					`${layout} ${realization}: both roles create the same carriers`
				)
				for (const [i, [name, declaration]] of a.entries()) {
					const other = defined(b[i], `${layout} ${realization}: the clerk's carrier ${i}`)
					assert.equal(
						other[1],
						declaration,
						`${layout} ${realization}: carrier ${i} is declared alike`
					)
					assert.notEqual(
						other[0],
						name,
						`${layout} ${realization}: carrier ${i} is named alike for both roles`
					)
				}
				assert.deepEqual(
					roleCarriersOf(layout).writer[realization],
					a,
					`${layout} ${realization}: one role names its carriers alike each compile`
				)
			}
			c.note("a layout's put for two roles")
		}),
	oracle: {
		kind: "specification",
		name: "per carrier position of each realization: one declaration for both roles, and a name for each"
	},
	box: "each layout's put from a query read back by its added facts, compiled for two roles of one login, in both realizations",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/identity.ts",
			original: "\t\t\t[scope, String(ordinal), declaration],",
			replacement: "\t\t\t[String(ordinal), declaration],",
			why: "A carrier named by its declaration alone, as be2a16b66 named it: two roles' programs of one declaration name one session table, which the second role may not truncate."
		}
	]
})
