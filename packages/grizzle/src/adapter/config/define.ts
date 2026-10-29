import { Option } from "effect"
import type { GrizzleConfig } from "#adapter/types/config.ts"

/**
 * The configurations defineConfig typed, by identity. The command line reads only these: a configuration is always
 * `export default defineConfig({ ... })`, so an Effect password, whose requirements and error channel exist only in its
 * type, is always one defineConfig's signature typed as an Effect of a Redacted, failing with CredentialError, with no
 * requirement.
 */
const defined = new WeakMap<object, GrizzleConfig>()

/**
 * defineConfig, the identity function that types grizzle.config.ts (its shape: packages/grizzle/src/adapter/types/config.ts).
 *
 * This module is public: the connection barrel (packages/grizzle/src/adapter/public/layer.ts) re-exports it. It imports no Node module,
 * so the package root stays free of them. The command line (config.ts) reads the configurations defineConfig typed
 * from this module's one registry: the bin and the application import this one file, through the package's export and
 * through config.ts, so they share its module instance and its WeakMap.
 *
 * The identity function that types a configuration: `export default defineConfig({ ... })`.
 */
export const defineConfig = <const C extends GrizzleConfig>(config: C): C => {
	defined.set(config, config)
	return config
}

/** The configuration defineConfig typed as `value`, when it did. Not re-exported by the public barrel. */
export const definedConfig = (value: object): Option.Option<GrizzleConfig> =>
	Option.fromUndefinedOr(defined.get(value))
