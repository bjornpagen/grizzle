/**
 * The command line's entry point. The bin (packages/grizzle/src/cli/bin.ts) runs the command line; main.ts, the module
 * it loads, run as the program itself refuses and runs nothing, where since 06ac8e5d5 it defined the command line and
 * exited 0, so a script that ran it read every command as having succeeded.
 *
 * Oracle: the command line's contract for its entry points: main.ts run as the program exits 2 naming the bin, its
 * one line on stderr and nothing on stdout, and the bin answers each command line with the command line's own report,
 * never main.ts's refusal and never nothing.
 *
 * The usage is the bin's alone: a command line that asks for it (no argument, or `--help` or `-h` anywhere) prints the
 * usage and loads the bin, the usage module and the engine's usage facade over its one module of constants, and nothing
 * else, where it loaded the whole command line and the engine (967 modules, 3.1 s of CPU). Oracle: the bin's module
 * set as cli/usage.ts and engine plan/usage.ts state it, read off a load hook in the child (load-probe.ts), and the
 * usage as the command line prints it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { helpText } from "#cli/usage.ts"
import {
	entryCaseGen,
	helpLineGen,
	mainRefusal,
	probedBin,
	runEntry,
	usageModules
} from "#test/unit/cli/entry.fixtures.ts"

/**
 * main.ts run as the program exits 2 naming the bin and runs nothing, and the bin runs the command line, so no entry
 * point exits 0 having done nothing.
 */
export const mainTsRunAsTheProgramExits2NamingTheBinAndTheBinRunsTheCommandLineSoNoEntryPointExits0HavingDoneNothing =
	property.exhaust(finite(entryCaseGen), {
		box: "the bin and main.ts, each over no arguments, the help, generate, check and migrate of a missing configuration file, and an unknown command",
		needs: { checkout: Checkout.dir },
		situations: [],
		check:
			(resources) =>
			([entry, argv]) =>
				Effect.gen(function* () {
					const checkout = yield* resources.checkout
					const ran = yield* runEntry(checkout, entry, argv)
					const line = `${entry} ${Arr.join(argv, " ")}`
					if (entry === "main.ts") {
						assert.deepEqual(ran, { status: 2, stdout: "", stderr: mainRefusal }, line)
						return
					}
					assert.ok(
						!Str.includes(mainRefusal)(ran.stderr),
						`${line} printed main.ts's refusal:\n${ran.stderr}`
					)
					assert.ok(
						ran.status === 0 ? ran.stdout !== "" : ran.stderr !== "",
						`${line} exited ${ran.status} having said nothing`
					)
				}),
		oracle: {
			kind: "specification",
			name: "main.ts refuses as the program, exit 2 naming the bin, and the bin answers with the command line's report"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/main.ts",
				original: "if (import.meta.main) {\n\trefuseAsProgram()\n}",
				replacement: "",
				why: "main.ts run as the program defines the command line and exits 0 having done nothing, as it did since 06ac8e5d5; the entry point search fails."
			},
			{
				file: "packages/grizzle/src/cli/main.ts",
				original: "if (import.meta.main) {",
				replacement: "if (true) {",
				why: "main.ts refuses wherever it loads, under the bin too, which then prints the refusal beside its own report; the entry point search fails."
			}
		]
	})

/** The usage loads the bin, the usage and the engine's usage facade alone, and prints the usage the command line prints. */
export const theUsageLoadsTheBinTheUsageAndTheEnginesUsageFacadeAloneAndPrintsTheUsageTheCommandLinePrints =
	property.exhaust(finite(helpLineGen), {
		box: "no argument, --help and -h alone, and each after a command, a known one and an unknown one",
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (argv) =>
			Effect.gen(function* () {
				const checkout = yield* resources.checkout
				const ran = yield* probedBin(checkout, argv)
				const line = `bin.ts ${Arr.join(argv, " ")}`
				assert.deepEqual(
					{ status: ran.status, stdout: ran.stdout, stderr: ran.stderr },
					{ status: 0, stdout: `${helpText}\n`, stderr: "" },
					line
				)
				assert.deepEqual<ReadonlyArray<string>>(
					ran.loaded,
					usageModules,
					`${line} loads the usage alone`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the usage's modules as cli/usage.ts and engine plan/usage.ts state them, and the usage the command line prints"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/bin.ts",
				original:
					"const usageAlone: boolean = import.meta.main && helpAsked(process.argv.slice(argumentsStart))",
				replacement: "const usageAlone: boolean = false",
				why: "The usage loads the whole command line and the engine: grizzle --help spent 3.1 s of CPU on 967 modules before it printed."
			},
			{
				file: "packages/grizzle/src/cli/usage.ts",
				original: 'import { maxMigrationNameLength } from "#compiler/plan/usage.ts"',
				replacement: 'import { maxMigrationNameLength } from "#compiler/plan/migration.ts"',
				why: "The usage reads its name bound through the engine's migration facade, which loads the drafting and the compiler beneath it."
			}
		]
	})
