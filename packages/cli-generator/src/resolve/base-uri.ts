import { Option } from "effect"
import { stringMember } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { resolveUri, retrievalBase, stripFragment } from "#model/uri.ts"

/**
 * The base URI of a document's non-schema objects (design 3.3): the retrieval URI for 3.0 and 3.1;
 * for 3.2 the `$self` value resolved against the retrieval URI with its fragment stripped, else the
 * retrieval URI. `None` when `$self` does not resolve to a URI.
 */
export const documentBase = (
	line: SpecLine,
	retrieval: string,
	root: Json
): Option.Option<string> => {
	const normalized = retrievalBase(retrieval)
	const self = line === "3.2" ? stringMember(root, "$self") : undefined

	return self === undefined
		? Option.some(normalized)
		: Option.map(resolveUri(self, normalized), stripFragment)
}

/**
 * The base URI inside a Schema Object (design 3.3): for 3.1 and 3.2 the schema's own `$id`
 * resolved against the enclosing base with its fragment stripped, else the enclosing base; 3.0 has
 * no `$id`. `None` when `$id` does not resolve to a URI.
 */
export const schemaBase = (
	line: SpecLine,
	enclosing: string,
	schema: Json
): Option.Option<string> => {
	const id = line === "3.0" ? undefined : stringMember(schema, "$id")

	return id === undefined
		? Option.some(enclosing)
		: Option.map(resolveUri(id, enclosing), stripFragment)
}
