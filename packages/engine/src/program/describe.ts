import type { Json } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { toQueryDescription } from "#compiler/ir/describe.ts"
import type { LoweredProgram } from "#compiler/ir/products.ts"
import { compileQuery, queryInput, querySchema } from "#compiler/program/compile.ts"
import { schemaArtifacts } from "#compiler/program/schema.ts"

/**
 * describeQuery and lowerQuery: the inspection vocabulary over query values, internal to the engine (tests, the golden
 * capture and the compile profiler read it; no package export does).
 *
 * - describeQuery: a query or ordered value to its QueryDescription, its Description in canonical JSON form
 *   (ir/describe.ts). Like every builder-side convenience it is synchronous and throws the
 *   CompileError for a value it cannot describe: a value the builder did not make,
 *   or a child query that still names an attachment's parent variables.
 * - lowerQuery: the optimized artifact's statement texts, the LoweredProgram view of a template compiled for
 *   the `snapshot` context (ir/products.ts): exactly what the runtime would send, every result column cast
 *   to text.
 */
export const describeQuery = (query: unknown): Json => {
	const input = queryInput(query)
	const description = Result.flatMap(input, (i) => toQueryDescription(i.desc))
	if (!description.ok) {
		throw description.error
	}
	return description.value
}

/** The entry point compiles for the snapshot context, before any admission, read as rows. */
export const lowerQuery = (query: unknown): Result.Result<LoweredProgram, CompileError> => {
	const input = queryInput(query)
	if (!input.ok) {
		return input
	}
	const source = querySchema(input.value, undefined)
	if (!source.ok) {
		return source
	}
	const artifacts = schemaArtifacts(source.value.schema, {
		installation: undefined,
		vectorSchema: undefined
	})
	if (!artifacts.ok) {
		return artifacts
	}
	const template = compileQuery(source.value, {
		context: "snapshot",
		artifacts: artifacts.value,
		read: "rows"
	})
	if (!template.ok) {
		return template
	}
	return Result.ok(
		Object.freeze({ statements: Object.freeze(template.value.optimized.map((s) => s.sql)) })
	)
}
