import type plugin from "#oxlint-plugin.ts"
import type { OptionsOf } from "#oxlint/rule.ts"

type MarkedRule = Exclude<keyof typeof plugin.rules, "no-comment">

/**
 * Every plugin rule the marked fixtures prove, with the options it runs under there. Paths point into the rule's own
 * fixture directory, so `<rule>/clean.tsx` is the file an exemption names. no-comment is proven by its fixer cases
 * instead: a marker comment is a comment it would strip.
 */
export const FIXTURE_RULES: Readonly<{
	[Rule in MarkedRule]: OptionsOf<(typeof plugin.rules)[Rule]>
}> = {
	"import-doors": {
		doors: [
			{
				module: "node:assert",
				guards: { kind: "module" },
				doors: ["import-doors/clean.tsx"],
				message: "Import assertions from the assertion door."
			},
			{
				module: "node:util",
				guards: { kind: "exports", names: ["isDeepStrictEqual"] },
				doors: ["import-doors/clean.tsx"],
				message: "Use the assertion door's typed deepEqual."
			}
		]
	},
	"brands-sole-mint": {
		mints: [
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["TableName", "ColumnName"] },
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["SqlText"] }
		]
	},
	"no-default-parameter": null,
	"no-dynamic-imports": {
		allowed: [{ file: "no-dynamic-imports/clean.tsx", specifier: "#config/user.ts" }]
	},
	"no-inline-suppression": null,
	"no-new-error": null,
	"no-option-bridge": null,
	"no-optional-parameter": null,
	"no-overload": null,
	"no-pointless-type-alias": null,
	"no-raw-regexp": null,
	"no-raw-sql": { sources: ["no-raw-sql"], writers: [] },
	"no-switch-default-bailout": null,
	"no-try": null,
	"no-useless-continue": null,
	"prefer-early-return": null,
	"side-effect-free": {
		modules: [
			{
				file: "side-effect-free/clean.tsx",
				specifiers: ["#fixture/proven.ts"],
				functions: [
					{ name: "brand", returns: "functions", invokes: [] },
					{ name: "twice", returns: "values", invokes: [] },
					{ name: "derive", returns: "values", invokes: [{ parameter: 0, property: "compute" }] }
				],
				constants: ["limit"]
			}
		]
	},
	"test-no-prose-search": {
		fields: ["what"],
		textHelpers: ["containsText", "lacksText"],
		searchHelpers: ["containsText"]
	},
	"test-no-spelled-names": { markers: ["__pk", "__fk__"] }
}
