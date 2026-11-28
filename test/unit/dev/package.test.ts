/**
 * The package as a git submodule consumer takes it (consumer.ts): the README's and SKILL.md's programs, mirrored line
 * for line in test/types/examples/fixtures, typecheck as a consumer's, against the package's source reached through its
 * exports under a consumer's tsconfig: the repository's strictness and Node's types, and nothing of the repository's
 * own: no project references and no paths. A refusal the README states by `@ts-expect-error` would leave its directive
 * unused were a type `any`.
 *
 * Oracle: TypeScript's own checker. Box: each mirrored program, SKILL.md's with the README's it imports.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, FileSystem, Path, String as Str } from "effect"
import { consumerProject, exitedCleanly, runChild } from "#test/support/unit/dev/consumer.ts"
import { type Mirror, mirrorBox, mirrors, mirrorTsconfig } from "#test/unit/dev/package.fixtures.ts"

/**
 * The package as a submodule consumer takes it typechecks the README's and SKILL.md's programs against its source,
 * through its exports: each mirrored program, in a consumer's scratch project of its own, SKILL.md's beside the
 * README's it imports.
 */
export const thePackageAsASubmoduleConsumerTakesItTypechecksTheREADMEsAndSKILLmdsProgramsAgainstItsSourceThroughItsExports =
	property.exhaust(mirrorBox, {
		box: "each mirrored program, the README's and SKILL.md's, which imports the README's",
		needs: {},
		situations: ["readme", "skill"] satisfies ReadonlyArray<Reached<Mirror>>,
		check: (_, c: Case<Mirror>) => (mirror) =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const { root, project } = yield* consumerProject
					const readme = yield* fs.readFileString(path.join(root, mirrors.readme))
					yield* fs.writeFileString(path.join(project, "readme.ts"), readme)
					if (mirror === "skill") {
						const skill = yield* fs.readFileString(path.join(root, mirrors.skill))
						yield* fs.writeFileString(
							path.join(project, "skill.ts"),
							Str.replaceAll(`#${mirrors.readme}`, "./readme.ts")(skill)
						)
					}
					yield* fs.writeFileString(
						path.join(project, "tsconfig.json"),
						mirrorTsconfig(mirror === "skill" ? ["readme.ts", "skill.ts"] : ["readme.ts"])
					)
					const checked = yield* runChild(
						process.execPath,
						[
							path.join(root, "node_modules", "typescript", "bin", "tsc"),
							"-p",
							path.join(project, "tsconfig.json")
						],
						project,
						{}
					)
					assert.equal(
						checked.exitCode,
						exitedCleanly,
						`the ${mirror} program, typechecked as a consumer's:\n${checked.stdout}${checked.stderr}`
					)
					c.note(mirror)
				})
			),
		oracle: {
			kind: "specification",
			name: "TypeScript's own checker, under a consumer's tsconfig"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/builders.ts",
				original: "this.types.length - 1",
				replacement: "1 - this.types.length",
				why: "Operator mutant ada527ba97 at packages/engine/src/scalar/compute/builders.ts:284 in <module>: `this.types.length - 1` becomes `1 - this.types.length`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
