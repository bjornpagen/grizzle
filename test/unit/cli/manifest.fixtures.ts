/** What the properties of manifest.test.ts read: its space and the manifest.json files a case commits. */

import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { decode, everyProperty, type Json, noRevivers } from "#compiler/core/canonical.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { formatKey } from "#compiler/core/format.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { joinedSnapshot, snapshotSeal } from "#compiler/deploy/snapshot/build.ts"
import { defined, succeeded } from "#test/support/assert.ts"

/**
 * What a case commits beside the first draft's other file: a snapshot.json that records no format, as every grizzle
 * before formats wrote; a manifest.json sealed under the domain those grizzles sealed in (`manifest`); a record sealed
 * again over an edit no draft reads, so it reads but is not the record the schemas compile to; or that edit under the
 * draft's seal, a hand edit.
 */
const commits = [
	"an earlier format",
	"an earlier format's seal",
	"a record not the compile's",
	"a hand edit"
] as const
export type Commit = (typeof commits)[number]

/** Every case: each commit once. */
export const commitSpace = finite((source): Commit => source.draw(element(commits)))

/** A JSON record of a file's text, its canonical tags as written. */
const recordOf = (text: string): { readonly [key: string]: Json } =>
	trustedJson<{ readonly [key: string]: Json }>(text)

/** The manifest member of a manifest.json's JSON record. */
const manifestOf = (members: { readonly [key: string]: Json }): { readonly [key: string]: Json } =>
	recordOf(jsonText(defined(members["manifest"], "manifest.json's manifest")))

/** snapshot.json as a grizzle before formats wrote it: the draft's members, its format left out. */
export const unformatted = (snapshot: string): string => {
	const { [formatKey]: _format, ...members } = recordOf(snapshot)
	return jsonText(members)
}

/** The pair joined: the content both files hold, which a seal digests. */
const joinedContent = (snapshot: string, manifest: string): Readonly<Record<string, unknown>> =>
	succeeded(
		joinedSnapshot(
			succeeded(decode(snapshot, noRevivers), "snapshot.json decodes"),
			succeeded(decode(manifest, noRevivers), "manifest.json decodes")
		),
		"the pair joins"
	).content

/** manifest.json sealed as a grizzle before formats sealed it: the digest of both files under the domain `manifest`. */
export const earlierSealed = (snapshot: string, manifest: string): string =>
	jsonText({
		...recordOf(manifest),
		seal: succeeded(
			digest("manifest", joinedContent(snapshot, manifest), everyProperty),
			"the earlier seal"
		)
	})

/** The record `record` with its last edge left out, an edit no draft reads: sealed again over the edit, or under the
 * seal it carries. */
export const editedManifest = (snapshot: string, record: string, sealed: boolean): string => {
	const members = recordOf(record)
	const manifest = manifestOf(members)
	const edges = trustedJson<ReadonlyArray<Json>>(jsonText(defined(manifest["edges"], "the edges")))
	const edited = jsonText({ ...members, manifest: { ...manifest, edges: Arr.dropRight(edges, 1) } })
	if (!sealed) {
		return edited
	}
	return jsonText({
		...recordOf(edited),
		seal: succeeded(snapshotSeal(joinedContent(snapshot, edited)), "the edited record's seal")
	})
}
