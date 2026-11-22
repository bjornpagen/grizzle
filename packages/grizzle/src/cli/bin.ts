#!/usr/bin/env -S node --disable-proto=delete --disable-sigusr1
import { enableCompileCache } from "node:module"
import { argumentsStart, helpAsked, helpText } from "#cli/usage.ts"

/**
 * The command line (main.ts), loaded with Node's compile cache on, so a run reads each module's stripped TypeScript and
 * compiled code from the cache an earlier run wrote, keyed by the module's content and Node's version, where every run
 * stripped and compiled every module of grizzle's again. The cache reaches only the modules loaded after it is on
 * (https://nodejs.org/docs/v26.13.0/api/module.html#module-compile-cache), so the bin and the usage it answers alone
 * (usage.ts), the modules loaded before it, import the command line after it. The directory is Node's:
 * NODE_COMPILE_CACHE's, else Node's own under the system's temporary directory. A process environment that sets
 * NODE_DISABLE_COMPILE_CACHE runs with none, as Node holds it: the environment's owner decides, never the bin.
 */
const commandLine = () => {
	enableCompileCache()
	return import("#cli/main.ts")
}

/**
 * Whether the `grizzle` bin, run as the program Node runs, was given a command line that asks for the usage alone
 * (usage.ts helpAsked): it is answered with the usage here, as the command line answers it, and loads nothing of the
 * command line, whose modules, the engine's among them, the usage needs none of (`grizzle --help` loaded 967 modules and
 * spent 3.1 s of CPU before it printed). Any other runs the command line, only as the program Node runs, so a module
 * that imports the bin (the dependency audit loads every entry point) loads the command line and runs nothing.
 */
const usageAlone: boolean = import.meta.main && helpAsked(process.argv.slice(argumentsStart))

if (usageAlone) {
	process.stdout.write(`${helpText}\n`)
} else {
	const { runCommand } = await commandLine()
	if (import.meta.main) {
		runCommand()
	}
}
