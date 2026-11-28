import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Phantom } from "#compiler/core/phantom.ts"
import type { TextSearchConfiguration, TextSearchWeight } from "#compiler/ir/search.ts"
import type { SearchDocument, TextQueryValue } from "#compiler/scalar/search.ts"
import type { InputTerm, ParamNeeds } from "#compiler/types/core/phantom.ts"
import type { Field, GeneratedField } from "#compiler/types/fields/field.ts"

export type { SearchDocument } from "#compiler/scalar/search.ts"
export type {
	TextQueryParser,
	TextSearchConfiguration,
	TextSearchWeight
} from "#compiler/ir/search.ts"

/**
 * PostgreSQL's full text search, typed.
 *
 * A search document is a tsvector PostgreSQL parses from texts under one text search configuration of pg_catalog's,
 * its identity as a type, and stores in a generated field (searchDocument), or holds as its caller wrote it in a field
 * of its own (tsvector): its host value is the text PostgreSQL prints for it (SearchDocument), which a read delivers
 * and a write of a stored one sends back as it is, and nothing more of it is the host's. A query is matched against a
 * document, and ranks it, under the document's own configuration, so no query is ever read under another, and every
 * match and rank is PostgreSQL's alone (UnhostedOrigin): a contract predicate, a row check and a generated field refuse
 * one.
 *
 * A search document's field: a tsvector of configuration C, tsvector(C)'s, its caller's, and searchDocument's
 * generated field's type.
 */
export interface SearchDocumentField<out C extends TextSearchConfiguration> extends Field<
	SearchDocument<C>,
	"tsvector"
> {
	readonly configuration: C
}

/** A part of a search document: a weight label and a text term of the row, which reads no parameter. */
export type SearchPart = readonly [TextSearchWeight, InputTerm<string, unknown, unknown, "text">]

/**
 * searchDocument(configuration, [weight, text], ...): a generated field of the row's texts parsed under
 * `configuration`, each text's positions labelled by its weight and the parts concatenated in their order, as
 * `setweight(to_tsvector(configuration, text), weight) || ...` writes it; PostgreSQL computes it as it writes the row.
 */
export type SearchDocumentConstructor = <const C extends TextSearchConfiguration>(
	configuration: C,
	...parts: NonEmptyReadonlyArray<SearchPart>
) => GeneratedField<SearchDocumentField<C>>

/**
 * A query of full text search, Search.websearch's or Search.plain's: its text and the parser that reads it,
 * which a match or a rank parses under the document it meets. It is no term: no position but a match's or a rank's
 * takes one. P are the parameters its text needs, and O its text's origin.
 */
export interface TextQuery<in P = unknown, out O = unknown>
	extends TextQueryValue, Phantom<{ readonly needs: ParamNeeds<P>; readonly origin: O }> {}
