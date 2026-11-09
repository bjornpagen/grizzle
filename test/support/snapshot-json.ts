import { trustedJson } from "#compiler/core/trusted.ts"
import { writeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { succeeded } from "#test/support/assert.ts"

/**
 * The JSON value an import of a committed snapshot.json yields, from the file's text, every field kept: the one shape
 * DbLayer.make takes its snapshot in. It revives nothing: the layer's parseSnapshot revives the canonical tags, once.
 */
export const snapshotJson = (text: string): { readonly fingerprint: string } =>
	trustedJson<{ readonly fingerprint: string }>(text)

/** The JSON value of the snapshot.json `grizzle generate` writes for `snapshot`: what an application gives DbLayer.make. */
export const snapshotValue = (snapshot: DeploySnapshot): { readonly fingerprint: string } =>
	snapshotJson(succeeded(writeSnapshot(snapshot), "the installation's snapshot files").snapshot)
