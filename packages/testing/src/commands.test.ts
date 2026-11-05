import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Order,
	Schema,
	Struct
} from "effect"
import { fraction, plus, shareOf, everyCase, type Fraction } from "#chance.fixtures.ts"
import {
	type Answer,
	accepted,
	type Machine,
	type Program,
	program,
	type Real,
	refused,
	runProgram,
	StepInapplicable,
	type StepFeature,
	stepFeature,
	took,
	type Verdict
} from "#commands.ts"
import { drawn, exhaust, explore, Run } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import { constant, element, type Gen, int, subarray, type Weight } from "#gen.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { forcedChooser, generate } from "#source.ts"
import { fullSwarm, type Presence, type Swarm, swarm } from "#swarm.ts"
import { runOfTest } from "#vitest/run.ts"
import { searched } from "#vitest/searched.ts"

type Queue = ReadonlyArray<number>

type QueueParameters = Readonly<{ push: number; pop: undefined; size: undefined; peek: number }>

type QueueCommand = keyof QueueParameters

/** What a bounded queue refuses: a push when it is full, a pop when it is empty. */
type QueueRefusal = "full" | "empty"

const CAPACITY = 3

const COMMANDS: Arr.NonEmptyReadonlyArray<QueueCommand> = ["push", "pop", "size", "peek"]

/**
 * A bounded FIFO queue as its model judges it, every command at the weights given: a push to a full queue and a pop
 * of an empty one are refused, named, and drawn like any other step; a peek names a position the queue holds, which is
 * the harness's own invariant, since no position past the end can be written down.
 */
const queueOf = (
	weights: Readonly<Record<QueueCommand, Weight>>,
	values: Gen<number>
): Machine<Queue, QueueParameters, QueueRefusal> => ({
	initial: [],
	commands: {
		push: {
			weight: weights.push,
			applies: () => true,
			parameters: () => values,
			judge: (queue, value) =>
				queue.length < CAPACITY ? accepted(Arr.append(queue, value)) : refused("full")
		},
		pop: {
			weight: weights.pop,
			applies: () => true,
			parameters: () => constant(undefined),
			judge: (queue) => (queue.length > 0 ? accepted(Arr.drop(queue, 1)) : refused("empty"))
		},
		size: {
			weight: weights.size,
			applies: () => true,
			parameters: () => constant(undefined),
			judge: (queue) => accepted(queue)
		},
		peek: {
			weight: weights.peek,
			applies: (queue) => queue.length > 0,
			parameters: (queue) => int(0, queue.length - 1),
			judge: (queue) => accepted(queue)
		}
	}
})

const EVEN: Readonly<Record<QueueCommand, Weight>> = { push: 1, pop: 1, size: 1, peek: 1 }

/** The weights a command's weight is drawn from in the weights property: small, so their totals stay small. */
const WEIGHTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

const QUEUE = queueOf(EVEN, int(0, 9))

/** How a ring buffer can be wrong: not at all, wrapping its reads at the wrong place, or overwriting when full. */
type Fault = "none" | "short read wrap" | "overwrites when full"

/** A ring buffer, the system under test, wrong as `fault` says. */
const ringBuffer = (fault: Fault) => {
	const slots = new Float64Array(CAPACITY)
	const readWrap = fault === "short read wrap" ? CAPACITY - 1 : CAPACITY
	let head = 0
	let tail = 0
	let size = 0
	return {
		push: (value: number): boolean => {
			if (size === CAPACITY && fault !== "overwrites when full") {
				return false
			}
			slots[tail] = value
			tail = (tail + 1) % CAPACITY
			size = Math.min(CAPACITY, size + 1)
			return true
		},
		pop: (): Option.Option<number> => {
			if (size === 0) {
				return Option.none()
			}
			const value = slots[head] ?? 0
			head = (head + 1) % readWrap
			size -= 1
			return Option.some(value)
		},
		peek: (at: number): number => slots[(head + at) % CAPACITY] ?? 0,
		size: () => size
	}
}

/** The queue's state the verdict claims after a step from `before`. */
const claimed = (before: Queue, verdict: Verdict<Queue, QueueRefusal>): Queue =>
	verdict.kind === "accepted" ? verdict.next : before

/** Each command run on a ring buffer: it answers what the buffer did, and checks it against the queue claimed. */
const realOf = (
	buffer: ReturnType<typeof ringBuffer>
): Real<Queue, QueueParameters, QueueRefusal, never, never> => ({
	push: (value, _before, after) =>
		Effect.sync((): Answer<QueueRefusal> => {
			const tookIt = buffer.push(value)
			strictEqual(buffer.size(), after.length)
			return tookIt ? took : refused("full")
		}),
	pop: (_parameters, before) =>
		Effect.sync((): Answer<QueueRefusal> => {
			const popped = buffer.pop()
			if (Option.isNone(popped)) {
				return refused("empty")
			}
			deepStrictEqual(popped, Arr.head(before))
			return took
		}),
	size: (_parameters, before) =>
		Effect.sync((): Answer<QueueRefusal> => {
			strictEqual(buffer.size(), before.length)
			return took
		}),
	peek: (at, before) =>
		Effect.sync((): Answer<QueueRefusal> => {
			deepStrictEqual(Option.some(buffer.peek(at)), Arr.get(before, at))
			return took
		})
})

/** A program over a swarm of the queue's commands, the swarm drawn with it. */
const swarmed =
	(
		machine: Machine<Queue, QueueParameters, QueueRefusal>,
		size: Readonly<{ min: number; max: number }>
	): Gen<Readonly<{ mix: Swarm<QueueCommand>; steps: Program<QueueParameters> }>> =>
	(source) => {
		const mix = source.draw(swarm(COMMANDS))
		return { mix, steps: source.draw(program(machine, size, mix)) }
	}

/**
 * The verdicts of a program, judged by folding its machine's own judge over its steps: the second implementation
 * `runProgram`'s answers and final state are checked against.
 */
const foldOf = (
	machine: Machine<Queue, QueueParameters, QueueRefusal>,
	steps: Program<QueueParameters>
): Folded =>
	Arr.reduce(
		steps,
		{ model: machine.initial, verdicts: [] },
		({ model, verdicts }: Folded, step): Folded => {
			const verdict = verdictOf(machine, model, step)
			return { model: claimed(model, verdict), verdicts: Arr.append(verdicts, verdict) }
		}
	)

/** A program's final state and its steps' verdicts, by the fold. */
type Folded = Readonly<{ model: Queue; verdicts: ReadonlyArray<Verdict<Queue, QueueRefusal>> }>

const verdictOf = (
	machine: Machine<Queue, QueueParameters, QueueRefusal>,
	model: Queue,
	step: Program<QueueParameters>[number]
): Verdict<Queue, QueueRefusal> => {
	switch (step.command) {
		case "push":
			return machine.commands.push.judge(model, step.parameters)
		case "pop":
			return machine.commands.pop.judge(model, step.parameters)
		case "size":
			return machine.commands.size.judge(model, step.parameters)
		case "peek":
			return machine.commands.peek.judge(model, step.parameters)
	}
}

/** The answer a verdict predicts, and the other answer a lying system gives instead. */
const answerOf = (verdict: Verdict<Queue, QueueRefusal>): Answer<QueueRefusal> =>
	verdict.kind === "accepted" ? took : verdict

const lieAbout = (verdict: Verdict<Queue, QueueRefusal>): Answer<QueueRefusal> =>
	verdict.kind === "accepted" ? refused("full") : took

/** How many programs of at most `steps` steps the harness can write from `model`: each step one it can name there. */
const writable = (
	machine: Machine<Queue, QueueParameters, QueueRefusal>,
	values: number,
	model: Queue,
	steps: number
): number => {
	if (steps === 0) {
		return 1
	}
	const pushes = Arr.map(Arr.range(0, values - 1), (value): Program<QueueParameters>[number] => ({
		command: "push",
		parameters: value
	}))
	const peeks = Arr.map(Arr.fromIterable(model.keys()), (at): Program<QueueParameters>[number] => ({
		command: "peek",
		parameters: at
	}))
	const next: ReadonlyArray<Program<QueueParameters>[number]> = [
		...pushes,
		{ command: "pop", parameters: undefined },
		{ command: "size", parameters: undefined },
		...peeks
	]
	return (
		1 +
		Arr.reduce(
			next,
			0,
			(sum, step) =>
				sum + writable(machine, values, claimed(model, verdictOf(machine, model, step)), steps - 1)
		)
	)
}

const STEP_FEATURES: Arr.NonEmptyReadonlyArray<StepFeature<QueueParameters, QueueRefusal>> = [
	"push accepted",
	"push refused full",
	"pop accepted",
	"pop refused empty",
	"size accepted",
	"peek accepted"
]

describe("a state machine", () => {
	it.effect(
		"draws every program its harness can write, each step one the model accepts or refuses, in a box of 3 steps",
		(ctx) =>
			Effect.gen(function* () {
				const twoValued = queueOf(EVEN, int(0, 1))
				const programs = new Set<string>()
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "writable programs",
							generator: program(twoValued, { min: 0, max: 3 }, fullSwarm(COMMANDS)),
							literal: Formatter.format,
							limit: 2000,
							coverage: noCoverage,
							caseHang: Duration.minutes(1)
						},
						(steps) =>
							Effect.sync(() => {
								programs.add(Formatter.format(steps))
							})
					)
				)
				strictEqual(programs.size, writable(twoValued, 2, twoValued.initial, 3))
			})
	)

	it.effect(
		"answers every step as the system did, and fails at the first step the system answers otherwise than its model",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "verdicts",
						draw: drawn(swarmed(QUEUE, { min: 0, max: 8 })),
						literal: Formatter.format,
						coverage: required<"agrees" | "diverges">(["agrees", "diverges"], {
							cases: 100,
							sense: notesOnly
						}),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					({ steps }, c) =>
						Effect.gen(function* () {
							const lies: ReadonlySet<number> = new Set(
								c.draw(subarray(Arr.fromIterable(steps.keys())))
							)
							const folded = foldOf(QUEUE, steps)
							const answers = Arr.map(folded.verdicts, (verdict, at) =>
								lies.has(at) ? lieAbout(verdict) : answerOf(verdict)
							)
							let at = 0
							const answer = (): Effect.Effect<Answer<QueueRefusal>> =>
								Effect.sync(() => {
									const given = Arr.getUnsafe(answers, at)
									at += 1
									return given
								})
							const liar: Real<Queue, QueueParameters, QueueRefusal, never, never> = {
								push: answer,
								pop: answer,
								size: answer,
								peek: answer
							}
							const exit = yield* Effect.exit(runProgram(QUEUE, liar, steps))
							const firstLie = Arr.head(Arr.sort(Arr.fromIterable(lies), Order.Number))
							if (Option.isSome(firstLie)) {
								c.note("diverges")
								const failed = Exit.findErrorOption(exit)
								assertTrue(Option.isSome(failed), "a lie fails the run")
								const step = Arr.getUnsafe(steps, firstLie.value)
								const verdict = Arr.getUnsafe(folded.verdicts, firstLie.value)
								deepStrictEqual(
									Option.map(failed, (error) =>
										error._tag === "VerdictDiverged"
											? [error.at, error.command, error.predicted, error.answered]
											: [error._tag]
									),
									Option.some([
										firstLie.value,
										step.command,
										stepFeature<QueueParameters, QueueRefusal>(step.command, answerOf(verdict)),
										stepFeature<QueueParameters, QueueRefusal>(step.command, lieAbout(verdict))
									])
								)
							} else {
								c.note("agrees")
								deepStrictEqual(
									exit,
									Exit.succeed({
										model: folded.model,
										verdicts: Arr.map(steps, (step, index) =>
											stepFeature<QueueParameters, QueueRefusal>(
												step.command,
												answerOf(Arr.getUnsafe(folded.verdicts, index))
											)
										)
									})
								)
							}
						})
				)
			)
	)

	it.effect(
		"checks a correct system against its model on every program, its refusals included",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "ring buffer",
						draw: drawn(swarmed(QUEUE, { min: 0, max: 12 })),
						literal: Formatter.format,
						coverage: required(STEP_FEATURES, { cases: 400, sense: notesOnly }),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					({ steps }, c) =>
						Effect.gen(function* () {
							const ran = yield* runProgram(QUEUE, realOf(ringBuffer("none")), steps)
							c.noteAll(ran.verdicts)
						})
				)
			)
	)

	it.effect(
		"draws each command as often as its weight times its presence, a pick it cannot write drawn again among those it can",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "command weights",
						draw: drawn((source) => ({
							weights: {
								push: source.draw(element(WEIGHTS)),
								pop: source.draw(element(WEIGHTS)),
								size: source.draw(element(WEIGHTS)),
								peek: source.draw(element(WEIGHTS))
							},
							mix: source.draw(swarm(COMMANDS))
						})),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					({ weights, mix }) =>
						Effect.sync(() => {
							const machine = queueOf(weights, int(0, 1))
							const cases = everyCase(program(machine, { min: 1, max: 1 }, mix))
							const effective = (command: QueueCommand) =>
								BigInt(weights[command] * presenceOf(mix, command))
							const total = Arr.reduce(COMMANDS, 0n, (sum, command) => sum + effective(command))
							const writableFirst = Arr.filter(COMMANDS, (command) => command !== "peek")
							const writableTotal = Arr.reduce(
								writableFirst,
								0n,
								(sum, command) => sum + effective(command)
							)
							const expected = (command: QueueCommand): Fraction =>
								command === "peek" || writableTotal === 0n
									? fraction(0n, 1n)
									: plus(
											fraction(effective(command), total),
											fraction(effective("peek") * effective(command), total * writableTotal)
										)
							deepStrictEqual(
								Arr.map(Struct.keys(EVEN), (command) =>
									shareOf(cases, (steps) => Arr.some(steps, (step) => step.command === command))
								),
								Arr.map(Struct.keys(EVEN), expected)
							)
						})
				)
			)
	)

	it.effect(
		"shrinks a failing program to the fewest steps that break it, keeping the refused step the failure needs",
		(ctx) =>
			Effect.gen(function* () {
				const shrunkOf = (fault: Fault) =>
					Effect.gen(function* () {
						const generator = swarmed(QUEUE, { min: 0, max: 12 })
						const failed = yield* Effect.flip(
							explore(
								{
									suite: `ring buffer that ${fault}`,
									draw: drawn(generator),
									literal: Formatter.format,
									coverage: noCoverage,
									kept: [],
									runs: 400,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang: Duration.minutes(1)
								},
								({ steps }) => runProgram(QUEUE, realOf(ringBuffer(fault)), steps)
							)
						)
						assertTrue(
							failed._tag === "PropertyFalsified",
							`${failed._tag} is a falsified property`
						)
						const values = Option.getOrThrow(failed.replay).values
						return generate(generator, forcedChooser(Float64Array.from(values), values.length))
							.value.steps
					}).pipe(Effect.provideServiceEffect(Run, runOfTest(ctx)))
				const overwriting = yield* shrunkOf("overwrites when full")
				const wrapping = yield* shrunkOf("short read wrap")
				deepStrictEqual(overwriting, [
					{ command: "push", parameters: 0 },
					{ command: "push", parameters: 0 },
					{ command: "push", parameters: 0 },
					{ command: "push", parameters: 0 }
				])
				deepStrictEqual(wrapping, [
					{ command: "push", parameters: 0 },
					{ command: "push", parameters: 0 },
					{ command: "push", parameters: 1 },
					{ command: "pop", parameters: undefined },
					{ command: "pop", parameters: undefined },
					{ command: "pop", parameters: undefined }
				])
			})
	)

	it.effect("refuses a kept program whose step its harness cannot write", () =>
		Effect.gen(function* () {
			const refusedRun = yield* Effect.flip(
				runProgram(QUEUE, realOf(ringBuffer("none")), [{ command: "peek", parameters: 0 }])
			)
			deepStrictEqual(
				Schema.is(StepInapplicable)(refusedRun) ? [refusedRun.at, refusedRun.command] : [],
				[0, "peek"]
			)
		})
	)
})

/** A command's presence in a swarm, 0 when off. */
const presenceOf = (mix: Swarm<QueueCommand>, command: QueueCommand): 0 | Presence =>
	mix[command] ?? 0
