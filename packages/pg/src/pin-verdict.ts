import { NodeFileSystem, NodeRuntime } from "@effect/platform-node"
import { Array as Arr, Console, Data, Effect, Runtime } from "effect"
import { installedBuild, patchesOf, verdict } from "#pg/installation.ts"

/** The pin.env this checkout's scripts read. */
const pinFile = `${import.meta.dirname}/../../../scripts/pg/pin.env`

/**
 * The checkout's pin is older than the installation: the installation holds a build of the same release with patches
 * the pin lacks, which building the pin would drop under every cluster that runs from it. Its message is the refusal
 * build.sh prints.
 */
class PinOlder extends Data.TaggedError("PinOlder")<{
	readonly installation: string
	readonly commit: string
	readonly lacking: Arr.NonEmptyReadonlyArray<string>
}> {
	override readonly [Runtime.errorReported] = false

	override get message(): string {
		return Arr.join(
			[
				`This checkout is older than the PostgreSQL installation at ${this.installation}: both build the release ${this.commit}, and the installation carries patches ${pinFile} lacks:`,
				...Arr.map(this.lacking, (patch) => `  ${patch}`),
				"Building this pin would put the release there without them, under every cluster that runs from it. Update this checkout to a grizzle whose pin.env lists them. Nothing was changed."
			],
			"\n"
		)
	}
}

/**
 * Prints what build.sh does with this checkout's pin over the build the installation holds
 * (installation.ts verdict): `build` or `built`. A pin older than the installation is refused instead, its
 * fault and the patches it lacks printed, with a failing exit. Its arguments are the installation, the stem of a
 * stamp's name (scripts/pg/lib.sh stamp_stem), and the pin's release commit and patches, PG_PIN_COMMIT and
 * PG_PIN_PATCHES; any other arguments are refused.
 */
const main = Effect.gen(function* () {
	const [installation, stem, commit, patches, ...rest] = yield* Effect.sync(
		(): ReadonlyArray<string> => process.argv.slice(2)
	)
	if (
		installation === undefined ||
		stem === undefined ||
		commit === undefined ||
		patches === undefined ||
		rest.length > 0
	) {
		return yield* Effect.die(
			new Error(
				"usage: pin-verdict.ts <installation> <stamp stem> <PG_PIN_COMMIT> <PG_PIN_PATCHES>"
			)
		)
	}
	const installed = yield* installedBuild(installation, stem)
	const decided = verdict(installed, { commit, patches: patchesOf(patches) })
	if (decided.kind === "older") {
		return yield* new PinOlder({ installation, commit, lacking: decided.lacking })
	}
	yield* Console.log(decided.kind)
}).pipe(
	Effect.tapError((error) => Console.error(error.message)),
	Effect.provide(NodeFileSystem.layer)
)

NodeRuntime.runMain(main)
