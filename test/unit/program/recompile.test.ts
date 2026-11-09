import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { exact } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import * as Result from "#compiler/core/result.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { type QueryTemplate, queryInput } from "#compiler/program/compile.ts"
import { type ExecutionRequest, templateFor } from "#compiler/program/template.ts"
import { schemaInputOf, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseGen } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"

/**
 * The compilation the runtime runs, over generated programs built through the public builders: a compilation is a
 * function of its query and schema alone.
 *
 * Each case draws a public program (oracle/public/generate.ts) and compiles every query read as a Db compiles it
 * (program/template.ts templateFor), then each again after the case's other reads compiled in between: every read
 * compiles, and again to the same statements, so nothing one compilation leaves behind answers another.
 *
 * How every read here is compiled: as a Db's reads are, for the snapshot context, read as rows.
 */
const request: ExecutionRequest = {
	context: "snapshot",
	read: "rows"
}

/** The specs of a template's optimized statements' large forms. */
const largeSpecs = (t: QueryTemplate) =>
	Arr.flatMap(flight(t.programs.optimized.roots), (s) =>
		s.forms.kind === "chosen" ? [s.forms.large.spec] : []
	)

/** The statements a template emits, as text. */
const statementsOf = (t: QueryTemplate) => ({
	optimized: Arr.map(t.optimized, (s) => s.sql),
	variants: Arr.map(largeSpecs(t), (s) => s.sql)
})

/** What a case reaches: a compiled read, and one compiled again after others. */
type RecompileFeature = "compiled" | "compiled again after another read"

describe("compiling again", () => {
	it.effect(
		"every generated read compiles as a Db compiles it, and compiling it again after other reads gives the same template",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/program/recompile",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<RecompileFeature>(
							["compiled", "compiled again after another read"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, notes) =>
						Effect.sync(() => {
							const fail = (why: string): never => {
								throw new Error(`${why}\n${printCase(c)}`)
							}
							const built = buildSchema(c.schema)
							const schema = built.schema
							const input = schemaInputOf(schema)
							const artifacts = testArtifacts(input, testCompile)
							const asDb = (query: unknown) =>
								Result.flatMap(artifacts, (a) =>
									Result.flatMap(queryInput(query), (q) => templateFor(q, input, a, request))
								)
							const queries = Arr.flatMap(c.reads, (read) =>
								read.kind === "query" ? [buildRoot(built, schema, read.query)] : []
							)
							const first = Arr.map(queries, asDb)
							for (const [i, query] of queries.entries()) {
								const outcome = first[i]
								if (outcome === undefined) {
									return fail(`the outcome of read ${i}`)
								}
								if (!outcome.ok) {
									return fail(`read ${i} is refused: ${outcome.error.message}`)
								}
								notes.note("compiled")
								const fresh = asDb(query)
								if (!fresh.ok) {
									return fail(
										`read ${i} is refused after other reads compiled: ${fresh.error.message}`
									)
								}
								if (
									Option.isSome(
										exact(statementsOf(fresh.value.template), statementsOf(outcome.value.template))
									)
								) {
									fail("a compilation compiles another template after other reads compiled")
								}
								if (queries.length > 1) {
									notes.note("compiled again after another read")
								}
							}
						})
				)
			)
	)
})
