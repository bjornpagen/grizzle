import { registerHooks } from "node:module"
import { jsonText } from "#compiler/core/trusted.ts"

/**
 * What a command line loads, recorded by a child Node process that imports this module before its entry point
 * (entry.test.ts's usage property):
 *
 *   node --import test/unit/cli/load-probe.ts packages/grizzle/src/cli/bin.ts <arguments>
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
