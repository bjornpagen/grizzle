/**
 * What output-idle.test.ts's property reads: drawn idle-timeout settings and response bodies, each body's waits played
 * on the virtual clock while the send reads it, and what the send left.
 */

import { awaitFact } from "@bjornpagen/testing/fact"
import {
	type Aimed,
	aimed,
	array,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	Predicate,
	Queue,
	Record,
	Ref,
	Runtime,
	Stream,
	String as Str
} from "effect"
import { HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import * as Output from "#runtime-src/runtime/output.ts"
import { PREFIX, plainWorld, type Sent, type SendWorld, sendIn } from "#test/support/send.ts"

/** The variable the run reads its idle timeout from when no flag gives one, under the harness's prefix. */
const VARIABLE = `${PREFIX}_IDLE_TIMEOUT`

/** The unprefixed spelling, which the runtime never reads. */
const UNPREFIXED = "IDLE_TIMEOUT"

/** The longest bound a drawn setting holds, in seconds: a wait past it is past every drawn bound. */
const LONGEST_BOUND = 60

/** The longest wait a body draws, in seconds: far past every drawn bound. */
const LONGEST_WAIT = 4000

/**
 * Texts the design refuses as an idle timeout, none a whole number of seconds 1 or more and none a part of the
 * refusal's own words, so a refusal that shows the value is told from one that does not.
 */
const INVALID: Arr.NonEmptyReadonlyArray<string> = [
	"0",
	"-1",
	"-12",
	"1.5",
	"0.5",
	"soon",
	"ten",
	"5s"
]

/** `<PREFIX>_IDLE_TIMEOUT` as the environment holds it: absent, whole seconds, or a text the design refuses. */
export type Variable =
	| Readonly<{ kind: "absent" }>
	| Readonly<{ kind: "seconds"; seconds: number }>
	| Readonly<{ kind: "invalid"; text: string }>

/**
 * Where a run's idle timeout may come from: `--idle-timeout` (its parsed seconds), the prefixed variable, and the
 * unprefixed `IDLE_TIMEOUT`, which holds whole seconds when set.
 */
export type Settings = Readonly<{
	flag: Option.Option<number>
	variable: Variable
	unprefixed: Option.Option<number>
}>

/** One chunk of a body and the wait before it, in milliseconds. */
export type Chunk = Readonly<{ wait: number; text: string }>

/**
 * A response body as its server sends it: its chunks, each after its wait, then its end after a last wait. Every wait
 * is an odd number of half seconds, so none equals a bound of whole seconds.
 */
export type Body = Readonly<{ chunks: ReadonlyArray<Chunk>; end: number }>

/** One send: its settings, the status it is answered with, where a 2xx body goes, and the body. */
export type IdleRun = Readonly<{
	settings: Settings
	status: 200 | 500
	destination: "stdout" | "file"
	body: Body
}>

const seconds: Gen<number> = int(1, LONGEST_BOUND)

const variable: Gen<Variable> = weighted<Variable>([
	[2, constant<Variable>({ kind: "absent" })],
	[3, map(seconds, (count): Variable => ({ kind: "seconds", seconds: count }))],
	[1, map(element(INVALID), (text): Variable => ({ kind: "invalid", text }))]
])

const unprefixed: Gen<Option.Option<number>> = weighted([
	[3, constant(Option.none<number>())],
	[1, map(seconds, Option.some)]
])

const settings: Gen<Settings> = (s) => ({
	flag: s.draw(option(seconds)),
	variable: s.draw(variable),
	unprefixed: s.draw(unprefixed)
})

/** A wait of an odd number of half seconds, from `shortest` up to `longest` seconds, each in whole seconds. */
const waitOf = (shortest: number, longest: number): Gen<number> =>
	map(int(shortest, longest - 1), (halves) => (2 * halves + 1) * 500)

const wait: Gen<number> = weighted([
	[4, waitOf(0, LONGEST_BOUND)],
	[1, waitOf(0, LONGEST_WAIT)]
])

const text: Gen<string> = string(characterOf(["1", "2", "a", "z"]), { min: 1, max: 3 })

const chunkAfter =
	(before: Gen<number>): Gen<Chunk> =>
	(s) => ({ wait: s.draw(before), text: s.draw(text) })

const body: Gen<Body> = (s) => ({
	chunks: s.draw(array(chunkAfter(wait), { min: 0, max: 5 })),
	end: s.draw(wait)
})

const status: Gen<200 | 500> = weighted<200 | 500>([
	[3, constant<200 | 500>(200)],
	[1, constant<200 | 500>(500)]
])

const destination: Gen<"stdout" | "file"> = element<"stdout" | "file">(["stdout", "file"])

const runs: Gen<IdleRun> = (s) => ({
	settings: s.draw(settings),
	status: s.draw(status),
	destination: s.draw(destination),
	body: s.draw(body)
})

/** What a send left: how it ended, its exit code, the requests sent, stdout, and the case directory's names and target. */
export type Left = Readonly<{
	ended: string
	exitCode: Option.Option<number>
	sent: number
	stdout: string
	valueShown: boolean
	names: ReadonlyArray<string>
	target: Option.Option<string>
}>

/** The target `--output` names, in the case's own directory. */
const TARGET = "out.json"

/** The operation sent: a GET whose 200 is JSON. */
const meta: Output.OperationMeta = {
	media: { request: [], responses: { "200": ["application/json"], default: [] } },
	method: "GET",
	operationId: "items-get",
	pathTemplate: "/items",
	security: []
}

/** The environment a run's settings give. */
const environmentOf = (given: Settings): Readonly<Record<string, string>> => {
	const prefixed = ((): Readonly<Record<string, string>> => {
		switch (given.variable.kind) {
			case "absent":
				return {}
			case "seconds":
				return { [VARIABLE]: String(given.variable.seconds) }
			case "invalid":
				return { [VARIABLE]: given.variable.text }
		}
	})()
	return Option.match(given.unprefixed, {
		onNone: () => prefixed,
		onSome: (count) => ({ ...prefixed, [UNPREFIXED]: String(count) })
	})
}

/**
 * The failures a send may end with here, each by its tag and the one field its contract names: the stream's reason, the
 * usage error's flag, the API error's status.
 */
const DETAILS = {
	ResponseStreamError: "reason",
	UsageError: "flag",
	ApiResponseError: "status"
} as const

/** A failure the harness erased to unknown, read as its tag and the field its tag names; another failure is named so. */
const failureOf = (error: unknown): string => {
	for (const [tag, field] of Record.toEntries(DETAILS)) {
		if (Predicate.isTagged(error, tag)) {
			const detail = Predicate.hasProperty(error, field) ? error[field] : undefined
			return Predicate.isString(detail) || Predicate.isNumber(detail)
				? `${tag} ${String(detail)}`
				: tag
		}
	}
	return "another failure"
}

/** How a send ended: a success, or its failure. */
const endedOf = (sent: Sent): string =>
	Exit.isSuccess(sent.exit)
		? "succeeded"
		: Option.match(sent.failure, { onNone: () => "a defect", onSome: failureOf })

/** The exit code a failure states for itself. */
const statedCode = (error: unknown): Option.Option<number> => {
	if (!Predicate.hasProperty(error, Runtime.errorExitCode)) {
		return Option.none()
	}
	const code = error[Runtime.errorExitCode]
	return Predicate.isNumber(code) ? Option.some(code) : Option.none()
}

/** The exit code a send's end gives: 0 for a success, the code its failure states otherwise. */
const exitCodeOf = (sent: Sent): Option.Option<number> =>
	Exit.isSuccess(sent.exit) ? Option.some(0) : Option.flatMap(sent.failure, statedCode)

/** A body's pieces in the order the send meets them: each chunk, then its end, each after its wait. */
const piecesOf = (
	given: Body
): ReadonlyArray<Readonly<{ wait: number; brings: Option.Option<string> }>> =>
	Arr.append(
		Arr.map(given.chunks, (one) => ({ wait: one.wait, brings: Option.some(one.text) })),
		{ wait: given.end, brings: Option.none<string>() }
	)

/**
 * Sends the run's request through the send harness with its body's server played on the virtual clock. The body is
 * pulled only while the send reads it (a high-water mark of 0), and each wait passes only once the send waits for the
 * piece after it, so no wait passes while the send does real work (a temp file's write) and each wait is measured from
 * where the send's own idle clock starts. A send that ends before it reads its body (a refused setting) takes no piece.
 */
const played = (dir: ScratchDir, run: IdleRun) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const pulls = yield* Ref.make(0)
		const ended = yield* Ref.make(false)
		const pieces = yield* Queue.unbounded<string, Cause.Done>()
		const source = Stream.fromEffectRepeat(
			Effect.andThen(
				Ref.update(pulls, (count) => count + 1),
				Queue.take(pieces)
			)
		).pipe(Stream.encodeText)
		const context = yield* Effect.context()
		const world: SendWorld = {
			...plainWorld(meta, HttpClientRequest.get("/items")),
			env: environmentOf(run.settings),
			reply: () =>
				new Response(
					Stream.toReadableStreamWith(source, context, { strategy: { highWaterMark: 0 } }),
					{ headers: { "content-type": "application/json" }, status: run.status }
				),
			output:
				run.destination === "file"
					? Option.some({ name: TARGET, force: false, dir })
					: Option.none()
		}
		const fiber = yield* Effect.forkChild(
			sendIn(world).pipe(
				Effect.provideService(Output.idleTimeoutSetting, run.settings.flag),
				Effect.ensuring(Ref.set(ended, true))
			)
		)
		const waitingFor = (piece: number) =>
			awaitFact(
				Effect.gen(function* () {
					if (yield* Ref.get(ended)) {
						return Option.some(false)
					}
					const pulled = yield* Ref.get(pulls)
					return pulled > piece ? Option.some(true) : Option.none()
				})
			)
		for (const [index, piece] of piecesOf(run.body).entries()) {
			if (!(yield* waitingFor(index))) {
				break
			}
			yield* TestClock.adjust(Duration.millis(piece.wait))
			yield* Option.match(piece.brings, {
				onNone: () => Queue.end(pieces),
				onSome: (chunk) => Queue.offer(pieces, chunk)
			})
		}
		const sent = yield* Fiber.join(fiber)
		const target = path.join(dir, TARGET)
		const exists = yield* Effect.orDie(fs.exists(target))
		const content = exists ? yield* Effect.orDie(fs.readFileString(target)) : ""
		const names = yield* Effect.orDie(fs.readDirectory(dir))
		const left: Left = {
			ended: endedOf(sent),
			exitCode: exitCodeOf(sent),
			sent: sent.requests.length,
			stdout: sent.stdout,
			valueShown:
				run.settings.variable.kind === "invalid" &&
				Str.includes(run.settings.variable.text)(sent.stderr),
			names: Arr.sort(names, Order.String),
			target: exists ? Option.some(content) : Option.none()
		}
		return left
	})

/** A run's send played on a virtual clock of its own. */
export const leftBy = (dir: ScratchDir, run: IdleRun) =>
	Effect.scoped(
		Effect.gen(function* () {
			const clock = yield* Layer.build(TestClock.layer())
			return yield* Effect.provideContext(played(dir, run), clock)
		})
	)

/** The bound a run reads, or its refusal: the flag, else the prefixed variable, else none; the unprefixed never. */
type Bound =
	| Readonly<{ kind: "refused" }>
	| Readonly<{ kind: "read"; seconds: Option.Option<number> }>

const boundOf = (given: Settings): Bound =>
	Option.match(given.flag, {
		onSome: (count): Bound => ({ kind: "read", seconds: Option.some(count) }),
		onNone: (): Bound => {
			switch (given.variable.kind) {
				case "absent":
					return { kind: "read", seconds: Option.none() }
				case "seconds":
					return { kind: "read", seconds: Option.some(given.variable.seconds) }
				case "invalid":
					return { kind: "refused" }
			}
		}
	})

/** A body's waits in the order the send meets them. */
const waitsOf = (given: Body): ReadonlyArray<number> =>
	Arr.map(piecesOf(given), (piece) => piece.wait)

/** Where a body's first wait past the bound falls among its waits: none with no bound, or when every wait is within it. */
const stallOf = (given: Body, bound: Option.Option<number>): Option.Option<number> =>
	Option.flatMap(bound, (count) =>
		Arr.findFirstIndex(waitsOf(given), (one) => one > Duration.toMillis(Duration.seconds(count)))
	)

/** The text of a body's first `count` chunks. */
const writtenOf = (given: Body, count: number): string =>
	Arr.join(
		Arr.map(Arr.take(given.chunks, count), (one) => one.text),
		""
	)

/**
 * What design 9 I5 says a send leaves. The idle timeout is `--idle-timeout`, else `<PREFIX>_IDLE_TIMEOUT`, else none;
 * an unprefixed `IDLE_TIMEOUT` is never read. A variable that is no whole number of seconds 1 or more is a usage error
 * naming the variable and never its value (exit 2), before anything is sent. Under a timeout, a read that waits longer
 * than it for the body's next chunk or its end fails idleTimeout (exit 5), the error body's read included: stdout keeps
 * the chunks written before the wait, and `--output` leaves neither the target nor a temp file. A body whose every wait
 * is within the timeout is read whole however long it takes in all, and with no timeout every wait is waited: a 2xx
 * body lands on stdout or in the target, and an error body is the API error's (exit 1).
 */
export const expectedOf = (run: IdleRun): Left => {
	const nothing: Omit<Left, "ended" | "exitCode"> = {
		sent: 1,
		stdout: "",
		valueShown: false,
		names: [],
		target: Option.none()
	}
	const bound = boundOf(run.settings)
	if (bound.kind === "refused") {
		return { ...nothing, ended: `UsageError ${VARIABLE}`, exitCode: Option.some(2), sent: 0 }
	}
	return Option.match(stallOf(run.body, bound.seconds), {
		onSome: (stall): Left => ({
			...nothing,
			ended: "ResponseStreamError idleTimeout",
			exitCode: Option.some(5),
			stdout: run.status === 200 && run.destination === "stdout" ? writtenOf(run.body, stall) : ""
		}),
		onNone: (): Left => {
			if (run.status === 500) {
				return { ...nothing, ended: "ApiResponseError 500", exitCode: Option.some(1) }
			}
			const whole = writtenOf(run.body, run.body.chunks.length)
			return run.destination === "stdout"
				? { ...nothing, ended: "succeeded", exitCode: Option.some(0), stdout: whole }
				: {
						...nothing,
						ended: "succeeded",
						exitCode: Option.some(0),
						names: [TARGET],
						target: Option.some(whole)
					}
		}
	})
}

export type IdleFeature =
	| "a wait past the bound on stdout"
	| "a wait past the bound writing --output"
	| "a wait past the bound in an error body"
	| "the end past the bound"
	| "a body past the bound in all"
	| "no bound, a wait past every bound"
	| "the flag decides over the variable"
	| "an unprefixed variable alone"
	| "an invalid variable"
	| "an error body read whole"

/** How a body fares under a bound: refused before it is read, read whole, or stalled at a wait. */
const verdictUnder = (given: Body, bound: Bound): string =>
	bound.kind === "refused"
		? "refused"
		: Option.match(stallOf(given, bound.seconds), {
				onNone: () => "read whole",
				onSome: (index) => `stalled at ${String(index)}`
			})

/** The situations a run reaches, each read from the run and the oracle's bound. */
export const idleFeatures = (run: IdleRun): ReadonlyArray<IdleFeature> => {
	const bound = boundOf(run.settings)
	const read = bound.kind === "read" ? bound.seconds : Option.none<number>()
	const stall = stallOf(run.body, read)
	const waits = waitsOf(run.body)
	const total = Arr.reduce(waits, 0, (sum, one) => sum + one)
	const when = (holds: boolean, feature: IdleFeature): ReadonlyArray<IdleFeature> =>
		holds ? [feature] : []
	const stalledTo = (to: "stdout" | "file") =>
		Option.isSome(stall) && run.status === 200 && run.destination === to
	return [
		...when(stalledTo("stdout"), "a wait past the bound on stdout"),
		...when(stalledTo("file"), "a wait past the bound writing --output"),
		...when(Option.isSome(stall) && run.status === 500, "a wait past the bound in an error body"),
		...when(
			Arr.isReadonlyArrayNonEmpty(run.body.chunks) &&
				Option.contains(stall, run.body.chunks.length),
			"the end past the bound"
		),
		...when(
			Option.isNone(stall) &&
				Arr.isReadonlyArrayNonEmpty(run.body.chunks) &&
				Option.exists(read, (count) => total > Duration.toMillis(Duration.seconds(count))),
			"a body past the bound in all"
		),
		...when(
			bound.kind === "read" &&
				Option.isNone(read) &&
				Arr.some(waits, (one) => one > Duration.toMillis(Duration.seconds(LONGEST_BOUND))),
			"no bound, a wait past every bound"
		),
		...when(
			Option.isSome(run.settings.flag) &&
				run.settings.variable.kind !== "absent" &&
				verdictUnder(run.body, bound) !==
					verdictUnder(run.body, boundOf({ ...run.settings, flag: Option.none() })),
			"the flag decides over the variable"
		),
		...when(
			Option.isNone(run.settings.flag) &&
				run.settings.variable.kind === "absent" &&
				Option.isSome(run.settings.unprefixed),
			"an unprefixed variable alone"
		),
		...when(bound.kind === "refused", "an invalid variable"),
		...when(
			bound.kind === "read" && Option.isNone(stall) && run.status === 500,
			"an error body read whole"
		)
	]
}

/** Settings whose bound is read, with the seconds it reads: the flag's, or the variable's under no flag. */
const bounded: Gen<Readonly<{ settings: Settings; seconds: number }>> = (s) => {
	const count = s.draw(seconds)
	const settled: Settings = s.draw(element([false, true]))
		? { flag: Option.some(count), variable: s.draw(variable), unprefixed: Option.none() }
		: {
				flag: Option.none(),
				variable: { kind: "seconds", seconds: count },
				unprefixed: Option.none()
			}
	return { settings: settled, seconds: count }
}

/** A body whose first wait past `count` seconds falls at a drawn chunk, or at its end when `atEnd`. */
const stalledBody =
	(count: number, atEnd: boolean): Gen<Body> =>
	(s) => {
		const within = waitOf(0, count)
		const past = waitOf(count, count + LONGEST_BOUND)
		const length = s.draw(int(atEnd ? 1 : 0, 4))
		const stall = atEnd ? length : s.draw(int(0, length))
		return {
			chunks: Array.from({ length }, (_, index) =>
				s.draw(chunkAfter(index < stall ? within : index === stall ? past : wait))
			),
			end: s.draw(stall === length ? past : wait)
		}
	}

/** A run under a bound it reads whose body stalls past it, at a chunk or at its end when `atEnd`. */
const stalled =
	(answered: 200 | 500, to: "stdout" | "file", atEnd: boolean): Gen<IdleRun> =>
	(s) => {
		const given = s.draw(bounded)
		return {
			settings: given.settings,
			status: answered,
			destination: to,
			body: s.draw(stalledBody(given.seconds, atEnd))
		}
	}

/**
 * A run whose every wait is within its bound and whose waits pass it in all: three to five chunks, each after a wait
 * past half the bound.
 */
const readWhole =
	(answered: 200 | 500): Gen<IdleRun> =>
	(s) => {
		const given = s.draw(bounded)
		const longHalf = waitOf(Math.floor(given.seconds / 2), given.seconds)
		return {
			settings: given.settings,
			status: answered,
			destination: s.draw(destination),
			body: {
				chunks: s.draw(array(chunkAfter(longHalf), { min: 3, max: 5 })),
				end: s.draw(waitOf(0, given.seconds))
			}
		}
	}

/** A run under no bound whose end waits past every drawn bound. */
const unbounded: Gen<IdleRun> = (s) => {
	const drawn = s.draw(runs)
	return {
		...drawn,
		settings: { flag: Option.none(), variable: { kind: "absent" }, unprefixed: s.draw(unprefixed) },
		body: { ...drawn.body, end: s.draw(waitOf(LONGEST_BOUND, LONGEST_WAIT)) }
	}
}

/**
 * A run stalled under the flag's bound beside a variable that alone gives another verdict: a text the design refuses,
 * or a bound past every wait.
 */
const flagOverVariable: Gen<IdleRun> = (s) => {
	const count = s.draw(seconds)
	return {
		settings: {
			flag: Option.some(count),
			variable: s.draw(
				element<Variable>([
					{ kind: "invalid", text: "soon" },
					{ kind: "seconds", seconds: LONGEST_WAIT }
				])
			),
			unprefixed: Option.none()
		},
		status: 200,
		destination: "stdout",
		body: s.draw(stalledBody(count, false))
	}
}

/** Runs, aimed at each pending situation by one built to reach it. */
export const aimedRuns: Aimed<IdleRun, IdleFeature> = aimed(runs, [
	["a wait past the bound on stdout", stalled(200, "stdout", false)],
	["a wait past the bound writing --output", stalled(200, "file", false)],
	["a wait past the bound in an error body", stalled(500, "stdout", false)],
	["the end past the bound", stalled(200, "stdout", true)],
	["a body past the bound in all", readWhole(200)],
	["no bound, a wait past every bound", unbounded],
	["the flag decides over the variable", flagOverVariable],
	[
		"an unprefixed variable alone",
		(s) => ({
			...s.draw(runs),
			settings: {
				flag: Option.none(),
				variable: { kind: "absent" },
				unprefixed: Option.some(s.draw(seconds))
			}
		})
	],
	[
		"an invalid variable",
		(s) => ({
			...s.draw(runs),
			settings: {
				flag: Option.none(),
				variable: { kind: "invalid", text: s.draw(element(INVALID)) },
				unprefixed: s.draw(unprefixed)
			}
		})
	],
	["an error body read whole", readWhole(500)]
])
