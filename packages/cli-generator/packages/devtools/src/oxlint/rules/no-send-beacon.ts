import { Option } from "effect"
import { problem } from "#oxlint/rule.ts"
import { calleeNameOf } from "#oxlint/syntax.ts"

const MESSAGE =
	"navigator.sendBeacon and PostHog's sendBeacon transport never retry. Analytics events take PostHog's ordinary path, which retries; a project's own presence beacon is on this rule's exception list."

/** `navigator.sendBeacon(...)`, and a `transport: "sendBeacon"` option. */
export const noSendBeacon = problem((context) => ({
	CallExpression: (node) => {
		if (Option.contains(calleeNameOf(node.callee), "navigator.sendBeacon")) {
			context.report({ node, message: MESSAGE })
		}
	},
	Property: (node) => {
		if (
			node.key.type === "Identifier" &&
			node.key.name === "transport" &&
			!node.computed &&
			node.value.type === "Literal" &&
			node.value.value === "sendBeacon"
		) {
			context.report({ node, message: MESSAGE })
		}
	}
}))
