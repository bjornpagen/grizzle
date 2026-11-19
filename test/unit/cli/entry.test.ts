/**
 * The command line's entry point. The bin (packages/grizzle/src/cli/bin.ts) runs the command line; main.ts, the module
 * it loads, run as the program itself refuses and runs nothing, where since 06ac8e5d5 it defined the command line and
 * exited 0, so a script that ran it read every command as having succeeded.
 *
 * Oracle: the command line's contract for its entry points: main.ts run as the program exits 2 naming the bin, its
 * one line on stderr and nothing on stdout, and the bin answers each command line with the command line's own report,
 * never main.ts's refusal and never nothing.
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { entryCaseGen, mainRefusal, runEntry } from "#test/unit/cli/entry.fixtures.ts"

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
