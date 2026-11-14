/**
 * A schema of rosters and closed relations states no law: it compiles to the empty law model (no law, native object,
 * constraint or law the migration discharges), and installs.
 *
 * The oracle is the specification: a roster's handles and a closed relation's rows are immutable finite facts the
 * description boundary checks (ir/desc.ts: one row per key, each of every field, keyed by closed ids), so no law
 * remains to discharge, whatever the rosters, their sizes and the closed relations over them, none at all included.
 *
 * Inputs: zero to three rosters of one to three handles, each alone or with a closed relation of a bigint payload over
 * every handle.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): no-law-closed-relation-keyed (the theory states a closed relation's
 * primary key as a law).
 *
 * Features: no relation, a roster alone, a closed relation.
 */

import { sketched, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, constant, int, map, oneOf } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { bigint } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { closed, closedRelation, f } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { modelOf, schemaOf } from "#test/unit/laws/model/support.ts"

/** A closed relation over a roster: none, or one value of a bigint payload per handle that has a row. */
type Payload =
	| { readonly kind: "none" }
	| { readonly kind: "values"; readonly values: ReadonlyArray<bigint> }

describe("a schema that states no law", () => {
	it.effect(
		"compiles rosters and closed relations only to the empty law model, and installs",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "rosters and closed relations are immutable facts the description checks: no law, native or constraint remains"
						},
						suite: "unit/laws/model/no-law",
						draw: sketched(
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
							(rosters) =>
								schemaOf(
									Arr.flatMap(rosters, (r, i) => {
										const handles = ["Low", "Mid", "High"].slice(0, r.handles)
										const name = defined(["Tier", "Rate", "Plan"][i], "a roster's name")
										const roster = closed(name, handles)
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
								)
						),
						literal: Formatter.format,
						coverage: required<"no relation" | "a roster alone" | "a closed relation">(
							["no relation", "a roster alone", "a closed relation"],
							{ cases: 30, sense: notesOnly }
						),
						kept: [],
						runs: 30,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(desc, n) =>
						Effect.sync(() => {
							if (desc.relations.length === 0) {
								n.note("no relation")
							}
							for (const r of desc.relations) {
								n.note(r.kind === "closedRelation" ? "a closed relation" : "a roster alone")
							}
							const m = modelOf(desc)
							assert.deepEqual(
								[m.theory.laws, m.natives, m.constraints, m.migrationLaws],
								[[], [], [], []]
							)
							const owned = owning(desc)
							succeeded(compileInstallation(owned, installOptions(owned, "owner")))
						})
				)
			)
	)
})
