/**
 * What the property of attachment-chains.test.ts reads: chains of attachments over one approximate search, imported
 * into one query or read as the query, and the query a case checks.
 */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { Distance } from "#compiler/public/compute.ts"
import { query, v } from "#compiler/public/query.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	Document,
	DocumentCurrent,
	DocumentEmbedding,
	Search
} from "#test/support/fixtures/api/search.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

/**
 * A case of the box: where the chain the case may attach a name twice in stands, imported or read as the query, whether
 * it attaches its one name, `a`, twice, and, imported, the chain imported beside it: none, one attaching `a` once
 * itself, or one attaching `b`. Every chain is an attachment over the approximate nearest of one source, so every
 * import's search is one node of the query (check/approximate: one search for one identity).
 */
export type ChainCase =
	| { readonly where: "root"; readonly doubled: boolean }
	| {
			readonly where: "imported"
			readonly doubled: boolean
			readonly beside: "none" | "the same name" | "another name"
	  }

const chainCases: NonEmptyReadonlyArray<ChainCase> = [
	{ where: "root", doubled: false },
	{ where: "root", doubled: true },
	{ where: "imported", doubled: false, beside: "none" },
	{ where: "imported", doubled: false, beside: "the same name" },
	{ where: "imported", doubled: false, beside: "another name" },
	{ where: "imported", doubled: true, beside: "none" },
	{ where: "imported", doubled: true, beside: "the same name" },
	{ where: "imported", doubled: true, beside: "another name" }
]

export const chainCaseGen: Gen<ChainCase> = element(chainCases)

/** An account's current embeddings scored against a vector: their approximate nearest twenty. */
const nearest = () =>
	query(Search)
		.rule((r) => {
			const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
			return r
				.match(DocumentEmbedding, { document, revision, value })
				.match(DocumentCurrent, { document, revision })
				.match(Document, { id: document, account: r.param("account", Document.fields.account) })
				.find({
					document,
					revision,
					distance: Distance.cosine(value, r.param("vector", DocumentEmbedding.fields.value))
				})
		})
		.approximateNearest({ by: "distance", take: 20 })

/** The nearest documents with each one's title attached as `a`. */
const chainA = () =>
	nearest().attach(
		"a",
		(p) =>
			query(Search).rule((r) => {
				const { title } = v(Document, "titled")
				return r.match(Document, { id: p.document, title }).find({ title })
			}),
		"option"
	)

/** The nearest documents with each one's title attached as `b`. */
const chainB = () =>
	nearest().attach(
		"b",
		(p) =>
			query(Search).rule((r) => {
				const { title } = v(Document, "titled")
				return r.match(Document, { id: p.document, title }).find({ title })
			}),
		"option"
	)

/** A query reading the chain attaching `a`, imported at its parameters. */
const importingAlone = () =>
	query(Search).rule((r) => {
		const one = chainA().bind({
			account: r.param("account", Document.fields.account),
			vector: r.param("vector", DocumentEmbedding.fields.value)
		})
		const { document, distance } = v(one, "one")
		return r.match(one, { document, distance }).find({ document, distance })
	})

/** A query reading the chain attaching `a` and `beside`, another chain, each imported at its parameters. */
const importingBeside = (beside: () => ReturnType<typeof chainA> | ReturnType<typeof chainB>) =>
	query(Search).rule((r) => {
		const at = {
			account: r.param("account", Document.fields.account),
			vector: r.param("vector", DocumentEmbedding.fields.value)
		}
		const one = chainA().bind(at)
		const two = beside().bind(at)
		const { document, distance } = v(one, "one")
		const { distance: other } = v(two, "two")
		return r
			.match(one, { document, distance })
			.match(two, { document, distance: other })
			.find({ document, distance })
	})

/** The description of a query value, as a compile reads one at its boundary (program/compile.ts queryInput). */
const descOf = (q: unknown): InferredQuery => succeeded(queryInput(q), "a query value").desc

/**
 * `q`, whose last stage is an attachment, attached again by that attachment: one chain attaching one name twice, which
 * no builder writes (query/build/attach.ts attachmentName refuses it), and a Description can.
 */
const attachedAgain = (q: InferredQuery): InferredQuery => {
	const stage = q.stage
	if (stage.kind !== "attach") {
		throw new Error("a chain ending in an attachment")
	}
	return { stage: { kind: "attach", input: stage, attach: stage.attach } }
}

/** `q` with the query its rule's first match imports attached again (attachedAgain). */
const firstImportAttachedAgain = (q: InferredQuery): InferredQuery => {
	const stage = q.stage
	if (stage.kind !== "rules") {
		throw new Error("a query of rules")
	}
	const [rule, ...rules] = stage.arms
	const [first, ...matches] = rule.matches
	if (first?.source.kind !== "query") {
		throw new Error("a rule whose first match is an import")
	}
	const again = { ...first, source: { ...first.source, query: attachedAgain(first.source.query) } }
	return { stage: { ...stage, arms: [{ ...rule, matches: [again, ...matches] }, ...rules] } }
}

/** The query a case checks. */
export const chainQuery = (c: ChainCase): InferredQuery => {
	if (c.where === "root") {
		const chain = descOf(chainA())
		return c.doubled ? attachedAgain(chain) : chain
	}
	const read = descOf(
		c.beside === "none"
			? importingAlone()
			: importingBeside(c.beside === "the same name" ? chainA : chainB)
	)
	return c.doubled ? firstImportAttachedAgain(read) : read
}

/** Where a case's chain attaches `a`: the attachment a second attachment of it is refused at. */
export const attachmentLoc = (q: InferredQuery): SourceLoc => {
	const chain =
		q.stage.kind === "rules" && q.stage.arms[0].matches[0]?.source.kind === "query"
			? q.stage.arms[0].matches[0].source.query
			: q
	if (chain.stage.kind !== "attach") {
		throw new Error("a chain ending in an attachment")
	}
	return chain.stage.attach.loc
}

/** A case's query checked as a compile checks a query read as rows. */
export const checkedChain = (q: InferredQuery): Result.Result<LogicalQuery, CompileError> =>
	checkQuery(checking(Search), q, checkOptions("query"))
