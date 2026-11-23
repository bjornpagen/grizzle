import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { trusted } from "#compiler/core/trusted.ts"
import { derivedOf, writeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"

/**
 * The JSON value an import of a committed snapshot.json yields, from the file's text, every field kept: the one shape
 * DbLayer.make takes its snapshot in. It revives nothing: the layer's parseSnapshot revives the canonical tags, once.
 */
export const snapshotJson = (text: TextChunks): { readonly fingerprint: string } =>
	trusted<{ readonly fingerprint: string }>(jsonOf(text))

/** The JSON value of the snapshot.json `grizzle generate` writes for `snapshot` of `installation`, with its derived
 * runtime facts: what an application gives DbLayer.make. */
export const snapshotValue = (
	snapshot: DeploySnapshot,
	installation: Installation
): { readonly fingerprint: string } =>
	snapshotJson(
		succeeded(writeSnapshot(snapshot, derivedOf(installation)), "the installation's snapshot files")
			.snapshot
	)
