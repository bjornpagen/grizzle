import { trustedJson } from "#compiler/core/trusted.ts"

/**
 * The JSON value an import of a committed snapshot.json yields, from the file's text, every field kept: the one shape
 * DbLayer.make takes its snapshot in. It revives nothing: the layer's parseSnapshot revives the canonical tags, once.
 */
export const snapshotJson = (text: string): { readonly fingerprint: string } =>
	trustedJson<{ readonly fingerprint: string }>(text)
