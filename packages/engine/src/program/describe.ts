import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { Json } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { fromQueryDescription, toQueryDescription } from "#compiler/ir/describe.ts"
import type { LoweredProgram } from "#compiler/ir/products.ts"
import { compileQuery, queryInput, querySchema } from "#compiler/program/compile.ts"
import { checkedInput, parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { type OrderedValue, type QueryValue, queryFromDesc } from "#compiler/query/build/query.ts"

/**
 * describeQuery, queryFromDescription and lowerQuery: the inspection vocabulary over query values, internal to the
 * engine (tests, the golden capture and the compile profiler read it; no package export does).
 *
 * - describeQuery: a query or ordered value to its QueryDescription, its Description in canonical JSON form
 *   (ir/describe.ts). Like every builder-side convenience it is synchronous and throws the
 *   CompileError for a value it cannot describe: a value the builder did not make,
 *   or a child query that still names an attachment's parent variables.
 * - queryFromDescription: the inverse, a QueryDescription (or any value claiming to be one) back to a query value with
 *   the same combinators (query/build queryFromDesc). A value that does not decode as a query's Description is
 *   MalformedDescription. A Description names relations, not the
 *   schema that declares them, so the rebuilt value is schemaless unless the caller names the schema, in which case
 *   the Description is also checked against it.
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

/** The schema, when named, is parsed once here, at the entry point, and the query checked against it. */
export const queryFromDescription = (
	description: unknown,
	schema: unknown
): Result.Result<QueryValue | OrderedValue, CompileError> =>
	Result.flatMap(fromQueryDescription(description), (desc) =>
		schema === undefined
			? queryFromDesc(desc, undefined)
			: Result.flatMap(
					Result.flatMap(Result.flatMap(parseSchemaInput(schema), checkedInput), (checked) =>
						checkQuery(checked, desc, {
							read: "rows",
							meter: new BudgetMeter(compileBudgets),
							label: "query"
						})
					),
					() => queryFromDesc(desc, schema)
				)
	)

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
		budgets: compileBudgets,
		read: "rows"
	})
	if (!template.ok) {
		return template
	}
	return Result.ok(
		Object.freeze({ statements: Object.freeze(template.value.optimized.map((s) => s.sql)) })
	)
}
