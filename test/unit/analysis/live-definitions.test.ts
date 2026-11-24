/**
 * A checked schema checks each import its live definitions read once (analysis/schema.ts CheckedSchema, the one session
 * of its live definitions' checks): a live definition is checked for its refusals alone and reads the definitions below
 * it as imports, so over a chain of live derived relations, each reading the definition below it, the imports are
 * checked once each, one for each definition that reads another, where a session of each definition's own
 * checked the whole chain below it again, a number of checks of the square of the chain's length.
 *
 * The count is work, never time: V8's precise coverage counts the checker's import checks (kernel/calls.ts callCounts,
 * check/checker.ts #importChecked). The box is exhausted: chains of one to nine definitions.
 *
 * Features: a chain of one definition, a chain of several.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { own } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	decodedQuery,
	decodedSchema,
	f,
	type QueryDesc,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { callCounts } from "#test/support/kernel/calls.ts"

type ChainFeature = "a chain of one definition" | "a chain of several"

/** The fields every relation of a chain holds, T's and each definition's head. */
const fields = ["doc", "at", "b"] as const

/**
 * A chain of `length` live derived relations over T: D1's definition finds every row of T, and each D(i + 1)'s every row
 * of D(i)'s definition, which it reads as an import, so D(i)'s check reads the chain of i - 1 imports below it. Each
 * reads T alone, so each stands at the first derived level, in the extension of T's schema.
 */
const chainOf = (length: number): SchemaDesc => {
	const vars = Arr.map(fields, (id) => ({ id, origin: undefined }))
	const bindings = Rec.fromEntries(Arr.map(fields, (x) => [x, { kind: "var", var: x }] as const))
	const definitionOver = (
		source:
			| { readonly kind: "relation"; readonly name: string }
			| {
					readonly kind: "query"
					readonly query: QueryDesc
					readonly bind: Readonly<Record<string, never>>
			  }
	): QueryDesc =>
		decodedQuery({
			kind: "rules",
			arms: [
				{
					vars,
					matches: [{ source, bindings }],
					where: [],
					head: bindings,
					interiors: [],
					attach: []
				}
			]
		})
	const definitions: Array<QueryDesc> = [definitionOver({ kind: "relation", name: "T" })]
	for (let i = 1; i < length; i += 1) {
		definitions.push(
			definitionOver({
				kind: "query",
				query: defined(definitions[i - 1], "the definition below"),
				bind: {}
			})
		)
	}
	return {
		name: "chain_1",
		relations: Arr.map(definitions, (query, i) => ({
			kind: "derived" as const,
			name: `D${i + 1}`,
			level: 1,
			storage: "live" as const,
			query
		})),
		statements: [],
		bases: [
			{
				name: "chain",
				relations: [relation("T", { doc: f.natural, at: f.natural, b: f.natural }, ["doc", "at"])],
				statements: [],
				bases: []
			}
		]
	}
}

/** A checked schema checks each import its live definitions read once, one for each definition that reads another. */
export const aCheckedSchemaChecksEachImportItsLiveDefinitionsReadOnce = property.exhaust(
	finite(int(1, 9)),
	{
		needs: {},
		box: "chains of one to nine live definitions, each reading the one below it",
		situations: ["a chain of one definition", "a chain of several"] satisfies ReadonlyArray<
			Reached<ChainFeature>
		>,
		check: (_, k: Case<ChainFeature>) => (length) =>
			Effect.gen(function* () {
				k.note(length === 1 ? "a chain of one definition" : "a chain of several")
				const owned = succeeded(own(decodedSchema(chainOf(length))), "the chain owns")
				const [, counts] = yield* callCounts(
					Effect.sync(() => succeeded(checkedSchema(owned, everySlice(owned)), "the chain checks")),
					{ imports: { file: "packages/engine/src/check/checker.ts", name: "#importChecked" } }
				)
				assert.equal(
					counts.imports,
					length - 1,
					`a chain of ${length} definitions checks each of its ${length - 1} imports once`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one import check for each live definition that reads another (kernel/calls.ts callCounts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "r.desc.query, r.name, r.loc, live)",
				replacement: "r.desc.query, r.name, r.loc, new CheckSession(this.patterns))",
				why: "Each live definition is checked in a session of its own, which checks the whole chain of imports below it again: a chain of n definitions checks n(n - 1) / 2 imports, and the property fails from three."
			}
		]
	}
)
