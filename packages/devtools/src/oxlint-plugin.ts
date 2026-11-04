import type { Rule } from "#oxlint/rule.ts"
import { brandsSoleMint } from "#oxlint/rules/brands-sole-mint.ts"
import { importDoors } from "#oxlint/rules/import-doors.ts"
import { noComment } from "#oxlint/rules/no-comment.ts"
import { noDefaultParameter } from "#oxlint/rules/no-default-parameter.ts"
import { noDynamicImports } from "#oxlint/rules/no-dynamic-imports.ts"
import { noInlineSuppression } from "#oxlint/rules/no-inline-suppression.ts"
import { noNewError } from "#oxlint/rules/no-new-error.ts"
import { noOptionBridge } from "#oxlint/rules/no-option-bridge.ts"
import { noOptionalParameter } from "#oxlint/rules/no-optional-parameter.ts"
import { noOverload } from "#oxlint/rules/no-overload.ts"
import { noPointlessTypeAlias } from "#oxlint/rules/no-pointless-type-alias.ts"
import { noRawRegexp } from "#oxlint/rules/no-raw-regexp.ts"
import { noRawSql } from "#oxlint/rules/no-raw-sql.ts"
import { noSwitchDefaultBailout } from "#oxlint/rules/no-switch-default-bailout.ts"
import { noTry } from "#oxlint/rules/no-try.ts"
import { noUselessContinue } from "#oxlint/rules/no-useless-continue.ts"
import { preferEarlyReturn } from "#oxlint/rules/prefer-early-return.ts"
import { testNoProseSearch } from "#oxlint/rules/test-no-prose-search.ts"
import { testNoSpelledNames } from "#oxlint/rules/test-no-spelled-names.ts"

/** Every rule of the plugin, by its name. */
const PLUGIN_RULES = {
	"brands-sole-mint": brandsSoleMint,
	"import-doors": importDoors,
	"no-comment": noComment,
	"no-default-parameter": noDefaultParameter,
	"no-dynamic-imports": noDynamicImports,
	"no-inline-suppression": noInlineSuppression,
	"no-new-error": noNewError,
	"no-option-bridge": noOptionBridge,
	"no-optional-parameter": noOptionalParameter,
	"no-overload": noOverload,
	"no-pointless-type-alias": noPointlessTypeAlias,
	"no-raw-regexp": noRawRegexp,
	"no-raw-sql": noRawSql,
	"no-switch-default-bailout": noSwitchDefaultBailout,
	"no-try": noTry,
	"no-useless-continue": noUselessContinue,
	"prefer-early-return": preferEarlyReturn,
	"test-no-prose-search": testNoProseSearch,
	"test-no-spelled-names": testNoSpelledNames
} as const satisfies Readonly<Record<string, Rule>>

/**
 * The oxlint plugin: the syntactic rules oxlint has no built-in rule for. Each rule reads syntax alone; type-aware rules live in superlint (src/lint.ts). The preset
 * (src/preset.ts) loads it through `jsPlugins`, enables every rule and passes each project's names as rule options;
 * Node strips its types.
 */
const plugin: Readonly<{ meta: Readonly<{ name: string }>; rules: typeof PLUGIN_RULES }> = {
	meta: { name: "devtools" },
	rules: PLUGIN_RULES
}

export default plugin
