import { limitEvidence } from "#lint/rules/limit-evidence.ts"
import { noCaseList } from "#lint/rules/no-case-list.ts"
import { noEnvironment } from "#lint/rules/no-environment.ts"
import { noModuleState } from "#lint/rules/no-module-state.ts"
import { noOptionalPublicInput } from "#lint/rules/no-optional-public-input.ts"
import { noSpreadArgument } from "#lint/rules/no-spread-argument.ts"
import { noNullUndefinedUnion } from "#lint/rules/null-undefined-union.ts"
import { sqlTextAssertion } from "#lint/rules/sql-text-assertion.ts"
import { testCaseIsSearch } from "#lint/rules/test-case-is-search.ts"
import { tupleIdentity } from "#lint/rules/tuple-identity.ts"
import { uncheckedVocabularyLiteral } from "#lint/rules/unchecked-vocabulary-literal.ts"
import type { Start } from "#lint/types.ts"

/**
 * Whether the gate runs a rule on the tree. Every rule runs against its fixtures. A pending rule is registered while the
 * tree still holds its violations: the gate leaves it out, `superlint --pending` runs it beside the rest, and it is
 * turned on, here, once its violations are fixed.
 */
type Gate = "on" | "pending"

/** One superlint rule: the id it reports under (its name in the output and its fixture directory), how it starts on a
 * program, and whether the gate runs it. Every rule visits every owned file, test files included. */
export type Rule = Readonly<{ id: string; start: Start; gate: Gate }>

/** Every rule superlint runs. Every rule visits every owned file; a rule whose options name nothing to guard in a
 * repository is inert there. A rule that reads nothing but the file starts as its own Visit. */
export const RULES: ReadonlyArray<Rule> = [
	{ id: "limit-evidence", start: () => limitEvidence, gate: "on" },
	{ id: "no-case-list", start: noCaseList, gate: "on" },
	{ id: "no-environment", start: () => noEnvironment, gate: "on" },
	{ id: "no-module-state", start: () => noModuleState, gate: "on" },
	{
		id: "no-null-undefined-union",
		start: () => noNullUndefinedUnion,
		gate: "on"
	},
	{
		id: "no-optional-public-input",
		start: noOptionalPublicInput,
		gate: "pending"
	},
	{ id: "no-spread-argument", start: () => noSpreadArgument, gate: "on" },
	{ id: "sql-text-assertion", start: () => sqlTextAssertion, gate: "on" },
	{ id: "test-case-is-search", start: testCaseIsSearch, gate: "on" },
	{ id: "tuple-identity", start: () => tupleIdentity, gate: "on" },
	{
		id: "unchecked-vocabulary-literal",
		start: () => uncheckedVocabularyLiteral,
		gate: "on"
	}
]
