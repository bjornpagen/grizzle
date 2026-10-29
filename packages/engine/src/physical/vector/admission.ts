import { schemaUsesVectors } from "#compiler/physical/vector/premise.ts"
import { vectorExtension } from "#compiler/physical/vector/storage.ts"
import type { Owned } from "#compiler/schema/own.ts"

interface ExtensionExpectation {
	readonly extension: string
	readonly version: string
	readonly schema: string
}

/** What admission verifies of the vector extension. A schema that uses vectors requires pgvector at its pinned version, installed in the schema the installation names
 * for it: `vector` 0.8.7 in `vector_ext` on the local cluster. The expectation is pure data; the catalog read and the
 * comparison with `pg_extension.extversion` and the namespace of `pg_extension.extnamespace` belong to Db.open's
 * minimal admission, which pins the same `vectorExtension` and turns a refusal
 * into `OpenError{stage: "capability"}`. A schema without vectors expects nothing and admits any host,
 * with or without the extension. */
export const vectorExpectations = (
	owned: Owned,
	vectorSchema: string
): ReadonlyArray<ExtensionExpectation> =>
	schemaUsesVectors(owned)
		? [{ extension: vectorExtension.name, version: vectorExtension.version, schema: vectorSchema }]
		: []
