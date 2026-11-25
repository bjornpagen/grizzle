/**
 * The authoring entry, @bjornpagen/grizzle (packages/grizzle/src/index.ts), loads the DSL alone: a schema module or a
 * grizzle.config.ts that imports it evaluates its declarations and loads nothing that compiles, installs or runs them,
 * where it loaded the runtime's layer and errors and the host compiles beneath them (873 modules and 4.0 s of user CPU
 * for the import alone, now 451 and 2.1 s). What compiles or runs a schema is @bjornpagen/grizzle/runtime's and
 * @bjornpagen/grizzle/compile's.
 *
 * Oracle: the architecture's zones (.fallowrc.json), which classify every module: the DSL's are dsl-<zone>, each the
 * part of <zone> the entry loads, whose rules let them load only each other, browser-core, credential, values and
 * grizzle-text. A program loads no module of the packages outside them, of the compiler's SQL only the printer (dsl.fixtures.ts
 * printer states why), and every module the DSL's zones name, so the zones are the entry's closure and no more. Read off
 * a load hook in the child (test/support/load-probe.ts).
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	besideTheDsl,
	isDslZone,
	packageSources,
	printer,
	probedProgram,
	programGen,
	zoneOf,
	zonesOf
} from "#test/unit/entry/dsl.fixtures.ts"

/**
 * A program over the authoring entry loads the DSL alone: no module of the packages outside the DSL's zones,
 * browser-core, credential, values and grizzle-text, the SQL printer alone of the compiler's SQL, and every module the DSL's zones
 * name.
 */
export const aProgramOverTheAuthoringEntryLoadsTheDslAloneNoCompilerInstallOrRuntimeModuleAndEveryModuleTheDslZonesName =
	property.exhaust(finite(programGen), {
		box: "the entry imported alone, a one-relation grizzle.config.ts and a schema module with closed values, text refinements, a containment, a query, a ChangeSet and a login",
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (program) =>
			Effect.gen(function* () {
				const checkout = yield* resources.checkout
				const zones = yield* zonesOf(checkout)
				const ran = yield* probedProgram(checkout, program)
				assert.deepEqual(
					{ status: ran.status, stdout: ran.stdout, stderr: ran.stderr },
					{ status: 0, stdout: "", stderr: "" },
					program
				)
				assert.deepEqual(
					Arr.filter(ran.outside, (url) => !Str.includes("/node_modules/")(url)),
					[],
					`${program} loads from outside the checkout only its dependencies`
				)
				const ours = Arr.filter(ran.loaded, Str.startsWith("packages/"))
				assert.deepEqual(
					Arr.flatMap(ours, (file) => {
						const zone = zoneOf(zones, file)
						return isDslZone(zone) || Arr.contains(besideTheDsl, zone) ? [] : [`${file} (${zone})`]
					}),
					[],
					`${program} loads a module outside the DSL`
				)
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.filter(ours, Str.startsWith("packages/engine/src/sql/")),
					printer,
					`${program} loads the compiler's SQL printer and no more of its SQL`
				)
				const sources = yield* packageSources(checkout)
				const named = Arr.filter(sources, (file) => isDslZone(zoneOf(zones, file)))
				assert.deepEqual(
					Arr.difference(named, ours),
					[],
					`${program} loads every module the DSL's zones name`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the architecture's DSL zones (.fallowrc.json dsl-*), browser-core, credential, values and grizzle-text, and the SQL printer the DSL loads"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/index.ts",
				original: 'export * from "#adapter/public/config.ts"\n',
				replacement:
					'export * from "#adapter/public/config.ts"\nexport * from "#adapter/public/host.ts"\n',
				why: "The entry re-exports the host compiles again (compileServed, rowEvaluator, insertPreview and their kin), as it did: every program loads the compiler beneath them."
			},
			{
				file: "packages/grizzle/src/index.ts",
				original: 'export { CredentialError } from "#adapter/errors/credential.ts"',
				replacement: 'export { CredentialError } from "#adapter/public/errors.ts"',
				why: "CredentialError is read off the runtime's errors, beside which it was defined (adapter/errors/failures.ts): every program loads the runtime's failures and what they name."
			},
			{
				file: "packages/engine/src/public/schema.ts",
				original: 'export { schemaNameOf, wholeSchemaNameOf } from "#compiler/program/names.ts"\n',
				replacement:
					'export { schemaNameOf, wholeSchemaNameOf } from "#compiler/program/names.ts"\nexport { constraintNamesOf, lawsByStatement, lawsOf } from "#compiler/program/laws.ts"\n',
				why: "The engine's schema facade re-exports the law model again (lawsOf, lawsByStatement, constraintNamesOf), as it did: every program loads the law compiler."
			}
		]
	})
