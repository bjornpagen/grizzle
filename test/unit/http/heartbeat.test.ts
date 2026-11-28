/**
 * An HTTP handler's heartbeat is a Node timer's delay, which its config states and httpHandler parses where it is
 * given (packages/grizzle/src/http/handler.ts readConfig, connection/config.ts timerDelay): an integer of milliseconds
 * from the least delay a Node timer waits to the longest it keeps builds a handler; anything else is refused when the
 * handler is built, naming HttpConfig.heartbeatMs and the timer's range.
 *
 * Each case: the shelving login's layer (test/support/unit/adapter/services.fixtures.ts), which connects nothing while it is
 * built, and a handler of it built with one heartbeat: each end of the range, 0, -1, one past the longest, a fraction,
 * NaN, infinity, a text, or none.
 *
 * Oracle: Node's timers, as their documentation states the delays a timer keeps (connection/config.ts timerMinMs,
 * timerMaxMs).
 */

import * as gRuntime from "@bjornpagen/grizzle/runtime"
import { assert, assertVariant } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Exit, Formatter, Layer } from "effect"
import { DbLayer } from "#adapter/public/layer.ts"
import { httpHandler } from "#http/index.ts"
import { ShelvingServed, shelvingConfig } from "#test/support/unit/adapter/services.fixtures.ts"

type HeartbeatFeature = "a timer's delay built" | "a delay no timer keeps refused"

/** Each end of a timer's range, and every value outside it a JavaScript caller can pass. */
const heartbeats = [
	gRuntime.timerMinMs,
	gRuntime.timerMaxMs,
	0,
	-1,
	gRuntime.timerMaxMs + 1,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	"1000",
	undefined
] as const

/** Whether `heartbeat` is a delay a Node timer keeps. */
const timerKeeps = (heartbeat: unknown): heartbeat is number =>
	typeof heartbeat === "number" &&
	Number.isSafeInteger(heartbeat) &&
	heartbeat >= gRuntime.timerMinMs &&
	heartbeat <= gRuntime.timerMaxMs

/** httpHandler builds a handler of a heartbeat a Node timer keeps, and refuses any other, naming HttpConfig.heartbeatMs. */
export const httpHandlerBuildsAHeartbeatANodeTimerKeepsAndRefusesAnyOtherNamingHttpConfigHeartbeatMs =
	property.exhaust(
		finite((source) => source.draw(element<unknown>(heartbeats))),
		{
			needs: {},
			situations: [
				"a timer's delay built",
				"a delay no timer keeps refused"
			] satisfies ReadonlyArray<Reached<HeartbeatFeature>>,
			check: (_, c: Case<HeartbeatFeature>) => (heartbeat) =>
				Effect.scoped(
					Effect.gen(function* () {
						const services = yield* Layer.build(DbLayer.make(shelvingConfig([])))
						/** A JavaScript caller's config, its heartbeat any value, as the parse is handed it. */
						const config = Object.assign(
							{ logins: [ShelvingServed] as const, heartbeatMs: gRuntime.timerMinMs },
							{ heartbeatMs: heartbeat }
						)
						const built = yield* Effect.exit(
							httpHandler(config).pipe(Effect.provideContext(services))
						)
						if (timerKeeps(heartbeat)) {
							assert.ok(Exit.isSuccess(built), `a heartbeat of ${heartbeat} ms builds a handler`)
							c.note("a timer's delay built")
							return
						}
						assert.ok(
							Exit.isFailure(built),
							`a heartbeat of ${Formatter.format(heartbeat)} is refused`
						)
						const error = Exit.findErrorOption(built)
						assert.ok(error._tag === "Some", "the refusal is a typed failure")
						const reason = error.value.reason
						assertVariant(reason, "kind", "setting", "a setting's refusal")
						assert.deepEqual(
							reason.fault.setting,
							["HttpConfig", "heartbeatMs"],
							"it names the heartbeat"
						)
						assert.deepEqual(
							reason.fault.rule,
							{
								kind: "integer",
								least: gRuntime.timerMinMs,
								most: gRuntime.timerMaxMs,
								unit: "milliseconds"
							},
							"it states a timer's range"
						)
						c.note("a delay no timer keeps refused")
					})
				),
			oracle: {
				kind: "specification",
				name: "Node's timers: a delay from 1 to 2,147,483,647 milliseconds is kept, any other is not"
			},
			box: "each end of a timer's range, 0, -1, one past the longest, a fraction, NaN, infinity, a text, and none",
			show: Formatter.format,
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/connection/config.ts",
					original:
						"export const timerDelay = (v: number): boolean => integerIn(v, timerMinMs, timerMaxMs)",
					replacement:
						"export const timerDelay = (v: number): boolean => integerIn(v, 0, timerMaxMs)",
					why: "A heartbeat of 0 is admitted, a delay Node's timers read as 1."
				}
			]
		}
	)
