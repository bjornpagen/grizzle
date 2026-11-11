import { Array as Arr } from "effect"
import { refusal } from "#oxlint/rule.ts"
import { isNamed } from "#oxlint/syntax.ts"

/** The reads of the current time. */
export const CLOCK_READS: ReadonlyArray<string> = [
	"Clock.currentTimeMillis",
	"Clock.currentTimeNanos",
	"Date.now",
	"DateTime.now",
	"DateTime.nowAsDate",
	"DateTime.nowInCurrentZone",
	"DateTime.nowUnsafe",
	"performance.now",
	"process.hrtime"
]

/** The constructor whose call with no argument, or call as a function, reads the current time. */
export const DATE_READS: ReadonlyArray<string> = ["Date"]

/**
 * A read of the current time in a test: `Date.now()`, `new Date()`, `performance.now()`, Effect's `Clock` and
 * `DateTime` reads. A verdict that depends on how long something took, or on when it ran, depends on the machine.
 */
export const noWallClockVerdict = refusal(
	"wallClock",
	"This reads the clock, so the verdict depends on the machine and the moment. No verdict depends on the clock: control time with TestClock under it.effect, or assert the fact itself.",
	(context, refuse) => ({
		MemberExpression: (node) => {
			if (isNamed(context, node, CLOCK_READS)) {
				refuse(node)
			}
		},
		NewExpression: (node) => {
			if (isNamed(context, node.callee, DATE_READS) && Arr.isReadonlyArrayEmpty(node.arguments)) {
				refuse(node)
			}
		},
		CallExpression: (node) => {
			if (isNamed(context, node.callee, DATE_READS)) {
				refuse(node)
			}
		}
	})
)
