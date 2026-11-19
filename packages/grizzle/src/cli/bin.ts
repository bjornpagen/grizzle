#!/usr/bin/env -S node --disable-proto=delete --disable-sigusr1
import { enableCompileCache } from "node:module"

/**
 * The command line (main.ts), loaded with Node's compile cache on, so a run reads each module's stripped TypeScript and
 * compiled code from the cache an earlier run wrote, keyed by the module's content and Node's version, where every run
 * stripped and compiled every module of grizzle's again. The cache reaches only the modules loaded after it is on
 * (https://nodejs.org/docs/v26.13.0/api/module.html#module-compile-cache), so the bin, the one module loaded before it,
 * imports the command line after it. The directory is Node's: NODE_COMPILE_CACHE's, else Node's own under the system's
 * temporary directory.
 */
const commandLine = () => {
	enableCompileCache()
	return import("#cli/main.ts")
}

/**
 * The `grizzle` bin: the command line, run only as the program Node runs, so a module that imports the bin (the
 * dependency audit loads every entry point) runs nothing.
 */
const { runCommand } = await commandLine()
if (import.meta.main) {
	runCommand()
}
