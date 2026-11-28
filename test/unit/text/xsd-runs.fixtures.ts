/**
 * What xsd.test.ts compares the committed table of general categories with: the unicode generator's runs over the
 * running Node (scripts/gen/unicode/generate.ts), read once.
 */

import { generalCategories } from "@bjornpagen/grizzle-text/regex/categories.generated"
import { Function } from "effect"
import { runsOfRunningNode } from "#scripts/gen/unicode/generate.ts"

/** The generator's runs over the running Node, read once, as the committed table's ought to be. */
const runsOver = Function.memoize((_: typeof generalCategories): string => runsOfRunningNode())
export const generatedRuns = (): string => runsOver(generalCategories)
