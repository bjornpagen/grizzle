/**
 * The configuration-settings program (test/types/api/config-settings.ts): defineConfig takes exactly the settings the
 * command line's loader reads, every one of its roster and none else, so a configuration the loader would refuse
 * (generate's "the configuration has no setting ..." at its configuration stage) is refused where it is written: each
 * setting left out, and a setting no configuration has beside them all, qti-pie's `contracts` among them, which
 * typechecked while defineConfig's one type parameter took every subtype of its configuration. Each configuration is a
 * cell of the box; a batch's cells are one program, checked armed. Oracle: the loader's roster (cli/errors.ts
 * configSettings, cli/config.ts onlyKeys).
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { configSettingsBox } from "#test/types/api/config-settings.dictionary.ts"
import { configSettingsProgram } from "#test/types/api/config-settings.ts"

/** defineConfig takes exactly the settings the loader reads: each one required, and none else. */
export const configSettingsAgree = boxAgreement(finite(word(configSettingsBox)), {
	box: "every setting, each one left out, and a setting no configuration has beside them all",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: configSettingsProgram,
	oracle: {
		kind: "specification",
		name: "the loader's roster of settings, each required and none else"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/config/define.ts",
			original: "(config: C & NoOtherSettings<C>): C => {",
			replacement: "(config: C): C => {",
			why: "defineConfig's type parameter takes every subtype of a configuration, a setting no configuration has among them: the configuration of a stranger typechecks, which the loader refuses."
		},
		{
			file: "packages/grizzle/src/adapter/types/config.ts",
			original: "\treadonly migrations: string\n",
			replacement: "\treadonly migrations: string\n\treadonly contracts?: ReadonlyArray<unknown>\n",
			why: "The configuration's type states a setting the loader has no name for: the configuration of the stranger typechecks, which the loader refuses."
		}
	]
})
