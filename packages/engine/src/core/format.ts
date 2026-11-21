/**
 * The format of every file grizzle writes and reads back: a committed snapshot's two files (snapshot.json records it,
 * and the seal manifest.json carries digests under it) and a served file. A file of any other format, or of none, is
 * refused before anything of it is read, never read in part or converted: grizzle reads exactly this format, so an
 * installation whose committed snapshot holds another is drafted afresh, and a served file is written again by
 * `grizzle generate`. A change of what any of those files holds is a change of this format, and nothing reads the
 * format before it.
 *
 * @formatConstant grizzle's artifact format: 4, whose snapshot.json records every structural text domain the
 * installation holds (derived.textDomains), each refinement any artifact over it or any program it serves types a value
 * by, and every contract outside the base they type a value by (derived.params.contracts). Format 3's files were written
 * in several shapes, changes of what they hold riding its number (a constant recorded with no language before
 * 56f26ca01), so a reader that trusted a sealed record of 3 met shapes it never wrote; every one is refused here
 */
export const artifactFormat = 4

/** The member of a snapshot.json or a served file that records its format (artifactFormat). */
export const formatKey = "format"

/** Whether a file's recorded format, as read, is this grizzle's (artifactFormat). */
export const isArtifactFormat = (recorded: unknown): boolean => recorded === artifactFormat

/** The files that record their format: a committed snapshot, by its snapshot.json, and a login's served file. */
export type FormattedFile = "snapshot" | "served"

/**
 * What a file records of its format, as read and never trusted: none, where it holds no format member, or a value, by
 * its JSON text (`0`, `2`, any value a hand edit left there).
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
 * servedFile for a served file) and the command line prints (the shell's cli/refusals.ts). No grizzle converts a
 * committed snapshot of another format: its installation is drafted afresh by this grizzle; a served file is written
 * again.
 */
export const formatRefusal: {
	readonly [F in FormattedFile]: Readonly<{ problem: string; fix: string }>
} = {
	snapshot: {
		problem: "snapshot.json records another format than this grizzle's",
		fix: "draft the installation afresh with this grizzle, from an empty migrations directory into an empty database: no grizzle reads another format's records"
	},
	served: {
		problem: "the served file records another format than this grizzle's",
		fix: servedFileFix
	}
}

/** What a refused file records of its format, against the format this grizzle reads and writes, in words. */
export const recordedFormatText = (recorded: RecordedFormat, expected: number): string =>
	`${recorded.kind === "none" ? "it records none" : `it records format ${recorded.text}`}, where this grizzle reads and writes format ${expected}`
