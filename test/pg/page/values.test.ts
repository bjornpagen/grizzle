/**
 * Boundary values through the page runtime, drawn from the scalar edge dictionaries.
 *
 * The Measures fixture (test/unit/page/fixtures.ts) orders one relation by a double precision, an exact numeric, a
 * bigint and a text, each the leading key of one ordered query (ascending and descending for the double, the id
 * completing every order). Each case stores drawn facts, every field drawn from its type's value classes with their
 * edge classes and every spelling (test/support/oracle/gen/domain.ts valueClasses): -0 beside 0, NaN, the infinities, a
 * subnormal and the largest finite double; numeric NaN (the fixture's numeric(161, 40) holds no infinity, which only an
 * unbounded numeric does), more digits than a binary64 holds and the smallest scale; the bigint extremes and 2^53 + 1,
 * which a binary64 cannot hold, either sign; the empty text, text beyond the BMP, U+10FFFF and combining marks. Through
 * Db, for a drawn query at a drawn window size per direction:
 *
 * - the windows walked from the start, each after the last one's last row, and from the end, each before the first one's
 *   first row, are D cut at the size, then one empty window: every boundary value round-trips as an anchor, the seek
 *   comparing it in PostgreSQL's own order (NaN greatest, -0 = 0, code points);
 * - every row's RowKey, its key fields' values, anchors a window by its values exactly: the boundary texts its anchor
 *   binds (adapter/page/window.ts windowCall), each its comparator's codec's, are read back by PostgreSQL, as its
 *   column's type, equal to the value stored in the row.
 *
 * Oracle: D itself, the complete sorted result read by the query's unpaged member, which the windows cut; and
 * PostgreSQL's reading of each anchor's boundary text as its column's type.
 *
 * Features: each ordered field's edge classes and spellings, each direction and window size.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { windowCall } from "#adapter/page/window.ts"
import { keyOf } from "#compiler/live/index.ts"
import { paged } from "#compiler/public/workload.ts"
import { expectedWalk, pageTemplate, rowOf, sortedResult, walk } from "#test/pg/page/support.ts"
import {
	factTexts,
	type Field,
	id,
	isCompared,
	measuresInstall,
	measuresTemplate,
	orderedNames,
	queries,
	reached,
	sqlTypes,
	storedFact,
	valuesCaseGen,
	type ValuesFeature
} from "#test/pg/page/values.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Measure, Measures } from "#test/unit/page/fixtures.ts"

/**
 * Boundary values through the page runtime cuts D of drawn edge values of every ordered type into windows exactly, each row's RowKey anchoring by its values as PostgreSQL reads them back.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/page/values.test.ts at 8ad8d5b2c).
 */
export const boundaryValuesThroughThePageRuntimeCutsDOfDrawnEdgeValuesOfEveryOrderedTypeIntoWindowsExactlyEachRowsRowKeyAnchoringByItsValuesAsPostgreSQLReadsThemBack =
	property.explore(valuesCaseGen, {
		needs: { seated: Substrate.seat(measuresTemplate) },
		situations: [
			...Arr.map(orderedNames, (q): ValuesFeature => `query ${q}`),
			"float -0",
			"float NaN",
			"float infinity",
			"float subnormal",
			"numeric NaN",
			"numeric of more than 17 digits",
			"bigint extreme",
			"bigint beyond 2^53",
			"empty text",
			"text beyond the BMP",
			"a tie on the leading key"
		] satisfies ReadonlyArray<Reached<ValuesFeature>>,
		check:
			({ seated }, notes: Case<ValuesFeature>) =>
			(c) =>
				Effect.flatMap(seated, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const opened = yield* openedIn(Measures, {}, measuresInstall, taken)
							const names = namesOf(opened.installed)
							const table = names.table(Measure)
							const column = (field: Field | "id"): string => names.column(Measure, field)
							const { ctx: dbCtx, load } = yield* openServedDb(
								opened.installed,
								opened.server.roles.app,
								{}
							)
							/**
							 * Every ordered query, a paged member of the workload under its position's name, and unpaged
							 * beside it, whose read is D.
							 */
							const loaded = yield* load(
								Rec.fromEntries(
									Arr.flatMap(orderedNames, (q, i) => [
										[`paged${i}`, paged(queries[q])],
										[`unpaged${i}`, queries[q]]
									])
								)
							)

							/** The case's facts replace the last case's whole (substrate/replace.ts). */
							const stored = Arr.map(c.facts, storedFact)
							const texts = Arr.map(stored, factTexts)
							yield* replaceRows(
								s.admin,
								installationGroup(names),
								Arr.map(texts, (f, n) => ({
									sql: `INSERT INTO ${table} (${column("id")}, ${column("x")}, ${column("amount")}, ${column("big")}, ${column("label")}) VALUES ($1::uuid, $2::double precision, $3::numeric, $4::bigint, $5::text)`,
									params: [id(n + 1), f.x, f.amount, f.big, f.label]
								}))
							)
							const at = Arr.findFirstIndex(orderedNames, (n) => n === c.query).pipe(
								Option.getOrThrow
							)
							const pagedMember = member(loaded, `paged${at}`)
							const q = memberCalls(dbCtx, pagedMember)
							const compiled = pageTemplate(pagedMember, opened.installed.names.codes)
							const runtime = compiled.runtime
							const rows = yield* readOnce(memberCalls(dbCtx, member(loaded, `unpaged${at}`)))({
								params: {},
								facts: {}
							})
							assert.equal(rows.length, c.facts.length)
							const full = sortedResult(compiled, rows)
							for (const [from, size] of [
								["start", c.forward],
								["end", c.backward]
							] as const) {
								const walked = yield* walk(q, compiled.fields, {}, size, from, full.length)
								assert.deepEqual(walked.nodes, full, `from the ${from} at ${size}`)
								assert.deepEqual(
									walked.windows,
									expectedWalk(full, size, from),
									`the windows from the ${from} at ${size}`
								)
							}
							for (const delivered of rows) {
								const call = succeeded(
									windowCall(
										{
											anchor: { kind: "after", key: keyOf(compiled.fields, delivered) },
											size: 1
										},
										runtime.anchors
									)
								)
								const texts = call.variant === "after" ? call.boundary : []
								const node = rowOf(delivered)
								for (const [i, comparator] of runtime.page.comparators.entries()) {
									const field = comparator.field
									assert.ok(isCompared(field), `a comparator of ${field}, no field of Measure`)
									const [answer] = yield* s.admin.queryValues(
										`SELECT ($1::${sqlTypes[field]} = m.${column(field)})::text FROM ${table} AS m WHERE m.${column("id")} = $2::uuid`,
										[defined(texts[i]), String(node["id"])]
									)
									assert.deepEqual(
										answer,
										["true"],
										`${c.query}: ${field} of ${String(node["id"])} as its anchor carries it`
									)
								}
							}
							notes.note(`query ${c.query}`)
							notes.noteAll(reached(stored))
							/** A tie on the leading key, by the column type's own equality. */
							const leading = defined(runtime.page.comparators[0]).field
							if (!isCompared(leading)) {
								return assert.fail(`a comparator of ${leading}, no field of Measure`)
							}
							const [tied] = yield* s.admin.queryValues(
								`SELECT (count(*) > count(DISTINCT m.${column(leading)}))::text FROM ${table} AS m`,
								[]
							)
							if (tied?.[0] === "true") {
								notes.note("a tie on the leading key")
							}
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "D itself, and PostgreSQL's reading of each anchor's boundary text"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})
