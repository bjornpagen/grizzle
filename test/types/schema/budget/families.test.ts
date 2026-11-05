import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert, defined } from "#test/support/assert.ts"
import { run } from "#test/support/process.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import { disarm } from "#test/types/batch/directives.ts"
import { entriesFrom } from "#test/types/query/budget/generate.ts"
import { familySizes, generateFamiliesSource } from "#test/types/schema/budget/families.ts"

import { regex } from "arkregex"
/**
 * The family-scale schema (test/types/schema/budget/families.ts): families, trees, folds and nested additions at 500,
 * 1,000 and 2,000 families and as many folds under one schema, each typechecked as a program of its own.
 *
 * The oracle is the type checker and its instantiation count (tsgo --extendedDiagnostics). Every program typechecks
 * with no diagnostic, so no TS2589 or TS2859 and every assertion and directive it states holds; the largest, disarmed,
 * raises exactly the refusal its directive names; and the instantiations grow linearly in the families. Linearity is
 * read from the increments: for a count a + b·n^k the increment from 1,000 to 2,000 families is 2^k times the one from
 * 500 to 1,000, so a linear count gives 2 and a quadratic one 4, and the test refuses a ratio of 3 or more, the
 * midpoint between them. The constant a, what the public barrels cost before any family, cancels in the increments.
 *
 * The programs are not in the type-test batch (test/types/batch/groups.ts): an instantiation count is one program's,
 * so each size is checked alone, with the batch's compiler options and no Effect language service.
 *
 * Measured on 2026-11-05 (TypeScript 7.1.0-beta, effect-tsgo 0.67.1, macOS arm64, 10 cores, other sessions' load
 * unrecorded), with the counted families flat (rows first): 2.74M, 4.68M and 8.54M instantiations at 500, 1,000 and
 * 2,000 families, an increment ratio of 1.99, linear; check times of 6.6 s, 18 s and 52 s, about 3 times per doubling,
 * superlinear. The check time is not gated: it is recorded for W8's performance pass.
 */

/** The repository root, four levels above this directory. */
const repoRoot = Effect.gen(function* () {
	const path = yield* Path.Path
	return path.resolve(import.meta.dirname, "../../../..")
})

/** "test/types/schema/.families-x/index.ts(12,3): error TS2345: ..." -> its file, line and code. */
const diagnosticLine = regex("^(.+?)\\((\\d+),(\\d+)\\): error (TS\\d+): ")

/** "Instantiations:  7747124" -> the count. */
const instantiationsLine = regex("^Instantiations:\\s+(\\d+)$")

/** An error diagnostic of the program: its line, its code, and its first line with every continuation line. */
interface ProgramError {
	readonly line: number
	readonly code: string
	readonly lines: Array<string>
}

/** What one program's check reported: its error lines, each with its continuation lines, and its instantiations. */
interface Checked {
	readonly families: number
	readonly errors: ReadonlyArray<{
		readonly line: number
		readonly code: string
		readonly text: string
	}>
	readonly unattributed: ReadonlyArray<string>
	readonly instantiations: number
}

/**
 * The program of `families` families, armed or disarmed, written beside this directory's fixtures so it resolves the
 * sources as they do, and checked by the repository's compiler with its extended diagnostics.
 */
const checkedProgram = (families: number, armed: boolean) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const spelled = yield* repoRoot
			const root = yield* fs.realPath(spelled)
			const dir = yield* scopedTempDir(path.join(root, "test/types/schema"), ".families-")
			const entry = (repoPath: string): string => {
				const relative = path.relative(dir, path.join(root, repoPath))
				return Str.startsWith(".")(relative) ? relative : `./${relative}`
			}
			const source = generateFamiliesSource(families, entriesFrom(entry))
			const placed = armed ? { source, directives: [] } : disarm("index.ts", source)
			yield* fs.writeFileString(path.join(dir, "package.json"), '{ "type": "module" }\n')
			yield* fs.writeFileString(path.join(dir, "index.ts"), placed.source)
			yield* fs.writeFileString(
				path.join(dir, "tsconfig.json"),
				jsonText({
					extends: Arr.map(["packages/devtools/tsconfig.base.json", "tsconfig.base.json"], (base) =>
						path.relative(dir, path.join(root, base))
					),
					compilerOptions: {
						noEmit: true,
						noErrorTruncation: true,
						customConditions: ["grizzle-source"],
						plugins: []
					},
					files: ["index.ts"]
				})
			)
			const ran = yield* run(
				process.execPath,
				[
					path.join(root, "node_modules/typescript/bin/tsc"),
					"--pretty",
					"false",
					"--extendedDiagnostics",
					"-p",
					path.join(dir, "tsconfig.json")
				],
				{ cwd: root, env: { PWD: root } }
			)
			const program = path.relative(root, path.join(dir, "index.ts"))
			const errors: Array<ProgramError> = []
			const unattributed: Array<string> = []
			let instantiations: number | undefined
			let current: ProgramError | undefined
			for (const line of Str.split(ran.stdout, "\n")) {
				if (current !== undefined && regex("^\\s").test(line)) {
					current.lines.push(line)
					continue
				}
				current = undefined
				const counted = instantiationsLine.exec(Str.trim(line))
				if (counted !== null) {
					instantiations = Number(counted[1])
					continue
				}
				const diagnostic = diagnosticLine.exec(line)
				if (diagnostic === null) {
					continue
				}
				if (diagnostic[1] === program) {
					current = {
						line: Number(diagnostic[2]),
						code: defined(diagnostic[4], "the code a diagnostic names"),
						lines: [line]
					}
					errors.push(current)
				} else {
					unattributed.push(line)
				}
			}
			const checked: Checked = {
				families,
				errors: Arr.map(errors, (e) => ({
					line: e.line,
					code: e.code,
					text: Arr.join(e.lines, "\n")
				})),
				unattributed: [
					...unattributed,
					...Arr.filter(Str.split(ran.stderr, "\n"), (l) => Str.trim(l) !== "")
				],
				instantiations: defined(
					instantiations,
					`tsgo reports the instantiations of ${families} families`
				)
			}
			return { checked, directives: placed.directives }
		})
	)

layer(NodeServices.layer, { excludeTestServices: true })("the family-scale schema", (it) => {
	it.effect(
		"typechecks 500, 1,000 and 2,000 families and as many folds, nested two deep and with trees, with no diagnostic, linear in instantiations",
		() =>
			Effect.gen(function* () {
				const sizes = yield* Effect.forEach(familySizes, (families) =>
					Effect.map(checkedProgram(families, true), (c) => c.checked)
				)
				for (const s of sizes) {
					assert.deepEqual(
						{ errors: Arr.map(s.errors, (e) => e.text), unattributed: s.unattributed },
						{ errors: [], unattributed: [] },
						`${s.families} families typecheck with no diagnostic`
					)
				}
				const [small, middle, large] = sizes
				const first = defined(middle).instantiations - defined(small).instantiations
				const second = defined(large).instantiations - defined(middle).instantiations
				assert.ok(first > 0, `each family adds instantiations: ${first} from 500 to 1,000 families`)
				assert.ok(
					second < 3 * first,
					`linear in the families: ${second} instantiations from 1,000 to 2,000 families against ${first} from 500 to 1,000, a ratio of ${(second / first).toFixed(2)}, which a linear count holds at 2 and a quadratic one at 4`
				)
			})
	)

	it.effect("raises exactly the refusal its directive names at 2,000 families, disarmed", () =>
		Effect.gen(function* () {
			const { checked, directives } = yield* checkedProgram(Arr.lastNonEmpty(familySizes), false)
			assert.deepEqual(checked.unattributed, [], "no diagnostic outside the program")
			assert.deepEqual(
				Arr.map(checked.errors, (e) => ({ line: e.line, code: e.code })),
				Arr.map(directives, (d) => ({ line: d.line, code: d.code })),
				"each directive's line raises its code, and no other line raises any"
			)
			for (const d of directives) {
				if (d.claim.kind === "refusal") {
					const printed = `Refusal<"${d.claim.refusal}">`
					assert.ok(
						Arr.some(checked.errors, (e) => e.line === d.line && Str.includes(printed)(e.text)),
						`line ${d.line} prints ${printed}`
					)
				}
			}
		})
	)
})
