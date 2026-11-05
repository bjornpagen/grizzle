import { limitEvidence } from "#lint/rules/limit-evidence.ts"
import { noEnvironment } from "#lint/rules/no-environment.ts"
import { noModuleState } from "#lint/rules/no-module-state.ts"
import { noSpreadArgument } from "#lint/rules/no-spread-argument.ts"
import { noNullUndefinedUnion } from "#lint/rules/null-undefined-union.ts"
import { sqlTextAssertion } from "#lint/rules/sql-text-assertion.ts"
import { uncheckedVocabularyLiteral } from "#lint/rules/unchecked-vocabulary-literal.ts"
import type { Visit } from "#lint/types.ts"

/** The files a rule visits: every owned file, or every owned file but the test files (the preset's isTestFile), where
 * the rule guards product code only. */
type Scope = "every file" | "outside tests"

/** Every rule superlint runs, by the id it reports under: its name in the output and its fixture directory. Every
 * rule visits every owned file of its scope; a rule whose options name nothing to guard in a repository is inert there. */
export const RULES: ReadonlyArray<Readonly<{ id: string; visit: Visit; scope: Scope }>> = [
	{ id: "limit-evidence", visit: limitEvidence, scope: "every file" },
	{ id: "no-environment", visit: noEnvironment, scope: "every file" },
	{ id: "no-module-state", visit: noModuleState, scope: "outside tests" },
	{ id: "no-null-undefined-union", visit: noNullUndefinedUnion, scope: "every file" },
	{ id: "no-spread-argument", visit: noSpreadArgument, scope: "every file" },
	{ id: "sql-text-assertion", visit: sqlTextAssertion, scope: "every file" },
	{ id: "unchecked-vocabulary-literal", visit: uncheckedVocabularyLiteral, scope: "every file" }
]
