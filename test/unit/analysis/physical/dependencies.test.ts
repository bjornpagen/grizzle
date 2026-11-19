/**
 * The physical analysis's dependency tables (analysis/physical/fds.ts Dependencies), against a brute-force oracle over
 * small generated tables: a heading of up to six columns, hidden attributes beside it, dependencies that read spans at
 * a point, point rules, evidence contexts, and an identity of alternatives of requirements of key options, the shape a
 * rule region's identification takes, encoded as the rules encode it (one hidden attribute per requirement).
 *
 * - The closure of every start among the heading's columns holds exactly the columns, and the row, that firing every
 *   dependency and point rule until none adds a fact holds: the reduction at freeze drops nothing a start can reach.
 * - A start identifies a row exactly when that closure holds the row, which is exactly when, under the identity's own
 *   reading (some alternative whose every requirement has an option inside the closure of the plain dependencies), the
 *   start is a key: the encoding is the identity.
 * - The proof is the strongest: its context is the least demanding one under which a closure of only the dependencies
 *   holding in it reaches the row. The search requires a start whose whole closure, every dependency admitted at once,
 *   first reaches the row through a more demanding dependency, where only the order of the contexts finds the
 *   strongest proof.
 * - The canonical key lies among the start's columns, identifies a row, and drops no column it could drop on a proof no
 *   more demanding.
 * - Every key the capped enumeration the analysis once ran finds (at most eight minimal keys from the options and the
 *   heading, closed under the exchange), the table identifies: the analysis without caps proves at least what the
 *   capped one proved.
 *
 * And a rule region's table (analysis/physical/rules.ts regionProps), over every scan of a relation of two keys that
 * binds some of its columns and fixes some to a literal or a parameter: a constant on a bound column fixes the column's
 * variable, so the table closes and identifies from every start among the variables exactly as the scan without those
 * constants does under a filter equating each such variable with its value.
 *
 * Features: each table's closures, identities and contexts; each placement of each constant.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, subarray } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { rowAttribute } from "#compiler/analysis/physical/fds.ts"
import { lessDemanding } from "#compiler/ir/evidence.ts"
import {
	cappedKeys,
	type DependencyFeature,
	listed,
	oldKeyMinimal,
	oracleClosure,
	oracleDeps,
	rank,
	type RegionFeature,
	satisfies,
	type Scan,
	scanColumns,
	scanProps,
	specGen,
	subsetsOf,
	tableOf
} from "#test/unit/analysis/physical/dependencies.fixtures.ts"

/**
 * A fragment's dependency table closes, identifies and keys exactly as the brute-force oracle does, and proves every
 * key the capped search found.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/dependencies.test.ts:322 at 8cad5bce, its runs and its coverage's cases).
 */
export const aFragmentsDependencyTableClosesIdentifiesAndKeysExactlyAsTheBruteForceOracleDoesAndProvesEveryKeyTheCappedSearchFound =
	property.explore(specGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"identified",
			"not identified",
			"a proof stronger than the whole closure's"
		] satisfies ReadonlyArray<Reached<DependencyFeature>>,
		check: (_, c: Case<DependencyFeature>) => (s) =>
			Effect.sync(() => {
				const table = tableOf(s)
				const visible = [...s.heading, rowAttribute]
				const plainDeps = oracleDeps({ ...s, identity: [] })
				const oldKey = (cs: ReadonlyArray<string>): boolean =>
					satisfies(s.identity, oracleClosure(s, cs, 1, false))
				for (const start of subsetsOf(s.heading)) {
					const expected = oracleClosure(s, start, 1, true)
					const closure = table.closure(start)
					for (const v of visible) {
						assert.equal(closure.columns.has(v), expected.has(v), `${v} from (${listed(start)})`)
					}
					const identified = table.identification(start)
					assert.equal(
						identified !== undefined,
						expected.has(rowAttribute),
						`the row from (${listed(start)})`
					)
					assert.equal(
						identified !== undefined,
						oldKey(start),
						`the identity at (${listed(start)})`
					)
					if (identified === undefined) {
						c.note("not identified")
						continue
					}
					c.note("identified")
					const least = oracleClosure(s, start, 0, true).has(rowAttribute) ? 0 : 1
					assert.equal(
						rank(identified.just.context),
						least,
						`the proof's context at (${listed(start)})`
					)
					if (least === 0 && Arr.some(s.deps, (d) => d.context === "immediate")) {
						c.note("a less demanding stage chosen")
					}
					/** The proof the whole closure's first derivations give, every dependency admitted at once. */
					const whole = table.explain(table.closure(start), [rowAttribute])
					if (rank(whole.context) > least) {
						c.note("a proof stronger than the whole closure's")
					}
					const key = identified.key
					assert.ok(
						Arr.every(key, (k) => start.includes(k)),
						`the key (${listed(key)}) among (${listed(start)})`
					)
					const proof = defined(table.proof(key), `the key (${listed(key)}) identifies a row`)
					for (const k of key) {
						const narrower = table.proof(Arr.filter(key, (x) => x !== k))
						assert.ok(
							narrower === undefined || lessDemanding(proof.context, narrower.context),
							`the key (${listed(key)}) keeps ${k} only for a proof no more demanding`
						)
					}
				}
				const minimal = Arr.filter(subsetsOf(s.heading), (k) => oldKeyMinimal(k, oldKey)).length
				if (minimal > 8) {
					c.note("more minimal keys than the cap")
				}
				const options = Arr.flatMap(s.identity, (alternative) => alternative.flat())
				for (const key of cappedKeys(s.heading, [...options, s.heading], oldKey, 8, plainDeps)) {
					c.note("a key the capped search found")
					assert.ok(
						table.identification(key) !== undefined,
						`the capped search's key (${listed(key)})`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "firing every dependency and point rule by brute force until none adds a fact, under each context"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/physical/dependencies.test.ts#aFragmentsDependencyTableClosesIdentifiesAndKeysExactlyAsTheBruteForceOracleDoesAndProvesEveryKeyTheCappedSearchFound:-:0.4.1.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.1.0.0.0.0.0.0.0.2.1.1.1.1.0.0.1.0.0"
				),
				reason:
					"a dependency that reads the point an immediate rule pins and derives that span's column: the row's proof holds the pin, so it is immediate, never the dependency's query-local context alone",
				since: "2026-11-05"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/fds.ts",
				original: "\t\tfor (const stage of this.#stages) {",
				replacement: "\t\tfor (const stage of this.#stages.toReversed()) {",
				why: "A start's proof sought in the most demanding context first, so it is not the strongest (analysis/physical/fds.ts proof); the tables fail."
			}
		]
	})

/** A rule region's dependency table fixes a bound column's variable by the column's constant, as a filter on the variable does. */
export const aRuleRegionsDependencyTableFixesABoundColumnsVariableByTheColumnsConstantAsAFilterOnTheVariableDoes =
	property.exhaust(
		finite((source): Scan => ({
			bound: source.draw(subarray(scanColumns)),
			constants: Arr.map(
				source.draw(subarray(scanColumns)),
				(column) => [column, source.draw(element(["literal", "param"] as const))] as const
			)
		})),
		{
			needs: {},
			situations: [
				"a bound column's constant fixes its variable",
				"an unbound column's constant",
				"a key's constant fixes the row"
			] satisfies ReadonlyArray<Reached<RegionFeature>>,
			check: (_, c: Case<RegionFeature>) => (scan) =>
				Effect.sync(() => {
					if (scan.bound.length === 0) {
						return
					}
					const stated = scanProps(scan, "on the occurrence")
					const filtered = scanProps(scan, "as a filter")
					for (const start of subsetsOf(scan.bound)) {
						const closure = stated.dependencies.closure(start)
						const expected = filtered.dependencies.closure(start)
						for (const v of [...scan.bound, rowAttribute]) {
							assert.equal(
								closure.columns.has(v),
								expected.columns.has(v),
								`${v} from (${listed(start)})`
							)
						}
						assert.equal(
							stated.dependencies.identification(start) !== undefined,
							filtered.dependencies.identification(start) !== undefined,
							`the row from (${listed(start)})`
						)
					}
					const fixed = stated.dependencies.closure([])
					for (const [column] of scan.constants) {
						if (!scan.bound.includes(column)) {
							c.note("an unbound column's constant")
							continue
						}
						c.note("a bound column's constant fixes its variable")
						assert.ok(fixed.columns.has(column), `the constant fixes ${column}`)
						if (column !== "city") {
							c.note("a key's constant fixes the row")
							assert.ok(
								fixed.columns.has(rowAttribute),
								`the constant on the key ${column} fixes the row`
							)
						}
					}
				}),
			oracle: {
				kind: "universal",
				name: "differential: the constants on the occurrence close and identify as the same scan under a filter equating each bound variable with its value"
			},
			box: "every scan of Person binding any of its columns and fixing any to a literal or a parameter",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/physical/rules.ts",
					original:
						"\t\t\tfixedColumn(c.column, {\n\t\t\t\tfixed: fact.fixed,\n\t\t\t\tjust: joinJustifications([fact.just, eqJust([v])])\n\t\t\t})\n",
					replacement: "",
					why: "A constant on a bound column fixes no variable (analysis/physical/rules.ts regionProps); the region's constants fail."
				}
			]
		}
	)
