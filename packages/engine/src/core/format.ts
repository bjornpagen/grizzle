/**
 * The format of every file grizzle writes and reads back: a committed snapshot's two files (snapshot.json records it,
 * and the seal manifest.json carries digests under it) and a served file. A file of any other format, or of none, as
 * every grizzle before this one wrote, is refused before anything of it is read, never read in part or converted: an
 * installation's committed snapshot moves to this format once, by the converter its release ships beside grizzle, and a
 * served file is written again by `grizzle generate`. A change of what any of those files holds is a change of this
 * format, and nothing reads the format before it.
 *
 * @formatConstant grizzle's artifact format: 2, whose installed statements hold an IN list of one item as the equality
 * PostgreSQL stores it as, beside every snapshot member and served form the commits after format 1 moved (canonical
 * selections, generated fields' records, the case split, chain folds, closed-pattern AREs, key references, places)
 */
export const artifactFormat = 2

/** The member of a snapshot.json or a served file that records its format (artifactFormat). */
export const formatKey = "format"

/** Whether a file's recorded format, as read, is this grizzle's (artifactFormat). */
export const isArtifactFormat = (recorded: unknown): boolean => recorded === artifactFormat

/** The files that record their format: a committed snapshot, by its snapshot.json, and a login's served file. */
export type FormattedFile = "snapshot" | "served"

/**
 * What a file records of its format, as read and never trusted: none, as every grizzle before formats wrote, or a
 * value, by its JSON text (`0`, `2`, any value a hand edit left there).
 */
export type RecordedFormat =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "recorded"; text: string }>

/** What a file's format member holds, as RecordedFormat reads it: undefined where the file holds no such member. */
export const recordedFormat = (value: unknown): RecordedFormat =>
	value === undefined ? { kind: "none" } : { kind: "recorded", text: JSON.stringify(value) }

/** How a served file of another format is put right, which a served file out of date shares: write it again. */
export const servedFileFix = "run grizzle generate, which writes the served file again"

/**
 * Each formatted file's refusal of a format other than this grizzle's, and its fix: the one text the engine's readers
 * refuse by (deploy/snapshot/build.ts joinedSnapshot and served.ts servedSnapshot for a snapshot, served/json.ts
 * servedFile for a served file) and the command line prints (the shell's cli/refusals.ts). A committed snapshot moves to
 * this format by its release's converter, never by hand; a served file is written again.
 */
export const formatRefusal: {
	readonly [F in FormattedFile]: Readonly<{ problem: string; fix: string }>
} = {
	snapshot: {
		problem: "snapshot.json records another format than this grizzle's",
		fix: "convert the installation's committed snapshot with the converter its release ships beside grizzle"
	},
	served: {
		problem: "the served file records another format than this grizzle's",
		fix: servedFileFix
	}
}

/** What a refused file records of its format, against the format this grizzle reads and writes, in words. */
export const recordedFormatText = (recorded: RecordedFormat, expected: number): string =>
	`${recorded.kind === "none" ? "it records none, as every grizzle before formats wrote" : `it records format ${recorded.text}`}, where this grizzle reads and writes format ${expected}`
