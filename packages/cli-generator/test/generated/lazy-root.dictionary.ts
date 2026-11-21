import { dictionary } from "@bjornpagen/testing/dictionary"

/** What an invocation names. */
export type InvocationFeature =
	| "the root's help"
	| "no arguments"
	| "--describe"
	| "--completions bash"
	| "an unknown group"
	| "a group alone"
	| "a group's help"
	| "an unknown command in a group"
	| "a command's help"

/** Every kind of invocation, in the order the differential lists them. */
export const invocationFeatures = dictionary<InvocationFeature>([
	"the root's help",
	"no arguments",
	"--describe",
	"--completions bash",
	"an unknown group",
	"a group alone",
	"a group's help",
	"an unknown command in a group",
	"a command's help"
])
