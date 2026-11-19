/** What the properties of ann.test.ts read: the fixture's templates, the spaces, and the reads and exact baselines. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
import {
	accountA,
	accountB,
	accountC,
	anyRevision,
	type Compiled,
	candidates,
	DocumentEmbedding,
	type Fixture,
	annTemplate,
	annFacts,
	repeated,
	shared,
	sizes,
	textRows,
	titles,
	unfiltered,
	untagged,
	vectorText
} from "#test/pg/vector/ann/support.ts"
import { paramTexts, scalarsOnly } from "#test/support/compile.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/**
 * Whether a plan reads the HNSW index the workload requests on DocumentEmbedding.value, named as its installation names it.
 */
const readsHnsw = (fx: Fixture, indexes: ReadonlyArray<string>): boolean => {
	const hnsw = namesOf(fx.installed).accessIndex(DocumentEmbedding, ["value"])
	return Arr.some(indexes, (i) => i === hnsw)
}

export const run = (
	session: RawSession,
	c: Compiled,
	params: Readonly<Record<string, unknown>>
) => {
	const spec = defined(c.specs[0], "statement 0")
	return Effect.map(session.values(spec.sql, paramTexts(spec, params, scalarsOnly)), textRows)
}

/** Whether PostgreSQL plans the executable statement with its parameters over the HNSW index. */
export const servedByHnsw = (
	session: RawSession,
	fx: Fixture,
	c: Compiled,
	params: Readonly<Record<string, unknown>>
) =>
	Effect.gen(function* () {
		const spec = defined(c.specs[0], "statement 0")
		const rows = yield* session.values(
			`EXPLAIN (FORMAT JSON, COSTS FALSE) ${spec.sql}`,
			paramTexts(spec, params, scalarsOnly)
		)
		const [explained] = defined(rows[0], "the EXPLAIN row")
		return readsHnsw(fx, planIndexNames(explained))
	})

/**
 * The exact baseline: the complete eligible relation scored with cosine_distance, which no index orders, under the
 * statement's own key order. It also returns every eligible fact's exact score.
 */
export const exactScores = (
	session: RawSession,
	fx: Fixture,
	account: string,
	vector: ReadonlyArray<number>
) =>
	Effect.map(
		session.values(
			`SELECT e."document"::text, e."revision"::text, vector_ext.cosine_distance(e."value", $1::text::vector_ext.vector)::text
			 FROM ${fx.table("DocumentEmbedding")} AS e
			 JOIN ${fx.table("DocumentCurrent")} AS c ON c."document" = e."document" AND c."revision" = e."revision"
			 JOIN ${fx.table("Document")} AS d ON d."id" = e."document"
			 WHERE d."account" = $2::text::uuid
			 ORDER BY vector_ext.cosine_distance(e."value", $1::text::vector_ext.vector), e."document", e."revision"`,
			[vectorText(vector), account]
		),
		textRows
	)

/**
 * The exact baseline of anyRevision: every distinct (document, distance) of an account's revisions, scored with
 * cosine_distance, which no index orders.
 */
export const exactDistinct = (
	session: RawSession,
	fx: Fixture,
	account: string,
	vector: ReadonlyArray<number>
) =>
	Effect.map(
		session.values(
			`SELECT DISTINCT e."document"::text, vector_ext.cosine_distance(e."value", $1::text::vector_ext.vector)::text
			 FROM ${fx.table("DocumentEmbedding")} AS e
			 JOIN ${fx.table("Document")} AS d ON d."id" = e."document"
			 WHERE d."account" = $2::text::uuid`,
			[vectorText(vector), account]
		),
		textRows
	)

export const key = (row: ReadonlyArray<string>): string => `${row[0]}/${row[1]}`

/** candidates delivers (distance, document, revision): heading order is canonical code-unit order. */
export const asTriple = (row: ReadonlyArray<string>): readonly [string, string, string] => {
	const [distance, document, revision] = row
	if (distance === undefined || document === undefined || revision === undefined) {
		throw new Error("a row of three columns")
	}
	return [document, revision, distance]
}

/** An account of the fixture, by the letter its size is listed under. */
export type AccountLabel = keyof typeof sizes

/** Each of the fixture's accounts by its letter. */
const accountOf: { readonly [L in AccountLabel]: string } = {
	A: accountA,
	B: accountB,
	C: accountC
}

/** An account of the fixture and the letter a report names it by. */
export type Account = readonly [account: string, label: AccountLabel]

/** The fixture's accounts, every one its sizes list. */
export const accounts: Arr.NonEmptyReadonlyArray<Account> = Arr.map(
	nonEmpty(Rec.keys(sizes), "the fixture's accounts"),
	(label): Account => [accountOf[label], label]
)

/** The bound each program of the fixture states (support.ts): candidates' and untagged's, then the others'. */
export const candidatesTake = 20
export const anyRevisionTake = 10

/** A probe a test numbers: any number names a query vector of the run's draw (support.ts probeOf). */
export const probeNumber: Gen<number> = int(0, 2 ** 31 - 1)

/** A search of the candidates: an account probed with a drawn vector, or account A's shared embedding. */
export type CandidateProbe =
	| { readonly kind: "drawn"; readonly account: Account; readonly n: number }
	| { readonly kind: "duplicate" }

export const candidateProbeGen: Gen<CandidateProbe> = weighted<CandidateProbe>([
	[
		8,
		(source) => ({
			kind: "drawn",
			account: source.draw(element(accounts)),
			n: source.draw(probeNumber)
		})
	],
	[1, () => ({ kind: "duplicate" })]
])

/** What a search came to. */
export type SearchFeature =
	| `account ${AccountLabel}`
	| "underfilled by a small account"
	| "the duplicate embedding"
	| "served by the HNSW index"
	| "a negated tag excluded"
	| "a repeated document probed with its own embedding"

/**
 * A transaction's changes to account B's nearest candidates: how many of the nearest lose their current embedding, and
 * how many after them get a new current revision, of the probe numbered `n`.
 */
export interface Superseding {
	readonly n: number
	readonly removed: number
	readonly superseded: number
}

export const supersededGen: Gen<Superseding> = (source) => {
	const kind = source.draw(element(["removed", "superseded", "both"] as const))
	return {
		n: source.draw(probeNumber),
		removed: kind === "superseded" ? 0 : source.draw(int(1, 12)),
		superseded: kind === "removed" ? 0 : source.draw(int(1, 8))
	}
}

export type SupersededFeature =
	| "nearest embeddings removed"
	| "nearest revisions superseded"
	| "both, in one transaction"
	| "served by the HNSW index"

export const supersededFeatures = (c: Superseding): ReadonlyArray<SupersededFeature> => [
	...(c.removed > 0 ? ["nearest embeddings removed" as const] : []),
	...(c.superseded > 0 ? ["nearest revisions superseded" as const] : []),
	...(c.removed > 0 && c.superseded > 0 ? ["both, in one transaction" as const] : [])
]

export const searcher = (fx: Fixture) =>
	Effect.flatMap(Substrate, (s) =>
		s.session({ ...worldSession(fx.installed.world(fx.app)), label: "searcher" })
	)

/** The single searches of the fixture, each one approximate search over a stored source. */
export const shapePrograms = { candidates, anyRevision, unfiltered } as const

/** Their names, the box of the shapes property. */
export const shapeNames = nonEmpty(Rec.keys(shapePrograms), "the fixture's single searches")

/** The accounts of the template's population with a repeated document. */
export const repeatingAccounts = nonEmpty(
	Arr.filter(accounts, ([account]) => repeated(annFacts, account).length > 0),
	"the accounts with a repeated document"
)

/**
 * The fixture installed with each property's programs, populated and analyzed once per member (support.ts
 * annTemplate), where each search installed and populated it before its cases.
 */
export const candidatesAnn = annTemplate(import.meta, "ann candidates", { candidates })
export const shapesAnn = annTemplate(import.meta, "ann shapes", shapePrograms)
export const fanoutAnn = annTemplate(import.meta, "ann fanout", { anyRevision })
export const negationAnn = annTemplate(import.meta, "ann negation", { candidates, untagged })
export const supersededAnn = annTemplate(import.meta, "ann superseded", { candidates })
export const sharedAnn = annTemplate(import.meta, "ann shared", { candidates, titles, shared })
