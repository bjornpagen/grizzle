import type { Brand } from "effect"
import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { Built, Phantom } from "#compiler/core/phantom.ts"
import {
	isTextSearchConfiguration,
	type TextQueryParser,
	type TextSearchConfiguration,
	textSearchConfigurations
} from "#compiler/ir/search.ts"
import { bareEnv, carrierSql, type Descriptor, defineField } from "#compiler/scalar/registry.ts"

/**
 * A search document as the host holds it: the text PostgreSQL prints for its tsvector (tsvectorout), its lexemes in
 * their one order, each with its positions and weights, under the brand "SearchDocument" and the configuration C it was
 * parsed under, an equality-only tag, so documents of two configurations are two types. The host reads one and never
 * makes one: a document is PostgreSQL's parse of its row's texts (ir/search.ts).
 */
export type SearchDocument<C extends TextSearchConfiguration = TextSearchConfiguration> = string &
	Brand.Brand<"SearchDocument"> &
	Phantom<{ readonly configuration: C }>

/** A search document's descriptor: its configuration, and its column, which delivers the document's printed text. */
export interface SearchDescriptor<
	C extends TextSearchConfiguration
> extends Descriptor<"tsvector"> {
	readonly configuration: C
	readonly column: Column<SearchDocument<C>>
}

/**
 * The descriptor of a search document parsed under `configuration`, one of pg_catalog's (ir/search.ts): a tsvector,
 * PostgreSQL's alone, which a generated field alone is of (public/fields.ts searchDocument), so no caller writes one and
 * no parameter carries one. A JavaScript caller's configuration outside the roster is MalformedDescription.
 */
export const searchDescriptor = <C extends TextSearchConfiguration>(
	configuration: C
): SearchDescriptor<C> => {
	if (!isTextSearchConfiguration(configuration)) {
		throw malformedDescription(
			captureLoc("searchDocument", []),
			`a text search configuration of pg_catalog's: ${textSearchConfigurations.join(", ")}`
		)
	}
	return defineField(
		{},
		carrierSql.tsvector,
		{ kind: "search", configuration },
		{ configuration, column: convertColumn<SearchDocument<C>>({ carrier: "tsvector" }) },
		SourceLoc(`searchDocument(${configuration})`, []),
		bareEnv
	)
}

/**
 * A query of full text search as a builder makes it (scalar/compute/builders.ts textQueryOf): the parser that reads its
 * text into a tsquery under the configuration of the document a match or a rank meets (ir/search.ts TextQueryParser).
 * It is no term: no position but a match's or a rank's takes one, so no query is parsed where nothing reads it, and
 * none under another document's configuration. Its public type, with its text's parameters and origin, is types/search
 * TextQuery.
 */
export interface TextQueryValue extends Built {
	readonly parser: TextQueryParser
}
