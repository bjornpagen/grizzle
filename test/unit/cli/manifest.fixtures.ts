/** What the properties of manifest.test.ts read: its space and the manifest.json files a case commits. */

import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { CompiledSchema } from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { draftSchema } from "#cli/generate.ts"
import { decode, everyProperty, type Json, noRevivers, toJson } from "#compiler/core/canonical.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import {
	joinedSnapshot,
	noWorkload,
	snapshotSeal,
	targetState
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot, SnapshotContent } from "#compiler/deploy/snapshot/types.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * What a case commits as manifest.json beside the first draft's snapshot.json: the form a grizzle before records wrote,
 * every installed statement whole with its reasons, state and phase and no seal; a record sealed again over an edit no
 * draft reads, so it reads but is not the record the schemas compile to; or that edit under the draft's seal, a hand
 * edit.
 */
const commits = ["the earlier form", "a record not the compile's", "a hand edit"] as const
export type Commit = (typeof commits)[number]

/** Every case: each commit once. */
export const commitSpace = finite((source): Commit => source.draw(element(commits)))

/**
 * The whole content of the snapshot `committed` records, as `grizzle generate` compiles `compiled` again from it
 * (cli/generate.ts draftSchema): every object of the compile's manifest whole, the ledger's among them, with its
 * reasons, its state and its phase (build.ts targetState).
 */
export const contentOf = (
	compiled: CompiledSchema,
	committed: DeploySnapshot
): Effect.Effect<SnapshotContent, CliError> =>
	Effect.map(draftSchema(compiled, committed, [], noDeclarations), (draft) =>
		succeeded(
			targetState({
				installation: draft.installation,
				workload: noWorkload,
				checks: lawChecks(draft.installation)
			}),
			"the draft's content"
		)
	)

/** A JSON record of a file's text, its canonical tags as written. */
const recordOf = (text: string): { readonly [key: string]: Json } =>
	trustedJson<{ readonly [key: string]: Json }>(text)

/** The manifest member of a manifest.json's JSON record. */
const manifestOf = (members: { readonly [key: string]: Json }): { readonly [key: string]: Json } =>
	recordOf(jsonText(defined(members["manifest"], "manifest.json's manifest")))

/**
 * manifest.json as a grizzle before records wrote it, of the record `record` and the snapshot's whole content: the
 * record's members, each object whole as the compile installs it, with its reasons, its state and its phase, and no
 * seal; the fingerprint snapshot.json records digests exactly this content.
 */
export const earlierManifest = (record: string, content: SnapshotContent): string => {
	const { seal: _seal, ...members } = recordOf(record)
	const objects = Arr.map(content.manifest.objects, (o) =>
		succeeded(
			toJson(
				{
					kind: o.kind,
					ident: o.ident,
					ddl: o.ddl,
					reasons: o.reasons,
					state: o.state,
					phase: o.phase
				},
				everyProperty
			),
			"an object's JSON"
		)
	)
	return jsonText({ ...members, manifest: { ...manifestOf(members), objects } })
}

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
	const joined = succeeded(
		joinedSnapshot(
			succeeded(decode(snapshot, noRevivers), "snapshot.json decodes"),
			succeeded(decode(edited, noRevivers), "the edited manifest.json decodes")
		),
		"the edited pair joins"
	)
	assert.ok(joined.form === "recorded", "the edited manifest.json is a record")
	return jsonText({
		...recordOf(edited),
		seal: succeeded(snapshotSeal(joined.content), "the edited record's seal")
	})
}
