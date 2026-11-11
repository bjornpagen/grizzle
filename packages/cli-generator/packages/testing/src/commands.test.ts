import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Exit, Formatter, Option } from "effect"
import {
	type Machine,
	type Program,
	program,
	type Real,
	runProgram,
	StepInapplicable
} from "#commands.ts"
import { drawn, exhaust, explore } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import { constant, int } from "#gen.ts"
import { wordsOf } from "#random.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink, shrink } from "#shrink.ts"
import { generate, randomChooser, recorder } from "#source.ts"
import { searched } from "#vitest/searched.ts"

type Queue = ReadonlyArray<number>

type QueueParameters = Readonly<{ push: number; pop: undefined; size: undefined }>

const CAPACITY = 3

/** A bounded FIFO queue as its model sees it. */
const QUEUE: Machine<Queue, QueueParameters> = {
	initial: [],
	commands: {
		push: {
			applies: (queue) => queue.length < CAPACITY,
			parameters: () => int(0, 9),
			next: (queue, value) => Arr.append(queue, value)
		},
		pop: {
			applies: (queue) => queue.length > 0,
			parameters: () => constant(undefined),
			next: (queue) => Arr.drop(queue, 1)
		},
		size: {
			applies: () => true,
			parameters: () => constant(undefined),
			next: (queue) => queue
		}
	}
}

/** A ring buffer, the system under test: its read position wraps at `readWrap`, which is its capacity when correct. */
const ringBuffer = (readWrap: number) => {
	const slots = new Float64Array(CAPACITY)
	let head = 0
	let tail = 0
	let size = 0
	return {
		push: (value: number) => {
			slots[tail] = value
			tail = (tail + 1) % CAPACITY
			size += 1
		},
		pop: () => {
			const value = slots[head] ?? 0
			head = (head + 1) % readWrap
			size -= 1
			return value
		},
		size: () => size
	}
}

/** Each command run on a ring buffer and checked against the queue the model predicts. */
const realOf = (
	buffer: ReturnType<typeof ringBuffer>
): Real<Queue, QueueParameters, never, never> => ({
	push: (value) => Effect.sync(() => buffer.push(value)),
	pop: (_parameters, before) =>
		Effect.sync(() => deepStrictEqual(Option.some(buffer.pop()), Arr.head(before))),
	size: (_parameters, before) => Effect.sync(() => strictEqual(buffer.size(), before.length))
})

/** Every command run on nothing: a program's model alone. */
const modelOnly: Real<Queue, QueueParameters, never, never> = {
	push: () => Effect.void,
	pop: () => Effect.void,
	size: () => Effect.void
}

/** Whether a program fails on a fresh ring buffer that wraps its reads at `readWrap`. */
const failsOn = (readWrap: number) => (steps: Program<QueueParameters>) =>
	Effect.map(Effect.exit(runProgram(QUEUE, realOf(ringBuffer(readWrap)), steps)), Exit.isFailure)

describe("a state machine", () => {
	it.effect("draws only programs its model allows, every one of them", (ctx) =>
		Effect.gen(function* () {
			const programs = new Set<string>()
			const twoValued: Machine<Queue, QueueParameters> = {
				...QUEUE,
				commands: {
					...QUEUE.commands,
					push: { ...QUEUE.commands.push, parameters: () => int(0, 1) }
				}
			}
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "allowed programs",
						generator: program(twoValued, { min: 0, max: 3 }),
						literal: Formatter.format,
						limit: 1000,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(steps) =>
						runProgram(twoValued, modelOnly, steps).pipe(
							Effect.tap(() => Effect.sync(() => programs.add(Formatter.format(steps))))
						)
				)
			)
			strictEqual(programs.size, 1 + 3 + 11 + 41)
		})
	)

	it.effect("checks a correct system against its model on every program", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "ring buffer",
					draw: drawn(program(QUEUE, { min: 0, max: 12 })),
					literal: Formatter.format,
					coverage: required<"push" | "pop" | "size" | "full">(["push", "pop", "size", "full"], {
						cases: 200,
						sense: notesOnly
					}),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(steps, c) =>
					Effect.gen(function* () {
						c.noteAll(Arr.map(steps, (step) => step.command))
						const final = yield* runProgram(QUEUE, realOf(ringBuffer(CAPACITY)), steps)
						if (final.length === CAPACITY) {
							c.note("full")
						}
					})
			)
		)
	)

	it.effect(
		"shrinks a failing program to the simplest that wraps the reads: fill, then drain",
		() =>
			Effect.gen(function* () {
				const generator = program(QUEUE, { min: 0, max: 12 })
				const recorded = recorder()
				const found = yield* Effect.findFirst(
					Arr.map(Arr.range(0, 999), (seed) =>
						generate(recorded, generator, randomChooser(wordsOf(seed)))
					),
					(generated) => failsOn(CAPACITY - 1)(generated.value)
				)
				const failing = Option.getOrThrow(found)
				const shrunk = yield* shrink(generator, failing, failsOn(CAPACITY - 1), completeShrink)
				deepStrictEqual(shrunk.best.failure, [
					{ command: "push", parameters: 0 },
					{ command: "push", parameters: 0 },
					{ command: "push", parameters: 1 },
					{ command: "pop", parameters: undefined },
					{ command: "pop", parameters: undefined },
					{ command: "pop", parameters: undefined }
				])
			})
	)

	it.effect("refuses a kept program whose step its model does not allow", () =>
		Effect.gen(function* () {
			const refused = yield* Effect.flip(
				runProgram(QUEUE, realOf(ringBuffer(CAPACITY)), [{ command: "pop", parameters: undefined }])
			)
			deepStrictEqual(
				refused,
				StepInapplicable.make({
					at: 0,
					command: "pop",
					message: "step 0 runs pop, which the model does not allow in its state there"
				})
			)
		})
	)
})
