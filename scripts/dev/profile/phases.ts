import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { appendAll } from "#compiler/core/array.ts"
import { identity, parseSchemaName } from "#compiler/core/identity.ts"
import type * as Result from "#compiler/core/result.ts"
import { initMigrationName } from "#compiler/deploy/render/folder.ts"
import { generateMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { workloadRequests, withWorkload } from "#compiler/physical/access/extension.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { lowerQuery } from "#compiler/program/describe.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { isOrderedValue, isQueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { ownedDesc } from "#compiler/schema/protocol.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { changeSetDesc, changeSetOver } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { defined } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import * as graphApi from "#test/support/fixtures/api/graph.ts"
import * as ledgerApi from "#test/support/fixtures/api/ledger.ts"
import * as payrollApi from "#test/support/fixtures/api/payroll.ts"
import * as queueApi from "#test/support/fixtures/api/queue.ts"
import * as searchApi from "#test/support/fixtures/api/search.ts"
import * as spansApi from "#test/support/fixtures/api/spans.ts"
import * as workApi from "#test/support/fixtures/api/work.ts"
import { switchToManualDescribed, workPrograms } from "#test/unit/workload/fixtures.ts"

/**
 * The compile phases of a fixture's install path, with no database: what scripts/dev/profile/compile.ts times.
 *
 * Each worked example (Work with its Reports level and Plans, the payroll ledger with its Reporting level, the queue,
 * spans and calendar, the graph, vector search, and the ledger) is compiled with its native laws, derived relations and
 * its workload where the fixtures give one: own, the law model, the workload, the full installation (the law model again,
 * the physical DDL, the closed constants, the derived-relation and workload extensions, the index plan, the
 * grants and the emitted script), the first migration with its snapshot, the lowered statements of every query and
 * ordered query the fixture exports, and the write programs of a generic set of ChangeSets over each stored relation (an
 * enumerated insert, delete and put; a described insert from a relation parameter; a described delete over the stored
 * relation; an insert with a delta read-back). Nothing is memoized: each phase pays for the ownership, the law model and
 * the schema reading it does itself.
 */
export interface Fixture {
	readonly label: string
	/** The schema, whose relations record (its base's included) holds the relation values the generic ChangeSets write. */
	readonly schema: AnySchema
	/** The module that exports the fixture's queries and ordered queries. */
	readonly module: Readonly<Record<string, unknown>>
	/** Whether this fixture lowers the module's queries (once per module). */
	readonly queries: boolean
	/** Its workload, over the fixture's schema, when the fixtures give one. */
	readonly programs?: Readonly<Record<string, unknown>>
	/** ChangeSets of the fixtures beyond the generic ones. */
	readonly changeSets?: ReadonlyArray<readonly [string, unknown]>
}

/**
 * The account budgets with at least `least` automatic tasks: a range on the derived relation's `tasks` column, which
 * justifies a workload index on its materialized view.
 */
const busyAccounts = query(workApi.Reports).rule((r) => {
	const { account, tasks, budget } = v(workApi.AccountBudget, "accountBudget")
	return r
		.match(workApi.AccountBudget, { account, tasks, budget })
		.where(r.ge(tasks, r.param("least", pg.bigint)))
		.find({ account, budget })
})

export const fixtures: ReadonlyArray<Fixture> = [
	{
		label: "work",
		schema: workApi.Reports,
		module: workApi,
		queries: true,
		programs: { ...workPrograms, busyAccounts },
		changeSets: [["switchToManualDescribed", switchToManualDescribed]]
	},
	{ label: "plans", schema: workApi.Plans, module: workApi, queries: false },
	{ label: "payroll", schema: payrollApi.Reporting, module: payrollApi, queries: true },
	{ label: "queue", schema: queueApi.Queue, module: queueApi, queries: true },
	{
		label: "schedule",
		schema: spansApi.Schedule,
		module: spansApi,
		queries: true,
		programs: { intersecting: spansApi.intersecting, strictlyInside: spansApi.strictlyInside }
	},
	{ label: "calendars", schema: spansApi.Calendars, module: spansApi, queries: false },
	{ label: "network", schema: graphApi.Network, module: graphApi, queries: true },
	{
		label: "search",
		schema: searchApi.Search,
		module: searchApi,
		queries: true,
		programs: { byDistance: searchApi.byDistance }
	},
	{ label: "ledger", schema: ledgerApi.Ledger, module: ledgerApi, queries: true }
]

/**
 * The generic ChangeSets over one stored relation, by label. The relation and the schema are known only at run time, so
 * the ChangeSets and queries are built through the builders' JavaScript-caller views (changeSetOver, queryOver,
 * varsOver), which deliver the same values the public builders make.
 */
const genericChangeSets = (
	schema: unknown,
	relation: unknown,
	name: string,
	fields: ReadonlyArray<string>
): ReadonlyArray<readonly [string, unknown]> => {
	const empty = () => changeSetOver.empty(schema)
	const all = (vars: Readonly<Record<string, unknown>>) =>
		Rec.fromEntries(Arr.map(fields, (f) => [f, vars[f]]))
	const fromParam = queryOver(schema).rule((r: RuleValue) => {
		const b = all(varsOver(relation, "relation"))
		return r.match(r.relation("facts", relation), b).find(b)
	})
	const stored = queryOver(schema).rule((r: RuleValue) => {
		const b = all(varsOver(relation, "relation"))
		return r.match(relation, b).find(b)
	})
	return [
		[`${name} insert`, empty().insert(relation, [])],
		[`${name} delete`, empty().delete(relation, [])],
		[`${name} put`, empty().put(relation, [])],
		[`${name} described insert`, empty().insert(relation, fromParam)],
		[`${name} described delete`, empty().delete(relation, stored)],
		[
			`${name} insert with read-back`,
			empty()
				.insert(relation, [])
				.read("added", (delta: DeltaValue) =>
					queryOver(schema).rule((r: RuleValue) => {
						const b = all(varsOver(delta.added(relation), "addedRelation"))
						return r.match(delta.added(relation), b).find(b)
					})
				)
		]
	]
}

/**
 * The relation value the schema holds under the relation name `name`: the relations record of an extension carries its
 * base's, so every relation of the Description is found whether or not the fixture module exports it.
 */
const relationValue = (schema: AnySchema, name: string): Option.Option<unknown> =>
	Arr.findFirst(Rec.values(schema.relations), (value) => {
		const d = ownedDesc(value, "relation")
		return d?.name === name
	})

/** The generic ChangeSets over every stored relation of the fixture, and the fixture's own, by label. */
const writeChangeSets = (f: Fixture): ReadonlyArray<readonly [string, unknown]> => {
	const desc = schemaDescOf(f.schema)
	if (desc === undefined) {
		throw new Error(`no schema description for ${f.label}`)
	}
	const sets: Array<readonly [string, unknown]> = [...(f.changeSets ?? [])]
	const relations = [...(desc.extends?.relations ?? []), ...desc.relations]
	for (const r of relations) {
		if (r.kind !== "relation") {
			continue
		}
		const relation = Option.getOrThrowWith(
			relationValue(f.schema, r.name),
			() => new Error(`${f.label}: the schema value holds no relation ${r.name}`)
		)
		appendAll(sets, genericChangeSets(f.schema, relation, r.name, Rec.keys(r.fields)))
	}
	return sets
}

const ok = <A, E>(r: Result.Result<A, E>, what: string): A => {
	if (!r.ok) {
		throw new Error(`${what}: ${Formatter.format(r.error)}`)
	}
	return r.value
}

/** Runs `phase`'s work and returns its result; the caller decides whether and how to time it. */
export type Timer = <A>(phase: string, work: () => A) => A

/** A fixture to compile, the timer to time its phases with, and whether to time each program on its own. */
export interface PhasesInput {
	readonly fixture: Fixture
	readonly timed: Timer
	readonly each: boolean
}

/**
 * Every compile phase of the fixture, each under `timed` with the phase name `<label> <phase>`; with `each`, every
 * query and write program also under `timed` on its own (`<label> query <name>`, `<label> write <name>`). Returns every
 * output.
 */
export const compilePhases = ({ fixture: f, timed, each }: PhasesInput) => {
	const one: Timer = (phase, work) => (each ? timed(phase, work) : work())
	const owner = "grizzle_owner"
	const installedAt = identity.schema(ok(parseSchemaName(`profile_${f.label}`), "schema name"))
	const input = ok(parseSchemaInput(f.schema), "schema input")
	const owned = timed(`${f.label} own`, () =>
		ok(own(input.kind === "role" ? input.desc.base : input.desc), "own")
	)
	timed(`${f.label} laws`, () => ok(compileLaws(owned), "laws"))
	/** A fresh installation's codes: every roster's handles in declared order. */
	const codes = firstCodebook(rostersOf(owned))
	const base = { ...completeInstallOptions(owned, installedAt, [], [], codes), owner }
	const programsGiven = f.programs
	const plan =
		programsGiven === undefined
			? undefined
			: timed(`${f.label} workload`, () =>
					ok(
						compileTestWorkload(
							[{ login: "profile", workloads: [workload(f.schema, programsGiven)] }],
							f.schema,
							testCompile
						),
						"workload"
					)
				)
	const options = plan === undefined ? base : withWorkload(base, plan)
	const installation = timed(`${f.label} installation`, () =>
		ok(compileInstallation(owned, options), "installation")
	)
	const access = plan === undefined ? {} : plan.access
	const paths = plan === undefined ? [] : workloadRequests(plan, installation.settings.vectorSchema)
	const generate = timed(`${f.label} migration`, () =>
		ok(
			generateMigration({
				previous: emptySnapshot({ schemaName: owned.name, schema: installation.names.schema }),
				installation,
				workload: { access, accessPaths: paths },
				naming: { kind: "named", name: initMigrationName },
				timestamp: "20261012000001",
				abandoned: [],
				declared: { renames: [], drops: [] }
			}),
			"generateMigration"
		)
	)
	/** Every query and ordered query the module exports, and each write program. */
	const queries = timed(`${f.label} queries`, () =>
		f.queries
			? Arr.flatMap(Rec.toEntries(f.module), ([name, value]) =>
					isQueryValue(value) || isOrderedValue(value)
						? [[name, one(`${f.label} query ${name}`, () => lowerQuery(value))] as const]
						: []
				)
			: []
	)
	const sets = writeChangeSets(f)
	const checked = ok(checkedSchema(owned), "checked")
	/** The keys of every view a write program's members and read-backs read, as the schema's artifacts know them. */
	const artifacts = ok(
		schemaArtifacts(input, { installation: installedAt, vectorSchema: undefined, codes }),
		"artifacts"
	)
	const writes = timed(`${f.label} writes`, () =>
		Arr.map(
			sets,
			([label, value]) =>
				[
					label,
					one(`${f.label} write ${label}`, () =>
						compileWrite(
							checked,
							defined(changeSetDesc(value), `the write ${label}'s Description`),
							{
								names: installation.names,
								reads: installation.names,
								claims: { kind: "every" },
								world: { kind: "reality" },
								laws: artifacts.laws,
								derived: artifacts.derived
							}
						)
					)
				] as const
		)
	)
	return { installation, plan, generate, queries, writes }
}
