/**
 * The golden fixtures, byte for byte: the generator is deterministic, so what it writes for two fixed documents is a
 * snapshot, regenerated only in a change whose point is its output. users-update pins a request module, the servers
 * table and a command module; body-alternatives pins the builders of a lone JSON, form and multipart body.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Effect, FileSystem, Path } from "effect"
import { generateFixture, harnessLayer } from "#test/support/cli-package.ts"

/** A fixture: its directory under test/fixtures, `/`-separated, and each expected file beside the generated path it
 * pins. */
type Golden = Readonly<{
	fixture: string
	pins: ReadonlyArray<readonly [expected: string, generated: string]>
}>

const USERS_UPDATE: Golden = {
	fixture: "golden/users-update",
	pins: [
		["expected/src/api/users.ts", "src/api/users.ts"],
		["expected/src/api/servers.ts", "src/api/servers.ts"],
		["expected/src/cli/users.ts", "src/cli/users.ts"]
	]
}

const BODY_ALTERNATIVES: Golden = {
	fixture: "body-alternatives",
	pins: [["expected/api-lone.ts.txt", "src/api/lone.ts"]]
}

/** Every pinned file of a fixture, generated, equals its expected bytes. */
const matchesExpected = (golden: Golden) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const fixture = path.join(import.meta.dirname, "..", "fixtures", golden.fixture)
			const spec = yield* fs.readFileString(path.join(fixture, "openapi.json"))
			const config = yield* fs.readFileString(path.join(fixture, "author-config.json"))
			const generated = yield* generateFixture({
				spec: { path: "openapi.json", text: spec },
				config: { path: "author-config.json", text: config },
				authorFiles: []
			})
			const pins = yield* Effect.forEach(golden.pins, ([expected, written]) =>
				Effect.map(
					Effect.all({
						expected: fs.readFileString(path.join(fixture, expected)),
						generated: fs.readFileString(path.join(generated.dir, written))
					}),
					(texts) => [expected, texts] as const
				)
			)
			deepStrictEqual(
				Arr.map(pins, ([name, texts]) => [name, texts.generated] as const),
				Arr.map(pins, ([name, texts]) => [name, texts.expected] as const)
			)
		})
	)

layer(harnessLayer, { excludeTestServices: true })("emit: the golden fixtures", (it) => {
	it.effect("users-update generates its expected files byte for byte", () =>
		matchesExpected(USERS_UPDATE)
	)

	it.effect("body-alternatives generates its lone builders byte for byte", () =>
		matchesExpected(BODY_ALTERNATIVES)
	)
})
