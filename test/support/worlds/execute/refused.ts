import { Effect, Schema } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import type { GrizzleErrorTag } from "#test/support/error-tags.ts"

/** The tag a CompileError carries among grizzle's errors. */
const compileErrorTag: GrizzleErrorTag = "CompileError"

/** A CompileError, recognized as the adapter recognizes one (adapter/errors/execution.ts). */
const CompileErrorSchema = Schema.declare(isCompileError, { expected: compileErrorTag })

/** The refusal grizzle raised building a value of an installation: a relation, a law, a role, a login or a query. */
export class RealizeRefused extends Schema.TaggedError<
	RealizeRefused,
	{ readonly brand: unique symbol }
>()("RealizeRefused", {
	what: Schema.String,
	refusal: CompileErrorSchema
}) {}

/** A builder threw something other than a CompileError: a defect of the run, carried until it is raised as one. */
export class Thrown extends Schema.TaggedError<Thrown, { readonly brand: unique symbol }>()(
	"Thrown",
	{
		cause: Schema.Unknown
	}
) {}

/**
 * Runs one builder call: a CompileError it throws is the installation's refusal, anything else a defect. The values
 * of an installation are known only at run time, so they are built on the builders' runtime path, the admission the
 * typed public builders run (`role`, `login` and `derived` of the schema modules, `alternatives` of the statements,
 * `regexField` of the text field), which a JavaScript caller's arguments meet.
 */
export const attempt = <A>(what: string, build: () => A): Effect.Effect<A, RealizeRefused> =>
	Effect.catchTag(
		Effect.try({
			try: build,
			catch: (cause) =>
				isCompileError(cause)
					? RealizeRefused.make({ what, refusal: cause })
					: Thrown.make({ cause })
		}),
		"Thrown",
		(thrown) => Effect.die(thrown.cause)
	)
