import { refuse } from "#compiler/analysis/theory/build.ts"
import { compareText } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type Limit, postgresSource, published } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import type { CreateStatistics } from "#compiler/sql/ast.ts"

/** The most columns one extended statistics object covers, STATS_MAX_DIMENSIONS. */
export const statisticsMaxColumns: Limit = published({
	value: 8,
	owner: "PostgreSQL 19rc2",
	unit: "columns",
	scope: "one extended statistics object: a request's and an access path's",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/statistics/statistics.h#L19`,
	quote: "#define STATS_MAX_DIMENSIONS\t8\t/* max number of attributes */",
	verified: "2026-11-14"
})

export const statisticsKinds = ["ndistinct", "dependencies", "mcv"] as const
type StatisticsKind = (typeof statisticsKinds)[number]

export type StatisticsUse = "correlated selection" | "grouping"

export interface StatisticsRequest {
	readonly relation: string
	/** In code point order, at least two and at most statisticsMaxColumns. */
	readonly columns: ReadonlyArray<string>
	readonly kinds: ReadonlyArray<StatisticsKind>
	readonly uses: ReadonlyArray<StatisticsUse>
}

/** The identity of a request's column set: the relation and its columns joined by NUL and \u0001, which no name holds. */
const statisticsKey = (s: Pick<StatisticsRequest, "relation" | "columns">): string =>
	`${s.relation}\u0000${s.columns.join("\u0001")}`

/** The canonical order of requests: by relation, then column list, strings by code unit, and of two column lists one
 * of which begins the other, the longer first. */
const compareRequests = (a: StatisticsRequest, b: StatisticsRequest): number => {
	const relation = compareText(a.relation, b.relation)
	if (relation !== 0) {
		return relation
	}
	for (const [i, x] of a.columns.entries()) {
		const y = b.columns[i]
		if (y === undefined) {
			break
		}
		const order = compareText(x, y)
		if (order !== 0) {
			return order
		}
	}
	return b.columns.length - a.columns.length
}

/** One request per column set, with the union of the uses of the requests over it, in canonical order. */
export const mergeStatistics = (
	requests: ReadonlyArray<StatisticsRequest>
): ReadonlyArray<StatisticsRequest> => {
	const merged = new Map<string, StatisticsRequest>()
	for (const r of requests) {
		const key = statisticsKey(r)
		const prior = merged.get(key)
		if (prior === undefined) {
			merged.set(key, r)
			continue
		}
		merged.set(key, {
			relation: r.relation,
			columns: r.columns,
			kinds: statisticsKinds.filter((k) => prior.kinds.includes(k) || r.kinds.includes(k)),
			uses: [...new Set([...prior.uses, ...r.uses])].toSorted(compareText)
		})
	}
	return [...merged.values()].toSorted(compareRequests)
}

/** The statistics objects of the requests, merged, each added to the graph after the table or view it is built on.
 *
 * Extended statistics as a compilation product. CREATE STATISTICS follows the same route as an index: each statistics
 * object is requested by the workload's access, its justification, and the snapshot records which programs ask for it
 * (ProgramAccess). The fixed policy requests one object per column set that a program's correlated equality selections
 * or group key cover on one relation, with all three kinds PostgreSQL 19 builds from columns: `ndistinct`,
 * `dependencies` and `mcv`. Requests over one column set merge, uniting their uses. Statistics are estimates, never
 * evidence: no law and no rewrite certificate reads them.
 *
 * The object is `CREATE STATISTICS <schema>.<statistics> (ndistinct, dependencies, mcv) ON <cols> FROM
 * <schema>.<relation>`, columns in code point order, named at the naming door for its relation and columns
 * (identity.statistics). It is built in the Indexes phase with the indexes, after its relation. The
 * relation is a stored relation's table or a derived relation's materialized view, which PostgreSQL 19 takes extended
 * statistics on as it does a table: the statistics are planned once every installer extension has run, on the
 * relation as the builder knows it then (`InstallBuilder.target`), so a derived relation's statistics
 * follow its view, created after it, and a request on a derived relation no extension installs is deferred with the
 * relation, as its index requests are.
 *
 * Statistics need ANALYZE to become useful: on a fresh installation autovacuum's ANALYZE builds them as rows arrive,
 * and a migration that adds one to a table or view that may hold rows runs ANALYZE of it after it, which is the
 * migration renderer's. */
export const planStatistics = (
	b: InstallBuilder,
	requests: ReadonlyArray<StatisticsRequest>
): void => {
	for (const r of mergeStatistics(requests)) {
		const label = `statistics (${r.columns.join(", ")}) of ${r.relation}`
		const o = b.target(r.relation)
		if (o.kind === "deferred") {
			continue
		}
		if (o.kind === "none") {
			refuse(
				"MalformedDescription",
				SourceLoc(label, []),
				`statistics on a stored or derived relation; ${r.relation} is none`
			)
		}
		const [first, second, ...more] = r.columns
		if (
			first === undefined ||
			second === undefined ||
			r.columns.length > statisticsMaxColumns.value ||
			new Set(r.columns).size !== r.columns.length
		) {
			return refuse(
				"MalformedDescription",
				SourceLoc(label, []),
				`two to ${statisticsMaxColumns.value} distinct statistics columns`
			)
		}
		const unknown = r.columns.find((field) => o.field({ kind: "field", field }) === undefined)
		if (unknown !== undefined) {
			refuse(
				"MalformedDescription",
				SourceLoc(label, []),
				`a field of ${r.relation}; ${unknown} is none`
			)
		}
		const named = identity.statistics(r.relation, r.columns)
		const name = b.name(named)
		const ddl: CreateStatistics = {
			kind: "createStatistics",
			name: { schema: identifierOf(b.names.levelOf(r.relation)), name },
			statistics: r.kinds,
			columns: [
				b.names.column(r.relation, first),
				b.names.column(r.relation, second),
				...more.map((f) => b.names.column(r.relation, f))
			],
			table: b.names.relation(r.relation)
		}
		const reasons: ReadonlyArray<PhysicalReason> = [{ kind: "access" }]
		b.add(
			{
				kind: "statistics",
				ident: b.qualifiedOf("statistics", r.relation, named),
				ddl: [ddl],
				reasons,
				phase: "indexes"
			},
			[o.object]
		)
	}
}
