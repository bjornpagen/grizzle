import { Array as Arr, Effect, Schema, Struct } from "effect"
import type { Gen, Size } from "#gen.ts"

/**
 * One command of a state machine, judged by its model alone: whether it applies in a model's state, the parameters it
 * draws there, and the state the model predicts after it. All three are pure, so a whole program is generated, printed,
 * enumerated and shrunk without touching the system under test, and every program drawn is a sequence of actions the
 * model allows.
 */
export type Command<M, P> = Readonly<{
	applies: (model: M) => boolean
	parameters: (model: M) => Gen<P>
	next: (model: M, parameters: P) => M
}>

/** A state machine: the model's initial state and its commands, each named, with the parameters each takes. */
export type Machine<M, P> = Readonly<{
	initial: M
	commands: { readonly [K in keyof P]: Command<M, P[K]> }
}>

type StepOf<P> = { readonly [K in keyof P]: Readonly<{ command: K; parameters: P[K] }> }

/** One step of a program: a command by name and the parameters it was drawn with. */
export type Step<P> = StepOf<P>[keyof P]

/**
 * A program of a state machine: plain data that prints as the literal a kept case writes,
 * `[{ command: "push", parameters: 3 }, { command: "pop", parameters: undefined }]`.
 */
export type Program<P> = ReadonlyArray<Step<P>>

/**
 * How each command runs on the real system: given its parameters and the model's states before and after it, it acts
 * and checks the system against the state the model predicts. It is supplied when the program runs, so it can close
 * over the scoped resources the property set up.
 */
export type Real<M, P, E, R> = {
	readonly [K in keyof P]: (parameters: P[K], before: M, after: M) => Effect.Effect<void, E, R>
}

/** A program's step names a command its model does not allow there: a kept program that drifted from its machine. */
export class StepInapplicable extends Schema.TaggedError<
	StepInapplicable,
	{ readonly brand: unique symbol }
>()("StepInapplicable", { at: Schema.Finite, command: Schema.String, message: Schema.String }) {}

/**
 * Programs of between `size.min` and `size.max` steps. Each step picks a command among all of the machine's, in the
 * order it declares them, so one decision names the same command in every state and shrinking can move a step past
 * its neighbour; a pick that does not apply in the model's state picks again among the commands that do, so every
 * allowed command is equally likely. The step then draws its parameters in that state and advances the model, and the
 * program ends early where no command applies. Each step is its own span, so shrinking deletes and reorders steps, and
 * the steps after an edit are drawn again in the state it leaves, so a shrunk program is still one the model allows.
 */
export const program =
	<M, P>(machine: Machine<M, P>, size: Size): Gen<Program<P>> =>
	(source) => {
		const names = Struct.keys(machine.commands)
		const drawStep = <K extends keyof P>(command: K, model: M): StepOf<P>[K] => ({
			command,
			parameters: source.draw(machine.commands[command].parameters(model))
		})
		source.open("array")
		const length = source.choose(size.min, size.max)
		const steps: Array<Step<P>> = []
		let model = machine.initial
		for (let index = 0; index < length; index += 1) {
			const applicable = Arr.filter(names, (name) => machine.commands[name].applies(model))
			if (!Arr.isReadonlyArrayNonEmpty(applicable)) {
				break
			}
			source.open("element")
			const named = Arr.getUnsafe(names, source.choose(0, names.length - 1))
			const step = drawStep(
				machine.commands[named].applies(model)
					? named
					: Arr.getUnsafe(applicable, source.choose(0, applicable.length - 1)),
				model
			)
			model = advance(machine, model, step.command, step.parameters)
			steps.push(step)
			source.close()
		}
		source.close()
		return steps
	}

/** The model's state after a command runs with its parameters. */
const advance = <M, P, K extends keyof P>(
	machine: Machine<M, P>,
	model: M,
	command: K,
	parameters: P[K]
): M => machine.commands[command].next(model, parameters)

/**
 * Runs a program on the real system, step by step: each step's command must apply in the model's state, its real run
 * checks the system against the state the model predicts, and the model advances. It succeeds with the model's final
 * state, and fails with the first step whose run fails, or with `StepInapplicable` for a kept program that names a
 * command the model no longer allows.
 */
export const runProgram = Effect.fn("testing.commands.run")(function* <M, P, E, R>(
	machine: Machine<M, P>,
	real: Real<M, P, E, R>,
	steps: Program<P>
) {
	const runStep = <K extends keyof P>(command: K, parameters: P[K], before: M, after: M) =>
		real[command](parameters, before, after)
	let model = machine.initial
	for (let at = 0; at < steps.length; at += 1) {
		const { command, parameters } = Arr.getUnsafe(steps, at)
		if (!machine.commands[command].applies(model)) {
			return yield* StepInapplicable.make({
				at,
				command: String(command),
				message: `step ${at} runs ${String(command)}, which the model does not allow in its state there`
			})
		}
		const after = advance(machine, model, command, parameters)
		yield* runStep(command, parameters, model, after)
		model = after
	}
	return model
})
