/**
 * The format of every file grizzle writes and reads back: a committed snapshot's two files (snapshot.json records it,
 * and the seal manifest.json carries digests under it) and a served file. A file of any other format, or of none, as
 * every grizzle before this one wrote, is refused before anything of it is read, never read in part or converted: an
 * installation's committed snapshot moves to this format once, by the converter its release ships beside grizzle, and a
 * served file is written again by `grizzle generate`. A change of what any of those files holds is a change of this
 * format, and nothing reads the format before it.
 *
 * @formatConstant grizzle's artifact format: 1, the first that records itself
 */
export const artifactFormat = 1

/** The member of a snapshot.json or a served file that records its format (artifactFormat). */
export const formatKey = "format"

/** Whether a file's recorded format, as read, is this grizzle's (artifactFormat). */
export const isArtifactFormat = (recorded: unknown): boolean => recorded === artifactFormat
