/**
 * A schema of rosters and closed relations states no law of its own: it compiles to the law model of natural alone,
 * the contract every schema holds (schema/own.ts #collectFields), its one law natural's contract, which no column of
 * the schema stores, and its one native object natural's domain, with no constraint or law the migration discharges,
 * and installs.
 *
 * The oracle is the specification: a roster's handles and a closed relation's rows are immutable finite facts the
 * description boundary checks (ir/desc.ts: one row per key, each of every field, keyed by closed ids), so no law
 * remains to discharge but natural's, whatever the rosters, their sizes and the closed relations over them, none at all
 * included.
 *
 * Inputs: zero to three rosters of one to three handles, each alone or with a closed relation of a bigint payload over
 * every handle.
 *
 * Features: no relation, a roster alone, a closed relation.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, constant, int, map, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect } from "effect"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { succeeded } from "#test/support/assert.ts"
import { closed, closedRelation, f } from "#test/support/fixtures/ir/desc.ts"
import { owning } from "#test/support/policy.ts"
import type { Payload } from "#test/unit/laws/model/semantics.fixtures.ts"
import { modelOf, schemaOf } from "#test/unit/laws/model/support.ts"

/** A schema that states no law compiles rosters and closed relations to natural's law model alone, and installs. Its budget is its suite's before it was a property (test/unit/laws/model/semantics.test.ts at 4ca3036a): 30 runs and 30 steered cases. */
export const aSchemaThatStatesNoLawCompilesRostersAndClosedRelationsToNaturalsLawModelAloneAndInstalls =
	property.explore(
		array(
			(source) => ({
				handles: source.draw(int(1, 3)),
				payload: source.draw(
					oneOf([
						constant<Payload>({ kind: "none" }),
						map(array(bigint(-5n, 5n), { min: 3, max: 3 }), (values): Payload => ({
							kind: "values",
							values
						}))
					])
				)
			}),
			{ min: 0, max: 3 }
		),
		{
			needs: {},
			budget: { runs: 30, steered: 30 },
			situations: ["no relation", "a roster alone", "a closed relation"] satisfies ReadonlyArray<
				Reached<"no relation" | "a roster alone" | "a closed relation">
			>,
			check: (_, n: Case<"no relation" | "a roster alone" | "a closed relation">) => (sketch) =>
				Effect.gen(function* () {
					const desc = ((rosters) =>
						schemaOf(
							Arr.flatMap(rosters, (r, i) => {
								const handles = ["Low", "Mid", "High"].slice(0, r.handles)
								const name = defined(["Tier", "Rate", "Plan"][i], "a roster's name")
								const roster = closed.ordered(name, handles)
								const payload = r.payload
								return payload.kind === "none"
									? [roster]
									: [
											roster,
											closedRelation(
												`${name}Value`,
												{ key: f.closedId(name), n: f.bigint },
												["key"],
												Arr.map(handles, (h, j) => ({
													key: h,
													n: defined(payload.values[j], "a row's value")
												}))
											)
										]
							}),
							[],
							"Laws"
						))(sketch)
					return yield* Effect.sync(() => {
						if (desc.relations.length === 0) {
							n.note("no relation")
						}
						for (const r of desc.relations) {
							n.note(r.kind === "closedRelation" ? "a closed relation" : "a roster alone")
						}
						const m = modelOf(desc)
						assert.deepEqual(
							Arr.map(m.theory.laws, (l) =>
								l.detail.kind === "contract"
									? { contract: l.detail.contract, uses: l.detail.uses.length }
									: { contract: undefined, uses: 0 }
							),
							[{ contract: "natural", uses: 0 }],
							"the one law is natural's contract, which no column of the schema stores"
						)
						assert.deepEqual(
							Arr.map(m.natives, (n) => n.namespace),
							["domain"],
							"the one native object is natural's domain"
						)
						assert.deepEqual([m.constraints, m.migrationLaws], [[], []])
						const owned = owning(desc)
						succeeded(compileInstallation(owned, installOptions(owned)))
					})
				}),
			oracle: {
				kind: "specification",
				name: "rosters and closed relations are immutable facts the description checks: no law, native or constraint remains but natural's, which every schema holds"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/theory.ts",
					original: '\t\t\tif (r?.kind === "relation") {',
					replacement: "\t\t\tif (r !== undefined) {",
					why: "The theory states every stored relation's primary key as a law, a closed relation's and a roster's among them (analysis/theory/theory.ts normalize); a closed relation holds no key name (analysis/schema.ts), so stating one fails, and the law model of natural alone is not compiled."
				}
			]
		}
	)
