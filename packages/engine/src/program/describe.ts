import type { Json } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { toQueryDescription } from "#compiler/ir/describe.ts"
import type { LoweredProgram } from "#compiler/ir/products.ts"
import { compileQuery, queryInput, querySchema } from "#compiler/program/compile.ts"
import { type SchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { type Owned, own, ownRole, rostersOf } from "#compiler/schema/own.ts"

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

/** The schema a query's artifacts are computed over, owned: a role's base, or the schema itself. */
const ownedOf = (input: SchemaInput): Result.Result<Owned, CompileError> => {
	switch (input.kind) {
		case "owned":
			return Result.ok(input.owned)
		case "role":
			return Result.map(ownRole(input.desc), (role) => role.base)
		case "built":
		case "desc":
			return own(input.desc)
	}
}

/** The entry point compiles for the snapshot context, before any admission, read as rows, under a fresh installation's
 * codes of the schema's rosters (ir/codes.ts firstCodebook). */
export const lowerQuery = (query: unknown): Result.Result<LoweredProgram, CompileError> => {
	const input = queryInput(query)
	if (!input.ok) {
		return input
	}
	const source = querySchema(input.value, undefined)
	if (!source.ok) {
		return source
	}
	const owned = ownedOf(source.value.schema)
	if (!owned.ok) {
		return owned
	}
	const artifacts = schemaArtifacts(source.value.schema, {
		installation: undefined,
		vectorSchema: undefined,
		codes: firstCodebook(rostersOf(owned.value))
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
