import { limitEvidence } from "#lint/rules/limit-evidence.ts"
import { noCaseList } from "#lint/rules/no-case-list.ts"
import { noEnvironment } from "#lint/rules/no-environment.ts"
import { noModuleState } from "#lint/rules/no-module-state.ts"
import { noOptionalPublicInput } from "#lint/rules/no-optional-public-input.ts"
import { noSpreadArgument } from "#lint/rules/no-spread-argument.ts"
import { noNullUndefinedUnion } from "#lint/rules/null-undefined-union.ts"
import { sqlTextAssertion } from "#lint/rules/sql-text-assertion.ts"
import { testCaseIsSearch } from "#lint/rules/test-case-is-search.ts"
import { uncheckedVocabularyLiteral } from "#lint/rules/unchecked-vocabulary-literal.ts"
import type { Start } from "#lint/types.ts"

/** The files a rule visits: every owned file, or every owned file but the test files (the preset's isTestFile), where
 * the rule guards product code only. */
type Scope = "every file" | "outside tests"

/**
 * Whether the gate runs a rule on the tree. Every rule runs against its fixtures. A pending rule is registered while the
 * tree still holds its violations: the gate leaves it out, `superlint --pending` runs it beside the rest, and it is
 * turned on, here, once its violations are fixed.
 */
type Gate = "on" | "pending"

/** One superlint rule: the id it reports under (its name in the output and its fixture directory), how it starts on a
 * program, the files it visits, and whether the gate runs it. */
export type Rule = Readonly<{ id: string; start: Start; scope: Scope; gate: Gate }>

/** Every rule superlint runs. Every rule visits every owned file of its scope; a rule whose options name nothing to
 * guard in a repository is inert there. A rule that reads nothing but the file starts as its own Visit. */
export const RULES: ReadonlyArray<Rule> = [
	{ id: "limit-evidence", start: () => limitEvidence, scope: "every file", gate: "on" },
	{ id: "no-case-list", start: noCaseList, scope: "every file", gate: "pending" },
	{ id: "no-environment", start: () => noEnvironment, scope: "every file", gate: "on" },
	{ id: "no-module-state", start: () => noModuleState, scope: "outside tests", gate: "on" },
	{
		id: "no-null-undefined-union",
		start: () => noNullUndefinedUnion,
		scope: "every file",
		gate: "on"
	},
	{
		id: "no-optional-public-input",
		start: noOptionalPublicInput,
		scope: "every file",
		gate: "pending"
	},
	{ id: "no-spread-argument", start: () => noSpreadArgument, scope: "every file", gate: "on" },
	{ id: "sql-text-assertion", start: () => sqlTextAssertion, scope: "every file", gate: "on" },
	{ id: "test-case-is-search", start: testCaseIsSearch, scope: "every file", gate: "pending" },
	{
		id: "unchecked-vocabulary-literal",
		start: () => uncheckedVocabularyLiteral,
		scope: "every file",
		gate: "on"
	}
]
