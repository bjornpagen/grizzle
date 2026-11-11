import { NodeFileSystem } from "@effect/platform-node"
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { inject, type TestContext } from "vitest"
import { type Deadline, noDeadline, type ProcessRun, Run } from "#explore.ts"
import { budgetOf, type Corpus } from "#fuzz.ts"
import { fnv1a32 } from "#random.ts"
import type { ReplayCase } from "#replay.ts"
import { tokenOf, valuesFromToken } from "#tape.ts"

/** The key the run travels under, from global setup to every test process. */
export const RUN_KEY = "superstarter.testing.run"

/**
 * The run as global setup hands it to every test process: plain data, because what crosses to a worker must survive
 * structured cloning. A replay and a fuzz run are variants, never missing fields.
 */
export type RunWire = Readonly<{
	seed: number
	source: "environment" | "fresh"
	replay:
		| Readonly<{ kind: "none" }>
		| Readonly<{ kind: "replay"; suite: string; replayed: ReplayCase }>
	fuzz:
		| Readonly<{ kind: "none" }>
		| Readonly<{
				kind: "fuzz"
				suite: string
				fuzzTime: Readonly<{ kind: "until-failure" }> | Readonly<{ kind: "given"; text: string }>
		  }>
}>

declare module "vitest" {
	interface ProvidedContext {
		"superstarter.testing.run": RunWire
	}
}

/** The first line of a corpus file: its format, so a file of another format is never read as a tape. */
const CORPUS_HEADER = "testing tape 1"

/** Every run of characters a slug leaves out. */
const UNSLUGGED = regex("[^a-z0-9]+", "g")

/** A suite's corpus directory: its label as a readable slug, and the label's digest so two labels never share one. */
const corpusDirectoryOf = (suite: string) =>
	`.vitest/testing/${Str.replaceAll(UNSLUGGED, "-")(Str.toLowerCase(suite))}-${fnv1a32(suite).toString(16)}`

/** A corpus in the package's gitignored `.vitest/testing/<suite>/`: one file per tape, named by its token's digest,
 * read shortest first. */
const fileCorpus = (fileSystem: FileSystem.FileSystem, suite: string): Corpus => {
	const directory = corpusDirectoryOf(suite)
	const fileOf = (values: Float64Array, length: number) =>
		`${directory}/${fnv1a32(tokenOf(values, length)).toString(16)}`
	return {
		load: Effect.gen(function* () {
			if (!(yield* fileSystem.exists(directory))) {
				return []
			}
			const names = yield* fileSystem.readDirectory(directory)
			const tapes = yield* Effect.forEach(names, (name) =>
				Effect.map(fileSystem.readFileString(`${directory}/${name}`), (text) => {
					const [header, token] = Str.split(Str.trim(text), "\n")
					return header === CORPUS_HEADER && token !== undefined ? [valuesFromToken(token)] : []
				})
			)
			return Arr.sort(
				Arr.flatten(tapes),
				Order.mapInput(Order.Number, (values: Float64Array) => values.length)
			)
		}).pipe(Effect.orDie),
		save: (values, length) =>
			Effect.gen(function* () {
				yield* fileSystem.makeDirectory(directory, { recursive: true })
				yield* fileSystem.writeFileString(
					fileOf(values, length),
					`${CORPUS_HEADER}\n${tokenOf(values, length)}\n`
				)
			}).pipe(Effect.orDie),
		drop: (values, length) =>
			fileSystem.remove(fileOf(values, length), { force: true }).pipe(Effect.orDie)
	}
}

/** This process's run, as global setup provided it, with a fuzz run's corpus on this package's disk. */
export const runOfProcess = Effect.gen(function* () {
	const wire = inject(RUN_KEY)
	const fileSystem = yield* FileSystem.FileSystem
	const processRun: ProcessRun = {
		seed: wire.seed,
		source: wire.source,
		replay:
			wire.replay.kind === "replay"
				? Option.some({ suite: wire.replay.suite, replayed: wire.replay.replayed })
				: Option.none(),
		fuzz:
			wire.fuzz.kind === "fuzz"
				? Option.some({
						suite: wire.fuzz.suite,
						budget:
							wire.fuzz.fuzzTime.kind === "given"
								? budgetOf(wire.fuzz.fuzzTime.text)
								: { kind: "until-failure" },
						corpus: fileCorpus(fileSystem, wire.fuzz.suite)
					})
				: Option.none()
	}
	return processRun
}).pipe(Effect.provide(NodeFileSystem.layer))

/**
 * The deadline of the test `ctx` runs, from its task: none when its timeout is unbounded (Vitest sets no timer for a
 * timeout of zero or less, or an infinite one), otherwise its timeout after its attempt began. Vitest starts a test's
 * timer when it calls the test's function, after its beforeEach hooks, and an attempt begins before them, at the test's
 * start or, for a retry or a repeat, once the last recorded attempt ended; so the deadline is never later than Vitest's.
 * A task that has no result has not begun to run, so no search can run in it.
 */
const deadlineOf = (ctx: TestContext): Effect.Effect<Deadline> => {
	const { timeout, result } = ctx.task
	if (timeout <= 0 || !Number.isFinite(timeout)) {
		return Effect.succeed(noDeadline)
	}
	return Option.match(Option.fromNullishOr(result?.startTime), {
		onNone: () =>
			Effect.die(
				`${ctx.task.fullName}: a search runs in a test that has begun, and this one has not`
			),
		onSome: (startTime) =>
			Effect.succeed<Deadline>({
				kind: "at",
				millis:
					Arr.reduce(result?.attempts ?? [], startTime, (began, attempt) =>
						Math.max(began, attempt.startTime + attempt.duration)
					) + timeout
			})
	})
}

/** The run of a search in the test `ctx` runs: this process's run, and the test's deadline. */
export const runOfTest = (ctx: TestContext) =>
	Effect.zipWith(runOfProcess, deadlineOf(ctx), (processRun, deadline) =>
		Run.of({ ...processRun, deadline })
	)
