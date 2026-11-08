import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { filter } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { descText } from "#compiler/ir/desc.ts"
import { describeQuery, lowerQuery } from "#compiler/program/describe.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
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

import { regex } from "arkregex"
/**
 * describeQuery and lowerQuery (packages/engine/src/program/describe.ts), the engine's internal inspection
 * vocabulary, with describeQuery's inverse (test/support/describe.ts queryFromDescription), over every generated query
 * read (test/support/oracle/public): a query rebuilt from its
 * Description, sent as JSON or not, is the same Description and lowers to the same statements; lowering is
 * byte-identical across runs; a bare Description, which names no schema, lowers to a refusal; and a Description is
 * checked against the schema it is given.
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
						oracle: { kind: "unstated" },
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
								assert.deepEqual(
									refusalLoc(
										refused(lowerQuery(bare), "MalformedDescription", "lowered with no schema")
									),
									SourceLoc("compile", [])
								)
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
			/** A Description over a relation the given schema lacks, named as drawn. */
			const relations: Readonly<Record<string, unknown>> = Work.relations
			const named = filter(
				matching(regex("^[A-Z][a-z]{2,8}$")),
				(name) => !Rec.has(relations, name),
				100
			)
			yield* searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
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
							const Elsewheres = schema("Elsewhere", { [name]: Elsewhere }, [])
							const d = describeQuery(
								query(Elsewheres).rule((r) => {
									const { task, budget } = v(Elsewhere, "elsewhere")
									return r.match(Elsewhere, { task, budget }).find({ task, budget })
								})
							)
							succeeded(queryFromDescription(d, Elsewheres), "a schema with the relation")
							refused(
								queryFromDescription(d, Work),
								"MalformedDescription",
								"a schema without the relation"
							)
							k.note("elsewhere")
						})
				)
			)
		})
	)
})
