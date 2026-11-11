import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { inject } from "vitest"

/**
 * The setup file a mutation run adds to every test file: before the test file loads, Node's module loader is hooked so
 * that the run's mutated file is what every import of its target loads, and every other module loads as it is.
 */
const mutated = inject("superstarter.testing.mutated")

const target = pathToFileURL(mutated.target).href

registerHooks({
	load: (url, context, nextLoad) =>
		url === target
			? { format: "module-typescript", source: mutated.text, shortCircuit: true }
			: nextLoad(url, context)
})
