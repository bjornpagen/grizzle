import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Inspectable, Layer, Option, Schema } from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import { type Repository, RepositoryLive } from "#shared/repository.ts"

const isDevtoolFailure = Schema.is(DevtoolFailure)

/** A dev tool failure prints its detail and cause; any other cause prints in full. */
const failureText = <E>(cause: Cause.Cause<E>): string =>
	Option.match(Option.filter(Cause.findErrorOption(cause), isDevtoolFailure), {
		onNone: () => Cause.pretty(cause),
		onSome: (failure) =>
			failure.cause === undefined
				? failure.detail
				: `${failure.detail}\n${Inspectable.toStringUnknown(failure.cause)}`
	})

/** Every service a dev tool runs on: Effect's Node platform, and the repository derived from it. */
const DEVTOOL_LAYER = Layer.provideMerge(RepositoryLive, NodeServices.layer)

/**
 * Runs a dev tool's program, which answers its exit status: 0 when it found nothing, 1 when it found something, or
 * whatever status a tool it launched answered. Every failure of the tool itself, a defect or an interruption
 * included, prints and exits 2, so 1 always means findings. It is every dev tool's entry point, the one place their
 * layers are provided: Effect's Node platform services, which are unstable, and so is it, and the repository.
 *
 * @stability unstable
 */
export const runDevtool = <E>(
	main: Effect.Effect<number, E, NodeServices.NodeServices | Repository>
): void => {
	const program = main.pipe(
		Effect.catchCause((cause) => Effect.as(Console.error(failureText(cause)), 2)),
		Effect.flatMap((status) =>
			Effect.sync(() => {
				process.exitCode = status
			})
		)
	)
	NodeRuntime.runMain(program.pipe(Effect.provide(DEVTOOL_LAYER)))
}
