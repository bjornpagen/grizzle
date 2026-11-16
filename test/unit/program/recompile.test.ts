import { type Reached } from "@bjornpagen/testing/features"
import { exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import * as Result from "#compiler/core/result.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { templateFor } from "#compiler/program/template.ts"
import { inputArtifacts, schemaInputOf, testCompile } from "#test/support/compile.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseGen } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	type RecompileFeature,
	request,
	statementsOf
} from "#test/unit/program/recompile.fixtures.ts"

/** Compiling again every generated read compiles as a Db compiles it, and compiling it again after other reads gives the same template. */
export const compilingAgainEveryGeneratedReadCompilesAsADbCompilesItAndCompilingItAgainAfterOtherReadsGivesTheSameTemplate =
	property.explore(caseGen, {
		needs: {},
		situations: ["compiled", "compiled again after another read"] satisfies ReadonlyArray<
			Reached<RecompileFeature>
		>,
		check: (_, notes: Case<RecompileFeature>) => (c) =>
			Effect.sync(() => {
				const fail = (why: string): never => {
					throw new Error(`${why}\n${printCase(c)}`)
				}
				const built = buildSchema(c.schema)
				const schema = built.schema
				const input = schemaInputOf(schema)
				const artifacts = inputArtifacts(input, testCompile)
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
						return fail(`read ${i} is refused after other reads compiled: ${fresh.error.message}`)
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
			}),
		oracle: {
			kind: "universal",
			name: "a compilation is a function of its query and schema: compiled again after other reads, the same statements"
		},
		kept: [],
		kills: []
	})
