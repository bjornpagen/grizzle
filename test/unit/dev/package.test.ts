/**
 * The package as a git submodule consumer takes it (consumer.ts): the README's and SKILL.md's programs, mirrored line
 * for line in test/types/examples/fixtures, typecheck as a consumer's, against the package's source reached through its
 * exports under a consumer's tsconfig: the repository's strictness and Node's types, and nothing of the repository's
 * own: no project references and no paths. A refusal the README states by `@ts-expect-error` would leave its directive
 * unused were a type `any`.
 *
 * That the linked package opens a role against the cluster and reads is test/pg/package/consumer.test.ts's.
 *
 * Oracle: TypeScript's own checker.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	type ConsumerProject,
	consumerProject,
	exitedCleanly,
	runChild
} from "#test/unit/dev/consumer.ts"

/**
 * The compiler options a consumer of the README's programs checks them under: the repository's own strictness, Node's
 * types, and nothing of the repository's tsconfigs: no project references, no paths.
 */
const mirrorTsconfig = `{
	"compilerOptions": {
		"target": "esnext",
		"lib": ["esnext"],
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"moduleDetection": "force",
		"strict": true,
		"exactOptionalPropertyTypes": true,
		"noUncheckedIndexedAccess": true,
		"allowImportingTsExtensions": true,
		"noEmit": true,
		"skipLibCheck": true,
		"types": ["node"]
	},
	"include": ["readme.ts", "skill.ts"]
}
`

/** The README's and SKILL.md's mirrored programs, which the type batch holds to their blocks, by their paths. */
const mirrors = {
	readme: "test/types/examples/fixtures/readme.ts",
	skill: "test/types/examples/fixtures/skill.ts"
} as const

/** The consumer's scratch project, made once for the file, which lives as long as the layer. */
class Consumer extends Context.Service<Consumer, ConsumerProject>()(
	"grizzle-workspace/test/unit/dev/package.test/Consumer"
) {
	static readonly layer = Layer.provideMerge(
		Layer.effect(Consumer, consumerProject),
		NodeServices.layer
	)
}

layer(Consumer.layer, { excludeTestServices: true })(
	"the package as a submodule consumer takes it",
	(it) => {
		it.effect(
			"typechecks the README's and SKILL.md's programs against its source, through its exports",
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const { root, project } = yield* Consumer
					const readme = yield* fs.readFileString(path.join(root, mirrors.readme))
					const skill = yield* fs.readFileString(path.join(root, mirrors.skill))
					yield* fs.writeFileString(path.join(project, "readme.ts"), readme)
					yield* fs.writeFileString(
						path.join(project, "skill.ts"),
						Str.replaceAll(`#${mirrors.readme}`, "./readme.ts")(skill)
					)
					yield* fs.writeFileString(path.join(project, "tsconfig.json"), mirrorTsconfig)
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
						`the README's programs, typechecked as a consumer's:\n${checked.stdout}${checked.stderr}`
					)
				})
		)
	}
)
