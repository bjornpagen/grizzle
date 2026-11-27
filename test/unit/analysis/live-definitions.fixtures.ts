/**
 * The box of test/unit/analysis/live-definitions.test.ts: chains of live derived relations over T, each reading the
 * definition below it as an import.
 */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Record as Rec } from "effect"
import {
	decodedQuery,
	f,
	type QueryDesc,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

/** The fields every relation of a chain holds, T's and each definition's head. */
const fields = ["doc", "at", "b"] as const

/**
 * A chain of `length` live derived relations over T: D1's definition finds every row of T, and each D(i + 1)'s every row
 * of D(i)'s definition, which it reads as an import, so D(i)'s check reads the chain of i - 1 imports below it. Each
 * reads T alone, so each stands at the first derived level, in the extension of T's schema.
 */
export const chainOf = (length: number): SchemaDesc => {
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
