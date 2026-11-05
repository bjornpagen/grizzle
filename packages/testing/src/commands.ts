import { Array as Arr, Effect, Schema, Struct } from "effect"
import type { Gen, Size, Weight } from "#gen.ts"
import type { Source } from "#source.ts"
import { type Swarm, weightOf } from "#swarm.ts"

/** The model accepts a step, and predicts the state the system enters after it. */
export type Accepted<M> = Readonly<{ kind: "accepted"; next: M }>

/** The model refuses a step, by a refusal of its own closed vocabulary, and the system must refuse it the same way. */
export type Refused<V extends string> = Readonly<{ kind: "refused"; refusal: V }>

/**
 * What a model predicts of one step: accepted, with the state after it, or refused, with the refusal the system must
 * answer. A refused step leaves the model's state as it was, and the system's must stay as it was too.
 */
export type Verdict<M, V extends string> = Accepted<M> | Refused<V>

/** The system accepted a step: what a real step answers when it took it. */
export type Took = Readonly<{ kind: "accepted" }>

/** What the real system answered one step: it took it, or refused it with a refusal of the model's vocabulary. */
export type Answer<V extends string> = Took | Refused<V>

/** The model accepts the step and predicts `next`. */
export const accepted = <M>(next: M): Accepted<M> => ({ kind: "accepted", next })

/** The model refuses the step, or the system answered it, by `refusal`. */
export const refused = <V extends string>(refusal: V): Refused<V> => ({ kind: "refused", refusal })

/** The answer of a real step the system took. */
export const took: Took = { kind: "accepted" }

/** The judge of a command its model never refuses: every step accepted, with the state `next` predicts after it. */
export const accepting =
	<M, P>(next: (model: M, parameters: P) => M) =>
	(model: M, parameters: P): Accepted<M> =>
		accepted(next(model, parameters))

/**
 * One command of a state machine, judged by its model alone:
 * - `weight` is how often a program draws it, against the other commands its swarm turns on;
 * - `applies` is the harness's own invariant, whether the step can be written in a model's state at all (a handle it
 *   never made cannot be named), and never what the system is expected to refuse, which `judge` says;
 * - `parameters` draws its parameters in a model's state, valid ones and the named invalid ones alike;
 * - `judge` is the model's verdict on the step: accepted with the state after it, or refused with its refusal.
 *
 * All are pure, so a whole program is generated, printed, enumerated and shrunk without touching the system under
 * test, and a program draws steps the model refuses as readily as steps it accepts: those are the cases to try.
 */
export type Command<M, P, V extends string> = Readonly<{
	weight: Weight
	applies: (model: M) => boolean
	parameters: (model: M) => Gen<P>
	judge: (model: M, parameters: P) => Verdict<M, V>
}>

/**
 * A state machine: the model's initial state and its commands, each named, with the parameters each takes and the
 * closed vocabulary `V` its refusals are named from (`never` for a machine that refuses nothing).
 */
export type Machine<M, P, V extends string> = Readonly<{
	initial: M
	commands: { readonly [K in keyof P]: Command<M, P[K], V> }
}>

/** A command's name. */
export type CommandName<P> = keyof P & string

type StepOf<P> = { readonly [K in CommandName<P>]: Readonly<{ command: K; parameters: P[K] }> }

/** One step of a program: a command by name and the parameters it was drawn with. */
export type Step<P> = StepOf<P>[CommandName<P>]

/**
 * A program of a state machine: plain data that prints as the literal a kept case writes,
 * `[{ command: "push", parameters: 3 }, { command: "pop", parameters: undefined }]`.
 */
export type Program<P> = ReadonlyArray<Step<P>>

/**
 * How each command runs on the real system: given its parameters, the model's state before it, the state the model
 * claims after it (the verdict's `next` when accepted, the state before it when refused) and the verdict itself, it
 * acts, checks that the system entered the claimed state, and answers what the system did: `took`, or `refused` with
 * the refusal the system's own error names. It is supplied when the program runs, so it can close over the scoped
 * resources the property set up.
 */
export type Real<M, P, V extends string, E, R> = {
	readonly [K in keyof P]: (
		parameters: P[K],
		before: M,
		after: M,
		verdict: Verdict<M, V>
	) => Effect.Effect<Answer<V>, E, R>
}

/** A program's step names a command its model does not allow there: a kept program that drifted from its machine. */
export class StepInapplicable extends Schema.TaggedError<
	StepInapplicable,
	{ readonly brand: unique symbol }
>()("StepInapplicable", { at: Schema.Finite, command: Schema.String, message: Schema.String }) {}

/**
 * The system answered a step otherwise than its model predicted: it took a step the model refuses, refused one the
 * model accepts, or refused by another refusal. `predicted` and `answered` are the step's features (`StepFeature`).
 */
export class VerdictDiverged extends Schema.TaggedError<
	VerdictDiverged,
	{ readonly brand: unique symbol }
>()("VerdictDiverged", {
	at: Schema.Finite,
	command: Schema.String,
	predicted: Schema.String,
	answered: Schema.String,
	message: Schema.String
}) {}

/** A step as a feature: its command and the verdict it met, `"push accepted"` or `"pop refused empty"`. */
export type StepFeature<P, V extends string> =
	| `${CommandName<P>} accepted`
	| `${CommandName<P>} refused ${V}`

/** The feature of a step that met `answer`. */
export const stepFeature = <P, V extends string>(
	command: CommandName<P>,
	answer: Answer<V>
): StepFeature<P, V> => {
	switch (answer.kind) {
		case "accepted":
			return `${command} accepted`
		case "refused":
			return `${command} refused ${answer.refusal}`
	}
}

/** The answer a verdict predicts: what the system must answer the step. */
const answerOf = <M, V extends string>(verdict: Verdict<M, V>): Answer<V> => {
	switch (verdict.kind) {
		case "accepted":
			return took
		case "refused":
			return verdict
	}
}

/** The model's state after a step it judged: the verdict's next state, or the state before it when refused. */
const claimedAfter = <M, V extends string>(before: M, verdict: Verdict<M, V>): M => {
	switch (verdict.kind) {
		case "accepted":
			return verdict.next
		case "refused":
			return before
	}
}

/** The greatest common divisor of two whole numbers. */
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * One of weighted commands, drawn in proportion to their weights, in the order given: each owns the next share of a
 * pick below the total, its weight over the weights' greatest common divisor, so commands of equal weight draw from as
 * many values as there are commands, and an enumeration meets no two values that name the same command for the same
 * reason. One command with weight is no choice and draws nothing.
 */
const pickOf = <K>(
	source: Source,
	weighted: Arr.NonEmptyReadonlyArray<readonly [name: K, weight: number]>
): K => {
	if (weighted.length === 1) {
		return Arr.headNonEmpty(weighted)[0]
	}
	const divisor = Arr.reduce(weighted, 0, (common, [, weight]) => gcd(weight, common))
	let rest = source.pick(
		0,
		Arr.reduce(weighted, 0, (sum, [, weight]) => sum + weight / divisor) - 1
	)
	for (const [name, weight] of weighted) {
		if (rest < weight / divisor) {
			return name
		}
		rest -= weight / divisor
	}
	return Arr.lastNonEmpty(weighted)[0]
}

/**
 * Programs of between `size.min` and `size.max` steps over the commands `drawn` turns on, each as often as its weight
 * times its presence in the swarm: the caller draws the swarm (`swarm` over the commands' names), so each program
 * explores its own lopsided mix, or passes `fullSwarm` for every command at its weight. Each step picks a command
 * among those on, in the order the machine declares them, so one decision names the same command in every state and
 * shrinking can move a step past its neighbour; a pick that does not apply in the model's state picks again among
 * those on that do, by the same weights. The step then draws its parameters in that state and the model judges it,
 * accepted or refused, and the program ends early where no command on applies. Each step is its own span, so
 * shrinking deletes and reorders steps, and the steps after an edit are drawn again in the state it leaves, so a
 * shrunk program is still one whose every step its harness can write.
 */
export const program =
	<M, P, V extends string>(
		machine: Machine<M, P, V>,
		size: Size,
		drawn: Swarm<CommandName<P>>
	): Gen<Program<P>> =>
	(source) => {
		const names: ReadonlyArray<CommandName<P>> = Struct.keys(machine.commands)
		const on = Arr.flatMap(names, (name) => {
			const presence = weightOf(drawn, name)
			return presence > 0 ? [[name, machine.commands[name].weight * presence] as const] : []
		})
		const drawStep = <K extends CommandName<P>>(command: K, model: M): StepOf<P>[K] => ({
			command,
			parameters: source.draw(machine.commands[command].parameters(model))
		})
		source.open("array")
		const length = source.choose(size.min, size.max)
		const steps: Array<Step<P>> = []
		if (Arr.isReadonlyArrayNonEmpty(on)) {
			let model = machine.initial
			for (let index = 0; index < length; index += 1) {
				const applicable = Arr.filter(on, ([name]) => machine.commands[name].applies(model))
				if (!Arr.isReadonlyArrayNonEmpty(applicable)) {
					break
				}
				source.open("element")
				const named = pickOf(source, on)
				const step = drawStep(
					machine.commands[named].applies(model) ? named : pickOf(source, applicable),
					model
				)
				model = claimedAfter(model, judgeStep(machine, model, step.command, step.parameters))
				steps.push(step)
				source.close()
			}
		}
		source.close()
		return steps
	}

/** The model's verdict on a command run with its parameters. */
const judgeStep = <M, P, V extends string, K extends CommandName<P>>(
	machine: Machine<M, P, V>,
	model: M,
	command: K,
	parameters: P[K]
): Verdict<M, V> => machine.commands[command].judge(model, parameters)

/** A program's run: the model's final state, and each step's feature in order, as the system answered it. */
export type Ran<M, P, V extends string> = Readonly<{
	model: M
	verdicts: ReadonlyArray<StepFeature<P, V>>
}>

/**
 * Runs a program on the real system, step by step: each step's command must apply in the model's state, the model
 * judges it, its real run checks the system against the state the verdict claims and answers what the system did,
 * which must be exactly the answer the verdict predicts, and the model advances, a refused step leaving it as it was.
 * It succeeds with the model's final state and every step's feature, for a property to note; it fails with the first
 * step whose run fails, with `VerdictDiverged` for the first step the system answered otherwise than its model, or
 * with `StepInapplicable` for a kept program that names a command its harness no longer allows.
 */
export const runProgram = Effect.fn("testing.commands.run")(function* <
	M,
	P,
	V extends string,
	E,
	R
>(machine: Machine<M, P, V>, real: Real<M, P, V, E, R>, steps: Program<P>) {
	const runStep = <K extends CommandName<P>>(
		command: K,
		parameters: P[K],
		before: M,
		verdict: Verdict<M, V>
	) => real[command](parameters, before, claimedAfter(before, verdict), verdict)
	let model = machine.initial
	const verdicts: Array<StepFeature<P, V>> = []
	for (let at = 0; at < steps.length; at += 1) {
		const { command, parameters } = Arr.getUnsafe(steps, at)
		if (!machine.commands[command].applies(model)) {
			return yield* StepInapplicable.make({
				at,
				command,
				message: `step ${at} runs ${command}, which the model does not allow in its state there`
			})
		}
		const verdict = judgeStep(machine, model, command, parameters)
		const answer = yield* runStep(command, parameters, model, verdict)
		const predicted = stepFeature<P, V>(command, answerOf(verdict))
		const answered = stepFeature<P, V>(command, answer)
		if (predicted !== answered) {
			return yield* VerdictDiverged.make({
				at,
				command,
				predicted,
				answered,
				message: `step ${at}: the model predicts ${predicted}, and the system answered ${answered}`
			})
		}
		verdicts.push(answered)
		model = claimedAfter(model, verdict)
	}
	const ran: Ran<M, P, V> = { model, verdicts }
	return ran
})
