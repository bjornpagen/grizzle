import { Schema } from "effect"
import { succeeded } from "#test/support/assert.ts"

const SnapshotJson = Schema.fromJsonString(
	Schema.StructWithRest(Schema.Struct({ fingerprint: Schema.String }), [
		Schema.Record(Schema.String, Schema.Unknown)
	])
)

const decodeSnapshotJson = Schema.decodeResult(SnapshotJson)

/**
 * The JSON value an import of a committed snapshot.json yields, from the file's text, every field kept: the one shape
 * DbLayer.make takes its snapshot in. It revives nothing: the layer's parseSnapshot revives the canonical tags, once.
 */
export const snapshotJson = (text: string): { readonly fingerprint: string } =>
	succeeded(decodeSnapshotJson(text))
