import { indices } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { int } from "@bjornpagen/testing/gen"
import { floorSeed, type Stream } from "@bjornpagen/testing/random"
import { sample } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, Option, pipe, Record as Rec, String as Str } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { LogicalQuery, StatementSpec } from "#compiler/ir/products.ts"
import { noLive } from "#compiler/live/notify.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { specifiedProgram } from "#compiler/lower/template.ts"
import { workloadRequests as accessRequests } from "#compiler/physical/access/extension.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallExtension,
	noCarriers,
	noHolds,
	noCalls,
	noCertificates,
	noContribution,
	noFences,
	servesNoParams
} from "#compiler/physical/install/extension.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { storedSettingValue } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { compileTestWorkload, lowerAligned, testCompile } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import { type Installed, seededTemplate } from "#test/support/install-migrate.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { Substrate, type SubstrateCase } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

export const dimensions = 8
const DocumentVector = pg.vector(dimensions)
const Title = str.regex("^.+$", "su")
const TagName = str.regex("^[a-z]{1,16}$")
const Document = relation("Document", { id: Id, account: Id, title: Title }, ["id"])
const DocumentCurrent = relation("DocumentCurrent", { document: Id, revision: pg.bigint }, [
	"document"
])

export const DocumentEmbedding = relation(
	"DocumentEmbedding",
	{ document: Id, revision: pg.bigint, value: DocumentVector },
	["document", "revision"]
)
const DocumentTag = relation("DocumentTag", { document: Id, tag: TagName }, ["document", "tag"])
/**
 * The approximate-retrieval fixture on PostgreSQL 19.
 *
 * The vector search example's Search schema at eight dimensions, with a tag relation, installed by the real installer
 * with the HNSW index the workload program `candidates` requests (the workload compiler's access paths, physical/access),
 * and a deterministic population sized so that PostgreSQL's planner prefers the index for an unfiltered
 * nearest-neighbor ORDER BY ... LIMIT:
 *
 * - account A holds most documents, account B a few hundred, and account C only twelve, so a search for C's
 *   documents is selective and must underfill a request for twenty;
 * - every third document has a second revision, which is its current one; every fiftieth document's current revision
 *   has no embedding yet, so it is not eligible ("pending embeddings are missing facts");
 * - two of account A's documents have identical current embeddings under different keys, which are different facts;
 * - every fourth single-revision document of accounts A and C also has a superseded second revision whose embedding
 *   equals its current one: a fact of its own under (document, revision), and a repeat of (document, distance) once the
 *   revision is projected away, so a search over every revision owes a DISTINCT before its bound;
 * - every vector is a unit vector of exact binary32 components, so its stored value is the text the fixture writes.
 *
 * Queries compile through the checker and the optimized pipeline (lowerOptimized), and run as the template's
 * executable statements (lower/template.ts specifiedProgram): every result column cast to text, every placeholder
 * filled by the template's own encoder. The conservative artifact of an approximate program is the exact pgvector
 * lowering, so the exact baseline here is the complete scan written directly against the
 * installation: `cosine_distance` over every eligible row, which no HNSW index orders.
 */
const AnnSearch = schema(
	"AnnSearch",
	[Document, DocumentCurrent, DocumentEmbedding, DocumentTag],
	[
		contained(on(DocumentCurrent, "document"), on(Document, "id")),
		contained(on(DocumentEmbedding, "document"), on(Document, "id")),
		contained(on(DocumentTag, "document"), on(Document, "id"))
	]
)

/** Exact scoring of the current revisions of an account's documents. */
const scoredDocuments = query(AnnSearch).rule((r) => {
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

/** The example's approximate candidates. */
export const candidates = scoredDocuments.approximateNearest({ by: "distance", take: 20 })

export const titles = query(AnnSearch).rule((r) => {
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

/**
 * Every revision of an account's documents, scored, its revision projected away: a document's revisions repeat it,
 * and equal embeddings repeat the whole fact, so the source owes a DISTINCT before the bound.
 */
export const anyRevision = query(AnnSearch)
	.rule((r) => {
		const { document, value } = v(DocumentEmbedding, "documentEmbedding")
		return r
			.match(DocumentEmbedding, { document, value })
			.match(Document, { id: document, account: r.param("account", Document.fields.account) })
			.find({
				document,
				distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
			})
	})
	.approximateNearest({ by: "distance", take: 10 })

/**
 * The example's scoring with an eligibility negation: an account's current revisions of documents not tagged gamma. The
 * negation's one correlated variable is a head column, so the checker places the AntiJoin above the projection, and
 * it is still part of the eligible universe evaluated before the bound.
 */
export const untagged = query(AnnSearch)
	.rule((r) => {
		const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
		return r
			.match(DocumentEmbedding, { document, revision, value })
			.match(DocumentCurrent, { document, revision })
			.match(Document, { id: document, account: r.param("account", Document.fields.account) })
			.where(r.not(DocumentTag, { document, tag: "gamma" }))
			.find({
				document,
				revision,
				distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
			})
	})
	.approximateNearest({ by: "distance", take: 20 })

/** Every current embedding, unfiltered, the source keyed by (document, revision). */
export const unfiltered = query(AnnSearch)
	.rule((r) => {
		const { document, revision, value } = v(DocumentEmbedding, "documentEmbedding")
		return r.match(DocumentEmbedding, { document, revision, value }).find({
			document,
			revision,
			distance: Compute.cosineDistance(value, r.param("vector", DocumentEmbedding.fields.value))
		})
	})
	.approximateNearest({ by: "distance", take: 10 })

/**
 * One search read by two rules, the near candidates and the tagged ones: one evaluation per execution, whose candidate
 * relation both arms read.
 */
export const shared = query(AnnSearch)
	.rule((r) => {
		const near = candidates.bind({
			account: r.param("account", Document.fields.account),
			vector: r.param("vector", DocumentEmbedding.fields.value)
		})
		const { document, distance } = v(near, "near")
		return r.match(near, { document, distance }).where(r.lt(distance, 1)).find({ document })
	})
	.rule((r) => {
		const near = candidates.bind({
			account: r.param("account", Document.fields.account),
			vector: r.param("vector", DocumentEmbedding.fields.value)
		})
		const { document } = v(near, "near")
		return r
			.match(near, { document })
			.match(DocumentTag, { document, tag: "gamma" })
			.find({ document })
	})

const uuidOf = (prefix: number, n: number): IdValue =>
	Id(
		`${pipe(prefix.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
	)

export const accountA = uuidOf(0xa, 1)
export const accountB = uuidOf(0xb, 1)
export const accountC = uuidOf(0xc, 1)

/** A xorshift32 generator. */
export const generator = (seed: number) => {
	const unsigned = seed >>> 0
	let state = unsigned === 0 ? 1 : unsigned
	return (): number => {
		state ^= state << 13
		state >>>= 0
		state ^= state >>> 17
		state ^= state << 5
		state >>>= 0
		return state / 0x100000000
	}
}

/** A unit vector of binary32 components, written as the shortest text of each binary32 value. */
export const unitVector = (next: () => number): ReadonlyArray<number> => {
	const raw = Array.from({ length: dimensions }, () => next() * 2 - 1)
	const norm = Math.sqrt(Arr.reduce(raw, 0, (s, x) => s + x * x))
	return Arr.map(raw, (x) => Math.fround(x / norm))
}

export const vectorText = (components: ReadonlyArray<number>): string =>
	`[${Arr.join(
		Arr.map(components, (c) => (Object.is(c, -0) ? "0" : String(c))),
		","
	)}]`

export interface DocumentFact {
	readonly id: string
	readonly account: string
	readonly current: bigint
	/** Each revision's embedding, absent for a pending one. */
	readonly embeddings: ReadonlyArray<{
		readonly revision: bigint
		readonly value: ReadonlyArray<number>
	}>
	readonly tags: ReadonlyArray<string>
}

export const sizes = { A: 2400, B: 400, C: 12 } as const

/** One draw of a stream: the seed of a population's and its probes' vectors. */
const drawOf = (stream: Stream): number =>
	defined(sample(int(0, 2 ** 31 - 1), stream, 1)[0], "the stream's draw")

/**
 * The population's draw: one value of the label's floor stream, so the population is the template's, loaded and
 * analyzed once per member (annTemplate), its structure (the account sizes, the revisions, the pending and repeated
 * documents) planted by index. What a run draws anew is each case's probe, numbered by a draw of the case's own
 * (probeOf), so a replay token gives the probe again.
 */
const populationDraw = drawOf(floorSeed("pg/vector/ann/vectors"))

const population = (draw: number): ReadonlyArray<DocumentFact> => {
	const next = generator(draw)
	const out: Array<DocumentFact> = []
	let n = 0
	const tagNames = ["alpha", "beta", "gamma", "delta"]
	for (const [account, count] of [
		[accountA, sizes.A],
		[accountB, sizes.B],
		[accountC, sizes.C]
	] as const) {
		for (let i = 0; i < count; i++) {
			n++
			const twoRevisions = n % 3 === 0
			const current = twoRevisions ? 2n : 1n
			const pending = n % 50 === 0
			const embeddings: Array<{ revision: bigint; value: ReadonlyArray<number> }> = [
				{ revision: 1n, value: unitVector(next) }
			]
			if (twoRevisions && !pending) {
				embeddings.push({ revision: 2n, value: unitVector(next) })
			}
			if (!twoRevisions && pending) {
				embeddings.length = 0
			}
			out.push({
				id: uuidOf(0xd, n),
				account,
				current,
				embeddings,
				tags: tagNames.slice(0, 1 + (n % 3))
			})
		}
	}
	/** Two documents of account A whose current embeddings are identical. */
	const [first, second] = Arr.filter(
		out,
		(d) => d.account === accountA && d.current === 1n && d.embeddings.length > 0
	)
	const shared = first?.embeddings[0]?.value
	if (second !== undefined && shared !== undefined) {
		out[out.indexOf(second)] = { ...second, embeddings: [{ revision: 1n, value: shared }] }
	}
	/**
	 * A superseded revision 2 equal to the current revision 1 of every fourth other single-revision document of A and
	 * C: the current revision stays 1.
	 */
	const pair = new Set([first?.id, second?.id])
	for (const account of [accountA, accountC]) {
		const single = Arr.filter(
			out,
			(d) =>
				d.account === account && d.current === 1n && d.embeddings.length === 1 && !pair.has(d.id)
		)
		for (const [i, d] of single.entries()) {
			const value = d.embeddings[0]?.value
			if (i % 4 === 0 && value !== undefined) {
				out[out.indexOf(d)] = { ...d, embeddings: [...d.embeddings, { revision: 2n, value }] }
			}
		}
	}
	return out
}

/** The documents of `account` with a superseded revision equal to their current one. */
export const repeated = (
	facts: ReadonlyArray<DocumentFact>,
	account: string
): ReadonlyArray<DocumentFact> =>
	Arr.filter(
		facts,
		(d) =>
			d.account === account &&
			d.embeddings.length === 2 &&
			d.current === 1n &&
			vectorText(defined(d.embeddings[0], "the first revision").value) ===
				vectorText(defined(d.embeddings[1], "the second revision").value)
	)

export const duplicatePair = (facts: ReadonlyArray<DocumentFact>): readonly [string, string] => {
	const byText = new Map<string, Array<string>>()
	for (const d of facts) {
		for (const e of d.embeddings) {
			if (e.revision === d.current) {
				const key = `${d.account}${vectorText(e.value)}`
				byText.set(key, [...(byText.get(key) ?? []), d.id])
			}
		}
	}
	const [a, b] = Option.getOrThrowWith(
		Arr.findFirst([...byText.values()], (ids) => ids.length === 2),
		() => new Error("the fixture has no duplicate embedding pair")
	)
	if (a === undefined || b === undefined) {
		throw new Error("a pair has two documents")
	}
	return [a, b]
}

/** The template's population (populationDraw). */
export const annFacts = population(populationDraw)

/** The query vector a test numbers `n` under a draw of vectors: distinct per number and per draw. */
export const probeOf =
	(draw: number) =>
	(n: number): ReadonlyArray<number> =>
		unitVector(generator((draw ^ Math.imul(0x5eed + n, 0x9e3779b1)) >>> 0))

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
	Arr.map(indices(Math.ceil(items.length / size)), (i) => items.slice(i * size, i * size + size))

/**
 * The HNSW index every approximate program of the workload requests, as the workload compiler hands it to the installer,
 * without the B-tree paths the same programs justify, so the planner's choice rests on the HNSW index alone.
 */
const workloadRequests = (programs: Readonly<Record<string, unknown>>): InstallExtension => ({
	contribute: () =>
		Result.map(
			compileTestWorkload(
				[{ login: "server", workloads: [workload(AnnSearch, programs)] }],
				AnnSearch,
				testCompile
			),
			(plan) => ({
				...noContribution,
				indexRequests: Arr.filter(accessRequests(plan, "vector_ext"), (r) => r.method === "hnsw")
			})
		),
	textDomainUses: noTextDomainUses,
	params: servesNoParams,
	certifies: noCertificates,
	carriers: noCarriers,
	holds: noHolds,
	calls: noCalls,
	live: noLive,
	fences: noFences
})

const checked = (q: unknown) =>
	Result.flatMap(queryInput(q), (input) =>
		checkQuery(checking(AnnSearch), input.desc, checkOptions("query"))
	)

/** The programs of a fixture's workload, by name. */
type AnnPrograms = Readonly<Record<string, unknown>>

/** What the ANN fixture installs with: its programs' HNSW requests, and its full world's login over them. */
const annOptions = <const P extends AnnPrograms>(programs: P) => ({
	ambient: ordinarySession,
	label: "ann",
	extensions: [workloadRequests(programs)],
	logins: [fullWorld(AnnSearch, programs).server]
})

/** The installed schema rebuilt under its installed name, its full world, and `programs`. */
const annOver = <const P extends AnnPrograms>(done: Installed, programs: P) => {
	const rebuilt = schema(done.declared, Rec.values(AnnSearch.relations), AnnSearch.statements)
	const world = fullWorld(rebuilt, {})
	return { installed: done, schema: rebuilt, app: world.app, server: world.server, programs }
}

/**
 * The ANN fixture's installation with `programs`' HNSW requests and the population as a template (install-migrate.ts
 * seededTemplate): installed, loaded and analyzed once per member, where each search installed and loaded it before its
 * cases, so plans are those of the pinned sizes. Its seat empties no table: a case writes only in a transaction it
 * rolls back, and reads its fixture over the clone (annIn).
 */
export const annTemplate = (declaredIn: ImportMeta, name: string, programs: AnnPrograms) =>
	seededTemplate({
		declaredIn,
		name,
		schema: AnnSearch,
		options: annOptions(programs),
		seed: (installed) => Effect.asVoid(populated(annOver(installed, programs)))
	})

/** The installed schema, its full world, and the programs P its door serves (annOver). */
export type AnnOpened<P extends AnnPrograms> = ReturnType<typeof annOver<P>>

/** The installation and its population, which a direct writer reads as the full world's role `app`. */
export interface Fixture {
	readonly installed: Installed
	readonly app: AnnOpened<AnnPrograms>["app"]
	readonly facts: ReadonlyArray<DocumentFact>
	readonly table: (relation: string) => string
	/** The query vector a test numbers `n`: distinct per number, drawn with the population. */
	readonly probe: (n: number) => ReadonlyArray<number>
}

/** A fixture whose door serves the programs P (`opened`). */
interface ServedAnn<P extends AnnPrograms> extends Fixture {
	readonly opened: AnnOpened<P>
}

/** The population loaded into an opened fixture and vacuumed and analyzed. */
const populated = <const P extends AnnPrograms>(opened: AnnOpened<P>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const fixture = opened.installed
		const table = (relation: string): string => {
			const name = fixture.names.relation(relation)
			return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
		}
		const facts = annFacts
		const statements: Array<string> = []
		for (const batch of chunks(facts, 500)) {
			statements.push(
				`INSERT INTO ${table("Document")} ("id", "account", "title") VALUES ${Arr.join(
					Arr.map(batch, (d) => `('${d.id}'::Id, '${d.account}'::Id, 'doc ${d.id}'::text)`),
					", "
				)}`
			)
			statements.push(
				`INSERT INTO ${table("DocumentCurrent")} ("document", "revision") VALUES ${Arr.join(
					Arr.map(batch, (d) => `('${d.id}'::Id, ${d.current}::bigint)`),
					", "
				)}`
			)
			const embeddings = Arr.flatMap(batch, (d) =>
				Arr.map(
					d.embeddings,
					(e) =>
						`('${d.id}'::uuid, ${e.revision}::bigint, '${vectorText(e.value)}'::vector_ext.vector)`
				)
			)
			if (embeddings.length > 0) {
				statements.push(
					`INSERT INTO ${table("DocumentEmbedding")} ("document", "revision", "value") VALUES ${Arr.join(embeddings, ", ")}`
				)
			}
			statements.push(
				`INSERT INTO ${table("DocumentTag")} ("document", "tag") VALUES ${Arr.join(
					Arr.flatMap(batch, (d) => Arr.map(d.tags, (t) => `('${d.id}'::Id, '${t}'::text)`)),
					", "
				)}`
			)
		}
		for (const sql of statements) {
			yield* s.admin.query(sql, [])
		}
		for (const r of ["Document", "DocumentCurrent", "DocumentEmbedding", "DocumentTag"]) {
			yield* s.admin.query(`VACUUM ANALYZE ${table(r)}`, [])
		}
		return {
			installed: fixture,
			app: opened.app,
			opened,
			facts,
			table,
			probe: probeOf(populationDraw)
		} satisfies ServedAnn<P>
	})

/**
 * The fixture of a case over a clone of an ANN template (annTemplate) with `programs`, the ones the template was
 * declared with: the template's population, which the clone holds, and its probes.
 */
export const annIn = <const P extends AnnPrograms>(
	taken: SubstrateCase<Installed>,
	programs: P
): ServedAnn<P> => {
	const opened = annOver(taken.value, programs)
	const table = (relation: string): string => {
		const name = opened.installed.names.relation(relation)
		return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
	}
	return {
		installed: opened.installed,
		app: opened.app,
		opened,
		facts: annFacts,
		table,
		probe: probeOf(populationDraw)
	}
}

export interface Compiled {
	readonly logical: LogicalQuery
	readonly program: OptimizedProgram
	readonly specs: ReadonlyArray<StatementSpec>
}

const failed = (what: string, r: CompileError) => new Error(`${what}: ${r.message}`)

/** A query's optimized program over the installation, and its executable statements. */
export const compile = (
	q: unknown,
	installed: Installed,
	purpose: "query" | "derivedDefinition"
): Compiled => {
	const logical = checked(q)
	if (!logical.ok) {
		throw failed("check", logical.error)
	}
	const program = lowerAligned(logical.value, purpose, {
		names: installed.names,
		context: "snapshot",
		catalog: installedCatalog(installed.installation)
	})
	if (!program.ok) {
		throw failed("lower", program.error)
	}
	return {
		logical: logical.value,
		program: program.value,
		specs: [specifiedProgram(program.value, installed.names.codes).statement.spec]
	}
}

export const vectorParam = (components: ReadonlyArray<number>) =>
	Vector.make(Float32Array.from(components), dimensions)

/** Rows of text columns from PostgreSQL, trusted as such: every statement here casts each result column to text. */
export const textRows = (rows: unknown): ReadonlyArray<ReadonlyArray<string>> =>
	trusted<ReadonlyArray<ReadonlyArray<string>>>(rows)

/**
 * The search policy the snapshot stores for `role`, as `parameter=value`: its role defaults, which Db.open's admission
 * compares with the role's settings in the catalog.
 */
export const admittedPolicy = (snapshot: DeploySnapshot, role: string): ReadonlyArray<string> =>
	Arr.flatMap(snapshot.manifest.roleDefaults, (s) =>
		s.kind === "alterRole" &&
		s.name === role &&
		s.action.kind === "set" &&
		Str.startsWith("hnsw.")(s.action.setting.parameter)
			? [`${s.action.setting.parameter}=${storedSettingValue(s.action.setting)}`]
			: []
	)
