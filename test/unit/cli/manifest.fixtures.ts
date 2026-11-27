/** What the properties of manifest.test.ts read: its space and the manifest.json files a case commits. */

import { defined } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { decode, everyProperty, type Json, noRevivers } from "#compiler/core/canonical.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { artifactFormat, formatKey, formatOf, type RecordedFormat } from "#compiler/core/format.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { joinedSnapshot, snapshotSeal } from "#compiler/deploy/snapshot/build.ts"
import { succeeded } from "#test/support/assert.ts"
import { chunked } from "#test/support/chunked.ts"

/**
 * What a case commits beside the first draft's other file: a snapshot.json that records no format, or that records the
 * format before this grizzle's or the one after it; both files as a draft of format 3 left them (`formatThree`); a
 * manifest.json sealed under a domain that names no format (`manifest`); a record sealed again over an edit no draft
 * reads, so it reads but is not the record the schemas compile to; that edit under the draft's seal, a hand edit; both
 * files as d76a61066
 * drafted them, qti-pie's pantry among them, its format the number alone, sealed under that format
 * (`a d76a61066 draft`); or that record relabelled with this grizzle's format,
 * sealed as d76a61066 sealed it (`a d76a61066 record under this format`).
 */
const commits = [
	"format none",
	"the format before",
	"the format after",
	"a format 3 draft",
	"a seal naming no format",
	"a record not the compile's",
	"a hand edit",
	"a d76a61066 draft",
	"a d76a61066 record under this format"
] as const
export type Commit = (typeof commits)[number]

/** The commits of a snapshot.json of another format than this grizzle's, each with the format it records. */
export const formatCommits = {
	"format none": { kind: "none" },
	"the format before": { kind: "recorded", text: String(artifactFormat - 1) },
	"the format after": { kind: "recorded", text: String(artifactFormat + 1) },
	"a format 3 draft": { kind: "recorded", text: "3" },
	"a d76a61066 draft": { kind: "recorded", text: String(artifactFormat) }
} as const satisfies { readonly [C in Commit]?: RecordedFormat }

/** Every case: each commit once. */
export const commitSpace = finite((source): Commit => source.draw(element(commits)))

/** A JSON record of a file's text, its canonical tags as written. */
const recordOf = (text: string): { readonly [key: string]: Json } =>
	trustedJson<{ readonly [key: string]: Json }>(text)

/** The manifest member of a manifest.json's JSON record. */
const manifestOf = (members: { readonly [key: string]: Json }): { readonly [key: string]: Json } =>
	recordOf(jsonText(defined(members["manifest"], "manifest.json's manifest")))

/** snapshot.json recording `recorded` as its format: the draft's members, its format left out or that value. */
export const formatted = (snapshot: string, recorded: RecordedFormat): string => {
	const { [formatKey]: _format, ...members } = recordOf(snapshot)
	return recorded.kind === "none"
		? jsonText(members)
		: jsonText({ ...members, [formatKey]: trustedJson<Json>(recorded.text) })
}

/** The pair joined: the content both files hold, which a seal digests. */
const joinedContent = (snapshot: string, manifest: string): Readonly<Record<string, unknown>> =>
	succeeded(
		joinedSnapshot(
			succeeded(decode(chunked(snapshot), noRevivers), "snapshot.json decodes"),
			succeeded(decode(chunked(manifest), noRevivers), "manifest.json decodes")
		),
		"the pair joins"
	).content

/** manifest.json sealed under a domain that names no format: the digest of both files under the domain `manifest`. */
export const formatlessSealed = (snapshot: string, manifest: string): string =>
	jsonText({
		...recordOf(manifest),
		seal: succeeded(
			digest("manifest", joinedContent(snapshot, manifest), everyProperty),
			"the earlier seal"
		)
	})

/** The record `record` with its last edge left out, the last dependency of the last object that has one, an edit no
 * draft reads: sealed again over the edit, or under the seal it carries. */
export const editedManifest = (snapshot: string, record: string, sealed: boolean): string => {
	const members = recordOf(record)
	const manifest = manifestOf(members)
	const objects = trustedJson<ReadonlyArray<Members & { readonly after: ReadonlyArray<Json> }>>(
		jsonText(defined(manifest["objects"], "the objects"))
	)
	const last = defined(
		Option.getOrUndefined(Arr.findLastIndex(objects, (o) => o.after.length > 0)),
		"an object created after another"
	)
	const edited = jsonText({
		...members,
		manifest: {
			...manifest,
			objects: Arr.map(objects, (o, i) =>
				i === last ? { ...o, after: Arr.dropRight(o.after, 1) } : o
			)
		}
	})
	if (!sealed) {
		return edited
	}
	return jsonText({
		...recordOf(edited),
		seal: succeeded(snapshotSeal(joinedContent(snapshot, edited)), "the edited record's seal")
	})
}

/** A JSON object's members. */
type Members = { readonly [key: string]: Json }

/** A manifest.json record with the language left out of each constant's header it records (snapshot/recorded.ts
 * RecordedConstant). */
const withoutLanguage = (members: Members): Members => {
	const manifest = trustedJson<
		Members & {
			readonly objects: ReadonlyArray<Members & { readonly ddl: ReadonlyArray<Members> }>
		}
	>(jsonText(defined(members["manifest"], "manifest.json's manifest")))
	return {
		...members,
		manifest: {
			...manifest,
			objects: Arr.map(manifest.objects, (o) => ({
				...o,
				ddl: Arr.map(o.ddl, (s): Members => {
					const header = s["header"]
					return s["kind"] === "recordedConstant" && header !== undefined
						? { ...s, header: Rec.remove(trustedJson<Members>(jsonText(header)), "language") }
						: s
				})
			}))
		}
	}
}

/**
 * Both files as a draft of format `sealed` left them: snapshot.json recording `recorded` as its format, and
 * manifest.json's record as that format held it (`shape`), sealed under its domain (`manifest-<format>`, build.ts
 * snapshotSeal) over the content both files hold, which leaves the format out, as a grizzle of that format wrote and
 * sealed it.
 */
const formatDraft = (
	snapshot: string,
	manifest: string,
	recorded: Json,
	sealed: number,
	shape: (record: Members) => Members
): { readonly snapshot: string; readonly manifest: string } => {
	const shaped = jsonText(shape(recordOf(manifest)))
	return {
		snapshot: formatted(snapshot, { kind: "recorded", text: jsonText(recorded) }),
		manifest: jsonText({
			...recordOf(shaped),
			seal: succeeded(
				digest(`manifest-${sealed}`, joinedContent(snapshot, shaped), everyProperty),
				`format ${sealed}'s seal`
			)
		})
	}
}

/**
 * Both files as d76a61066 drafted them, qti-pie's pantry among them, which 8b75446f4's `grizzle check` failed reading:
 * sealed under the domain of this grizzle's format's number, snapshot.json recording that number alone as its format,
 * or, `relabelled`, this grizzle's format.
 */
export const d76a61066Draft = (
	snapshot: string,
	manifest: string,
	relabelled: boolean
): { readonly snapshot: string; readonly manifest: string } =>
	formatDraft(
		snapshot,
		manifest,
		relabelled ? formatOf.snapshot : artifactFormat,
		artifactFormat,
		(record) => record
	)

/**
 * Both files as a draft of format 3 left them, edullm's reset folder of 2026-11-20 11:54Z among them: each constant
 * recorded by its name, its parameters and its result type, with no language (56f26ca01 added it, riding format 3). A
 * reader that trusted it replayed a constant of no language, whose print fell into another statement's arm and failed
 * (TypeError: name.replaceAll is not a function).
 */
export const formatThree = (
	snapshot: string,
	manifest: string
): { readonly snapshot: string; readonly manifest: string } =>
	formatDraft(snapshot, manifest, 3, 3, withoutLanguage)
