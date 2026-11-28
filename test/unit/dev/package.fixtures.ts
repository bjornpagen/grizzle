/** What the properties of package.test.ts read: the consumer's compiler options and the mirrored programs. */

import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { readmeModules } from "#test/support/readme.ts"

/**
 * The compiler options a consumer of the README's programs checks `include` under: the repository's own strictness, Node's
 * types, and nothing of the repository's tsconfigs: no project references, no paths.
 */
export const mirrorTsconfig = (include: ReadonlyArray<string>): string => `{
	"compilerOptions": {
		"target": "esnext",
		"lib": ["esnext"],
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"moduleDetection": "force",
		"strict": true,
		"exactOptionalPropertyTypes": true,
		"noUncheckedIndexedAccess": true,
		"allowImportingTsExtensions": true,
		"noEmit": true,
		"skipLibCheck": true,
		"types": ["node"]
	},
	"include": [${Arr.join(
		Arr.map(include, (file) => `"${file}"`),
		", "
	)}]
}
`

/**
 * The README's and SKILL.md's mirrored programs, which the type batch holds to their blocks, each the modules a consumer
 * checks: the README's two, and SKILL.md's beside the README's it imports.
 */
export const mirrors = {
	readme: readmeModules,
	skill: [...readmeModules, "test/types/examples/fixtures/skill.ts"]
} as const

/** A mirrored program: the README's, or SKILL.md's, which imports the README's. */
export type Mirror = keyof typeof mirrors

/** A mirrored program as a case draws it. */
const mirrorGen: Gen<Mirror> = element<Mirror>(["readme", "skill"])

/** The box: each mirrored program, checked with what it imports. */
export const mirrorBox = finite(mirrorGen)
