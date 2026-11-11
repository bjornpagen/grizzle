import type plugin from "#oxlint-plugin.ts"
import type { OptionsOf } from "#oxlint/rule.ts"

type MarkedRule = Exclude<keyof typeof plugin.rules, "no-comment">

/**
 * Every plugin rule the marked fixtures prove, with the options it runs under there. Paths point into the rule's own
 * fixture directory, so `<rule>/clean.tsx` is the file an exemption names. no-comment is proven by its fixer cases
 * (fixer-cases.ts) instead: a marker comment is a comment it would strip.
 */
export const FIXTURE_RULES: Readonly<{
	[Rule in MarkedRule]: OptionsOf<(typeof plugin.rules)[Rule]>
}> = {
	"bearer-owners": { owners: ["bearer-owners/clean.tsx"] },
	"brands-sole-mint": {
		mints: [
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["LabelStream", "RunStream"] },
			{ doors: ["brands-sole-mint/clean.tsx"], brands: ["TodoId", "TodoTitle"] }
		]
	},
	"import-doors": {
		doors: [
			{
				module: "pg",
				guards: { kind: "module" },
				doors: ["import-doors/clean.tsx"],
				message: "Reach Postgres through the database package."
			},
			{
				module: "@superstarter/todo-protocol/action",
				guards: { kind: "exports", names: ["makeActionClient"] },
				doors: ["import-doors/clean.tsx"],
				message: "Call a server action through the app's one action client."
			}
		]
	},
	"no-collation": null,
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
	"no-send-beacon": null,
	"no-svg-without-title": null,
	"no-switch-default-bailout": null,
	"no-try": null,
	"no-unoptimized-next-image": null,
	"no-useless-continue": null,
	"prefer-early-return": null
}
