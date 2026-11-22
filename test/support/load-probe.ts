import { registerHooks } from "node:module"
import { jsonText } from "#compiler/core/trusted.ts"

/**
 * What a program loads, recorded by a child Node process that imports this module before its entry point
 * (test/support/process.ts probedRun: the command line's usage, test/unit/cli/entry.test.ts, and the authoring entry's
 * programs, test/unit/entry/dsl.test.ts):
 *
 *   node --import test/support/load-probe.ts <entry point> <arguments>
 *
 * Before the entry point loads, it records the URL of every module Node loads after it, and as the process exits it
 * writes them to stderr on one line of its own, `loadProbe` and then their JSON, in the order Node loaded them.
 */
const probeLoads = (): void => {
	const loaded: Array<string> = []
	registerHooks({
		load: (url, context, nextLoad) => {
			loaded.push(url)
			return nextLoad(url, context)
		}
	})
	process.on("exit", () => {
		process.stderr.write(`loadProbe ${jsonText(loaded)}\n`)
	})
}

probeLoads()
