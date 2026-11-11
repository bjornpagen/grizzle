import type { PluginOptions } from "babel-plugin-react-compiler"

/**
 * The React Compiler's options, stated once: a Next app's next.config.ts builds with them, and the react-compiler
 * check compiles every source of the app's program with them, so a component or hook the compiler refuses fails
 * `pnpm check` exactly as it fails `next build`. At `all_errors` every function the compiler cannot compile is an
 * error, never a function left silently unmemoized.
 */
export const REACT_COMPILER_OPTIONS = {
	panicThreshold: "all_errors"
} as const satisfies PluginOptions
