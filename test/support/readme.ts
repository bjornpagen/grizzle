import { String as Str } from "effect"

/**
 * The README's program, as the tests that hold the README to checked code read it: its two modules, readme.ts, what
 * grizzle compiles, and readme.app.ts, the application (test/types/examples/documents.ts), and how the application's
 * module, and SKILL.md's, name readme.ts, which a program written outside the repository (a type batch's, a
 * consumer's) names by its file.
 */
export const readmeModules = [
	"test/types/examples/fixtures/readme.ts",
	"test/types/examples/fixtures/readme.app.ts"
] as const

/** How the README's application module and SKILL.md's name readme.ts in the repository. */
const readmeSpecifier = "#test/types/examples/fixtures/readme.ts"

/** A module's text as a program outside the repository holds it: readme.ts named by its file, `./readme.ts`. */
export const outsideTheRepository = (text: string): string =>
	Str.replaceAll(readmeSpecifier, "./readme.ts")(text)
