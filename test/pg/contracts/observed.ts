/**
 * What the plan contracts observe of a drawn shape (shapes.ts), installed as `grizzle generate` drafts and serves it on
 * PostgreSQL 19: every call of its workload made once through a Db of its login's full role, over a session of its own
 * through a protocol tap (test/support/wire-tap.ts), and each statement the call sent planned as the session plans it.
 *
 * - **What a call sends** is read off the wire: each statement it executes, by the name it is prepared under on the
 *   session and the text the session parsed under that name, with the parameters it bound; a write is called twice,
 *   its first call standing the write up on the session (README "A session's first call of a write stands the write
 *   up"), its second the call the contracts judge.
 * - **Its plan** is the generic plan the session holds for it: `EXPLAIN (VERBOSE, FORMAT JSON) EXECUTE <name>(...)` of
 *   the session's own prepared statement, every parameter NULL, in a transaction framed and begun by the Db's own
 *   prologue and rolled back. Every login's role stores plan_cache_mode at force_generic_plan (physical/ddl/roles.ts),
 *   so the session plans each statement it prepares generically; the test sets nothing.
 * - **At scale** the same statements are planned again on the same session, every table that holds a page recorded in
 *   pg_class as a million rows (`atScale`): the sizes a population of a few pages and one of millions plan at straddle
 *   every cost tie between them, and a law holds at both (contractCase). A flip between two plans that do the same
 *   bounded keyed work, a hash's and a sort's, is a tie the law admits; a scan where a probe should be is not.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Result, type Scope, String as Str } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { excludesNothing, oneShotStatement, runFramed, writeFrame } from "#adapter/wire/batch.ts"
import { type EstimatedNode, parsePlanTree } from "#bench/harness/explain.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { carrierSetting, settingCarrier } from "#compiler/sql/carriers.ts"
import { lexemesOf } from "#compiler/sql/lexer.ts"
import { defaultPool, poolFor } from "#test/pg/adapter/support.ts"
import {
	bindsDoc,
	bindsKey,
	built,
	carriedWrite,
	contentRead,
	derivedName,
	readName,
	type ShapeSketch,
	strataWrite,
	writeCalls
} from "#test/pg/contracts/shapes.ts"
import { type CopyIndex, indexesOf } from "#test/pg/physical/copies.ts"
import { scanBindings } from "#test/pg/physical/plan-bindings.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { readOnce, writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { type Installed, installGenerated } from "#test/support/install-migrate.ts"
import type { SqlError } from "#test/support/pg.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { testSql } from "#test/support/sql.ts"
import { Substrate, type SubstrateShape } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"

/** One statement a call executed: its prepared name, its text, the parameters it bound, and the session's plan of it. */
export interface Sent {
	readonly name: string
	readonly text: string
	readonly params: number
	readonly plan: EstimatedNode
}

/**
 * One call: its program's name, whether it reads or writes, the statements of the Db's prologue it executed (its
 * ledger's fence and its snapshot's guard, which every Db transaction sends), and every other statement it executed, in
 * order.
 */
export interface Called {
	readonly program: string
	readonly kind: "read" | "write"
	readonly prologue: number
	/** The statements past its prologue the compiler states the call sends (runtime/write/flight.ts ServedWrite `sends`), a read's one. */
	readonly stated: number
	readonly sent: ReadonlyArray<Sent>
}

/**
 * A shape as the contracts observe it: its installation, each of its programs' judged call, and the indexes of each
 * table a call's plan scans, by `<schema>.<table>`, as the catalog holds them (copies.ts indexesOf).
 */
export interface Observed {
	readonly installed: Installed
	readonly calls: ReadonlyArray<Called>
	/** The same calls' statements planned again with every table that holds a page at scale (`atScale`). */
	readonly scaled: ReadonlyArray<Called>
	readonly indexes: ReadonlyMap<string, ReadonlyArray<CopyIndex>>
}

/** A statement executed by name, before its plan is read: its name, text and bound parameters. */
interface Executed {
	readonly name: string
	readonly text: string
	readonly params: number
}

/**
 * The rows each table that holds a page reads as at scale (`atScale`): a million, past every cost tie a population of a
 * few pages and one of millions straddle, a probe's against a scan's, a hash's against a sort's, each statement's plans
 * at both sizes bound alike.
 *
 * @limitKind measured
 * @owner the plan contracts (test/pg/contracts/observed.ts)
 * @unit rows a table holds, as pg_class records them
 * @scope every table of a drawn shape's installation that holds a page, planned a second time
 * @evidence a population as installed plans at ten pages of rows (PostgreSQL 19 tableam.c
 *   table_block_relation_estimate_size, a table never vacuumed), some two thousand narrow rows; a million is
 *   five hundred times past it, the scale of edullm's 1x tables (PERFBAR), where a scan's price passes a probe's for
 *   every table of more than a few pages
 */
const scaleRows = 1_000_000

/**
 * Every table of `schema` that holds a page sized at scale (scaleRows) in pg_class (pg_restore_relation_stats), as the
 * owner, committed: the planner prices a table at its density times its pages (tableam.c
 * table_block_relation_estimate_size), so a table of one page whose pg_class records a million rows on it reads as a
 * million rows, and a statement a session prepared is planned again at its next EXECUTE, its relations' sizes moved. A
 * table of no page is left as installed: no density makes rows of it.
 */
const atScale = (substrate: SubstrateShape, schema: string) =>
	Effect.gen(function* () {
		const refused = yield* substrate.admin.queryValues(
			`SELECT pg_catalog.count(*) FILTER (WHERE NOT pg_catalog.pg_restore_relation_stats('schemaname', n.nspname::pg_catalog.text, 'relname', c.relname::pg_catalog.text,
				'relpages', (pg_catalog.pg_relation_size(c.oid) / pg_catalog.current_setting('block_size')::pg_catalog.int8)::pg_catalog.int4,
				'reltuples', ${scaleRows}::pg_catalog.float4, 'relallvisible', 0::pg_catalog.int4))::pg_catalog.text
			FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
			WHERE n.nspname = $1::text AND c.relkind IN ('r', 'm') AND pg_catalog.pg_relation_size(c.oid) > 0`,
			[schema]
		)
		assert.deepEqual(refused, [["0"]], "every table of a page sized at scale")
	})

/**
 * The shape `s` installed, its workload called and each judged call's statements planned (see the header). A shape the
 * compiler refuses fails with the refusal.
 */
const observed = (
	s: ShapeSketch
): Effect.Effect<Observed, CompileError | SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const generated = yield* installGenerated(
			(name) => {
				const b = built(s, name)
				return { schema: b.schema, logins: [b.world.server] }
			},
			{ label: "plan_contracts", ambient: ordinarySession }
		)
		const installed = generated.installed
		const b = built(s, installed.declared)
		const substrate = yield* Substrate
		const tap = makeTap(substrate.cluster)
		const db = yield* Effect.orDie(openServedDb(installed, b.world.server.roles.app, {}))
		const pool = yield* poolFor(installed.as(b.world.server), {
			...defaultPool,
			transport: { kind: "given", transport: tap.transport },
			pool: { max: 1 }
		})
		const ctx = { ...db.ctx, pool }
		const loaded = yield* Effect.orDie(db.load(b.programs))
		const texts = new Map<string, string>()
		/** The statements `call` executes on the tapped session, each by its prepared name and the text parsed under it. */
		const executedBy = <A, E>(call: Effect.Effect<A, E>) =>
			Effect.gen(function* () {
				const mark = tap.mark()
				yield* Effect.orDie(call)
				const window = tap.since(mark)
				const executed: Array<Executed> = []
				for (const m of window.frontend) {
					if (m.type === "P") {
						texts.set(m.name, m.text)
					}
					if (m.type === "B" && m.name !== "") {
						executed.push({
							name: m.name,
							text: defined(texts.get(m.name), `the text of ${m.name}`),
							params: m.params.length
						})
					}
				}
				return executed
			})
		const prologue: ReadonlySet<string> = new Set([
			ctx.prologue.fence.text.name,
			ctx.prologue.enter.text.name
		])
		const judged: Array<{
			readonly program: string
			readonly kind: "read" | "write"
			readonly stated: number
			readonly executed: ReadonlyArray<Executed>
		}> = []
		const reads = [
			...Arr.map(s.reads, (read, at) => ({
				program: readName(at),
				params: {
					...(read.via === "owner" ? { id: 1n } : bindsDoc(s, read) ? { doc: 1n } : {}),
					...(bindsKey(s, read) ? { k0: 1n } : {})
				}
			})),
			...(s.content ? [{ program: contentRead, params: { doc: 1n } }] : [])
		]
		for (const read of reads) {
			const executed = yield* executedBy(
				readOnce(memberCalls(ctx, member(loaded, read.program)))({ params: read.params, facts: {} })
			)
			judged.push({ program: read.program, kind: "read", stated: 1, executed })
		}
		for (const [at, write] of writeCalls(s).entries()) {
			const call = (n: number) =>
				writeAnswerOf(
					writeOnce(memberCalls(ctx, member(loaded, write.program)))({
						params: write.params(2 * at + n),
						facts: write.facts(2 * at + n)
					})
				)
			yield* executedBy(call(0))
			const loadedWrite = member(loaded, write.program)
			const stated =
				loadedWrite.kind === "change" && loadedWrite.variants.kind === "change"
					? loadedWrite.variants.change.entry.program.sends
					: assert.fail(`${write.program} loads as one change`)
			const executed = yield* executedBy(call(1))
			judged.push({ program: write.program, kind: "write", stated, executed })
		}
		const planned = Effect.scoped(
			Effect.flatMap(Effect.orDie(pool.lease), (session) =>
				Effect.forEach(judged, (j) =>
					Effect.map(
						Effect.orDie(
							runFramed(
								session,
								{ ...writeFrame(ctx.prologue, ctx.isolation, excludesNothing), end: "ROLLBACK" },
								[
									...carriersEmptied(Arr.filter(j.executed, (e) => !prologue.has(e.name))),
									...Arr.map(
										Arr.filter(j.executed, (e) => !prologue.has(e.name)),
										(e) =>
											oneShotStatement(
												testSql(
													`EXPLAIN (VERBOSE, FORMAT JSON) EXECUTE ${e.name}${
														e.params === 0
															? ""
															: `(${Arr.join(
																	Array.from({ length: e.params }, () => "NULL"),
																	", "
																)})`
													}`
												),
												[]
											)
									)
								]
							)
						),
						(outcomes): Called => ({
							program: j.program,
							kind: j.kind,
							prologue: Arr.filter(j.executed, (e) => prologue.has(e.name)).length,
							stated: j.stated,
							sent: Arr.map(
								Arr.zip(
									Arr.filter(j.executed, (e) => !prologue.has(e.name)),
									Arr.drop(
										outcomes,
										carriersEmptied(Arr.filter(j.executed, (e) => !prologue.has(e.name))).length
									)
								),
								([e, outcome]) => ({
									...e,
									plan: succeeded(
										Result.mapError(parsePlanTree(outcome.rows[0]?.[0]), (f) => f.message),
										`the session's plan of ${e.name}`
									)
								})
							)
						})
					)
				)
			)
		)
		const calls = yield* planned
		yield* atScale(substrate, installed.schema)
		const scaled = yield* planned

		const scanned = new Map<string, string>()
		for (const call of [...calls, ...scaled]) {
			for (const sent of call.sent) {
				for (const scan of scanBindings(sent.plan)) {
					scanned.set(
						`${scan.schema}.${scan.relation}`,
						`${quoteIdent(scan.schema)}.${quoteIdent(scan.relation)}`
					)
				}
			}
		}
		const indexes = new Map<string, ReadonlyArray<CopyIndex>>()
		for (const [table, quoted] of scanned) {
			const held = yield* indexesOf(quoted)
			indexes.set(table, held)
		}
		return { installed, calls, scaled, indexes }
	})

/**
 * The statement that sets each carrier setting `executed` reads (write/carriers/carriers.ts) to a carrier of no row,
 * inside the rolled-back frame its plans are read in, none where none reads one: a carrier lives in its call's
 * transaction alone, so a plan PostgreSQL makes again there, its cached one invalidated meanwhile, reads the setting
 * as it plans.
 */
const carriersEmptied = (executed: ReadonlyArray<Executed>) => {
	const settings = [
		...new Set(
			Arr.flatMap(executed, (e) =>
				Arr.flatMap(lexemesOf(e.text).lexemes, (l) => {
					if (l.kind !== "string") {
						return []
					}
					const text = Str.startsWith("'")(l.text) ? Str.slice(1, -1)(l.text) : l.text
					return settingCarrier(text) === undefined ? [] : [text]
				})
			)
		)
	]
	return Arr.isReadonlyArrayNonEmpty(settings)
		? [
				oneShotStatement(
					testSql(
						`SELECT ${Arr.join(
							Arr.map(settings, (s) => {
								const carrier = settingCarrier(s)
								const empty =
									carrier !== undefined && s === carrierSetting(carrier, undefined) ? "0" : "{}"
								return `pg_catalog.set_config('${s}', '${empty}', true)`
							}),
							", "
						)}`
					),
					[]
				)
			]
		: []
}

/** The situations a case reaches, which each contract's property requires the ones it judges among. */
export type ContractFeature =
	| "a live derived relation read"
	| "a stored derived relation read"
	| "two aliases of one definition"
	| "a read that binds k0"
	| "a document a row in hand binds"
	| "a binding stated by a where over a live derivation"
	| "a live derivation read by its key alone"
	| "a key of k0 alone"
	| "a negation in a live definition"
	| "a live definition read twice"
	| "a two-strata write"
	| "a carried binding"
	| "published content read through its fact"

/** The situations shape `s`, as `o` installed it, reaches (ContractFeature). */
const reachedOf = (s: ShapeSketch, o: Observed): ReadonlyArray<ContractFeature> => {
	const live = (at: number): boolean =>
		o.installed.installation.checked.holdings.get(derivedName(at))?.kind !== "stored"
	const readDerived = Arr.flatMap(s.reads, (r) =>
		r.relation.kind === "derived" ? [r.relation.at] : []
	)
	return [
		...(Arr.some(readDerived, live) ? (["a live derived relation read"] as const) : []),
		...(Arr.some(readDerived, (at) => !live(at))
			? (["a stored derived relation read"] as const)
			: []),
		...(Arr.some(s.reads, (r) => bindsKey(s, r)) ? (["a read that binds k0"] as const) : []),
		...(Arr.some(
			s.derived,
			(_, at) =>
				at > 0 &&
				o.installed.installation.checked.installedAs(derivedName(at)) ===
					o.installed.installation.checked.installedAs(derivedName(0))
		)
			? (["two aliases of one definition"] as const)
			: []),
		...(Arr.some(s.reads, (r) => r.via === "owner")
			? (["a document a row in hand binds"] as const)
			: []),
		...(Arr.some(
			s.reads,
			(r) => r.stated === "where" && r.relation.kind === "derived" && live(r.relation.at)
		)
			? (["a binding stated by a where over a live derivation"] as const)
			: []),
		...(Arr.some(
			s.reads,
			(r) => r.relation.kind === "derived" && live(r.relation.at) && !bindsDoc(s, r)
		)
			? (["a live derivation read by its key alone"] as const)
			: []),
		...(s.globalKey ? (["a key of k0 alone"] as const) : []),
		...(Arr.some(s.derived, (d, at) => live(at) && d.kind === "join" && Option.isSome(d.without))
			? (["a negation in a live definition"] as const)
			: []),
		...(Arr.some(s.derived, (d, at) => live(at) && d.kind === "over" && d.twice && live(0))
			? (["a live definition read twice"] as const)
			: []),
		...(Arr.some(writeCalls(s), (w) => w.program === strataWrite)
			? (["a two-strata write"] as const)
			: []),
		...(Arr.some(writeCalls(s), (w) => w.program === carriedWrite)
			? (["a carried binding"] as const)
			: []),
		...(s.content ? (["published content read through its fact"] as const) : [])
	]
}

/**
 * One case of a contract's property: the shape `s` observed (`observed`), the situations it reaches noted, and the
 * contract's law over it holding, its problems none, `what` naming the law in a failure.
 */
export const contractCase = (
	s: ShapeSketch,
	note: (feature: ContractFeature) => void,
	law: (s: ShapeSketch, o: Observed) => ReadonlyArray<string>,
	what: string
) =>
	Effect.gen(function* () {
		const o = yield* observed(s)
		Arr.forEach(reachedOf(s, o), note)
		assert.deepEqual(law(s, o), [], what)
		assert.deepEqual(law(s, { ...o, calls: o.scaled }), [], `${what}, every table at scale`)
	})
