/**
 * Dependent-sum keys through grizzle's migrations on PostgreSQL 19rc1, generated: a change to a dependent space is a
 * constant replacement, and the codes its slots are stay stable under declared renames.
 *
 * A case draws a history of versions of a slotted closed relation Last, keyed by (version, parent, at) with `at` a slot
 * of fin(Model, "positions"), and of its product twin LastProduct, keyed by the same fields as closed ids, each read by
 * the containment CHECK of a stored probe relation (Step into Last, StepProduct into LastProduct). The first version
 * draws Model's counts for (v0, k0) and (v0, k1) and Last's rows, each a slot below its parent's count; each later
 * version makes one change: a count grows, Last gains a row, a Position handle is renamed (declared), or Position
 * appends a handle. Every version is migrated through grizzle's generated folders, and after it each probe draws
 * (parent, position) pairs to insert into both probes.
 *
 * Oracle, against PostgreSQL's catalog and verdicts:
 * - content addressing: the functions Step's CHECK depends on stand exactly when Last's rows, as codes, and Model's
 *   counts stand, and each stands exactly when its content does: a function keeps its name only with its body, and a
 *   new name holds a body no function had. So a changed count replaces at least its counts' constant and its rows', and
 *   the owners' bases only where they move; a rename keeps every code, so it replaces none of them.
 *   Beside a rename, StepProduct's stand exactly when the rows and Position's size stand: a grown roster replaces the
 *   product's and no dependent space's.
 * - verdicts: a probe is admitted into both exactly when its pair is a row of Last, refused with 23514 otherwise.
 * - stored rows: every admitted probe is kept by every later migration.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { closedId, natural, pg, slot } from "#compiler/public/fields.ts"
import { closed, contained, fin, on, relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { migrated } from "#test/support/installed.ts"
import { sameIdentity, type ValueIdentity } from "#test/support/kernel/identity.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A relation's table and a field's column, as the naming door names them. */
const tableOf = (relationName: string): string =>
	identifierOf(identity.table(parsedName(relationName)))
const columnOf = (field: string): string => identifierOf(identity.column(parsedName(field)))

const Version = closed("Version", ["v0"])
const Kind = closed("Kind", ["k0", "k1"])
const parents = ["k0", "k1"] as const

/** A row of Last: a parent, by its code, and a slot, a Position's code. */
interface Row {
	readonly parent: number
	readonly at: number
}

/** One version: Position's handles in code order, Model's counts for k0 and k1, and Last's rows. */
interface Stage {
	readonly positions: readonly [string, ...Array<string>]
	readonly counts: readonly [number, number]
	readonly rows: ReadonlyArray<Row>
}

/** What a later version changes. */
type Change =
	| { readonly kind: "a count grows"; readonly parent: number }
	| { readonly kind: "Last gains a row"; readonly row: Row }
	| { readonly kind: "a position renamed"; readonly at: number }
	| { readonly kind: "a position appended" }

interface History {
	readonly first: Stage
	readonly later: ReadonlyArray<Change>
	/** Each version's probes, the first's first. */
	readonly probes: ReadonlyArray<ReadonlyArray<Row>>
}

const countOf = (s: Stage, parent: number): number => defined(s.counts[parent], "a parent's count")

/** The rows a stage admits: each parent's slots below its count. */
const slotsOf = (s: Stage): ReadonlyArray<Row> =>
	Arr.flatMap(parents, (_, parent) =>
		Arr.map(Arr.range(0, countOf(s, parent) - 1), (at) => ({ parent, at }))
	)

const sameRow = (a: Row, b: Row): boolean => a.parent === b.parent && a.at === b.at

/** The stage after a change. */
const changed = (s: Stage, c: Change, fresh: number): Stage => {
	switch (c.kind) {
		case "a count grows":
			return {
				...s,
				counts: c.parent === 0 ? [s.counts[0] + 1, s.counts[1]] : [s.counts[0], s.counts[1] + 1]
			}
		case "Last gains a row":
			return { ...s, rows: [...s.rows, c.row] }
		case "a position renamed":
			return {
				...s,
				positions: Arr.map(s.positions, (h, i) => (i === c.at ? `q${fresh}` : h))
			}
		case "a position appended":
			return { ...s, positions: Arr.append(s.positions, `n${fresh}`) }
	}
}

/** The changes that apply to a stage: a count below Position's size, a free slot, any handle, or one more handle. */
const changeGen = (s: Stage): Gen<Change> => {
	const grow = Arr.filter([0, 1], (parent) => countOf(s, parent) < s.positions.length)
	const free = Arr.filter(slotsOf(s), (r) => !Arr.some(s.rows, (x) => sameRow(x, r)))
	return oneOf<Change>([
		map(int(0, s.positions.length - 1), (at): Change => ({ kind: "a position renamed", at })),
		constant({ kind: "a position appended" }),
		...(Arr.isReadonlyArrayNonEmpty(grow)
			? [map(element(grow), (parent): Change => ({ kind: "a count grows", parent }))]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(free)
			? [map(element(free), (row): Change => ({ kind: "Last gains a row", row }))]
			: [])
	])
}

const probesGen = (s: Stage): Gen<ReadonlyArray<Row>> =>
	array(
		(source) => ({
			parent: source.draw(int(0, 1)),
			at: source.draw(int(0, s.positions.length - 1))
		}),
		{ min: 1, max: 2 }
	)

const historyGen: Gen<History> = (source) => {
	const counts: readonly [number, number] = [source.draw(int(1, 3)), source.draw(int(1, 3))]
	const draft: Stage = { positions: ["p0", "p1", "p2"], counts, rows: [] }
	const slots = nonEmpty(slotsOf(draft), "a slot below each count")
	const drawnRows = source.draw(subarray(slots))
	const first: Stage = {
		...draft,
		rows: drawnRows.length > 0 ? drawnRows : [Arr.headNonEmpty(slots)]
	}
	const versions = source.draw(int(1, 3))
	const later: Array<Change> = []
	const probes: Array<ReadonlyArray<Row>> = [source.draw(probesGen(first))]
	let stage = first
	for (let v = 1; v <= versions; v++) {
		const c = source.draw(changeGen(stage))
		later.push(c)
		stage = changed(stage, c, v)
		probes.push(source.draw(probesGen(stage)))
	}
	return { first, later, probes }
}

/** Every stage of a history, the first's first. */
const stagesOf = (h: History): ReadonlyArray<Stage> =>
	Arr.reduce(h.later, [h.first], (built: ReadonlyArray<Stage>, c, i) => [
		...built,
		changed(defined(built[built.length - 1], "the stage before"), c, i + 1)
	])

/** The schema of a stage under the declared name `name`. */
const schemaAt = (name: string, stage: Stage) => {
	const Position = closed("Position", stage.positions)
	const Model = closed.relation(
		"Model",
		{ version: closedId(Version), parent: closedId(Kind), positions: natural },
		["version", "parent"],
		[
			{ version: "v0", parent: "k0", positions: BigInt(stage.counts[0]) },
			{ version: "v0", parent: "k1", positions: BigInt(stage.counts[1]) }
		]
	)
	const owner = { version: closedId(Version), parent: closedId(Kind) }
	const rows = Arr.map(stage.rows, (r) => ({
		version: "v0" as const,
		parent: defined(parents[r.parent], "a parent"),
		at: defined(stage.positions[r.at], "a position")
	}))
	const Last = closed.relation(
		"Last",
		{ ...owner, at: slot(closedId(Position), fin(Model, "positions")) },
		["version", "parent", "at"],
		rows
	)
	const LastProduct = closed.relation(
		"LastProduct",
		{ ...owner, at: closedId(Position) },
		["version", "parent", "at"],
		rows
	)
	const probe = {
		id: pg.int4,
		version: closedId(Version),
		parent: closedId(Kind),
		at: closedId(Position)
	}
	const Step = relation("Step", probe, ["id"])
	const StepProduct = relation("StepProduct", probe, ["id"])
	return schema(name, { Version, Kind, Position, Model, Last, LastProduct, Step, StepProduct }, [
		contained(on(Step, "version", "parent", "at"), on(Last, "version", "parent", "at")),
		contained(
			on(StepProduct, "version", "parent", "at"),
			on(LastProduct, "version", "parent", "at")
		)
	])
}

/** What a version's migration declares: the handle its change renames, if it renames one. */
const declaredAt = (h: History, stages: ReadonlyArray<Stage>, v: number): Declarations => {
	const c = h.later[v - 1]
	if (c?.kind !== "a position renamed") {
		return noDeclarations
	}
	const before = defined(stages[v - 1], "the stage before the rename")
	const after = defined(stages[v], "the stage after the rename")
	return {
		renames: [
			{
				from: {
					kind: "handle",
					roster: parsedName("Position"),
					handle: defined(before.positions[c.at])
				},
				to: {
					kind: "handle",
					roster: parsedName("Position"),
					handle: defined(after.positions[c.at])
				}
			}
		],
		drops: []
	}
}

/** What a version reads: the functions each probe's CHECK depends on, each probe's verdicts, and Step's rows. */
interface Observed {
	readonly step: ReadonlyArray<string>
	/** Each function Step's CHECK depends on, by its name, beside the digest of its body. */
	readonly stepBodies: ReadonlyArray<readonly [string, string]>
	readonly stepProduct: ReadonlyArray<string>
	readonly verdicts: ReadonlyArray<readonly [Option.Option<string>, Option.Option<string>]>
	readonly rows: ReadonlyArray<string>
}

const values = (session: RawSession, sql: string) => Effect.orDie(session.values(sql, []))

type FinFeature =
	| Change["kind"]
	| "a probe admitted"
	| "a probe refused"
	| "a count grown under stored probes"

/** The order of rows by their codes: parent, then slot. */
const rowOrder: Order.Order<Row> = Order.combine(
	Order.mapInput(Order.Number, (r: Row) => r.parent),
	Order.mapInput(Order.Number, (r: Row) => r.at)
)

/** The pairs of a stage's rows, as codes, in order: each row's parent and slot. */
const rowPairs = (s: Stage): ValueIdentity => {
	const pairs: Array<number> = []
	for (const r of Arr.sort(s.rows, rowOrder)) {
		pairs.push(r.parent, r.at)
	}
	return pairs
}

const finCase = (h: History, c: Case<FinFeature>) =>
	Effect.gen(function* () {
		const stages = stagesOf(h)
		const observed: Array<Observed> = []
		let schemaName = ""
		let id = 0
		yield* migrated({
			label: "fin_migrations",
			schemaName: { kind: "unique" },
			first: (name) => {
				schemaName = name
				return { schema: schemaAt(name, h.first), logins: [] }
			},
			later: Arr.map(Arr.drop(stages, 1), (stage) => (name: string) => ({
				schema: schemaAt(name, stage),
				logins: []
			})),
			apply: { kind: "noPlaceholders" },
			register: false,
			declared: (v) => declaredAt(h, stages, v),
			observe: Option.some((v: number, owner: RawSession) =>
				Effect.gen(function* () {
					const schemaIdent = identifierOf(identity.schema(parsedSchemaName(schemaName)))
					const table = (r: string) => `${quoteIdent(schemaIdent)}.${quoteIdent(tableOf(r))}`
					const reads = (r: string) =>
						Effect.map(
							values(
								owner,
								`SELECT p.proname::text FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_depend AS d ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc AS p ON p.oid = d.refobjid WHERE c.conrelid = '${table(r)}'::regclass AND c.contype = 'c' ORDER BY 1`
							),
							(rows) => Arr.map(rows, (row) => String(row[0]))
						)
					const bodies = (r: string) =>
						Effect.map(
							values(
								owner,
								`SELECT p.proname::text, pg_catalog.md5(p.prosrc) FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_depend AS d ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc AS p ON p.oid = d.refobjid WHERE c.conrelid = '${table(r)}'::regclass AND c.contype = 'c' ORDER BY 1`
							),
							(rows) => Arr.map(rows, (row) => [String(row[0]), String(row[1])] as const)
						)
					const insert = (r: string, probe: Row) =>
						Effect.map(
							Effect.result(
								owner.query(
									`INSERT INTO ${table(r)} (${Arr.join(
										Arr.map(["id", "version", "parent", "at"], (f) => quoteIdent(columnOf(f))),
										", "
									)}) VALUES (${id}, 0::smallint, ${probe.parent}::smallint, ${probe.at}::smallint)`,
									[]
								)
							),
							(result) =>
								Result.match(result, {
									onSuccess: () => Option.none<string>(),
									onFailure: (e) =>
										Option.some(
											e.reason._tag === "ServerError" ? e.reason.fields.code : e.reason.message
										)
								})
						)
					const verdicts: Array<readonly [Option.Option<string>, Option.Option<string>]> = []
					for (const probe of defined(h.probes[v], "a version's probes")) {
						id += 1
						const intoStep = yield* insert("Step", probe)
						const intoProduct = yield* insert("StepProduct", probe)
						verdicts.push([intoStep, intoProduct])
					}
					const step = yield* reads("Step")
					const stepBodies = yield* bodies("Step")
					const stepProduct = yield* reads("StepProduct")
					const stored = yield* values(
						owner,
						`SELECT ${quoteIdent(columnOf("id"))}::text || ':' || ${quoteIdent(columnOf("parent"))}::text || ':' || ${quoteIdent(columnOf("at"))}::text FROM ${table("Step")} ORDER BY ${quoteIdent(columnOf("id"))}`
					)
					observed.push({
						step,
						stepBodies,
						stepProduct,
						verdicts,
						rows: Arr.map(stored, (row) => String(row[0]))
					})
				})
			)
		})
		const admitted: Array<string> = []
		let probeId = 0
		for (const [v, stage] of stages.entries()) {
			const now = defined(observed[v], "a version's reads")
			for (const [k, probe] of defined(h.probes[v], "a version's probes").entries()) {
				probeId += 1
				const member = Arr.some(stage.rows, (r) => sameRow(r, probe))
				c.note(member ? "a probe admitted" : "a probe refused")
				const expected = member ? Option.none<string>() : Option.some("23514")
				assert.deepEqual(
					defined(now.verdicts[k], "a probe's verdicts"),
					[expected, expected],
					`version ${v}: a probe is admitted exactly into Last's rows`
				)
				if (member) {
					admitted.push(`${probeId}:${probe.parent}:${probe.at}`)
				}
			}
			assert.deepEqual(now.rows, admitted, `version ${v}: every admitted probe is kept`)
			if (v === 0) {
				assert.ok(now.step.length > 0, "Step's CHECK reads Last's constants")
				continue
			}
			const change = defined(h.later[v - 1], "the version's change")
			c.note(change.kind)
			const was = defined(observed[v - 1], "the version before")
			const before = defined(stages[v - 1], "the stage before")
			const space = (s: Stage): ValueIdentity => [...rowPairs(s), s.counts[0], s.counts[1]]
			const product = (s: Stage): ValueIdentity => [...rowPairs(s), s.positions.length]
			const bodyBefore = new Map(was.stepBodies)
			const bodiesBefore = new Set(Arr.map(was.stepBodies, ([, body]) => body))
			for (const [name, body] of now.stepBodies) {
				const kept = bodyBefore.get(name)
				assert.ok(
					kept === undefined ? !bodiesBefore.has(body) : kept === body,
					`version ${v}: ${name} is named by its content`
				)
			}
			if (change.kind === "a count grows") {
				if (admitted.length > 0) {
					c.note("a count grown under stored probes")
				}
				assert.ok(
					Arr.filter(now.step, (fn) => !Arr.contains(was.step, fn)).length >= 2,
					`version ${v}: a changed count replaces its counts' constant and its rows'`
				)
			}
			assert.equal(
				sameIdentity(now.step, was.step),
				sameIdentity(space(stage), space(before)),
				`version ${v}: Step's constants stand exactly when Last's rows and the counts do`
			)
			if (change.kind !== "a position renamed") {
				assert.equal(
					sameIdentity(now.stepProduct, was.stepProduct),
					sameIdentity(product(stage), product(before)),
					`version ${v}: StepProduct's constants stand exactly when the rows and Position's size do`
				)
			}
		}
	})

layer(Substrate.layer)("dependent keys through grizzle's migrations on PostgreSQL 19rc1", (it) => {
	it.effect(
		"a changed count replaces its counts' and its rows' constants, each constant is named by its content, a rename or a grown slot roster replaces none of it, and every probe is admitted exactly into Last's rows",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/closed/fin-migrations",
						draw: drawn(historyGen),
						literal: Formatter.format,
						oracle: {
							kind: "postgresql",
							name: "content addressing of constants and the codes a rename keeps, against PostgreSQL's catalog and verdicts"
						},
						coverage: required<FinFeature>(
							[
								"a count grows",
								"Last gains a row",
								"a position renamed",
								"a position appended",
								"a probe admitted",
								"a probe refused",
								"a count grown under stored probes"
							],
							{ cases: 16, sense: notesOnly }
						),
						kept: [],
						runs: 3,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					finCase
				)
			)
	)
})
