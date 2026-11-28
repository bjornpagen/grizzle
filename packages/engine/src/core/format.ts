/**
 * The format of every file grizzle writes and reads back: a committed snapshot's two files (snapshot.json records it,
 * and the seal manifest.json carries digests under it) and a served file. What each file holds is its shape, the digest
 * of its type (recordShapes), and the format each file records is this number and that shape (formatOf), so a change of
 * what any of the files holds is a change of this format, made in the same change as its shape's.
 *
 * grizzle reads exactly this format. A file of any other format, or of none, is refused before anything of it is read,
 * never read in part or converted, and nothing of another format is carried forward: no command reads another format's
 * snapshot, manifest, meta.json or ledger, converts it or rebases an installation drafted from it. An artifact or an
 * installation of another format has one remedy, to purge it and regenerate (formatRefusal): its installation dropped
 * (`grizzle uninstall`), its migrations directory emptied, and the schema drafted afresh by `grizzle generate`, one
 * init migration `grizzle migrate` installs; a served file is written again by `grizzle generate`.
 *
 * @formatConstant grizzle's artifact format: 9
 */
export const artifactFormat = 9

/** The member of a snapshot.json or a served file that records its format (artifactFormat). */
export const formatKey = "format"

/** The files that record their format: a committed snapshot, by its snapshot.json, and a login's served file. */
export const formattedFiles = ["snapshot", "served"] as const

/** A file that records its format (formattedFiles). */
export type FormattedFile = (typeof formattedFiles)[number]

/**
 * The shape of what each file grizzle reads back holds: the SHA-256 digest of the structure of its type, a committed
 * snapshot's the record its seal holds (deploy/snapshot/types.ts DeploySnapshot), a served file's served/forms.ts
 * ServedFile, every object, member and statement kind it holds resolved, names, comments and order aside
 * (test/support/record-shape.ts recordShapeOf, which the unit test record-shape.test.ts holds these to). A kind of
 * object a snapshot may hold is one of its type's members, so the shape digests the roster of them, and a kind's
 * removal is a change of this format. A change of
 * what a file holds changes its shape in the same change, under this format's number: so a file written under another
 * shape is refused by its format (formatOf) before any reader meets a member it has no reading of, where a file of one
 * format's number was read whatever shape it held, and a read could fail inside grizzle (qti-pie's pantry, drafted at
 * d76a61066 before a declared statistic recorded its dependencies, failed `grizzle check` at 8b75446f4 reading one:
 * TypeError: Cannot read properties of undefined (reading 'map')).
 *
 * @formatConstant each file's shape: the digest of its type, by test/support/record-shape.ts
 */
export const recordShapes: { readonly [F in FormattedFile]: string } = {
	snapshot: "daa8e8007aacbd82b73b18923e5f49eede49ad72517215ee77970f9e4480d4a9",
	served: "ddc884232e40fe7411c4291ffd4e944202cee92e100b3ccbb5553627e43c1a0d"
}

/**
 * The format each formatted file records: this grizzle's format and its shape (recordShapes), `<format>:<shape>`. A
 * committed snapshot's seal digests its record under it (build.ts snapshotSeal).
 */
export const formatOf: { readonly [F in FormattedFile]: string } = {
	snapshot: `${artifactFormat}:${recordShapes.snapshot}`,
	served: `${artifactFormat}:${recordShapes.served}`
}

/** Whether `file`'s recorded format, as read, is this grizzle's (formatOf). */
export const isFormatOf = (file: FormattedFile, recorded: unknown): boolean =>
	recorded === formatOf[file]

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
 * servedFile for a served file) and the command line prints (the shell's cli/refusals.ts): purge and regenerate. No
 * grizzle converts a committed snapshot of another format: its installation is dropped and drafted afresh by this
 * grizzle; a served file is written again.
 */
export const formatRefusal: {
	readonly [F in FormattedFile]: Readonly<{ problem: string; fix: string }>
} = {
	snapshot: {
		problem: "snapshot.json records another format than this grizzle's",
		fix: "purge and regenerate: drop the installation (grizzle uninstall), empty its migrations directory, then run grizzle generate, which drafts the schema afresh in this grizzle's format, and grizzle migrate: no grizzle reads another format's records"
	},
	served: {
		problem: "the served file records another format than this grizzle's",
		fix: servedFileFix
	}
}

/** What a refused file records of its format, against the format this grizzle reads and writes, in words. */
export const recordedFormatText = (recorded: RecordedFormat, expected: string): string =>
	`${recorded.kind === "none" ? "it records none" : `it records format ${recorded.text}`}, where this grizzle reads and writes format ${expected}`
