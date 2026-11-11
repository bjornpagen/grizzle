import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	login,
	on,
	relation,
	role,
	type Schema,
	schema,
	type StatementsByName,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/** The dimension count of the Search schema's vectors. */
export const documentDimensions = 4
export const DocumentVector = pg.vector(documentDimensions)
const Title = str.regex("^.+$", "su")
export const Document = relation("Document", { id: uuid, account: uuid, title: Title }, ["id"])
export const DocumentCurrent = relation(
	"DocumentCurrent",
	{ document: uuid, revision: pg.bigint },
	["document"]
)

export const DocumentEmbedding = relation(
	"DocumentEmbedding",
	{ document: uuid, revision: pg.bigint, value: DocumentVector },
	["document", "revision"]
)

/**
 * Vector search in public-API form: the Search schema over a vector field, the exact cosine-distance scoring query and
 * its ordered form, and the explicit approximate retrieval over it. The dimension is 4 rather than a production
 * embedding's 1536, so facts stay small; nothing here depends on it.
 */
export const Search = schema(
	"Search",
	[Document, DocumentCurrent, DocumentEmbedding],
	[
		contained(on(DocumentCurrent, "document"), on(Document, "id")),
		contained(on(DocumentEmbedding, "document"), on(Document, "id"))
	]
)

/** Search under another name, as an installation under a unique schema name opens it. */
export type SearchNamed<N extends string> = Schema<
	N,
	(typeof Search)["relations"],
	StatementsByName<(typeof Search)["statements"], (typeof Search)["relations"]>
>

/**
 * Search's worlds over the schema they are given: a searcher, a writer of every relation, and the login holding both.
 */
export const searchWorlds = (installed: SearchNamed<string>) => {
	const searcher = role(installed, "searcher", wholeEntriesOf(installed))
	const writer = role(installed, "writer", wholeEntriesOf(installed), {
		write: writableNamesOf(installed)
	})
	return { searcher, writer, server: login(installed, "server", [searcher, writer]) }
}

/** Exact scoring of the current revisions of an account's documents, and its ordered form. */
export const scoredDocuments = query(Search).rule((r) => {
	const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
	return r
		.match(DocumentEmbedding, { document, revision, value })
		.match(DocumentCurrent, { document, revision })
		.match(Document, { id: document, account: r.param("account", Document.fields.account) })
		.find({
			document,
			revision,
			distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
		})
})

export const byDistance = scoredDocuments.orderBy(["distance", "asc"])

/** Approximate retrieval is explicit, and its candidates are matched like any relation. */
export const candidates = scoredDocuments.approximateNearest({ by: "distance", take: 20 })

export const titles = query(Search).rule((r) => {
	const source = candidates.bind({
		account: r.param("account", Document.fields.account),
		vector: r.param("vector", DocumentEmbedding.fields.value)
	})
	const { document, distance } = v(source, "source")
	const { title } = v(Document, "document")
	return r
		.match(source, { document, distance })
		.match(Document, { id: document, title })
		.find({ document, title, distance })
})
