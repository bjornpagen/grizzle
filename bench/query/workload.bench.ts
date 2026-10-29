import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { summarize } from "#bench/cold/stats.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { compareVariants, measureVariant } from "#bench/harness/variant.ts"
import {
	agrees,
	autocommit,
	compile,
	conditions,
	fill,
	GateSetupError,
	handwritten,
	handwrittenRows,
	headingOf,
	type InstalledIndex,
	installedIndexes,
	installFixture,
	measureQuery,
	plainExplain,
	queryPhases,
	rawSession,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"
import { identity } from "#compiler/core/identity.ts"
import { transportLimits } from "#compiler/lower/shapes/relparam/index.ts"
import { withWorkload } from "#compiler/physical/access/extension.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { withResidualLaws } from "#compiler/physical/laws/objects.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R13: every index is justified by a law or a workload program.
 *
 * "Every installed index maps to a law id or the workload's access; removing a program proposes exactly the drops
 * nothing else justifies; a program outside the workload returns the same result". One schema,
 * Account(id, region) <- Task(id, account, priority, title), its containment a law whose maintenance wants the
 * referencing column indexed, and three workload programs, each requesting an access path:
 *
 * - every index the installation created in PostgreSQL's catalog has a manifest object whose reasons name a law, its
 *   enforcement or the workload's access;
 * - the installation compiled with one program removed creates exactly the indexes the full one does less those only
 *   the workload's access stands on that the removed program alone asks for, and no other program alone does (a later
 *   migration drops them);
 * - a program outside the workload compiles and runs against the installed indexes, and its answer equals the
 *   conservative and handwritten ones;
 * - "A justified index is still work": each index's size, and the cost of inserting a batch of tasks into
 *   the installation with its workload indexes against one with its key and law indexes only, are recorded.
 */
const Account = relation("Account", { id: pg.bigint, region: pg.integer }, ["id"])
const Task = relation(
	"Task",
	{ id: pg.bigint, account: pg.bigint, priority: pg.integer, title: str.regex("^.{1,80}$", "su") },
	["id"]
)

const Workload = schema("Workload", { Account, Task }, [
	contained(on(Task, "account"), on(Account, "id"))
])

const urgentTasks = query(Workload).rule((r) => {
	const { id, priority } = v(Task)
	return r
		.match(Task, { id, priority })
		.where(r.ge(priority, r.param("min", pg.integer)))
		.find({ id, priority })
})

const regionAccounts = query(Workload).rule((r) => {
	const { id, region } = v(Account)
	return r
		.match(Account, { id, region })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ id })
})

const topOfAccount = query(Workload)
	.rule((r) => {
		const { id, priority } = v(Task)
		return r
			.match(Task, { id, account: r.param("account", Task.fields.account), priority })
			.find({ id, priority })
	})
	.orderBy(["priority", "desc"], ["id", "asc"])
	.take(5)

/** Outside the workload: tasks by title. */
const tasksTitled = query(Workload).rule((r) => {
	const { id, title } = v(Task)
	return r
		.match(Task, { id, title })
		.where(r.eq(title, r.param("title", Task.fields.title)))
		.find({ id, title })
})

const programs = { urgentTasks, regionAccounts, topOfAccount } as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly accounts: number
	readonly tasks: number
	readonly batch: number
	readonly samples: number
}

/** @internal */
export default defineGate({
	name: "query-workload",
	gates: ["R13"],
	title: "Every index justified by a law or a workload program, and a program outside the workload",
	scope:
		"The catalog's indexes against the installation manifest's justifications, the installation with one program " +
		"removed, a program outside the workload with its answer, and the size and insert cost of the workload " +
		"indexes against keys and law indexes only.",
	phases: queryPhases,
	options: {
		full: { accounts: 20000, tasks: 400000, batch: 10000, samples: 10 },
		quick: { accounts: 2000, tasks: 40000, batch: 2000, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installFixture(Workload, programs, "benchworkload", [])
			const bare = yield* installFixture(Workload, {}, "benchworkloadbare", [])
			for (const f of [fx, bare]) {
				yield* fill(f, "Account", options.accounts, { id: "g::int8", region: "(g % 100)::int4" })
				yield* fill(f, "Task", options.tasks, {
					id: "g::int8",
					account: `(1 + g % ${options.accounts})::int8`,
					priority: "((pg_catalog.hashint8(g) & 2147483647) % 100)::int4",
					title: "'task ' || (g % 5000)"
				})
				yield* settle(f)
			}
			const runtime = yield* runtimeSession(fx, fx.world.app, "m15b workload runtime")
			const raw = yield* rawSession(fx, fx.world.app, "m15b workload raw")
			const installation = fx.installed.installation
			const manifestIndexes = Arr.filter(installation.manifest.objects, (o) => o.kind === "index")
			const catalog = yield* installedIndexes(fx)
			/**
			 * The manifest object of a catalog index, by (schema, name): an access or law index is an index object, and a key's
			 * index is its constraint's, on the index's table.
			 */
			const schemaName = fx.installed.schema
			const manifestObjectOf = (index: InstalledIndex) =>
				Arr.findFirst(installation.manifest.objects, (o) => {
					const ident = parseIdent(o.ident)
					return (
						(ident.kind === "index" && ident.schema === schemaName && ident.name === index.name) ||
						(ident.kind === "constraint" &&
							ident.schema === schemaName &&
							ident.relation === index.table &&
							ident.name === index.name)
					)
				})
			/** Every catalog index, each by its manifest object's justification. */
			const justified = Arr.map(catalog, (index) =>
				Option.match(manifestObjectOf(index), {
					onNone: () => ({ name: index.name, ok: false, reasons: "no manifest object" }),
					onSome: (object) => ({
						name: index.name,
						ok: Arr.some(
							object.reasons,
							(r) => r.kind === "law" || r.kind === "enforcement" || r.kind === "access"
						),
						reasons: `[${Arr.join(
							Arr.map(object.reasons, (r) => r.kind),
							", "
						)}]`
					})
				})
			)
			/** The installation compiled with regionAccounts removed, against each program's own indexes. */
			const removed = "regionAccounts" satisfies keyof typeof programs
			const owned = owning(schemaDescOf(Workload))
			/** The index objects of the installation with the workload of `kept` alone, by ident, and those its access stands on. */
			const installedWith = Effect.fn("installedWith")(function* (
				kept: Readonly<Record<string, unknown>>
			) {
				const planned = compileTestWorkload(
					[{ login: "server", workloads: [workload(Workload, kept)] }],
					Workload,
					testCompile
				)
				if (!planned.ok) {
					return yield* Effect.die(GateSetupError.make({ what: planned.error.message }))
				}
				const installed = compileInstallation(
					owned,
					withResidualLaws(
						withWorkload(
							{
								...installOptions(owned, s.owner.role),
								installation: identity.schema(parsedSchemaName(fx.installed.declared))
							},
							planned.value
						)
					)
				)
				if (!installed.ok) {
					return yield* Effect.die(GateSetupError.make({ what: installed.error.message }))
				}
				const indexes = Arr.filter(installed.value.manifest.objects, (o) => o.kind === "index")
				return {
					idents: new Set(Arr.map(indexes, (o) => o.ident)),
					access: new Set(
						Arr.map(
							Arr.filter(indexes, (o) => Arr.some(o.reasons, (r) => r.kind === "access")),
							(o) => o.ident
						)
					)
				}
			})
			const reducedIdents = (yield* installedWith(
				Rec.fromEntries(Arr.filter(Rec.toEntries(programs), ([name]) => name !== removed))
			)).idents
			/** Each program's own access indexes, installed alone. */
			const alone = new Map<string, ReadonlySet<string>>()
			for (const [name, program] of Rec.toEntries(programs)) {
				alone.set(name, (yield* installedWith({ [name]: program })).access)
			}
			const gone = new Set(
				Arr.map(
					Arr.filter(manifestIndexes, (o) => !reducedIdents.has(o.ident)),
					(o) => o.ident
				)
			)
			const onlyRemoved = new Set(
				Arr.map(
					Arr.filter(
						manifestIndexes,
						(o) =>
							o.reasons.length > 0 &&
							Arr.every(o.reasons, (r) => r.kind === "access") &&
							Arr.every([...alone], ([name, idents]) => idents.has(o.ident) === (name === removed))
					),
					(o) => o.ident
				)
			)
			/** The program outside the workload. */
			const titled = compile(fx, tasksTitled, {
				role: fx.world.app,
				context: "snapshot",
				warm: 3,
				read: "rows"
			})
			const titledM = yield* measureQuery(
				runtime,
				raw,
				titled,
				{ title: "task 42" },
				{
					samples: options.samples,
					explainSamples: 1,
					serverPlans: [],
					explain: plainExplain,
					limits: transportLimits,
					conservativeSamples: options.samples
				}
			)
			const titledHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten",
					[
						{
							sql: handwrittenRows(
								headingOf(titled),
								`SELECT ${fx.column("Task", "id")} AS id, ${fx.column("Task", "title")} AS title FROM ${fx.table("Task")} WHERE ${fx.column("Task", "title")} = $1::text`
							),
							params: ["task 42"]
						}
					],
					autocommit
				),
				{
					samples: options.samples,
					warmup: 0,
					explainSamples: 1,
					explain: plainExplain,
					serverPlans: []
				}
			)
			/** Index sizes and the insert cost with and without the workload indexes. */
			const sizes = yield* s.admin.queryValues(
				`SELECT c.relname::text, pg_catalog.pg_relation_size(c.oid)::text FROM pg_catalog.pg_class c
				 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1::text AND c.relkind = 'i' ORDER BY 1`,
				[fx.installed.schema]
			)
			const owner = yield* s.session({ ...ownerSession(), label: "m15b workload inserts" })
			const insertCost = Effect.fn("insertCost")(function* (f: typeof fx) {
				const samples: Array<number> = []
				for (let i = 0; i < Math.max(2, options.samples); i++) {
					yield* owner.begin
					const start = performance.now()
					yield* owner.values(
						`INSERT INTO ${f.table("Task")} (${Arr.join(
							Arr.map(["id", "account", "priority", "title"], (x) => f.column("Task", x)),
							", "
						)}) ` +
							`SELECT ${options.tasks} + g, 1 + g % ${options.accounts}, g % 100, 'new ' || g FROM pg_catalog.generate_series(1, ${options.batch}) AS g`,
						[]
					)
					samples.push(Math.round((performance.now() - start) * 1000) / 1000)
					yield* owner.rollback
				}
				return summarize(samples)
			})
			const withWorkloadCost = yield* insertCost(fx)
			const keysOnlyCost = yield* insertCost(bare)
			const bareIndexes = yield* installedIndexes(bare)
			const installedState =
				"fresh install with three workload programs, and the same schema without a workload beside it; facts loaded, " +
				"then VACUUM (ANALYZE) of every table"
			const cases: Array<CaseRecord<"R13">> = [
				{
					name: "the installation's indexes and their justifications",
					gates: ["R13"],
					conditions: conditions({
						workload:
							"fresh install with three workload programs; the same schema without a workload beside it",
						schemaState: installedState,
						data: `${options.accounts} accounts, ${options.tasks} tasks in each installation`,
						parameters: { batch: options.batch },
						semantics:
							"the catalog's indexes, the manifest's reasons, and the indexes the reduced workload keeps",
						cache: "the insert batches run one after another on one session"
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						indexes: Arr.join(
							Arr.map(catalog, (i) => `${i.name}(${Arr.join(i.columns, ", ")})`),
							", "
						),
						justifications: Arr.join(
							Arr.map(justified, (j) => `${j.name}=${j.reasons}`),
							"; "
						),
						removedProgram: removed,
						dropped: Arr.join([...gone], ", "),
						droppedExpected: Arr.join([...onlyRemoved], ", "),
						indexBytes: Arr.join(
							Arr.map(sizes, (r) => `${String(r[0])}=${String(r[1])}`),
							", "
						),
						keysOnlyIndexes: Arr.join(
							Arr.map(bareIndexes, (i) => i.name),
							", "
						),
						insertWithWorkloadP50Ms: withWorkloadCost.p50,
						insertKeysOnlyP50Ms: keysOnlyCost.p50,
						insertBatch: options.batch
					}
				},
				{
					name: "a program outside the workload: tasks by title",
					gates: ["R13"],
					conditions: conditions({
						workload: "Task by title equality, a program no workload records",
						schemaState: installedState,
						data: `${options.tasks} tasks, 5000 distinct titles`,
						parameters: { title: "task 42" },
						semantics: "the (id, title) of the tasks with the title",
						cache: "warm: each variant runs once before its timed samples"
					}),
					phases: {},
					variants: [titledM.generated, titledM.conservative, titledHand],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				}
			]
			const r13: VerdictInput = {
				checks: [
					mechanism(
						"every installed index maps to a law, its enforcement or the workload's access",
						catalog.length > 0 && Arr.every(justified, (j) => j.ok),
						Arr.join(
							Arr.map(justified, (j) => `${j.name}: ${j.reasons}`),
							"; "
						)
					),
					mechanism(
						"removing a program drops exactly the indexes nothing else justifies",
						gone.size > 0 &&
							gone.size === onlyRemoved.size &&
							Arr.every([...gone], (i) => onlyRemoved.has(i)),
						`dropped [${Arr.join([...gone], ", ")}]; justified only by ${removed}: [${Arr.join([...onlyRemoved], ", ")}]`
					),
					mechanism(
						"a schema without a workload installs only key and law indexes",
						Arr.every(
							Arr.filter(bare.installed.installation.manifest.objects, (o) => o.kind === "index"),
							(o) => o.reasons.length > 0 && Arr.every(o.reasons, (r) => r.kind !== "access")
						),
						Arr.join(
							Arr.map(bareIndexes, (i) => i.name),
							", "
						)
					),
					agrees("the program outside the workload returns the conservative answer", titledM),
					equivalence(
						"and the handwritten answer",
						compareVariants(titledM.generated, titledHand).sameResult,
						`${titledM.generated.result.rows} generated rows, ${titledHand.result.rows} handwritten`
					)
				]
			}
			return { cases, verdicts: { R13: r13 } }
		})
})
