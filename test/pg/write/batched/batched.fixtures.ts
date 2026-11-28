/** What batched.test.ts reads: its schemas, its spaces, and each case's run. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { array, codePoint, element, type Gen, int, string } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { memberCalls, variantOf } from "#adapter/db/handles.ts"
import {
	excludesNothing,
	type PreparedStatement,
	runFramed,
	writeFrame
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { WrittenAt } from "#adapter/witness/classify.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import type { Param } from "#compiler/core/wire.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { sameBytes } from "#compiler/scalar/values/bytes.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import type { Generated } from "#test/support/install-migrate.ts"
import { fixtureTemplate, openedIn } from "#test/support/pg/reads/support.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, type SubstrateCase } from "#test/support/substrate/substrate.ts"

const Text = str.bytes(512, str.regex("^.*$", "su"))

/**
 * Nodes of documents, wide as edullm's qti.node is: keyed (doc, path, at), and by `seq` alone, a second key, so its
 * insert arbitrates every key and reads its met rows through the met window (sql/ast.ts FromSource `metRows`).
 */
const Wide = relation("Wide", { doc: int8, path: Text, at: int8, seq: int8, body: Text }, [
	"doc",
	"path",
	"at"
])

/** A note a call writes first, in a stratum of its own before the insert (ChangeSet.sequence). */
const Note = relation("Note", { id: int8 }, ["id"])

const build = (name: string) => schema(name, [Note, Wide], [key(on(Wide, "seq"))])

/**
 * A case: how many facts one call inserts, how wide each fact's body is, whether two of them, the first and the last,
 * share a `seq`, which the second key refuses, and whether the call writes a note first, in a stratum before the
 * insert's, in its one transaction.
 */
export interface Batched {
	readonly facts: number
	readonly body: number
	readonly pair: boolean
	readonly after: boolean
}

/**
 * Thousands of facts of hundreds of bytes: past PostgreSQL's default work_mem in one execution, whose met window sorts
 * every fact twice and whose CTEs keep them, and past one execution's share of it.
 */
export const batchedGen: Gen<Batched> = (s) => ({
	facts: s.draw(int(8000, 14000)),
	body: s.draw(int(200, 400)),
	pair: s.draw(element([false, true] as const)),
	after: s.draw(element([false, true] as const))
})

export type BatchedFeature =
	| "every fact inserted"
	| "a pair across executions refused"
	| "after a write of the same transaction"

/** Fact `i` of Wide: document i mod 7, a long path, at i, `seq` as given, and a body `body` bytes wide. */
const wideFact = (body: number, i: number, seq: bigint) => ({
	doc: BigInt(i % 7),
	path: `document/${Str.padStart(6, "0")(String(i % 997))}/${Str.repeat(120)("p")}`,
	at: BigInt(i),
	seq,
	body: `${Str.repeat(body)("b")}${String(i)}`
})

/** Fact `i` of a case: `seq` i, the last the first's where the case pairs them. */
const factOf = (c: Batched, i: number) =>
	wideFact(c.body, i, c.pair && i === c.facts - 1 ? 0n : BigInt(i))

/**
 * One case on a fresh installation: the call's facts inserted, after a note in a stratum of its own where the case
 * draws it, under EXPLAIN (ANALYZE, BUFFERS), rolled back, then applied. Its executions are several, each of a share of the facts within PostgreSQL's default work_mem, none of which
 * writes a temporary block: the temporary files of a write are O(B × width) for its share B, never O(N × width) for
 * its N facts. Applied, it inserts every fact once, as the host counts them; or, where two facts share `seq`, the
 * first in the first share and the last in the last, it is refused on the second key's law, as one execution of every
 * fact refuses the pair, and stores nothing, the note before it included: a batched flight a statement refuses is sent
 * again whole, every statement of its transaction with it.
 */
export const runBatched = (c: Batched, k: Case<BatchedFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("Batched"), "batched", {
				programs: {},
				logins: () => []
			})
			const S = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			const facts = Arr.map(indices(c.facts), (i) => factOf(c, i))
			const inserted = ChangeSet.empty(S).insert(Wide, facts)
			const change = c.after
				? ChangeSet.sequence(ChangeSet.empty(S).insert(Note, [{ id: 1n }]), inserted)
				: inserted
			if (!c.pair) {
				const plans = yield* explainedChange(db, change, {})
				assert.ok(
					plans.length > 1,
					`${Formatter.format(c)}: the insert of ${c.facts} facts runs in several executions, ${plans.length} ran`
				)
				assert.ok(
					Arr.every(plans, (p) => p.plan.buffers.tempWritten === 0),
					`${Formatter.format(c)}: no execution of the insert writes a temporary block, its ${plans.length} wrote ${Formatter.format(Arr.map(plans, (p) => p.plan.buffers.tempWritten))} blocks`
				)
			}
			const store = yield* observedChange(db, change, attemptLabel, { kind: "none" })
			const applied = yield* store.apply({})
			const outcome = applied.value
			if (!c.pair) {
				assert.equal(outcome.kind, "accepted", `${Formatter.format(c)}: the insert is accepted`)
				const added =
					outcome.kind === "accepted"
						? Option.getOrUndefined(Arr.findFirst(outcome.counts, (n) => n.relation === "Wide"))
								?.added
						: undefined
				assert.equal(added, BigInt(c.facts), `${Formatter.format(c)}: every fact is added once`)
				const substrate = yield* Substrate
				const stored = yield* substrate.admin.queryValues(
					`SELECT count(*)::text, count(DISTINCT seq)::text FROM ${fx.table("Wide")}`,
					[]
				)
				assert.deepEqual(
					stored,
					[[String(c.facts), String(c.facts)]],
					`${Formatter.format(c)}: the table holds every fact once`
				)
				const notes = yield* substrate.admin.queryValues(
					`SELECT count(*)::text FROM ${fx.table("Note")}`,
					[]
				)
				assert.deepEqual(
					notes,
					[[c.after ? "1" : "0"]],
					`${Formatter.format(c)}: the note the call writes first is stored with the facts`
				)
				k.note("every fact inserted")
				if (c.after) {
					k.note("after a write of the same transaction")
				}
				return
			}
			assert.equal(
				outcome.kind,
				"invariant-rejected",
				`${Formatter.format(c)}: two facts at one seq are refused, not ${outcome.kind}`
			)
			const substrate = yield* Substrate
			const left = yield* substrate.admin.queryValues(
				`SELECT (SELECT count(*) FROM ${fx.table("Note")})::text, (SELECT count(*) FROM ${fx.table("Wide")})::text`,
				[]
			)
			assert.deepEqual(
				left,
				[["0", "0"]],
				`${Formatter.format(c)}: the refused call stores nothing`
			)
			k.note("a pair across executions refused")
			if (c.after) {
				k.note("after a write of the same transaction")
			}
		})
	)

/** A pattern PostgreSQL checks a relation parameter's field against as it binds it: one to four lowercase letters. */
const Code = str.regex("^[a-z]{1,4}$", "u")

/** The codes a call names, each once. */
const Tag = relation("Tag", { code: Code }, ["code"])

/** Wide's facts and the codes a call names: the box of the admitted insert. */
const Admitted = schema("Admitted", [Wide, Tag], [])

/**
 * A call's facts of Wide inserted, then the codes of its relation parameter `named` into Tag, a stratum after. `named`'s
 * field is checked beyond its base, so its admission rides every statement before the first one sent wherever it holds
 * a fact, Tag's insert, and that one (write/program/admission.ts): Wide's insert carries it, the arrays of `named` its
 * first placeholders.
 */
const tagged = ChangeSet.sequence(
	ChangeSet.empty(Admitted).insert(Wide, []),
	ChangeSet.empty(Admitted).insert(
		Tag,
		query(Admitted).rule((r) => {
			const named = r.relation("named", { code: Code })
			const { code } = v(named, "named")
			return r.match(named, { code }).find({ code })
		})
	)
)

/** How the admitted box is installed: its label and its login's workload, `tagged`. */
const admittedInstall = Object.freeze({ label: "batched_admitted", programs: { tagged } })

/** The admitted box installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const admittedTemplate = fixtureTemplate(import.meta, Admitted, admittedInstall)

/**
 * A case of the admitted box: how many facts of Wide one call inserts and how wide each fact's body is, past one
 * execution's share; and the codes the call names, one of them past Code's length where the case is `outside`.
 */
export interface AdmittedCall {
	readonly facts: number
	readonly body: number
	readonly named: ReadonlyArray<string>
	readonly outside: boolean
}

/** A text inside Code: one to four lowercase letters. */
const codeGen: Gen<string> = string(codePoint(0x61, 0x7a), { min: 1, max: 4 })

/** A text outside Code: five or six lowercase letters, past its length. */
const outsideGen: Gen<string> = string(codePoint(0x61, 0x7a), { min: 5, max: 6 })

/**
 * Thousands of facts of hundreds of bytes, past one execution's share of work_mem (runtime/write/transport.ts
 * writeBatching): 2,500 facts of at least 450 bytes are 1.1 MB, past its 1 MiB; and one to three codes, inside Code,
 * or one outside it beside the rest.
 */
export const admittedGen: Gen<AdmittedCall> = (s) => {
	const facts = s.draw(int(2500, 5000))
	const body = s.draw(int(300, 400))
	const outside = s.draw(element([false, true] as const))
	const inside = s.draw(array(codeGen, { min: outside ? 0 : 1, max: outside ? 2 : 3 }))
	return { facts, body, named: outside ? [s.draw(outsideGen), ...inside] : inside, outside }
}

export type AdmittedFeature =
	| "every fact inserted, every execution binding the whole parameter"
	| "an outside code refused at every execution's Bind"

/** The prepared statements of a flight a session sent: each execution of a served statement, in order. */
type Flight = ReadonlyArray<PreparedStatement>

/** Whether two placeholder values are one: the same text, or the same bytes. */
const sameParam = (a: Param, b: Param): boolean =>
	typeof a === "string" || typeof b === "string" ? a === b : sameBytes(a, b)

/**
 * One case on a clone of the admitted box: the call made once through a Db of its login's full role, every flight its
 * sessions send recorded (the prepared statements of each), and Wide's insert's executions read off them, the
 * statement whose step writes Wide, sent under its own text, its admission's placeholders those its served form marks
 * (lower/conservative/types.ts AdmissionParamSlot).
 *
 * Inside Code, the write inserts every fact once and every code once, and its one flight sends Wide's insert in several
 * executions, each binding the same value at each admission placeholder: the whole parameter, never a share. Outside
 * it, the call is refused at bind as ParamRejected at `named`'s field, nothing written, and its first flight, the
 * batched one, sends the insert in several executions; each, sent again alone in a transaction of the write's frame
 * that ends ROLLBACK, is refused by PostgreSQL, the loaded write's own classifier reading each refusal as the
 * parameter's: each execution's Bind admits the whole parameter, before anything of it runs.
 */
export const runAdmitted = (
	c: AdmittedCall,
	k: Case<AdmittedFeature>,
	taken: SubstrateCase<Generated>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const o = yield* openedIn(Admitted, {}, admittedInstall, taken)
			const db = yield* Effect.orDie(openServedDb(o.installed, o.server.roles.app, {}))
			const members = yield* Effect.orDie(db.load({ tagged }))
			const loaded = member(members, "tagged")
			if (loaded.kind !== "change") {
				return assert.fail("tagged loads as a change")
			}
			const entry = variantOf(db.ctx, loaded.variants).entry
			const insert = defined(
				Option.getOrUndefined(
					Arr.findFirst(
						entry.program.statements,
						(s) => s.step.kind === "write" && s.step.relation === Wide.name
					)
				),
				"the statement that writes Wide"
			)
			if (insert.kind !== "whole") {
				return assert.fail("Wide's insert is a statement of its own")
			}
			/** Wide's insert's form, by its text's name, with the positions of its admission's placeholders. */
			const forms = new Map([
				[
					insert.form.text.name,
					Arr.flatMap(insert.form.paramSlots, (slot, at) => (slot.kind === "admission" ? [at] : []))
				] as const
			])
			const flights: Array<Flight> = []
			const ctx = {
				...db.ctx,
				pool: {
					...db.ctx.pool,
					lease: Effect.map(db.ctx.pool.lease, (session): Session => ({
						...session,
						send: (pipeline, onAnswer, onEnd, onCut) => {
							flights.push(Arr.flatMap(pipeline, (q) => (q._tag === "prepared" ? [q] : [])))
							session.send(pipeline, onAnswer, onEnd, onCut)
						}
					}))
				}
			}
			/** Wide's insert's executions in a flight. */
			const executionsIn = (flight: Flight): Flight =>
				Arr.filter(flight, (q) => forms.has(q.text.name))
			const facts = Arr.map(indices(c.facts), (i) => wideFact(c.body, i, BigInt(i)))
			const applied = yield* Effect.result(
				writeAnswerOf(
					writeOnce(memberCalls(ctx, loaded))({
						params: { named: Arr.map(c.named, (code) => ({ code })) },
						facts: { insert: { Wide: facts } }
					})
				)
			)
			const [batched] = Arr.filter(Arr.map(flights, executionsIn), Arr.isReadonlyArrayNonEmpty)
			const executions = batched ?? []
			assert.ok(
				executions.length > 1,
				`${Formatter.format(c)}: Wide's insert of ${c.facts} facts runs in several executions, ${executions.length} ran`
			)
			const [first, ...rest] = executions
			if (first === undefined) {
				return assert.fail("an execution of Wide's insert")
			}
			const substrate = yield* Substrate
			const names = o.installed.installation.names
			const stored = yield* substrate.admin.queryValues(
				`SELECT (SELECT count(*) FROM ${printObjectName(names.relation("Wide"))})::text, (SELECT count(*) FROM ${printObjectName(names.relation("Tag"))})::text`,
				[]
			)
			if (!c.outside) {
				if (Result.isFailure(applied)) {
					return assert.fail(
						`${Formatter.format(c)}: the write answers, not ${Formatter.format(applied.failure)}`
					)
				}
				assert.equal(
					applied.success._tag,
					"accepted",
					`${Formatter.format(c)}: the write is accepted`
				)
				assert.deepEqual(
					stored,
					[[String(c.facts), String(new Set(c.named).size)]],
					`${Formatter.format(c)}: Wide holds every fact once and Tag every code once`
				)
				const admitted = defined(forms.get(first.text.name), "the insert's form")
				assert.ok(
					admitted.length > 0,
					`${Formatter.format(c)}: Wide's insert carries the admission of named`
				)
				for (const execution of rest) {
					assert.ok(
						Arr.every(admitted, (at) =>
							sameParam(
								defined(execution.params[at], "an admission placeholder's value"),
								defined(first.params[at], "an admission placeholder's value")
							)
						),
						`${Formatter.format(c)}: every execution binds the whole parameter at each admission placeholder`
					)
				}
				k.note("every fact inserted, every execution binding the whole parameter")
				return
			}
			if (Result.isSuccess(applied)) {
				return assert.fail(
					`${Formatter.format(c)}: an outside code is refused at bind, not answered ${applied.success._tag}`
				)
			}
			const refused = applied.failure
			assertVariant(refused, "_tag", "paramRejected", "refused at bind")
			assert.deepEqual(
				refused.param,
				{ kind: "field", name: "named", field: "code" },
				"the refusal names the parameter's field"
			)
			assert.deepEqual(stored, [["0", "0"]], `${Formatter.format(c)}: nothing is written`)
			for (const [at, execution] of executions.entries()) {
				const alone = yield* Effect.scoped(
					Effect.flatMap(Effect.orDie(db.ctx.pool.lease), (session) =>
						Effect.result(
							runFramed(
								session,
								{
									...writeFrame(
										db.ctx.prologue,
										db.ctx.isolation,
										excludesNothing,
										entry.program.advice
									),
									end: "ROLLBACK"
								},
								[execution]
							)
						)
					)
				)
				if (Result.isSuccess(alone) || alone.failure._tag !== "BatchRefused") {
					return assert.fail(
						`${Formatter.format(c)}: execution ${at} alone is refused by PostgreSQL, not ${Result.isSuccess(alone) ? "run" : alone.failure._tag}`
					)
				}
				const refusal = entry.witness.classify(alone.failure.failure, unwritten)
				assert.deepEqual(
					refusal?.kind === "param" ? refusal.param : refusal,
					{ kind: "field", name: "named", field: "code" },
					`${Formatter.format(c)}: execution ${at}'s refusal is the parameter's, ParamRejected at named's field`
				)
			}
			k.note("an outside code refused at every execution's Bind")
		})
	)

/**
 * What a parameter's refusal is classified with of the statement that sent it: nothing, since a parameter's domain
 * names its parameter alone (witness/classify.ts), so the classifier reads no fact the statement writes.
 */
const unwritten: WrittenAt = {
	relations: [],
	judge: () => assert.fail("a parameter's refusal reads no written fact"),
	above: () => assert.fail("a parameter's refusal reads no written fact")
}
