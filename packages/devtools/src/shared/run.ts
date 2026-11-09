import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Inspectable, Layer, Option, Predicate, Schema } from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import { type Repository, RepositoryLive } from "#shared/repository.ts"

const isDevtoolFailure = Schema.is(DevtoolFailure)

/** What a failure's cause prints: a thrown error's stack, which says where it was thrown, or any other value in full. */
const causeText = (cause: unknown): string =>
	Predicate.isError(cause) && cause.stack !== undefined
		? cause.stack
		: Inspectable.toStringUnknown(cause)

/** A dev tool failure prints its detail and cause; any other cause prints in full. */
const failureText = <E>(cause: Cause.Cause<E>): string =>
	Option.match(Option.filter(Cause.findErrorOption(cause), isDevtoolFailure), {
		onNone: () => Cause.pretty(cause),
		onSome: (failure) =>
			failure.cause === undefined
				? failure.detail
				: `${failure.detail}\n${causeText(failure.cause)}`
	})

/** Every service a dev tool runs on: Effect's Node platform, and the repository derived from it. */
const DEVTOOL_LAYER = Layer.provideMerge(RepositoryLive, NodeServices.layer)

/** What an interrupted tool says, since an interruption stops it before it has anything to report. */
const INTERRUPTED =
	"Interrupted by SIGINT or SIGTERM before it finished, so it reports nothing: under turbo, the run cancels every running task once one fails, and that task's error is the one to read."

/**
 * Runs a dev tool's program, which answers its exit status: 0 when it found nothing, 1 when it found something, or
 * whatever status a tool it launched answered. Every failure of the tool itself, a defect included, prints and exits 2,
 * so 1 always means findings. A SIGINT or SIGTERM interrupts the program (Effect's runMain), which prints that it was
 * interrupted and exits 130. It is every dev tool's entry point, the one place their layers are provided: Effect's Node
 * platform services, which are unstable, and so is it, and the repository.
 *
 * @stability unstable
 */
export const runDevtool = <E>(
	main: Effect.Effect<number, E, NodeServices.NodeServices | Repository>
): void => {
	const program = main.pipe(
		Effect.catchCause((cause) => Effect.as(Console.error(failureText(cause)), 2)),
		Effect.onInterrupt(() => Console.error(INTERRUPTED)),
		Effect.flatMap((status) =>
			Effect.sync(() => {
				process.exitCode = status
			})
		)
	)
	NodeRuntime.runMain(program.pipe(Effect.provide(DEVTOOL_LAYER)))
}
