import { Array as Arr } from "effect"
import { refusal } from "#oxlint/rule.ts"
import { isNamed } from "#oxlint/syntax.ts"

/** The reads of the current time. */
const CLOCK_READS: ReadonlyArray<string> = [
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
			if (isNamed(context, node.callee, ["Date"]) && Arr.isReadonlyArrayEmpty(node.arguments)) {
				refuse(node)
			}
		},
		CallExpression: (node) => {
			if (isNamed(context, node.callee, ["Date"])) {
				refuse(node)
			}
		}
	})
)
