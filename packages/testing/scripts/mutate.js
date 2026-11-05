#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import { fileURLToPath } from "node:url"

/**
 * The library's directory, as the URLs of its own modules begin: the realpath Node loads this file from, so the same
 * spelling every module of the library is loaded by.
 */
const library = new URL("../", import.meta.url).href

/**
 * `grizzle-mutate`, the mutation tester's command for a package that has this library in its node_modules: it runs
 * scripts/mutate.ts with every flag it is given, in a Node of its own. Node strips no types from a file under
 * node_modules, and the library ships TypeScript source, so the child imports this module first (`--import`), which
 * registers a load hook that strips the types of the library's own `.ts` modules and leaves every other module to Node;
 * the run then loads as it does in the library's own checkout. The child's exit code, or the signal that ended it, is
 * this process's.
 */
const runMutate = () => {
	const child = spawn(
		process.execPath,
		[
			...process.execArgv,
			"--import",
			import.meta.url,
			fileURLToPath(new URL("mutate.ts", import.meta.url)),
			...process.argv.slice(2)
		],
		{ stdio: "inherit" }
	)
	child.on("exit", (code, signal) => {
		if (signal === null) {
			process.exitCode = code ?? 1
		} else {
			process.kill(process.pid, signal)
		}
	})
}

/** The load hook the child imports this module for: the library's TypeScript, stripped, as ES modules. */
const stripLibraryTypes = () => {
	registerHooks({
		load: (url, context, nextLoad) =>
			url.startsWith(library) && url.endsWith(".ts")
				? {
						format: "module",
						source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")),
						shortCircuit: true
					}
				: nextLoad(url, context)
	})
}

if (import.meta.main) {
	runMutate()
} else {
	stripLibraryTypes()
}
