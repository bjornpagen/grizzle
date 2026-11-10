import { int } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed, type Stream } from "@grizzle/testing/random"
import { sample } from "@grizzle/testing/source"
import { runOfProcess } from "@grizzle/testing/vitest/run"
import { Array as Arr, Effect, Option, pipe, String as Str } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { indices } from "#compiler/core/array.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { LogicalQuery, StatementSpec } from "#compiler/ir/products.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { specifiedStatements } from "#compiler/lower/template.ts"
import { workloadRequests as accessRequests } from "#compiler/physical/access/extension.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallExtension,
	noCertificates,
	noContribution
} from "#compiler/physical/install/extension.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { quoteIdent, storedSettingValue } from "#compiler/sql/print.ts"
import { installed } from "#test/pg/reads/support.ts"
import { defined } from "#test/support/assert.ts"
import { compileTestWorkload, lowerAligned, testCompile } from "#test/support/compile.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

export const dimensions = 8
const DocumentVector = pg.vector(dimensions)
const Title = str.regex("^.+$", "su")
const TagName = str.regex("^[a-z]{1,16}$")
const Document = relation("Document", { id: uuid, account: uuid, title: Title }, ["id"])
const DocumentCurrent = relation("DocumentCurrent", { document: uuid, revision: pg.bigint }, [
	"document"
])

export const DocumentEmbedding = relation(
	"DocumentEmbedding",
	{ document: uuid, revision: pg.bigint, value: DocumentVector },
	["document", "revision"]
)
const DocumentTag = relation("DocumentTag", { document: uuid, tag: TagName }, ["document", "tag"])
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
 * executable statements (lower/template.ts specifiedStatements): every result column cast to text, every placeholder
 * filled by the template's own encoder. The conservative artifact of an approximate program is the exact pgvector
 * lowering, so the exact baseline here is the complete scan written directly against the
 * installation: `cosine_distance` over every eligible row, which no HNSW index orders.
 */
const AnnSearch = schema(
	"AnnSearch",
	{ Document, DocumentCurrent, DocumentEmbedding, DocumentTag },
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

const uuidOf = (prefix: number, n: number): Uuid =>
	`${pipe(prefix.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

export const accountA = uuidOf(0xa, 1)
export const accountB = uuidOf(0xb, 1)
export const accountC = uuidOf(0xc, 1)

/** A xorshift32 generator. */
const generator = (seed: number) => {
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
const unitVector = (next: () => number): ReadonlyArray<number> => {
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
 * The run's draw of the population's and the probes' vectors: one value of the label's rotating stream under the run's
 * seed, the same in every process of one run and new in every run, never a fixed seed. The population's structure (the
 * account sizes, the revisions, the pending and repeated documents) is planted by index.
 */
const runDraw = Effect.map(runOfProcess, (run) =>
	drawOf(rotatingSeed(run.seed, floorSeed("pg/vector/ann/vectors")))
)

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

/** The query vector a test numbers `n` under the run's draw: distinct per number, drawn anew in every run. */
const probeOf =
	(draw: number) =>
	(n: number): ReadonlyArray<number> =>
		unitVector(generator((draw ^ Math.imul(0x5eed + n, 0x9e3779b1)) >>> 0))

/** The query vectors of this run, by the number a test gives each: the fixture's probes, for a fixture of its own. */
export const runProbes = Effect.map(runDraw, probeOf)

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
	certifies: noCertificates
})

const checked = (q: unknown) =>
	Result.flatMap(queryInput(q), (input) =>
		checkQuery(checking(AnnSearch), input.desc, checkOptions("query"))
	)

/** The programs of a fixture's workload, by name. */
type AnnPrograms = Readonly<Record<string, unknown>>

/**
 * The installed schema with the HNSW index each of `programs` requests, its full world's login serving them as its
 * workload's members.
 */
const openAnn = <const P extends AnnPrograms>(programs: P) =>
	installed(AnnSearch, {}, { label: "ann", extensions: [workloadRequests(programs)], programs })

/** The installed schema whose full world's login serves the programs P (test/pg/reads/support.ts installed). */
export type AnnOpened<P extends AnnPrograms> = Effect.Success<ReturnType<typeof openAnn<P>>>

/** The installation and its population, which a direct writer reads as the full world's role `app`. */
export interface Fixture {
	readonly installed: Installed
	readonly app: AnnOpened<AnnPrograms>["app"]
	readonly facts: ReadonlyArray<DocumentFact>
	readonly table: (relation: string) => string
	/** The query vector a test numbers `n`: distinct per number, drawn with the population. */
	readonly probe: (n: number) => ReadonlyArray<number>
}

/** A fixture whose full world's login serves the programs P, opened through `opened.served`. */
interface ServedAnn<P extends AnnPrograms> extends Fixture {
	readonly opened: AnnOpened<P>
}

/**
 * Installs the schema with the workload's HNSW index, loads the population of `draw`, and analyzes the tables so plans
 * are those of the pinned sizes. The installation's first migration stores the fixed search policy as the defaults of
 * the login whose role names a vector (physical/ddl/roles.ts), so every search here runs under it. `opened` is the
 * installed schema with its full world, whose login serves `programs`.
 */
const installDrawn = <const P extends AnnPrograms>(programs: P, draw: number) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const opened = yield* openAnn(programs)
		const fixture = opened.installed
		const table = (relation: string): string => {
			const name = fixture.names.relation(relation)
			return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
		}
		const facts = population(draw)
		const statements: Array<string> = []
		for (const batch of chunks(facts, 500)) {
			statements.push(
				`INSERT INTO ${table("Document")} ("id", "account", "title") VALUES ${Arr.join(
					Arr.map(batch, (d) => `('${d.id}'::uuid, '${d.account}'::uuid, 'doc ${d.id}'::text)`),
					", "
				)}`
			)
			statements.push(
				`INSERT INTO ${table("DocumentCurrent")} ("document", "revision") VALUES ${Arr.join(
					Arr.map(batch, (d) => `('${d.id}'::uuid, ${d.current}::bigint)`),
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
					Arr.flatMap(batch, (d) => Arr.map(d.tags, (t) => `('${d.id}'::uuid, '${t}'::text)`)),
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
			probe: probeOf(draw)
		} satisfies ServedAnn<P>
	})

/** The fixture over the run's population: new vectors in every run. */
export const installFixture = <const P extends AnnPrograms>(programs: P) =>
	Effect.flatMap(runDraw, (draw) => installDrawn(programs, draw))

/**
 * The fixture over the population `label` alone fixes, the way a witness phase's stream is fixed: the same vectors and
 * probes on every run seed, so a statistical verdict over it is the test source's, never the run's.
 */
export const installLabelled = <const P extends AnnPrograms>(programs: P, label: string) =>
	installDrawn(programs, drawOf(floorSeed(label)))

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
	const specs = specifiedStatements(program.value.roots, installed.names.codes)
	if (!specs.ok) {
		throw failed("specs", specs.error)
	}
	return {
		logical: logical.value,
		program: program.value,
		specs: Arr.map(flight(specs.value), (run) => run.spec)
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
