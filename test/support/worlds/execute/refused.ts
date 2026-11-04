import { Data, Effect } from "effect"
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"

/** The refusal grizzle raised building a value of an installation: a relation, a law, a role, a login or a query. */
export class RealizeRefused extends Data.TaggedError("RealizeRefused")<{
	readonly what: string
	readonly refusal: CompileError
}> {}

/** A builder threw something other than a CompileError: a defect of the run, carried until it is raised as one. */
export class Thrown extends Data.TaggedError("Thrown")<{ readonly cause: unknown }> {}

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
				isCompileError(cause) ? new RealizeRefused({ what, refusal: cause }) : new Thrown({ cause })
		}),
		"Thrown",
		(thrown) => Effect.die(thrown.cause)
	)
