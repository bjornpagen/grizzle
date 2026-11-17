/**
 * The generator's property modules, from the package root: the test modules toolchain-test runs (test.config.ts) and
 * Vitest leaves out (vitest.config.ts). Both runners read this one list, so a module runs on exactly one of them, and a
 * module converted to properties moves from Vitest to the runner by entering it, in the commit that converts it. The
 * list grows as each directory is converted, until it names every test module and Vitest's configs go.
 */
export const propertyModules: ReadonlyArray<string> = []
