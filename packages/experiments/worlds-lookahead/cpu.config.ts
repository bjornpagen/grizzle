/**
 * The network tier's config with cpu-setup.ts in every test process: `vitest run --config
 * packages/experiments/worlds-lookahead/cpu.config.ts <files>` from the repository's root.
 */
import { fileURLToPath } from "node:url"
import { mergeConfig } from "vitest/config"
import network from "#vitest.network.config.ts"

export default mergeConfig(network, {
	root: fileURLToPath(new URL("../../..", import.meta.url)),
	test: { setupFiles: [fileURLToPath(new URL("./cpu-setup.ts", import.meta.url))] }
})
