/** What the property of client-retry-after.test.ts reads: drawn scripts of answers, the timeout, and the attempts they make. */

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
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, DateTime, Effect, Fiber, Layer, Option, Ref, Sink, Stdio } from "effect"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Client from "#runtime-src/runtime/client.ts"

/** A `Retry-After` an answer carries: none, delay seconds, an HTTP date that many seconds after it, or text that is neither. */
export type RetryAfter =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "seconds"; seconds: number }>
	| Readonly<{ kind: "date"; seconds: number }>
	| Readonly<{ kind: "invalid"; text: string }>

/** One scripted answer: a status and its `Retry-After`. */
export type Answer = Readonly<{ status: number; retryAfter: RetryAfter }>

/** A run: the answers its attempts get in order (200 past the script), and the effective `--timeout` in seconds. */
export type Schedule = Readonly<{ answers: ReadonlyArray<Answer>; timeout: number }>

/** The statuses the design retries (5 Retries row), and others it does not. */
const RETRIED: Arr.NonEmptyReadonlyArray<number> = [408, 429, 500, 502, 503, 504]

const NOT_RETRIED: Arr.NonEmptyReadonlyArray<number> = [200, 201, 400, 404, 409]

/** The statuses a run ends with unretried that are failures. */
const REFUSED: Arr.NonEmptyReadonlyArray<number> = [400, 404, 409]

const retryAfter: Gen<RetryAfter> = weighted<RetryAfter>([
	[2, constant<RetryAfter>({ kind: "none" })],
	[3, map(int(0, 130), (seconds): RetryAfter => ({ kind: "seconds", seconds }))],
	[2, map(int(1, 130), (seconds): RetryAfter => ({ kind: "date", seconds }))],
	[
		1,
		map(
			oneOf([constant("soon"), string(characterOf(["x", "-", "."]), { min: 1, max: 3 })]),
			(text): RetryAfter => ({ kind: "invalid", text })
		)
	]
])

const answer: Gen<Answer> = (s) => ({
	status: s.draw(
		weighted([
			[3, element(RETRIED)],
			[1, element(NOT_RETRIED)]
		])
	),
	retryAfter: s.draw(retryAfter)
})

const schedules: Gen<Schedule> = (s) => ({
	answers: s.draw(array(answer, { min: 1, max: 4 })),
	timeout: s.draw(
		weighted([
			[1, constant(0)],
			[4, int(1, 60)]
		])
	)
})

/** What a run ends with: the final status, the server delay recorded as capped, and when each attempt arrived. */
export type Outcome = Readonly<{
	status: number
	capped: Option.Option<number>
	attempts: number
	arrivals: Option.Option<ReadonlyArray<number>>
}>

/** The retries the run is given, as `--retries 2`: three attempts at most. */
const RETRIES = 2

/**
 * What the design's retry policy does with a script (D-AD7, 13.1 R6): an attempt answered with a retried status is
 * sent again while the budget holds, after its `Retry-After` (seconds, or an HTTP date's distance) when one parses and
 * after the backoff otherwise; a delay past a nonzero `--timeout` is not waited, and the run ends with that answer and
 * the delay recorded; a status not retried, or the budget spent, ends the run with nothing recorded. Arrival times are
 * known while every wait is a server's delay.
 */
export const expectedOf = (schedule: Schedule): Outcome => {
	const arrivals: Array<number> = [0]
	let known = true
	for (let attempt = 0; ; attempt += 1) {
		const now = Arr.getUnsafe(arrivals, arrivals.length - 1)
		const got = schedule.answers[attempt] ?? { status: 200, retryAfter: { kind: "none" } }
		const done = (capped: Option.Option<number>): Outcome => ({
			status: got.status,
			capped,
			attempts: arrivals.length,
			arrivals: known ? Option.some(arrivals) : Option.none()
		})
		if (!Arr.contains(RETRIED, got.status) || attempt === RETRIES) {
			return done(Option.none())
		}
		const delay =
			got.retryAfter.kind === "seconds" || got.retryAfter.kind === "date"
				? Option.some(got.retryAfter.seconds)
				: Option.none()
		if (Option.exists(delay, (seconds) => schedule.timeout !== 0 && seconds > schedule.timeout)) {
			return done(delay)
		}
		known = known && Option.isSome(delay)
		arrivals.push(now + Option.getOrElse(delay, () => 0) * 1000)
	}
}

/** A scripted client: attempt k gets answer k (200 past the script), its arrival time recorded. */
const scripted = (schedule: Schedule, arrivals: Ref.Ref<ReadonlyArray<number>>) =>
	HttpClient.make((request) =>
		Effect.gen(function* () {
			const now = yield* TestClock.testClockWith((clock) => clock.currentTimeMillis)
			const seen = yield* Ref.getAndUpdate(arrivals, Arr.append(now))
			const got = schedule.answers[seen.length] ?? { status: 200, retryAfter: { kind: "none" } }
			const header = ((): Option.Option<string> => {
				switch (got.retryAfter.kind) {
					case "none":
						return Option.none()
					case "seconds":
						return Option.some(String(got.retryAfter.seconds))
					case "date":
						return Option.some(
							Headers.formatHttpDate(DateTime.makeUnsafe(now + got.retryAfter.seconds * 1000))
						)
					case "invalid":
						return Option.some(got.retryAfter.text)
				}
			})()
			return HttpClientResponse.fromWeb(
				request,
				new Response(`status ${got.status}`, {
					headers: Option.match(header, {
						onNone: () => ({}),
						onSome: (value) => ({ "retry-after": value })
					}),
					status: got.status
				})
			)
		})
	)

/** The retry transform alone over the scripted client, the virtual clock driven in one-second steps for six minutes. */
export const actualOf = (schedule: Schedule) =>
	Effect.scoped(
		Effect.gen(function* () {
			const arrivals = yield* Ref.make<ReadonlyArray<number>>([])
			const context = yield* Layer.build(
				Layer.mergeAll(TestClock.layer(), Stdio.layerTest({ stderr: () => Sink.drain }))
			)
			const exchange = Effect.gen(function* () {
				const budget = yield* Client.retryBudget
				const client = scripted(schedule, arrivals).pipe(
					Client.retryTransform((text) => text, budget, false)
				)
				const record = yield* Ref.make(Option.none<number>())
				const status = yield* Effect.scoped(
					client
						.execute(HttpClientRequest.get("http://127.0.0.1:1/r"))
						.pipe(Effect.map((response) => response.status))
				).pipe(Effect.provideService(Client.RetryAfterCap, record))
				return { status, capped: yield* Ref.get(record) }
			}).pipe(
				Effect.provideService(Client.timeoutSetting, Option.some(schedule.timeout)),
				Effect.provideService(Client.retriesSetting, Option.some(RETRIES))
			)
			const ended = yield* Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(exchange)
				for (let step = 0; step < 360; step += 1) {
					yield* TestClock.adjust("1 second")
				}
				return yield* Fiber.join(fiber)
			}).pipe(Effect.provideContext(context))
			const seen = yield* Ref.get(arrivals)
			const expected = expectedOf(schedule)
			const outcome: Outcome = {
				status: ended.status,
				capped: ended.capped,
				attempts: seen.length,
				arrivals: Option.map(expected.arrivals, () => seen)
			}
			return outcome
		})
	)

export type ScheduleFeature =
	| "a delay waited"
	| "a delay equal to the timeout"
	| "a delay past the timeout"
	| "an HTTP date"
	| "no cap, a long delay waited"
	| "retries run out"
	| "a status not retried"
	| "an invalid Retry-After"

export const scheduleFeatures = (
	schedule: Schedule,
	outcome: Outcome
): ReadonlyArray<ScheduleFeature> => {
	const used = Arr.take(schedule.answers, outcome.attempts)
	const delays = Arr.flatMap(used, (one) =>
		one.retryAfter.kind === "seconds" || one.retryAfter.kind === "date"
			? [one.retryAfter.seconds]
			: []
	)
	const when = (holds: boolean, feature: ScheduleFeature): ReadonlyArray<ScheduleFeature> =>
		holds ? [feature] : []
	return [
		...when(outcome.attempts > 1 && Arr.isReadonlyArrayNonEmpty(delays), "a delay waited"),
		...when(
			schedule.timeout !== 0 && Arr.contains(delays, schedule.timeout) && outcome.attempts > 1,
			"a delay equal to the timeout"
		),
		...when(Option.isSome(outcome.capped), "a delay past the timeout"),
		...when(
			Arr.some(used, (one) => one.retryAfter.kind === "date"),
			"an HTTP date"
		),
		...when(
			schedule.timeout === 0 && Arr.some(delays, (seconds) => seconds > 60) && outcome.attempts > 1,
			"no cap, a long delay waited"
		),
		...when(
			outcome.attempts === RETRIES + 1 && Arr.contains(RETRIED, outcome.status),
			"retries run out"
		),
		...when(
			!Arr.contains(RETRIED, outcome.status) && outcome.status !== 200,
			"a status not retried"
		),
		...when(
			Arr.some(used, (one) => one.retryAfter.kind === "invalid") &&
				Arr.contains(RETRIED, Arr.getUnsafe(used, 0).status),
			"an invalid Retry-After"
		)
	]
}

const scheduleOf =
	(answers: Gen<ReadonlyArray<Answer>>, timeout: Gen<number>): Gen<Schedule> =>
	(s) => ({ answers: s.draw(answers), timeout: s.draw(timeout) })

const one =
	(status: Gen<number>, after: Gen<RetryAfter>): Gen<ReadonlyArray<Answer>> =>
	(s) => [{ status: s.draw(status), retryAfter: s.draw(after) }]

const seconds = (lo: number, hi: number): Gen<RetryAfter> =>
	map(int(lo, hi), (count): RetryAfter => ({ kind: "seconds", seconds: count }))

/** Schedules, aimed at each pending situation by a script built to reach it. */
export const aimedSchedules: Aimed<Schedule, ScheduleFeature> = aimed(schedules, [
	["a delay waited", scheduleOf(one(element(RETRIED), seconds(1, 20)), int(20, 60))],
	[
		"a delay equal to the timeout",
		(s) => {
			const timeout = s.draw(int(1, 60))
			return {
				answers: [
					{ status: s.draw(element(RETRIED)), retryAfter: { kind: "seconds", seconds: timeout } }
				],
				timeout
			}
		}
	],
	[
		"a delay past the timeout",
		(s) => {
			const timeout = s.draw(int(1, 30))
			return {
				answers: [
					{
						status: s.draw(element(RETRIED)),
						retryAfter: { kind: "seconds", seconds: timeout + s.draw(int(1, 60)) }
					}
				],
				timeout
			}
		}
	],
	[
		"an HTTP date",
		scheduleOf(
			one(
				element(RETRIED),
				map(int(1, 20), (count): RetryAfter => ({ kind: "date", seconds: count }))
			),
			int(1, 60)
		)
	],
	["no cap, a long delay waited", scheduleOf(one(element(RETRIED), seconds(61, 130)), constant(0))],
	[
		"retries run out",
		scheduleOf(
			(s) =>
				Arr.makeBy(3, () => ({
					status: s.draw(element(RETRIED)),
					retryAfter: s.draw(seconds(0, 5))
				})),
			int(5, 60)
		)
	],
	["a status not retried", scheduleOf(one(element(REFUSED), seconds(60, 130)), int(1, 30))],
	[
		"an invalid Retry-After",
		scheduleOf(
			one(element(RETRIED), constant<RetryAfter>({ kind: "invalid", text: "soon" })),
			int(1, 30)
		)
	]
])
