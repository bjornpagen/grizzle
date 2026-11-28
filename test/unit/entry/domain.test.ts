/**
 * The contract entry, @bjornpagen/grizzle/domain (packages/grizzle/src/domain.ts), loads a consumer's contract's
 * checked mint and what its checker is derived by, the scalar typing, the predicate lowering and the text-language
 * analysis, and nothing a compile beyond them loads: no SQL printer, no schema builder, check, analysis, laws, logical,
 * query, lower, write, physical, deploy, program or install code. The runtime entry loads none of it
 * (runtime.test.ts), so a process that serves a login and parses no contract's values pays nothing for a parser, and a
 * process that parses one pays only for the derivation.
 *
 * Oracle: the architecture's contract zones (.fallowrc.json, contract.fixtures.ts domainZones), every zone a module
 * the contract entry loads lies in. Each zone's rule allows by value only contract zones, so no module the entry loads
 * can import a module of any other zone, even in one step: fallow's architecture check refuses the import. And a
 * program over the entry loads modules of the contract zones alone, read off a load hook in the child
 * (test/support/load-probe.ts).
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import {
	domainZoneGen,
	domainZones,
	probedDomainProgram
} from "#test/unit/entry/domain.fixtures.ts"
import { rulesOf, zoneOf, zonesOf } from "#test/unit/entry/dsl.fixtures.ts"

/** Whether `zone` is one of the contract entry's. */
const isContractZone = (zone: string): boolean => Arr.some(domainZones, (z) => z === zone)

/** A program over the contract entry loads modules of the contract zones alone, the engine's contract facade among them. */
export const aProgramOverTheContractEntryLoadsModulesOfTheContractZonesAlone = property.exhaust(
	finite(() => "the contract entry alone" as const),
	{
		box: "@bjornpagen/grizzle/domain imported alone",
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (program) =>
			Effect.gen(function* () {
				const checkout = yield* resources.checkout
				const zones = yield* zonesOf(checkout)
				const ran = yield* probedDomainProgram(checkout)
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
				assert.ok(
					Arr.contains(ours, "packages/engine/src/contract/parser.ts"),
					`${program} loads the engine's contract parser`
				)
				assert.deepEqual(
					Arr.flatMap(ours, (file) => {
						const zone = zoneOf(zones, file)
						return isContractZone(zone) ? [] : [`${file} (${zone})`]
					}),
					[],
					`${program} loads a module outside the contract's zones`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the architecture's contract zones (.fallowrc.json, contract.fixtures.ts domainZones)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/text/refinement.ts",
				original: 'import { structuralBounds } from "#compiler/text/bounds.ts"\n',
				replacement:
					'import { structuralBounds } from "#compiler/text/bounds.ts"\nimport "#compiler/text/membership.ts"\n',
				why: "The text-language analysis loads the SQL of a check again, as it did when it measured a check's bytes through the printer: the contract entry loads the SQL printer and its builders."
			},
			{
				file: "packages/engine/src/plan/contract.ts",
				original:
					'export { type DomainParser, domainParserOf } from "#compiler/contract/parser.ts"\n',
				replacement:
					'export { type DomainParser, domainParserOf } from "#compiler/contract/parser.ts"\nexport { quoteIdent } from "#compiler/plan/common.ts"\n',
				why: "The contract facade re-exports the compile's facade beside the parser: the contract entry loads the schema's compile, the checker and the install code beneath it."
			}
		]
	}
)

/**
 * Each contract zone has a rule, and it allows by value only contract zones: the contract's zones are closed under
 * every import fallow admits, so no module the entry loads reaches another zone's in one step or in many.
 */
export const eachContractZoneAllowsByValueOnlyContractZones = property.exhaust(
	finite(domainZoneGen),
	{
		box: "every contract zone of .fallowrc.json",
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (zone) =>
			Effect.gen(function* () {
				const checkout = yield* resources.checkout
				const rules = yield* rulesOf(checkout)
				const rule = Arr.findFirst(rules, (r) => r.from === zone)
				assert.ok(Option.isSome(rule), `${zone} has a rule`)
				assert.deepEqual(
					Arr.filter(
						Option.match(rule, { onNone: () => [], onSome: (r) => r.allow }),
						(allowed) => !isContractZone(allowed)
					),
					[],
					`${zone} allows a value import of a zone outside the contract's`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the architecture's contract zones (.fallowrc.json, contract.fixtures.ts domainZones)"
		},
		kept: [],
		kills: [
			{
				file: ".fallowrc.json",
				original:
					'"from": "dsl-text-language",\n\t\t\t\t"allow": ["browser-core", "dsl-core", "dsl-ir", "dsl-scalar", "grizzle-text", "values"]',
				replacement:
					'"from": "dsl-text-language",\n\t\t\t\t"allow": ["browser-core", "dsl-core", "dsl-ir", "dsl-scalar", "grizzle-text", "sql-printer", "values"]',
				why: "The text-language analysis may import the SQL builders by value again: a module the contract entry loads may reach the printer in one step."
			}
		]
	}
)
