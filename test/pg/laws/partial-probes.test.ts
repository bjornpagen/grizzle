/**
 * A law whose probe reads only the rows of a selected source is served by a partial index of that selection.
 *
 * A selected-source containment probes its source for a selected fact at the affected key, a scalar capacity over a
 * selected source aggregates the selected facts of the group, and a selected-source span coverage probes the group's
 * selected facts for an uncovered span: each reads only the rows its selection chooses, so the index engine plans its
 * request as a partial index `WHERE <selection>` (physical/indexes/engine.ts), named and holding exactly those rows. One
 * planted schema per family, each its law's source filled with many unselected facts and a few selected ones, analyzed,
 * is installed through its first migration. The property, for each:
 * - the index the law's selected probe lands on is one the engine created, partial, and the catalog's predicate of it
 *   holds exactly the source's selected rows, fewer than the source holds;
 * - a write that makes the law probe its source, the law made immediate in a transaction of the writer, rolled back,
 *   reads that partial index and never scans the source sequentially.
 * That the laws' outcomes are unchanged is the family suites' (test/pg/laws/families), whose oracles judge every
 * generated selected source.
 *
 * The owner's own reads of the index are published now, so none lands in the writer's
 * window below.
 *
 * A writer's write that makes the law probe its source, the law immediate, rolled back: the
 * partial index is read and the source never scanned sequentially.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Option, Schema } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { printObjectName, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	capacity,
	contained,
	f,
	on,
	onSelected,
	relation,
	type SchemaDesc,
	within
} from "#test/support/fixtures/ir/desc.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { oracleLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

type Family =
	| "a selected-source containment"
	| "a capacity over a selected source"
	| "a selected-source span coverage"

/**
 * One planted schema: its law, the relation its selected probe reads, the facts that fill it (statements over each
 * relation's table and each field's column), how many of the source's rows are selected and how many it holds, and
 * the write that makes the law probe the source.
 */
interface Planted {
	readonly family: Family
	readonly desc: SchemaDesc
	readonly law: LawId
	readonly source: string
	readonly selected: number
	readonly rows: number
	readonly load: (
		t: (relation: string) => string,
		c: (relation: string, field: string) => string
	) => ReadonlyArray<string>
	readonly fire: (
		t: (relation: string) => string,
		c: (relation: string, field: string) => string
	) => ReadonlyArray<string>
}

/**
 * Owner(id) and Item(id, owner, live): every live item's owner exists. 5000 items over 100 owners, the 50 of owners 1 to
 * 10 live; deleting owner 50, which holds no live item, finds no anchor, so the law probes Item for a live one.
 */
const containment = (): Planted => {
	const law = contained(onSelected("Item", ["owner"], { live: true }), on("Owner", ["id"]))
	const desc: SchemaDesc = {
		name: "PartialContainment",
		relations: [
			relation("Owner", { id: f.integer }, ["id"]),
			relation("Item", { id: f.integer, owner: f.integer, live: f.boolean }, ["id"])
		],
		statements: [law],
		extends: undefined
	}
	return {
		family: "a selected-source containment",
		desc,
		law: lawNamesOf(desc).lawOfDesc(law),
		source: "Item",
		selected: 50,
		rows: 5000,
		load: (t, c) => [
			`INSERT INTO ${t("Owner")} (${c("Owner", "id")}) SELECT g FROM pg_catalog.generate_series(1, 100) AS g`,
			`INSERT INTO ${t("Item")} (${c("Item", "id")}, ${c("Item", "owner")}, ${c("Item", "live")}) SELECT g, g % 100 + 1, g % 100 < 10 AND g <= 500 FROM pg_catalog.generate_series(1, 5000) AS g`
		],
		fire: (t, c) => [`DELETE FROM ${t("Owner")} WHERE ${c("Owner", "id")} = 50`]
	}
}

/**
 * Quota(id) and Seat(id, quota, held): at most 1000 held seats per quota, and every held seat's quota exists. 5000
 * seats over 100 quotas, every 50th held; a held seat inserted for quota 7 aggregates quota 7's held seats.
 */
const capacityOverSelected = (): Planted => {
	const law = capacity(
		on("Quota", ["id"]),
		onSelected("Seat", ["quota"], { held: true }),
		within(0n, 1000n),
		{
			kind: "count"
		}
	)
	const desc: SchemaDesc = {
		name: "PartialCapacity",
		relations: [
			relation("Quota", { id: f.integer }, ["id"]),
			relation("Seat", { id: f.integer, quota: f.integer, held: f.boolean }, ["id"])
		],
		statements: [
			contained(onSelected("Seat", ["quota"], { held: true }), on("Quota", ["id"])),
			law
		],
		extends: undefined
	}
	return {
		family: "a capacity over a selected source",
		desc,
		law: lawNamesOf(desc).lawOfDesc(law),
		source: "Seat",
		selected: 100,
		rows: 5000,
		load: (t, c) => [
			`INSERT INTO ${t("Quota")} (${c("Quota", "id")}) SELECT g FROM pg_catalog.generate_series(1, 100) AS g`,
			`INSERT INTO ${t("Seat")} (${c("Seat", "id")}, ${c("Seat", "quota")}, ${c("Seat", "held")}) SELECT g, g % 100 + 1, g % 50 = 0 FROM pg_catalog.generate_series(1, 5000) AS g`
		],
		fire: (t, c) => [
			`INSERT INTO ${t("Seat")} (${c("Seat", "id")}, ${c("Seat", "quota")}, ${c("Seat", "held")}) VALUES (5001, 7, true)`
		]
	}
}

/**
 * Open(room, during), keyed by the span, and Booking(id, room, slot, ok): every ok booking's slot is covered by its
 * room's open spans. Each of 100 rooms is open [0, 1000); 5000 bookings, every 50th ok; an ok booking inserted for room
 * 7 probes room 7's ok bookings for an uncovered slot.
 */
const coverage = (): Planted => {
	const law = contained(
		onSelected("Booking", ["room", "slot"], { ok: true }),
		on("Open", ["room", "during"])
	)
	const desc: SchemaDesc = {
		name: "PartialCoverage",
		relations: [
			relation("Open", { room: f.integer, during: f.span(f.integer, undefined) }, [
				"room",
				"during"
			]),
			relation(
				"Booking",
				{ id: f.integer, room: f.integer, slot: f.span(f.integer, undefined), ok: f.boolean },
				["id"]
			)
		],
		statements: [law],
		extends: undefined
	}
	return {
		family: "a selected-source span coverage",
		desc,
		law: lawNamesOf(desc).lawOfDesc(law),
		source: "Booking",
		selected: 100,
		rows: 5000,
		load: (t, c) => [
			`INSERT INTO ${t("Open")} (${c("Open", "room")}, ${c("Open", "during")}) SELECT g, pg_catalog.int4range(0, 1000) FROM pg_catalog.generate_series(1, 100) AS g`,
			`INSERT INTO ${t("Booking")} (${c("Booking", "id")}, ${c("Booking", "room")}, ${c("Booking", "slot")}, ${c("Booking", "ok")}) SELECT g, g % 100 + 1, pg_catalog.int4range(g % 900, g % 900 + 10), g % 50 = 0 FROM pg_catalog.generate_series(1, 5000) AS g`
		],
		fire: (t, c) => [
			`INSERT INTO ${t("Booking")} (${c("Booking", "id")}, ${c("Booking", "room")}, ${c("Booking", "slot")}, ${c("Booking", "ok")}) VALUES (5001, 7, pg_catalog.int4range(5, 6), true)`
		]
	}
}

/** One planted schema per family. */
const plantedGen: Gen<Planted> = element([containment(), capacityOverSelected(), coverage()])

const Counts = Schema.Array(Schema.Tuple([Schema.Finite]))
const Texts = Schema.Array(Schema.Tuple([Schema.String]))

layer(Substrate.layer)("partial law-probe indexes", (it) => {
	it.effect(
		"a selected probe reads a partial index that holds exactly its selection, never the whole source",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					return yield* exhaust(
						{
							suite: "laws/partial-probes",
							generator: plantedGen,
							literal: (p: Planted) => p.family,
							limit: 3,
							coverage: requiredInSpace<Family>([
								"a selected-source containment",
								"a capacity over a selected source",
								"a selected-source span coverage"
							]),
							/** A case installs, loads and analyzes five thousand rows: it may take as long as the whole test. */
							caseHang: Duration.minutes(10)
						},
						(p, c) =>
							Effect.gen(function* () {
								const login = oracleLogin(p.desc)
								const installed: Installed = yield* install(p.desc, {
									ambient: ordinarySession,
									label: "partial_probe",
									extensions: [],
									logins: [login]
								})
								const names = installed.installation.names
								const t = (r: string) => printObjectName(names.relation(r))
								const col = (r: string, field: string) => quoteIdent(names.column(r, field))
								/** The index the law's selected probe lands on: one the engine created, partial. */
								const index = Option.getOrThrowWith(
									Arr.findFirst(installed.installation.indexes, (i) =>
										Arr.some(
											i.requests,
											(r) =>
												r.role === "lawMaintenance" &&
												r.justification.law === p.law &&
												r.rows.kind === "selected"
										)
									),
									() => new Error(`the index of ${p.law}'s selected probe`)
								)
								assert.equal(index.index.kind, "created")
								assert.equal(index.relation, p.source)
								assert.equal(index.rows.kind, "selected")
								const indexName = `${quoteIdent(installed.schema)}.${quoteIdent(index.index.name)}`
								yield* transaction(substrate.admin, p.load(t, col))
								yield* substrate.admin.query(`ANALYZE ${t(p.source)}`, [])
								/** The catalog's predicate of the index holds exactly the selected rows. */
								const predicates = yield* Schema.decodeUnknownEffect(Texts)(
									yield* substrate.admin.queryValues(
										`SELECT pg_catalog.pg_get_expr(x.indpred, x.indrelid) FROM pg_catalog.pg_index AS x WHERE x.indexrelid = ${quoteString(indexName)}::regclass`,
										[]
									)
								)
								const [predicate] = defined(predicates[0], "the index's predicate")
								const counted = yield* Schema.decodeUnknownEffect(Counts)(
									yield* substrate.admin.queryValues(
										`SELECT count(*)::int4 FROM ${t(p.source)} WHERE ${predicate}`,
										[]
									)
								)
								const [held] = defined(counted[0], "the count of the predicate's rows")
								assert.equal(held, p.selected)
								assert.ok(held < p.rows, "the index holds fewer rows than the source")
								yield* substrate.admin.queryValues(
									"SELECT pg_catalog.pg_stat_force_next_flush()",
									[]
								)
								yield* substrate.admin.queryValues("SELECT 1", [])
								yield* Effect.scoped(
									Effect.gen(function* () {
										const w = yield* substrate.session({
											...worldSession(installed.world(login.roles[0])),
											label: "partial probe writer"
										})
										const indexScans = Effect.gen(function* () {
											yield* w.values("SELECT pg_catalog.pg_stat_force_next_flush()", [])
											const rows = yield* Schema.decodeUnknownEffect(Counts)(
												yield* w.values(
													`SELECT idx_scan::int4 FROM pg_catalog.pg_stat_all_indexes WHERE indexrelid = ${quoteString(indexName)}::regclass`,
													[]
												)
											)
											return defined(rows[0], "the index's statistics")[0]
										})
										const sequential = Effect.map(
											w.values(
												`SELECT seq_scan::int4 FROM pg_catalog.pg_stat_xact_all_tables WHERE relid = ${quoteString(t(p.source))}::regclass`,
												[]
											),
											(rows) => Number(rows[0]?.[0])
										)
										const before = yield* indexScans
										yield* w.begin
										const seqBefore = yield* sequential
										for (const statement of p.fire(t, col)) {
											yield* w.query(statement, [])
										}
										yield* w.query("SET CONSTRAINTS ALL IMMEDIATE", [])
										const seqAfter = yield* sequential
										yield* w.rollback
										const after = yield* indexScans
										assert.equal(seqAfter - seqBefore, 0, "the law scans its source sequentially")
										assert.ok(after > before, "the law's probe reads the partial index")
									})
								)
								c.note(p.family)
							})
					)
				})
			),
		600_000
	)
})
