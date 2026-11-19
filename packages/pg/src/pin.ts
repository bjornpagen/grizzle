import { homedir } from "node:os"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import {
	Array as Arr,
	Config,
	ConfigProvider,
	Data,
	Effect,
	FileSystem,
	Result,
	String as Str
} from "effect"
import { patchesOf } from "#pg/installation.ts"

import { regex } from "arkregex"

/**
 * scripts/pg/pin.env, grizzle's PostgreSQL pin: the one file that names the build every script, test and consumer
 * runs against. The shell scripts source it (scripts/pg/build.sh, source.sh), and `pin` is its parse, so no second copy
 * of any value exists.
 */
export const pinFile = `${import.meta.dirname}/../../../scripts/pg/pin.env`

/** A line of pin.env the shell would not read as this parse does, at its 1-based line number. */
class PinMalformed extends Data.TaggedError("PinMalformed")<{
	readonly line: number
	readonly text: string
	readonly reason: string
}> {
	override get message(): string {
		return `${pinFile}:${this.line}: ${this.reason}: ${this.text}`
	}
}

/** An assignment: a name of capitals, digits and underscores, then `=` and the value as written. */
const assignment = regex("^([A-Z][A-Z0-9_]*)=(.*)$")

/** A `$NAME` reference, as a part of a value split at each one. */
const reference = regex("^\\$[A-Z][A-Z0-9_]*$")

/** A value split around each `$NAME` reference, the references kept as parts of their own. */
const referenceParts = regex("(\\$[A-Z][A-Z0-9_]*)")

/**
 * The text a value as written stands for: within double quotes, the text between them; unquoted, the text itself,
 * which holds no space or quote, since the shell would read either otherwise than as one word.
 */
const unquoted = (raw: string): string | undefined =>
	Str.startsWith('"')(raw)
		? Str.endsWith('"')(raw) && raw.length > 1 && !Str.includes('"')(Str.slice(1, -1)(raw))
			? Str.slice(1, -1)(raw)
			: undefined
		: regex("^[^\\s\"'`\\\\]*$").test(raw)
			? raw
			: undefined

/**
 * pin.env's assignments, each `$NAME` replaced by the value of an earlier assignment or the user's home directory
 * (HOME), as the shell sources the file under `set -u`. A line that is neither blank, a comment nor an assignment, a
 * value the shell would read otherwise, and a reference to no earlier value are each PinMalformed, never skipped and
 * never empty.
 */
const assignments = (text: string): Effect.Effect<Readonly<Record<string, string>>, PinMalformed> =>
	Effect.gen(function* () {
		const values: Record<string, string> = { HOME: homedir() }
		const lines = Str.split(text, "\n")
		yield* Effect.forEach(
			lines,
			(raw, index) => {
				const line = Str.trim(raw)
				if (line === "" || Str.startsWith("#")(line)) {
					return Effect.void
				}
				const malformed = (reason: string) =>
					Effect.fail(new PinMalformed({ line: index + 1, text: line, reason }))
				const match = assignment.exec(line)
				if (match === null) {
					return malformed("neither a comment nor an assignment NAME=value")
				}
				const [, key, written] = match
				const value = unquoted(written)
				if (value === undefined) {
					return malformed("a value the shell reads otherwise than as one word")
				}
				const [resolved, missing] = Arr.partition(Str.split(value, referenceParts), (part) => {
					if (!reference.test(part)) {
						return Result.succeed(part)
					}
					const earlier = values[Str.slice(1)(part)]
					return earlier === undefined ? Result.fail(part) : Result.succeed(earlier)
				})
				if (Arr.isReadonlyArrayNonEmpty(missing)) {
					return malformed(`${Arr.join(missing, ", ")} names no earlier assignment`)
				}
				values[key] = Arr.join(resolved, "")
				return Effect.void
			},
			{ discard: true }
		)
		return values
	})

/**
 * Every assignment of pin.env, typed: the release's tag, commit and version; its source patches, in order, each
 * `<file>=<its SHA-256>`; pgvector's tag and version; and the source, the installation and the build tree beside it. A
 * missing one fails the parse.
 */
const pinConfig = Config.all({
	PG_PIN_TAG: Config.String("PG_PIN_TAG"),
	PG_PIN_COMMIT: Config.String("PG_PIN_COMMIT"),
	PG_PIN_VERSION: Config.String("PG_PIN_VERSION"),
	PG_PIN_PATCHES: Config.map(Config.String("PG_PIN_PATCHES"), patchesOf),
	PGVECTOR_PIN_TAG: Config.String("PGVECTOR_PIN_TAG"),
	PGVECTOR_PIN_VERSION: Config.String("PGVECTOR_PIN_VERSION"),
	GRIZZLE_PG_SRC: Config.String("GRIZZLE_PG_SRC"),
	GRIZZLE_PG_PREFIX: Config.String("GRIZZLE_PG_PREFIX"),
	GRIZZLE_PG_BUILD: Config.String("GRIZZLE_PG_BUILD")
})

/** The pin's every assignment, by the name pin.env gives it (pinConfig). */
export type Pin = Config.Success<typeof pinConfig>

/**
 * grizzle's PostgreSQL pin, scripts/pg/pin.env parsed once, when this module loads, from the checkout this package
 * lies in: a consumer imports it as `@bjornpagen/grizzle-pg/pin`. A pin that does not parse fails the load.
 */
export const pin: Pin = await Effect.runPromise(
	Effect.flatMap(
		Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(pinFile)),
		(text) =>
			Effect.flatMap(assignments(text), (values) =>
				pinConfig.parse(ConfigProvider.fromEnvRecord(values))
			)
	).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer))
)
