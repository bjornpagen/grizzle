import { refusal } from "#oxlint/rule.ts"
import { isCallTo } from "#oxlint/syntax.ts"

/** The calls that wait for time to pass, and the schedules that space their repetitions in time. */
const SLEEPS: ReadonlyArray<string> = [
	"Effect.delay",
	"Effect.sleep",
	"Schedule.exponential",
	"Schedule.fibonacci",
	"Schedule.fixed",
	"Schedule.spaced",
	"Schedule.windowed",
	"setInterval",
	"setTimeout"
]

/**
 * A wait for time to pass in a test: a sleep, a delay, a timer or a time-spaced schedule. A sleep long enough to pass
 * on a fast machine fails on a slow one and wastes time on both.
 */
export const noSleepWait = refusal(
	"sleep",
	"This waits for time to pass, which is too short on a slow machine and wasted on a fast one. Wait for the fact itself with awaitFact, or move time with TestClock under it.effect.",
	(context, refuse) => ({
		CallExpression: (node) => {
			if (isCallTo(context, node, SLEEPS)) {
				refuse(node)
			}
		}
	})
)
