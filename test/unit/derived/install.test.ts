import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, filter, map } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import * as Result from "#compiler/core/result.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { own } from "#compiler/schema/own.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import {
	decodedQuery,
	decodedSchema,
	f,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"

/** A derived relation's view columns in the fresh installation: two head names that convert to one PostgreSQL column
 * identifier are refused as IdentifierCollision, and names that convert apart install side by side.
 *
 * What a derived relation installs, each view column's type, typmod and collation, and every refreshed view against its
 * definition, is PostgreSQL's to judge, in the database suites. */
const Org = relation("Org", { id: f.uuid }, ["id"])
const Base: SchemaDesc = { name: "Base", relations: [Org], statements: [], extends: undefined }

/** A derived relation over Org whose head binds Org's id under two names. */
const pairs = (a: string, b: string): SchemaDesc => ({
	name: "Base",
	extends: Base,
	relations: [
		{
			kind: "derived",
			name: "Pairs",
			level: 1,
			query: decodedQuery({
				kind: "rules",
				arms: [
					{
						vars: [{ id: "id", origin: { relation: "Org", field: "id" } }],
						matches: [
							{
								source: { kind: "relation", name: "Org" },
								bindings: { id: { kind: "var", var: "id" } }
							}
						],
						where: [],
						head: { [a]: { kind: "var", var: "id" }, [b]: { kind: "var", var: "id" } },
						interiors: [],
						attach: []
					}
				]
			})
		}
	],
	statements: []
})

/** A head name's words, and the spellings of them that convert to one identifier (camelCase, snake_case, PascalCase). */
const words = element<ReadonlyArray<string>>([
	["owner", "id"],
	["level"],
	["alpha", "beta", "gamma"]
])
type Spelling = "camel" | "snake" | "pascal"
const spell = (ws: ReadonlyArray<string>, s: Spelling): string =>
	s === "snake"
		? Arr.join(ws, "_")
		: s === "camel"
			? Arr.join(
					Arr.map(ws, (w, i) => (i === 0 ? w : Str.capitalize(w))),
					""
				)
			: Arr.join(Arr.map(ws, Str.capitalize), "")

describe("derived relation view columns", () => {
	it.effect(
		"refuses two head names converting to one column identifier, and installs names converting apart",
		(ctx) =>
			Effect.gen(function* () {
				const spellings = element<Spelling>(["camel", "snake", "pascal"])
				const space = filter(
					map(
						(source) =>
							[
								source.draw(words),
								source.draw(words),
								source.draw((source) => [source.draw(spellings), source.draw(spellings)] as const)
							] as const,
						([wa, wb, [s, t]]) => ({
							a: spell(wa, s),
							b: spell(wb, t),
							same: wa === wb
						})
					),
					({ a, b }) => a !== b,
					1
				)
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/derived/head-identifiers",
							generator: space,
							literal: Formatter.format,
							limit: 100,
							coverage: requiredInSpace<"a collision refused" | "names installed apart">([
								"a collision refused",
								"names installed apart"
							]),
							caseHang: Duration.minutes(2)
						},
						({ a, b, same }, c) =>
							Effect.sync(() => {
								const installed = Result.flatMap(own(decodedSchema(pairs(a, b))), (owned) =>
									compileInstallation(owned, withDerivedRelations(installOptions(owned, "owner")))
								)
								if (same) {
									c.note("a collision refused")
									refused(installed, "IdentifierCollision")
									return
								}
								c.note("names installed apart")
								const N = installationNamesOf(succeeded(installed))
								assert.notEqual(
									N.columnIdent({ name: "Pairs" }, a),
									N.columnIdent({ name: "Pairs" }, b)
								)
							})
					)
				)
			})
	)
})
