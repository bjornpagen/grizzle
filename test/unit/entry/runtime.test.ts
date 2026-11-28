/**
 * The runtime entries, @bjornpagen/grizzle/runtime (packages/grizzle/src/runtime.ts) and @bjornpagen/grizzle/http
 * (packages/grizzle/src/http/index.ts), load no compiler: a served login's layer and its Dbs run on the served file
 * `grizzle generate` committed, every program rebuilt from it with nothing compiled (adapter/served/load.ts), so a
 * process that serves a login loads no schema builder, law model, checker, lowering, SQL printer or install code and
 * evaluates no schema module. Its start is the file's read, linear in its bytes: metis's student_app file, 14.9 MB, is
 * parsed, decoded (served) and loaded (loadServed) in 156 ms, 59 of them JSON.parse's, where compiling a schema of
 * qti-pie's in process takes seconds.
 *
 * Oracle: the architecture's runtime zones (.fallowrc.json), every zone a module the runtime entries load lies in
 * (runtime.fixtures.ts runtimeZones). Each zone's rule allows by value only runtime zones, so no module the runtime loads
 * can import a module of any other zone, the compiler's or the DSL builders', even in one step: fallow's architecture
 * check refuses the import. And a program over each entry loads modules of the runtime zones alone: Node loads no module
 * dynamically (the shared lint's no-dynamic-imports), so an entry's static closure is everything a process serving a
 * login loads, read off a load hook in the child (test/support/load-probe.ts).
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { rulesOf, zoneOf, zonesOf } from "#test/unit/entry/dsl.fixtures.ts"
import {
	probedRuntimeProgram,
	runtimeProgramGen,
	runtimeZoneGen,
	runtimeZones
} from "#test/unit/entry/runtime.fixtures.ts"

/** Whether `zone` is one of the runtime's. */
const isRuntimeZone = (zone: string): boolean => Arr.some(runtimeZones, (z) => z === zone)

/**
 * A program over each runtime entry loads modules of the runtime's zones alone, none of the compiler's or the DSL
 * builders', and the runtime facade every runtime module reads the engine through (plan/runtime.ts) among them.
 */
export const aProgramOverEachRuntimeEntryLoadsModulesOfTheRuntimeZonesAloneNoCompilerModule =
	property.exhaust(finite(runtimeProgramGen), {
		box: "@bjornpagen/grizzle/runtime and @bjornpagen/grizzle/http, each imported alone",
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (program) =>
			Effect.gen(function* () {
				const checkout = yield* resources.checkout
				const zones = yield* zonesOf(checkout)
				const ran = yield* probedRuntimeProgram(checkout, program)
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
					Arr.contains(ours, "packages/engine/src/plan/runtime.ts"),
					`${program} loads the engine's runtime facade`
				)
				assert.deepEqual(
					Arr.flatMap(ours, (file) => {
						const zone = zoneOf(zones, file)
						return isRuntimeZone(zone) ? [] : [`${file} (${zone})`]
					}),
					[],
					`${program} loads a module outside the runtime's zones`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the architecture's runtime zones (.fallowrc.json, runtime.fixtures.ts runtimeZones)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/plan/runtime.ts",
				original: 'export { servedFile } from "#compiler/served/json.ts"\n',
				replacement:
					'export { servedFile } from "#compiler/served/json.ts"\nexport { compiledSchema } from "#compiler/program/schema.ts"\n',
				why: "The runtime facade re-exports the schema's compile: every process that serves a login loads the law model, the checker and the lowering beneath it."
			},
			{
				file: "packages/grizzle/src/runtime.ts",
				original: 'export * from "#adapter/public/db.ts"\n',
				replacement:
					'export * from "#adapter/public/contract.ts"\nexport * from "#adapter/public/db.ts"\n',
				why: "The runtime entry re-exports the contract parser again, as it did: every process that serves a login loads the text-language analysis and the predicate lowering a contract's checker is derived by, whether it parses a contract's values or not."
			},
			{
				file: ".fallowrc.json",
				original:
					'"packages/grizzle/src/adapter/config/define.ts",\n\t\t\t\t\t"packages/grizzle/src/adapter/public/config.ts"',
				replacement:
					'"packages/grizzle/src/adapter/config/define.ts",\n\t\t\t\t\t"packages/grizzle/src/adapter/errors/credential.ts",\n\t\t\t\t\t"packages/grizzle/src/adapter/public/config.ts"',
				why: "CredentialError is the DSL's adapter's again, as it was: the runtime loads a module of dsl-adapter, whose rule allows the schema, query and ChangeSet builders by value."
			}
		]
	})

/**
 * Each runtime zone has a rule, and it allows by value only runtime zones: the runtime's zones are closed under every
 * import fallow admits, so no module the runtime loads reaches another zone's in one step or in many.
 */
export const eachRuntimeZoneAllowsByValueOnlyRuntimeZones = property.exhaust(
	finite(runtimeZoneGen),
	{
		box: "every runtime zone of .fallowrc.json",
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
						(allowed) => !isRuntimeZone(allowed)
					),
					[],
					`${zone} allows a value import of a zone outside the runtime's`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the architecture's runtime zones (.fallowrc.json, runtime.fixtures.ts runtimeZones)"
		},
		kept: [],
		kills: [
			{
				file: ".fallowrc.json",
				original:
					'"from": "served",\n\t\t\t\t"allow": [\n\t\t\t\t\t"browser-core",\n\t\t\t\t\t"core",',
				replacement:
					'"from": "served",\n\t\t\t\t"allow": [\n\t\t\t\t\t"browser-core",\n\t\t\t\t\t"check",\n\t\t\t\t\t"core",',
				why: "served allows the checker by value again, as it did: a module the runtime loads may import check/scan.ts, and through it the schema and the IR's lowering, in one step."
			},
			{
				file: ".fallowrc.json",
				original:
					'"reader",\n\t\t\t\t\t"runtime",\n\t\t\t\t\t"scalar",\n\t\t\t\t\t"values"\n\t\t\t\t],\n\t\t\t\t"allowTypeOnly": ["types", "write"]',
				replacement:
					'"laws",\n\t\t\t\t\t"reader",\n\t\t\t\t\t"runtime",\n\t\t\t\t\t"scalar",\n\t\t\t\t\t"values"\n\t\t\t\t],\n\t\t\t\t"allowTypeOnly": ["types", "write"]',
				why: "decode allows the law model by value again, as it did: the decode sites the runtime loads may import laws/ in one step."
			}
		]
	}
)
