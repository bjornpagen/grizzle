import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option } from "effect"
import { trusted } from "#compiler/core/trusted.ts"
import { type WorkloadPhysical, workloadExtension } from "#compiler/physical/access/extension.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { expectedCatalog, projectCatalog } from "#test/support/catalog/expected.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { installRealSchema } from "#test/support/oracle/install/real.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	Board,
	orderedTasks,
	planOf,
	Se,
	Sp,
	topThree,
	W,
	workPrograms
} from "#test/unit/workload/fixtures.ts"

/**
 * The workload's indexes and statistics on PostgreSQL 19: statistics are a compilation product like indexes.
 *
 * Each schema is installed with its residual laws and its workload. The catalog holds exactly the indexes the
 * installation's own DDL creates, every one valid; an ordered program and a take per group over the same keys share one
 * installed index; a span predicate's access path is GiST; an HNSW index's cosine class is the one in the installation's
 * vector schema; the justified extended statistics are installed with all three kinds; and every installed index and
 * statistics object stands on a law id or the workload's access. Which access paths the workload requests is
 * test/unit/workload's.
 */

/** Catalog rows of two and of three text columns, trusted as such. */
const textPairsOf = (rows: unknown): ReadonlyArray<readonly [string, string]> =>
	trusted<ReadonlyArray<readonly [string, string]>>(rows)
const textTriplesOf = (rows: unknown): ReadonlyArray<readonly [string, string, string]> =>
	trusted<ReadonlyArray<readonly [string, string, string]>>(rows)

/**
 * The catalog holds exactly the indexes the installation's DDL creates, with their methods, columns,
 * uniqueness and partial predicates, every one valid.
 */
const installWithWorkload = (schema: unknown, workload: WorkloadPhysical, label: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const { plan } = yield* installRealSchema(schemaDescOf(schema), {
			label,
			extensions: [workloadExtension(workload)],
			logins: []
		})
		const installed = yield* readCatalog(substrate.admin, plan.schema)
		if (installed.kind !== "present") {
			return assert.fail(`the schema ${plan.schema} is not installed`)
		}
		assert.deepEqual(
			projectCatalog(installed.catalog).indexes,
			expectedCatalog(plan.installation).indexes
		)
		const s = yield* substrate.session(ownerSession())
		const statistics = yield* Effect.map(
			s.values(
				`SELECT s.stxname::text, array_to_string(s.stxkind, ',')::text,
			        (SELECT string_agg(a.attname::text, ',' ORDER BY a.attnum) FROM pg_attribute a
			          WHERE a.attrelid = s.stxrelid AND a.attnum = ANY (s.stxkeys))::text
			 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace
			 WHERE n.nspname = '${plan.schema}' ORDER BY 1`,
				[]
			),
			textTriplesOf
		)
		return { plan, statistics }
	})

layer(Substrate.layer)("workload indexes and statistics on PostgreSQL 19", (it) => {
	it.effect(
		"the worked example's workload installs its statistics, and every index and statistics object is justified",
		() =>
			Effect.gen(function* () {
				const workload = planOf(W.Work, workPrograms)
				const { plan, statistics } = yield* installWithWorkload(W.Work, workload, "workload_work")
				/** The statistics the manifest creates are installed, each with all three kinds. */
				const created = Arr.filter(
					plan.installation.manifest.objects,
					(o) => o.kind === "index" || o.kind === "statistics"
				)
				const statisticsNames = Arr.flatMap(created, (o) =>
					Arr.flatMap(o.ddl, (st) => (st.kind === "createStatistics" ? [st.name.name] : []))
				)
				assert.notDeepEqual(statisticsNames, [], "the workload requests statistics")
				unorderedEqual(
					Arr.map(statistics, ([name, kinds]) => [name, kinds]),
					Arr.map(statisticsNames, (name) => [name, "d,f,m"])
				)
				for (const o of created) {
					assert.equal(
						Arr.some(o.reasons, (r) => r.kind === "law" || r.kind === "access"),
						true,
						o.ident
					)
				}
			})
	)

	it.effect(
		"orderedTasks and a take per group share one installed access index serving (priority DESC, id)",
		() =>
			Effect.gen(function* () {
				const programs = { orderedTasks, topThree }
				const workload = planOf(Board, programs)
				const { plan } = yield* installWithWorkload(Board, workload, "workload_board")
				const task = plan.installation.names.relation("Task").name
				const column = (field: string) => plan.installation.names.column("Task", field)
				const session = yield* (yield* Substrate).session(ownerSession())
				/**
				 * Every key of every index on the task table besides its keys, read from pg_index in key order: the index,
				 * the key's column and its direction.
				 */
				const installed = yield* Effect.map(
					session.values(
						`SELECT i.relname::text, a.attname::text, CASE WHEN (x.indoption[k.n - 1] & 1) = 1 THEN 'desc' ELSE 'asc' END::text
					 FROM pg_catalog.pg_index x
					 JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
					 JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
					 JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
					 CROSS JOIN LATERAL unnest(x.indkey::int2[]) WITH ORDINALITY AS k(att, n)
					 JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.att
					 WHERE n.nspname = $1::text AND t.relname = $2::text AND NOT x.indisprimary AND NOT x.indisunique
					 ORDER BY i.relname, k.n`,
						[plan.schema, task]
					),
					textTriplesOf
				)
				const shared = Option.getOrThrowWith(
					Arr.findFirst(
						plan.installation.indexes,
						(i) => i.index.kind === "created" && Arr.some(i.requests, (r) => r.role === "access")
					),
					() => new Error("the access index")
				)
				assert.deepEqual(
					installed,
					Arr.map(shared.keys, (k) => [shared.index.name, column(k.field), k.dir])
				)
				assert.deepEqual(
					Arr.map(installed, ([, key]) => key),
					[column("account"), column("priority"), column("id")]
				)
				const direction = (field: string) =>
					Option.getOrThrowWith(
						Arr.findFirst(installed, ([, key]) => key === column(field)),
						() => new Error(field)
					)[2]
				assert.notEqual(
					direction("priority"),
					direction("id"),
					"(priority DESC, id) in one scan direction"
				)
			})
	)

	it.effect("a span predicate's access path is installed as a GiST index", () =>
		Effect.gen(function* () {
			const programs = { intersecting: Sp.intersecting, strictlyInside: Sp.strictlyInside }
			const { plan } = yield* installWithWorkload(
				Sp.Schedule,
				planOf(Sp.Schedule, programs),
				"workload_spans"
			)
			/** The index serving each span predicate, created or the span key's own, which holds the span among its columns. */
			const serving = Arr.filter(plan.installation.indexes, (i) =>
				Arr.some(i.requests, (r) => r.role === "access" && r.use === "span predicate")
			)
			assert.notDeepEqual(serving, [], "a span predicate's access path")
			for (const i of serving) {
				assert.equal(i.method, "gist", i.index.name)
			}
		})
	)

	it.effect(
		"an approximate retrieval program installs HNSW with vector_cosine_ops of the installation's vector schema",
		() =>
			Effect.gen(function* () {
				const search = planOf(Se.Search, { byDistance: Se.byDistance })
				const workload: WorkloadPhysical = {
					...search,
					paths: [
						...search.paths,
						{
							relation: "DocumentEmbedding",
							derived: false,
							method: "hnsw",
							keys: [{ field: "value", dir: "asc" }],
							use: "approximate vector retrieval"
						}
					]
				}
				const { plan } = yield* installWithWorkload(Se.Search, workload, "workload_search")
				/**
				 * The installed HNSW index's operator class, read from the catalog: pgvector's cosine class, in the schema
				 * the installation installs the extension in.
				 */
				const vectorSchema = plan.installation.names.vectorSchema
				const hnsw = Arr.filter(
					plan.installation.indexes,
					(i) => i.index.kind === "created" && i.method === "hnsw"
				)
				assert.notDeepEqual(hnsw, [], "an HNSW index")
				const session = yield* (yield* Substrate).session(ownerSession())
				for (const i of hnsw) {
					const opclasses = yield* Effect.map(
						session.values(
							`SELECT n.nspname::text, c.opcname::text FROM pg_catalog.pg_index x
						 JOIN pg_catalog.pg_class r ON r.oid = x.indexrelid
						 JOIN pg_catalog.pg_namespace rn ON rn.oid = r.relnamespace
						 JOIN pg_catalog.pg_opclass c ON c.oid = x.indclass[0]
						 JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace
						 WHERE rn.nspname = $1::text AND r.relname = $2::text`,
							[plan.schema, i.index.name]
						),
						textPairsOf
					)
					assert.deepEqual(opclasses, [[vectorSchema, "vector_cosine_ops"]])
				}
			})
	)
})
