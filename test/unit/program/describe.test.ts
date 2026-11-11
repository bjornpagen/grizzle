import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, element, type Gen, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { descText } from "#compiler/ir/desc.ts"
import { describeQuery, lowerQuery } from "#compiler/program/describe.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert, nonEmpty, refused, succeeded } from "#test/support/assert.ts"
import { fromQueryDescription, queryFromDescription } from "#test/support/describe.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	caseSketchGen,
	type ProgramFeature,
	programFeatures,
	programForms,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"

/**
 * describeQuery and lowerQuery (packages/engine/src/program/describe.ts), the engine's internal inspection
 * vocabulary, with describeQuery's inverse (test/support/describe.ts queryFromDescription), over every generated query
 * read (test/support/oracle/public): a query rebuilt from its
 * Description, sent as JSON or not, is the same Description and lowers to the same statements; lowering is
 * byte-identical across runs; a bare Description, which names no schema, lowers to a MalformedDescription; and a
 * Description is checked against the schema it is given, a relation the schema lacks refused by its typed refusal.
 *
 * Oracles: the round trip (queryFromDescription ∘ describeQuery = id, as the Description's identity text, and lowering
 * a function of the Description), and the specification of the schema check. A relation the given schema lacks is
 * named by construction: its first letter begins none of the schema's relations.
 *
 * Features: every program form the public generator draws (programForms); a relation elsewhere.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): describe-lowering-counter, a lowering stamped with a running count;
 * describe-drops-literal, a Description spelling every integer literal as 0.
 *
 * A Description as the rebuild receives it: the value itself, and the value read back from its JSON text.
 */
const sentForms = (d: Json): ReadonlyArray<unknown> => [d, trustedJson<unknown>(jsonText(d))]

const text = (q: unknown): string =>
	succeeded(descText(queryValueDesc(q)), "the query's Description text")

describe("describeQuery, queryFromDescription and lowerQuery", () => {
	it.effect(
		"rebuild every generated query read as the same Description, which lowers to the same statements",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "queryFromDescription ∘ describeQuery = id, and lowering a function of the Description"
						},
						suite: "unit/program/describe-roundtrip",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						coverage: required<ProgramFeature>(programForms, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, k) =>
						Effect.sync(() => {
							const c = k.draw(resolveCase(sketch))
							const built = buildSchema(c.schema)
							for (const read of c.reads) {
								if (read.kind !== "query") {
									continue
								}
								const q = buildRoot(built, built.schema, read.query)
								const d = describeQuery(q)
								const lowered = succeeded(
									lowerQuery(q),
									`the generated query lowers\n${printCase(c)}`
								)
								for (const sent of sentForms(d)) {
									const rebuilt = succeeded(
										queryFromDescription(sent, built.schema),
										`the rebuild\n${printCase(c)}`
									)
									assert.equal(text(rebuilt), text(q))
									assert.deepEqual(lowerQuery(rebuilt), Result.ok(lowered))
								}
								/** A bare Description names no schema, so the compiler has none to lower it against. */
								const bare = succeeded(fromQueryDescription(d), "the Description read back")
								refused(lowerQuery(bare), "MalformedDescription", "lowered with no schema")
								for (const feature of programFeatures(read.query)) {
									if (Arr.some(programForms, (f) => f === feature)) {
										k.note(feature)
									}
								}
							}
						})
				)
			)
	)

	it.effect("check a Description against the schema it is given", (ctx) =>
		Effect.gen(function* () {
			/**
			 * A Description over a relation the given schema lacks: a capital that begins none of its relations' names,
			 * then two to eight small letters.
			 */
			const initials = new Set(Arr.map(Rec.keys(Work.relations), (name) => Str.slice(0, 1)(name)))
			const capitals = nonEmpty(
				Arr.filter(
					Arr.map(Arr.range(0x41, 0x5a), (point) => String.fromCodePoint(point)),
					(capital) => !initials.has(capital)
				),
				"a capital no relation of the schema begins with"
			)
			const named: Gen<string> = (source) =>
				`${source.draw(element(capitals))}${source.draw(string(codePoint(0x61, 0x7a), { min: 2, max: 8 }))}`
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a Description is checked against the schema it is given: a relation it lacks is refused"
						},
						suite: "unit/program/describe-schema",
						draw: drawn(named),
						literal: Formatter.format,
						coverage: required<"elsewhere">(["elsewhere"], { cases: 20, sense: notesOnly }),
						kept: [],
						runs: 20,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(name, k) =>
						Effect.sync(() => {
							const Elsewhere = relation(name, { task: uuid, budget: pg.bigint }, ["task"])
							const Elsewheres = schema("Elsewhere", [Elsewhere], [])
							const d = describeQuery(
								query(Elsewheres).rule((r) => {
									const { task, budget } = v(Elsewhere, "elsewhere")
									return r.match(Elsewhere, { task, budget }).find({ task, budget })
								})
							)
							succeeded(queryFromDescription(d, Elsewheres), "a schema with the relation")
							const e = refused(
								queryFromDescription(d, Work),
								"Refused",
								"a schema without the relation"
							)
							assert.equal(
								e.reason._tag === "Refused" ? e.reason.refusal : undefined,
								"the relation is not in this query's schema"
							)
							k.note("elsewhere")
						})
				)
			)
		})
	)
})
