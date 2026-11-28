/**
 * A described member's relation parameter is bound from the caller's values, and a value the program needs and the
 * caller leaves out, or gives as no list of facts, is refused at bind with an EncodingFailure at that parameter's slot,
 * before any SQL. The programs insert Item facts and put Stock facts read from relation parameters, one each or both, a non-empty
 * subset drawn as one; the caller gives every parameter a list of facts, or leaves one out, or gives one a number, a
 * list twice as often as either fault, each weight written out.
 *
 * Oracle: the specification, every relation parameter a list of facts.
 *
 * Features: every parameter given, a parameter left out, a parameter given a number.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { failed } from "#test/support/assert.ts"
import { parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	shopChangeSet,
	shopCompile,
	shopCompiled,
	stockFromParam
} from "#test/support/unit/write/put/support.ts"
import {
	fact,
	givenGen,
	parameterMembers,
	type ParamFeature
} from "#test/unit/write/put/program.fixtures.ts"

/**
 * The write program's relation parameters binds a described member's relation parameter from the caller's values, and
 * refuses one left out or no list at its slot.
 *
 * Budget: 200 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/write/put/program.test.ts:60 at 8cad5bce, its runs and its coverage's cases).
 */
export const theWriteProgramsRelationParametersBindsADescribedMembersRelationParameterFromTheCallersValuesAndRefusesOneLeftOutOrNoListAtItsSlot =
	property.explore(
		(source) =>
			Arr.map(source.draw(subset(parameterMembers, { min: 1, max: 2 })), (m) => ({
				relation: m.relation,
				param: m.param,
				op: m.op,
				given: source.draw(givenGen),
				qty: source.draw(bigint(0n, 9n))
			})),
		{
			needs: {},
			budget: { runs: 200, steered: 100 },
			situations: [
				"every parameter given",
				"a parameter left out",
				"a parameter given a number"
			] satisfies ReadonlyArray<Reached<ParamFeature>>,
			check: (_, c: Case<ParamFeature>) => (drawnMembers) =>
				Effect.sync(() => {
					const value = Arr.reduce(drawnMembers, shopChangeSet(), (changes, m) =>
						m.op === "insert"
							? changes.insert(m.relation, stockFromParam(m.relation, m.param))
							: changes.put(m.relation, stockFromParam(m.relation, m.param))
					)
					const program = shopCompiled(value, shopCompile)
					const params = Rec.fromEntries(
						Arr.flatMap(drawnMembers, (m): ReadonlyArray<readonly [string, unknown]> => {
							switch (m.given.kind) {
								case "facts":
									return [[m.param, Arr.map(m.given.facts, (n) => fact(n, m.qty))]]
								case "left out":
									return []
								case "a number":
									return [[m.param, 1]]
							}
						})
					)
					const members = collectInputs(program.binding.groups, parsedOf(value).inputs)
					const bound = bindWrite(
						flightOf(servableWrite(program), program.frontend.codes, noAdvice),
						{
							members,
							params,
							transport: inForce(bindFrame)
						}
					)
					const faulty = Arr.filter(drawnMembers, (m) => m.given.kind !== "facts")
					if (faulty.length === 0) {
						c.note("every parameter given")
						assert.ok(bound.ok, "a program given every parameter binds")
						return
					}
					c.noteAll(
						Arr.map(faulty, (m): ParamFeature =>
							m.given.kind === "left out" ? "a parameter left out" : "a parameter given a number"
						)
					)
					const failure = failed(bound, "a parameter left out or no list is refused")
					assert.ok(
						failure._tag === "EncodingFailure" &&
							failure.reason._tag === "factShape" &&
							failure.place._tag === "Slot" &&
							Arr.some(
								faulty,
								(m) => failure.place._tag === "Slot" && failure.place.name === m.param
							),
						"the refusal is factShape at a refused parameter's slot"
					)
				}),
			oracle: { kind: "specification", name: "every relation parameter a list of facts" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/write/bind.ts",
					original: "\t\tconst value = paramValue(decl.name)",
					replacement: "\t\tconst value = paramValue(decl.name) ?? []",
					why: "A parameter left out bound as no facts (runtime/write/bind.ts)."
				}
			]
		}
	)
