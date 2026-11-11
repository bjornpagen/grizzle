import { Array as Arr, Option, Record } from "effect"
import type { DummyRule, DummyRuleMap, OxlintConfig, OxlintOverride } from "oxlint"
import plugin from "#oxlint-plugin.ts"
import type { OptionsOf } from "#oxlint/rule.ts"
import { TEST_SUFFIXES } from "#shared/tests.ts"

/**
 * superstarter's lint preset. The root oxlint.config.ts calls `lintConfig` with the repository's own lists (ignored
 * paths, restricted modules, the files where no-shadow is ceremony, the plugin's names and the exception blocks);
 * everything else is the standard.
 */

/**
 * Lint rules rejected on purpose, each with why it is off. Each is off in every block of every configuration the
 * preset builds, naming one in a block is a type error, and turning one back on needs the owner.
 */
export const REJECTED = {
	"eslint/constructor-super": "the compiler owns it (TS2335, TS2377)",
	"eslint/getter-return": "the compiler owns it (TS2378)",
	"eslint/init-declarations":
		"it forces an initializer on every let, which is a sentinel, and definite-assignment analysis already proves an uninitialized let is set on every path",
	"eslint/max-depth": "it breeds single-use helpers to cut nesting",
	"eslint/no-class-assign": "the compiler owns it (TS2629)",
	"eslint/no-const-assign": "the compiler owns it (TS2588)",
	"eslint/no-dupe-class-members": "the compiler owns it (TS2393, TS2300)",
	"eslint/no-dupe-keys": "the compiler owns it (TS1117)",
	"eslint/no-fallthrough": "the compiler owns it (noFallthroughCasesInSwitch)",
	"eslint/no-func-assign": "the compiler owns it (TS2630)",
	"eslint/no-implied-eval": "its type-aware twin typescript/no-implied-eval owns it",
	"eslint/no-import-assign": "the compiler owns it (TS2632, TS2540)",
	"eslint/no-inner-declarations":
		"it is an ES5-era rule: a block-level function is legal in a strict module",
	"eslint/no-new-native-nonconstructor": "the compiler owns it (TS7009)",
	"eslint/no-obj-calls": "the compiler owns it (TS2349)",
	"eslint/no-redeclare":
		"it flags a type and a value of the same name, such as a brand and its mint or a Schema and its type, which TypeScript allows, and TypeScript already refuses a real redeclaration",
	"eslint/no-setter-return": "the compiler owns it (TS2408)",
	"eslint/no-this-before-super": "the compiler owns it (TS2376, TS17009)",
	"eslint/no-throw-literal": "it is deprecated, and typescript/only-throw-error owns it",
	"eslint/no-underscore-dangle": "it is naming taste that already needs an allow-list",
	"eslint/no-unreachable": "the compiler owns it (allowUnreachableCode: false)",
	"eslint/no-unsafe-negation": "the compiler owns it (TS2365, TS2322, TS2358)",
	"eslint/no-unsafe-optional-chaining": "the compiler owns it (strictNullChecks: TS2722, TS18048)",
	"eslint/no-unused-labels": "the compiler owns it (allowUnusedLabels: false)",
	"eslint/no-unused-private-class-members":
		"the compiler owns it (noUnusedLocals, noUnusedParameters)",
	"eslint/no-unused-vars": "the compiler owns it (noUnusedLocals, noUnusedParameters)",
	"eslint/no-use-before-define":
		"with functions, classes and variables allowed only the temporal dead zone remains, which the compiler owns (TS2448, TS2449)",
	"eslint/no-with": "the compiler owns it (TS1101, TS2410)",
	"eslint/prefer-regex-literals":
		"it pushes toward regex literals, and arkregex's regex() is the only regex form",
	"eslint/prefer-spread":
		"it turns f.apply(this, list) into f(...list), a variable-length list on the call stack, which superlint's no-spread-argument refuses",
	"eslint/preserve-caught-error": "try/catch is Effect's tryCatchInEffectGen's",
	"eslint/require-await": "async is banned, and Effect's asyncFunction owns it",
	"import/no-absolute-path": "it came only with the suspicious category, which is off",
	"import/no-empty-named-blocks": "it came only with the suspicious category, which is off",
	"import/no-named-as-default": "it came only with the suspicious category, which is off",
	"import/no-named-as-default-member": "it came only with the suspicious category, which is off",
	"import/no-self-import": "it came only with the suspicious category, which is off",
	"jsx-a11y/prefer-tag-over-role":
		"it equates an ARIA role with a tag that means something else: output for a status, img for a drawing",
	"node/no-sync": "Effect's nodeBuiltinImport owns it",
	"oxc/no-async-endpoint-handlers": "async is banned, and Effect's asyncFunction owns it",
	"oxc/no-const-enum": "erasableSyntaxOnly already refuses every enum",
	"react/exhaustive-deps":
		"the React Compiler hook rules (react/exhaustive-effect-dependencies, react/memo-dependencies) check the same thing",
	"react/no-array-index-key": "every list it flagged is positional, so it only produced disables",
	"react/no-unstable-nested-components":
		"it misfires on Effect's Option.match and Arr.map render callbacks, which return elements, not components",
	"react/react-in-jsx-scope": "the automatic JSX runtime needs no React in scope",
	"react/rules-of-hooks": "the React Compiler hook rule react/hooks checks the same thing",
	"typescript/ban-types":
		"it is deprecated, and no-empty-object-type, no-unsafe-function-type and no-wrapper-object-types own it",
	"typescript/consistent-return":
		"it contradicts Effect's missingReturnYieldStar (return yield*) and exhaustive switches without a default, and noImplicitReturns already refuses a real missing return",
	"typescript/consistent-type-exports": "verbatimModuleSyntax already makes it a compiler error",
	"typescript/consistent-type-imports": "verbatimModuleSyntax already makes it a compiler error",
	"typescript/no-confusing-void-expression":
		"it forces block bodies on void callbacks, and typescript/no-misused-promises and Effect's floatingEffect own the real bugs",
	"typescript/no-empty-interface": "it is deprecated, and typescript/no-empty-object-type owns it",
	"typescript/no-invalid-void-type":
		"oxlint's port refuses void as a type argument (Promise.withResolvers<void>()), which the rule exists to allow",
	"typescript/no-mixed-enums": "erasableSyntaxOnly already refuses every enum",
	"typescript/no-unnecessary-qualifier":
		"erasableSyntaxOnly already refuses every enum and runtime namespace",
	"typescript/no-unnecessary-type-assertion":
		"typescript/consistent-type-assertions already bans every cast",
	"typescript/no-unsafe-enum-comparison": "erasableSyntaxOnly already refuses every enum",
	"typescript/no-unsafe-type-assertion":
		"typescript/consistent-type-assertions already bans every cast",
	"typescript/non-nullable-type-assertion-style":
		"it recommends the non-null assertion, which typescript/no-non-null-assertion bans",
	"typescript/prefer-enum-initializers": "erasableSyntaxOnly already refuses every enum",
	"typescript/prefer-literal-enum-member": "erasableSyntaxOnly already refuses every enum",
	"typescript/prefer-readonly-parameter-types":
		"it needs an allow-list of every library, error and resource type, sees through no alias, and refuses state that is mutable by design",
	"typescript/promise-function-async": "async is banned",
	"typescript/require-await": "async is banned, and Effect's asyncFunction owns it",
	"typescript/return-await": "async is banned, and Effect's asyncFunction owns it",
	"typescript/strict-void-return":
		"it forces block bodies on void callbacks, and typescript/no-misused-promises and Effect's floatingEffect own the real bugs",
	"unicorn/consistent-function-scoping": "it moves a helper away from its one use",
	"unicorn/explicit-length-check": "it is opinion",
	"unicorn/no-array-for-each": "it misreads Effect's Arr.forEach and only enforces taste",
	"unicorn/no-instanceof-array": "unicorn/no-instanceof-builtins covers it",
	"unicorn/no-static-only-class": "its type-aware twin typescript/no-extraneous-class owns it",
	"unicorn/no-unnecessary-await": "its type-aware twin typescript/await-thenable owns it",
	"unicorn/prefer-array-index-of": "it pushes toward indexOf, whose -1 is a sentinel",
	"unicorn/prefer-date-now": "Effect's globalDate owns it",
	"unicorn/prefer-string-starts-ends-with":
		"its type-aware twin typescript/prefer-string-starts-ends-with owns it"
} as const satisfies Record<string, string>

type Rejected = keyof typeof REJECTED

/** Every rejected rule, off. */
const OFF: Readonly<Record<Rejected, "off">> = Record.map(REJECTED, () => "off" as const)

/** A block's rules: naming a rejected rule is a type error. */
export type ActiveRules = DummyRuleMap & Partial<Record<Rejected, never>>

/** A block's rules, refused by type when they name a rejected rule. lintConfig turns every rejected rule off after
 * each block, so no block can bring one back. */
export const active = <const R extends ActiveRules>(rules: R): R => rules

/**
 * Effect language-service diagnostics rejected on purpose, each with why it is off. The shared tsconfig base sets
 * exactly these to off, every other diagnostic the installed @effect/tsgo ships to error, and superlint at the
 * repository root refuses any tsconfig whose offs differ.
 */
export const REJECTED_DIAGNOSTICS = {
	apiStabilityLeak: "unstable Effect APIs stay usable, so exposing one is no defect",
	experimentalApiUsage:
		"unstable Effect APIs stay usable, so using an experimental one is no defect",
	missingPipeableSignature:
		"Function.dual is an overload in disguise that dispatches on arguments.length on every call, for a data-last form almost nothing calls (owner, 2026-10-26)",
	unstableApiUsage: "Effect's whole Node platform layer is marked unstable"
} as const satisfies Record<string, string>

/** The rules the preset turns on everywhere, with their generic options: the correctness category's reviewed
 * additions. Lists that name a project's own modules or files come from the project. */
export const GENERIC_RULES = {
	"eslint/array-callback-return": ["error", { checkForEach: true }],
	"eslint/block-scoped-var": "error",
	"eslint/curly": ["error", "all"],
	"eslint/default-case-last": "error",
	"eslint/default-param-last": "error",
	"eslint/eqeqeq": ["error", "always", { null: "ignore" }],
	"eslint/no-array-constructor": "error",
	"eslint/no-case-declarations": "error",
	"eslint/no-constructor-return": "error",
	"eslint/no-else-return": ["error", { allowElseIf: false }],
	"eslint/no-extend-native": "error",
	"eslint/no-extra-bind": "error",
	"eslint/no-extra-label": "error",
	"eslint/no-label-var": "error",
	"eslint/no-labels": ["error", { allowLoop: true }],
	"eslint/no-lone-blocks": "error",
	"eslint/no-multi-assign": "error",
	"eslint/no-new": "error",
	"eslint/no-param-reassign": "error",
	"eslint/no-proto": "error",
	"eslint/no-prototype-builtins": "error",
	"eslint/no-regex-spaces": "error",
	"eslint/no-return-assign": ["error", "except-parens"],
	"eslint/no-script-url": "error",
	"eslint/no-self-compare": "error",
	"eslint/no-sequences": "error",
	"eslint/no-shadow": "error",
	"eslint/no-template-curly-in-string": "error",
	"eslint/no-unexpected-multiline": "error",
	"eslint/no-unmodified-loop-condition": "error",
	"eslint/no-unneeded-ternary": "error",
	"eslint/no-useless-computed-key": "error",
	"eslint/no-useless-concat": "error",
	"eslint/no-useless-constructor": "error",
	"eslint/no-var": "error",
	"eslint/one-var": ["error", "never"],
	"eslint/prefer-arrow-callback": "error",
	"eslint/prefer-const": ["error", { ignoreReadBeforeAssign: true }],
	"eslint/prefer-exponentiation-operator": "error",
	"eslint/prefer-numeric-literals": "error",
	"eslint/prefer-object-has-own": "error",
	"eslint/prefer-rest-params": "error",
	"eslint/prefer-template": "error",
	"eslint/radix": "error",
	"import/extensions": ["error", "always", { ignorePackages: true, checkTypeImports: true }],
	"jsx-a11y/anchor-ambiguous-text": "error",
	"node/no-exports-assign": "error",
	"oxc/approx-constant": "error",
	"oxc/misrefactored-assign-op": "error",
	"oxc/no-accumulating-spread": "error",
	"oxc/no-barrel-file": ["error", { threshold: 0 }],
	"oxc/no-this-in-exported-function": "error",
	"react/button-has-type": "error",
	"react/capitalized-calls": "error",
	"react/exhaustive-effect-dependencies": "error",
	"react/hooks": "error",
	"react/iframe-missing-sandbox": "error",
	"react/jsx-no-comment-textnodes": "error",
	"react/jsx-no-script-url": "error",
	"react/jsx-no-target-blank": "error",
	"react/jsx-no-useless-fragment": "error",
	"react/memo-dependencies": "error",
	"react/no-danger": "error",
	"react/no-namespace": "error",
	"react/self-closing-comp": "error",
	"react/style-prop-object": "error",
	"typescript/adjacent-overload-signatures": "error",
	"typescript/ban-ts-comment": [
		"error",
		{ "ts-check": true, "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true }
	],
	"typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
	"typescript/dot-notation": "error",
	"typescript/no-confusing-non-null-assertion": "error",
	"typescript/no-deprecated": "error",
	"typescript/no-empty-object-type": "error",
	"typescript/no-explicit-any": "error",
	"typescript/no-extraneous-class": "error",
	"typescript/no-generated-empty-object-type": "error",
	"typescript/no-inferrable-types": "error",
	"typescript/no-misused-promises": "error",
	"typescript/no-non-null-assertion": "error",
	"typescript/no-unnecessary-boolean-literal-compare": "error",
	"typescript/no-unnecessary-condition": "error",
	"typescript/no-unnecessary-template-expression": "error",
	"typescript/no-unnecessary-type-arguments": "error",
	"typescript/no-unnecessary-type-constraint": "error",
	"typescript/no-unnecessary-type-conversion": "error",
	"typescript/no-unnecessary-type-parameters": "error",
	"typescript/no-unsafe-argument": "error",
	"typescript/no-unsafe-assignment": "error",
	"typescript/no-unsafe-call": "error",
	"typescript/no-unsafe-function-type": "error",
	"typescript/no-unsafe-member-access": "error",
	"typescript/no-unsafe-return": "error",
	"typescript/only-throw-error": "error",
	"typescript/prefer-find": "error",
	"typescript/prefer-function-type": "error",
	"typescript/prefer-includes": "error",
	"typescript/prefer-nullish-coalescing": "error",
	"typescript/prefer-optional-chain": "error",
	"typescript/prefer-promise-reject-errors": "error",
	"typescript/prefer-readonly": "error",
	"typescript/prefer-reduce-type-parameter": "error",
	"typescript/prefer-regexp-exec": "error",
	"typescript/prefer-return-this-type": "error",
	"typescript/prefer-string-starts-ends-with": "error",
	"typescript/related-getter-setter-pairs": "error",
	"typescript/restrict-plus-operands": "error",
	"typescript/switch-exhaustiveness-check": [
		"error",
		{ allowDefaultCaseForExhaustiveSwitch: false }
	],
	"typescript/use-unknown-in-catch-callback-variable": "error",
	"unicorn/new-for-builtins": "error",
	"unicorn/no-accessor-recursion": "error",
	"unicorn/no-array-fill-with-reference-type": "error",
	"unicorn/no-array-reverse": "error",
	"unicorn/no-array-sort": "error",
	"unicorn/no-confusing-array-with": "error",
	"unicorn/no-document-cookie": "error",
	"unicorn/no-instanceof-builtins": ["error", { useErrorIsError: true }],
	"unicorn/no-useless-switch-case": "error",
	"unicorn/prefer-add-event-listener": "error",
	"unicorn/prefer-array-flat": "error",
	"unicorn/prefer-array-flat-map": "error",
	"unicorn/prefer-dom-node-text-content": "error",
	"unicorn/prefer-math-min-max": "error",
	"unicorn/prefer-node-protocol": "error",
	"unicorn/prefer-number-properties": ["error", { checkInfinity: true }],
	"unicorn/require-module-specifiers": "error",
	"unicorn/require-post-message-target-origin": "error"
} as const satisfies ActiveRules

/** Relative imports are banned everywhere: a file reaches its package's files through `#` subpath imports. */
const RELATIVE_IMPORTS: RestrictedPattern = {
	group: [".", "..", "./**", "../**"],
	message:
		"Relative imports are banned. Use a `#` subpath import with the real file extension (`#lib/cn.ts`)."
}

/** One module, some of its exports, or all but some of them (`allowImportNames`), a project bans, and why. */
type RestrictedPath = Readonly<{
	name: string
	importNames?: ReadonlyArray<string>
	allowImportNames?: ReadonlyArray<string>
	allowTypeImports?: boolean
	message: string
}>

/** One glob of modules a project bans, and why. */
type RestrictedPattern = Readonly<{
	group: ReadonlyArray<string>
	importNames?: ReadonlyArray<string>
	allowTypeImports?: boolean
	message: string
}>

/** A project's no-restricted-imports lists. */
export type RestrictedImports = Readonly<{
	paths: ReadonlyArray<RestrictedPath>
	patterns: ReadonlyArray<RestrictedPattern>
}>

/** Effect's metrics reach no exporter: a fact belongs on its span, and a count or a rate is a query over spans. */
const EFFECT_METRICS_MESSAGE =
	"Effect metrics are exported nowhere: put the fact on its span (Effect.annotateCurrentSpan); counts and rates are queries over spans."

/** eslint/no-restricted-imports with a project's lists and the shared relative-import ban. A project's exception
 * block that narrows the lists for some files calls it too, so the relative ban stays on there. */
export const restrictedImports = (lists: RestrictedImports): DummyRule => [
	"error",
	{
		paths: [...lists.paths, { name: "effect/Metric", message: EFFECT_METRICS_MESSAGE }],
		patterns: [...lists.patterns, RELATIVE_IMPORTS]
	}
]

/** One property a project bans, and why. */
export type RestrictedProperty = Readonly<{ object?: string; property: string; message: string }>

/** Effect's metric constructors, banned wherever they are reached from. */
const EFFECT_METRICS: ReadonlyArray<RestrictedProperty> = Arr.map(
	["counter", "gauge", "frequency", "histogram", "summary", "summaryWithTimestamp", "timer"],
	(property) => ({ object: "Metric", property, message: EFFECT_METRICS_MESSAGE })
)

/** eslint/no-restricted-properties with a project's list and the shared metrics ban. A project's exception block
 * that narrows the list for some files calls it too, so the metrics ban stays on there. */
export const restrictedProperties = (list: ReadonlyArray<RestrictedProperty>): DummyRule => [
	"error",
	...list,
	...EFFECT_METRICS
]

/** Math.random is Effect's globalRandom's where Effect runs; in Effect-free code this ban owns it. */
const MATH_RANDOM: RestrictedProperty = {
	object: "Math",
	property: "random",
	message:
		"Math.random is banned: draw randomness from an injected source, so a run can be replayed."
}

/** One global a project bans, and why. */
type RestrictedGlobal = Readonly<{ name: string; message: string }>

/** Temporal, which Node 26 enables, is no clock of Effect's: banned everywhere. */
const TEMPORAL: RestrictedGlobal = {
	name: "Temporal",
	message:
		"Temporal is banned: time goes through Effect's Clock and DateTime, so a test controls it."
}

type PluginRule = keyof typeof plugin.rules

/** The plugin rules that take a project's names. */
type ConfiguredRule = {
	[Rule in PluginRule]: OptionsOf<(typeof plugin.rules)[Rule]> extends null ? never : Rule
}[PluginRule]

/** Test files, by their suffix. */
const TEST_FILES: ReadonlyArray<string> = Arr.map(TEST_SUFFIXES, (suffix) => `**/*${suffix}`)

/** The plugin rules that run only on Effect-free code, where Effect's diagnostics do not. */
const EFFECT_FREE_RULES: ReadonlyArray<PluginRule> = ["no-try", "no-new-error"]

/** What a repository states about itself. Every field is required: a repository with nothing to say states it
 * empty. Globs are relative to the repository root. */
export type Project = Readonly<{
	/** Paths oxlint never reads: vendored code, generated code, fixtures. */
	ignorePatterns: ReadonlyArray<string>
	restrictedImports: RestrictedImports
	restrictedGlobals: ReadonlyArray<RestrictedGlobal>
	restrictedProperties: ReadonlyArray<RestrictedProperty>
	/** The side-effect imports a project allows (`server-only`, stylesheets). */
	unassignedImports: ReadonlyArray<string>
	/** The workspace packages that use no Effect, by repository-relative directory: the root package.json's
	 * `superlint.effectFree`. No Effect-plugin tsconfig covers them, so the bans Effect's diagnostics own elsewhere
	 * hold there. */
	effectFree: ReadonlyArray<string>
	/** Tests, scripts and bench: no-shadow guards long passes and is ceremony there. */
	ceremony: ReadonlyArray<string>
	/** The plugin's per-project names, one options object per rule that takes them. */
	plugin: { readonly [Rule in ConfiguredRule]: OptionsOf<(typeof plugin.rules)[Rule]> }
	/** The testing library's oxlint plugin, by the specifier oxlint loads it with, and the rules it holds test files to. */
	tests: Readonly<{
		jsPlugin: string
		rules: DummyRuleMap
		/** Clock-free code beyond the test files, and the plugin's clock rules it is held to: the testing library and the
		 * tests' support, so no verdict rests on a hidden clock. A module whose job is the clock is an override's
		 * exception. */
		clock: Readonly<{ files: ReadonlyArray<string>; rules: DummyRuleMap }>
	}>
	/** The project's exceptions, in order; later blocks win. */
	overrides: ReadonlyArray<Readonly<{ files: ReadonlyArray<string>; rules: ActiveRules }>>
}>

/** A plugin rule at error, with the project's names when it takes them. */
const pluginEntry = (project: Project, rule: PluginRule): readonly [string, DummyRule] => {
	const named: Readonly<Record<string, unknown>> = project.plugin
	return [
		`devtools/${rule}`,
		Option.match(Record.get(named, rule), {
			onNone: (): DummyRule => "error",
			onSome: (options): DummyRule => ["error", options]
		})
	]
}

/** Each listed plugin rule, enabled with the project's names. */
const pluginRules = (project: Project, rules: ReadonlyArray<PluginRule>): DummyRuleMap =>
	Record.fromEntries(Arr.map(rules, (rule) => pluginEntry(project, rule)))

/** The plugin rules that run on every file. */
const EVERYWHERE_RULES: ReadonlyArray<PluginRule> = Arr.filter(
	Record.keys(plugin.rules),
	(rule) => !Arr.contains(EFFECT_FREE_RULES, rule)
)

/** A file group's block, none when the project has no such files. */
const groupBlock = (
	files: ReadonlyArray<string>,
	rules: DummyRuleMap
): ReadonlyArray<OxlintOverride> =>
	Arr.isReadonlyArrayNonEmpty(files) ? [{ files: [...files], rules: { ...rules, ...OFF } }] : []

/** oxlint's built-in plugins every file runs. */
const PLUGINS: ReadonlyArray<NonNullable<OxlintConfig["plugins"]>[number]> = [
	"eslint",
	"typescript",
	"unicorn",
	"oxc",
	"react",
	"jsx-a11y",
	"nextjs",
	"node",
	"import"
]

/** The testing plugin's clock rules over a project's clock-free code, none when it names none. */
const clockBlock = (tests: Project["tests"]): ReadonlyArray<OxlintOverride> =>
	Arr.isReadonlyArrayNonEmpty(tests.clock.files)
		? [
				{
					files: [...tests.clock.files],
					jsPlugins: [tests.jsPlugin],
					rules: { ...tests.clock.rules, ...OFF }
				}
			]
		: []

/** The repository's oxlint configuration: the shared standard with the project's lists. */
export const lintConfig = (project: Project): OxlintConfig => ({
	plugins: [...PLUGINS],
	jsPlugins: [`${import.meta.dirname}/oxlint-plugin.ts`],
	categories: { correctness: "error" },
	env: { browser: true, node: true, es2024: true },
	options: {
		typeAware: true,
		denyWarnings: true,
		reportUnusedDisableDirectives: "error",
		respectEslintDisableDirectives: false
	},
	ignorePatterns: [...project.ignorePatterns],
	rules: {
		...GENERIC_RULES,
		"eslint/no-restricted-globals": ["error", ...project.restrictedGlobals, TEMPORAL],
		"eslint/no-restricted-imports": restrictedImports(project.restrictedImports),
		"eslint/no-restricted-properties": restrictedProperties(project.restrictedProperties),
		"import/no-unassigned-import": ["error", { allow: [...project.unassignedImports] }],
		...pluginRules(project, EVERYWHERE_RULES),
		...OFF
	},
	overrides: [
		...groupBlock(
			Arr.map(project.effectFree, (directory) => `${directory}/**`),
			{
				...pluginRules(project, EFFECT_FREE_RULES),
				"oxc/no-async-await": "error",
				"typescript/strict-boolean-expressions": "error",
				"eslint/no-console": "error",
				"node/no-process-env": "error",
				"eslint/no-restricted-properties": restrictedProperties([
					...project.restrictedProperties,
					MATH_RANDOM
				])
			}
		),
		{
			files: [...TEST_FILES],
			plugins: [...PLUGINS, "vitest"],
			jsPlugins: [project.tests.jsPlugin],
			rules: { ...project.tests.rules, ...OFF }
		},
		...clockBlock(project.tests),
		...groupBlock(project.ceremony, { "eslint/no-shadow": "off" }),
		...Arr.map(project.overrides, (block) => ({
			files: [...block.files],
			rules: { ...block.rules, ...OFF }
		}))
	]
})
