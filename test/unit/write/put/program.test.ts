import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, constant, type Gen, int, subset, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { bigint } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { assert, failed } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	Item,
	shopChangeSet,
	shopCompile,
	shopCompiled,
	Stock,
	stockFromParam
} from "#test/unit/write/put/support.ts"

/**
 * A described member's relation parameter is bound from the caller's values, and a value the program needs and the
 * caller leaves out, or gives as no list of facts, is refused at bind with an EncodingFailure at that parameter's slot,
 * before any SQL. The programs put Item and Stock facts read from relation parameters, one each or both, a non-empty
 * subset drawn as one; the caller gives every parameter a list of facts, or leaves one out, or gives one a number, a
 * list twice as often as either fault, each weight written out.
 *
 * Oracle: the specification, every relation parameter a list of facts.
 *
 * Features: every parameter given, a parameter left out, a parameter given a number.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): put-param-missing-empty, a parameter left out bound as no facts.
 */
const parameterMembers = [
	{ relation: Item, param: "items" },
	{ relation: Stock, param: "stocks" }
] as const

/** What the caller gives a parameter: facts, nothing, or a value that is no list. */
type Given =
	| { readonly kind: "facts"; readonly facts: ReadonlyArray<number> }
	| { readonly kind: "left out" }
	| { readonly kind: "a number" }

const givenGen: Gen<Given> = weighted<Given>([
	[2, (source) => ({ kind: "facts", facts: source.draw(array(int(1, 3), { min: 0, max: 3 })) })],
	[1, constant({ kind: "left out" })],
	[1, constant({ kind: "a number" })]
])

const fact = (n: number, qty: bigint) => ({ id: uuidOf(n), label: "a", qty })

type ParamFeature = "every parameter given" | "a parameter left out" | "a parameter given a number"

describe("the write program's relation parameters", () => {
	it.effect(
		"binds a described member's relation parameter from the caller's values, and refuses one left out or no list at its slot",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/put/relation-parameters",
						draw: drawn((source) =>
							Arr.map(source.draw(subset(parameterMembers, { min: 1, max: 2 })), (m) => ({
								relation: m.relation,
								param: m.param,
								given: source.draw(givenGen),
								qty: source.draw(bigint(0n, 9n))
							}))
						),
						literal: Formatter.format,
						coverage: required<ParamFeature>(
							["every parameter given", "a parameter left out", "a parameter given a number"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "every relation parameter a list of facts" }
					},
					(drawnMembers, c) =>
						Effect.gen(function* () {
							const value = Arr.reduce(drawnMembers, shopChangeSet(), (changes, m) =>
								changes.put(m.relation, stockFromParam(m.relation, m.param))
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
							const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
							const bound = bindWrite(runnableWrite(program, program.frontend.codes), {
								members,
								params,
								transport: inForce(bindFrame)
							})
							const faulty = Arr.filter(drawnMembers, (m) => m.given.kind !== "facts")
							if (faulty.length === 0) {
								c.note("every parameter given")
								assert.ok(bound.ok, "a program given every parameter binds")
								return
							}
							c.noteAll(
								Arr.map(faulty, (m): ParamFeature =>
									m.given.kind === "left out"
										? "a parameter left out"
										: "a parameter given a number"
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
						})
				)
			)
	)
})
