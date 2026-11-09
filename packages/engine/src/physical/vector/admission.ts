import { schemaUsesVectors } from "#compiler/physical/vector/premise.ts"
import { vectorExtension } from "#compiler/physical/vector/storage.ts"
import type { Owned } from "#compiler/schema/own.ts"

interface ExtensionExpectation {
	readonly extension: string
	readonly version: string
	readonly schema: string
}

/** The vector extension a schema's installation expects. A schema that uses vectors requires pgvector at its pinned
 * version, installed in the schema the installation names for it: `vector` 0.8.7 in `vector_ext` on the local cluster;
 * a schema without vectors expects nothing. The expectation is pure data, which a page cursor's generation names the
 * version of; nothing at runtime compares it with the database, which PostgreSQL judges where a statement names the
 * extension's type. */
export const vectorExpectations = (
	owned: Owned,
	vectorSchema: string
): ReadonlyArray<ExtensionExpectation> =>
	schemaUsesVectors(owned)
		? [{ extension: vectorExtension.name, version: vectorExtension.version, schema: vectorSchema }]
		: []
