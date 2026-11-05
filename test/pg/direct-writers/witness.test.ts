/**
 * A residual law's witness at a direct writer's COMMIT, over every identity the transaction can act as by then.
 *
 * README, "Direct SQL access" and "Security model": a residual law withholds its witness keys from a role that
 * does not hold the witness relation whole, and no refusal quotes a value from outside the world it is raised in. A
 * residual law is judged at COMMIT, by whoever the transaction acts as then, which the writer may have changed after its
 * write: RESET ROLE, SET ROLE NONE and SET SESSION AUTHORIZATION DEFAULT make it its login, which holds nothing, and
 * SET ROLE another role of its login.
 *
 * The schema holds two laws whose witness is a fact the writer cannot see: a pinned Note's document exists (a
 * selected-source containment, whose witness is the pinned Note's id), and a Slot, keyed by its code, holds at most two
 * Claims of its code and lane (a capacity over a strict superkey of Slot's key, whose witness is the Slot's id). Its
 * login `desk` holds `remover`, which holds Doc whole and deletes documents, `claimer`, which holds Claim whole and
 * claims slots, and `auditor`, which holds Note and Slot whole and writes nothing. A case stores distinct drawn ids, has
 * the writer break one law (remover deletes a document a pinned Note names, or claimer makes a Slot's third Claim),
 * then makes up to three moves, each a change of identity or one made in a savepoint and rolled back to it, and
 * COMMITs. The COMMIT is refused with 23000 under the law's identity, and:
 *
 * - the DETAIL names the witness's key exactly when the identity at COMMIT holds the witness relation whole, and
 *   withholds it otherwise;
 * - no id of a fact outside that identity's world appears in the message, DETAIL, HINT or CONTEXT, unless the
 *   transaction's own write was given it.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { uuid as uuidGen } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { namedDetail } from "#compiler/ir/law.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import {
	capacity,
	contained,
	key,
	login,
	on,
	relation,
	role,
	schema,
	select,
	within
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { bareFixture, failure, openFixture } from "#test/pg/e2e-laws/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { strictDetail, withholds } from "#test/support/detail.ts"
import { lawIdOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Doc = relation("Doc", { id: uuid }, ["id"])
const Note = relation("Note", { id: uuid, doc: uuid, pinned: pg.boolean }, ["id"])
const Slot = relation("Slot", { id: uuid, code: pg.integer, lane: pg.integer }, ["id"])
const Claim = relation("Claim", { code: pg.integer, lane: pg.integer, who: uuid }, [
	"code",
	"lane",
	"who"
])

const pinnedNotes = contained(on(select(Note, { pinned: true }), "doc"), on(Doc, "id"))
const slotClaims = capacity(on(Slot, "code", "lane"), {
	from: on(Claim, "code", "lane"),
	within: within(0n, 2n)
})
const Witnesses = schema("Witnesses", { Doc, Note, Slot, Claim }, [
	pinnedNotes,
	key(Slot, ["code"]),
	slotClaims
])
const remover = role(Witnesses, "remover", { Doc }, { write: ["Doc"] })
const claimer = role(Witnesses, "claimer", { Claim }, { write: ["Claim"] })
const auditor = role(Witnesses, "auditor", { Note, Slot })
const desk = login(Witnesses, "desk", [remover, claimer, auditor])

type RoleName = "remover" | "claimer" | "auditor"
type RelationName = "Doc" | "Note" | "Slot" | "Claim"

/** A change of the identity a transaction acts as, which the role setting alone records. */
type RoleTurn =
	| { readonly kind: "reset-role" }
	| { readonly kind: "set-role-none" }
	| { readonly kind: "set-role"; readonly role: RoleName }

/** A change of identity, or one of the role setting made in a savepoint and rolled back to it, which changes nothing. */
type Move =
	| { readonly kind: "turn"; readonly turn: RoleTurn }
	| { readonly kind: "session-authorization-default" }
	| { readonly kind: "undone"; readonly turn: RoleTurn }

/** Who a transaction acts as: one of its login's roles, or the login itself. */
type Acting = { readonly kind: "login" } | { readonly kind: "role"; readonly role: RoleName }

/** The law the writer breaks and the facts it meets, every id distinct. */
type Breach =
	| {
			readonly kind: "selected-source"
			readonly doc: string
			readonly notes: ReadonlyArray<{ readonly id: string; readonly pinned: boolean }>
			readonly others: ReadonlyArray<{ readonly doc: string; readonly note: string }>
	  }
	| {
			readonly kind: "capacity"
			readonly slot: string
			readonly held: readonly [string, string]
			readonly claim: string
			readonly others: ReadonlyArray<string>
	  }

interface WitnessCase {
	readonly breach: Breach
	readonly moves: ReadonlyArray<Move>
}

type WitnessFeature =
	| "selected-source shown to a holder"
	| "selected-source withheld"
	| "capacity shown to a holder"
	| "capacity withheld"
	| "judged as the login"
	| "judged as another role of the login"
	| "a move undone"

const roleNames: Arr.NonEmptyReadonlyArray<RoleName> = ["remover", "claimer", "auditor"]

/** A role turn: RESET ROLE, SET ROLE NONE, or, three times as often as each, SET ROLE to one of the login's roles, so a
 * holder of the witness relation acts at COMMIT often enough to be shown its key. */
const roleTurnGen: Gen<RoleTurn> = weighted<RoleTurn>([
	[1, constant({ kind: "reset-role" })],
	[1, constant({ kind: "set-role-none" })],
	[3, map(element(roleNames), (r): RoleTurn => ({ kind: "set-role", role: r }))]
])

const moveGen: Gen<Move> = oneOf<Move>([
	map(roleTurnGen, (turn): Move => ({ kind: "turn", turn })),
	constant({ kind: "session-authorization-default" }),
	map(roleTurnGen, (turn): Move => ({ kind: "undone", turn }))
])

const families = ["selected-source", "capacity"] as const

const breachGen: Gen<Breach> = (source) => {
	const ids = source.draw(uniqueArray(uuidGen(7), (id) => id, { min: 9, max: 9 }, 10))
	const family = source.draw(element(families))
	const pinned = source.draw(array(boolean, { min: 1, max: 3 }))
	const others = source.draw(int(0, 2))
	const id = (i: number): string => Str.toLowerCase(elementAt(ids, i, "the case's ids"))
	const unpinned = Arr.every(pinned, (p) => !p)
	return family === "selected-source"
		? {
				kind: "selected-source",
				doc: id(0),
				notes: Arr.map(pinned, (p, i) => ({ id: id(1 + i), pinned: p || (unpinned && i === 0) })),
				others: Arr.take(
					Arr.map([0, 1], (j) => ({ doc: id(4 + 2 * j), note: id(5 + 2 * j) })),
					others
				)
			}
		: {
				kind: "capacity",
				slot: id(0),
				held: [id(1), id(2)],
				claim: id(3),
				others: Arr.take([id(4), id(5)], others)
			}
}

const caseGen: Gen<WitnessCase> = (source) => ({
	breach: source.draw(breachGen),
	moves: source.draw(array(moveGen, { min: 0, max: 3 }))
})

const idOf = (n: number): Uuid => `00000000-0000-4000-8000-${Str.padStart(12, "0")(String(n))}`

/** A Slot's third Claim made by claimer, then the identity moves of `moves`. */
const claimed = (moves: ReadonlyArray<Move>): WitnessCase => ({
	breach: { kind: "capacity", slot: idOf(1), held: [idOf(2), idOf(3)], claim: idOf(4), others: [] },
	moves
})

/** A document two Notes name, one pinned, deleted by remover, then the identity moves of `moves`. */
const removed = (moves: ReadonlyArray<Move>): WitnessCase => ({
	breach: {
		kind: "selected-source",
		doc: idOf(1),
		notes: [
			{ id: idOf(2), pinned: false },
			{ id: idOf(3), pinned: true }
		],
		others: [{ doc: idOf(4), note: idOf(5) }]
	},
	moves
})

/** The role a breach's write needs. */
const writerOf = (breach: Breach): RoleName =>
	breach.kind === "selected-source" ? "remover" : "claimer"

/** The relation whose fact a breach's law names as its witness. */
const witnessRelation = (breach: Breach): RelationName =>
	breach.kind === "selected-source" ? "Note" : "Slot"

/** The relations a role holds whole. */
const heldBy = (acting: Acting): ReadonlyArray<RelationName> => {
	if (acting.kind === "login") {
		return []
	}
	switch (acting.role) {
		case "remover":
			return ["Doc"]
		case "claimer":
			return ["Claim"]
		case "auditor":
			return ["Note", "Slot"]
	}
}

const turned = (turn: RoleTurn): Acting =>
	turn.kind === "set-role" ? { kind: "role", role: turn.role } : { kind: "login" }

/** Who the transaction acts as after its moves, from its writer. */
const actingAfter = (c: WitnessCase): Acting => {
	const writer: Acting = { kind: "role", role: writerOf(c.breach) }
	return Arr.reduce(c.moves, writer, (acting: Acting, move: Move): Acting => {
		switch (move.kind) {
			case "turn":
				return turned(move.turn)
			case "session-authorization-default":
				return { kind: "login" }
			case "undone":
				return acting
		}
	})
}

/** Every id a relation's stored facts hold, as PostgreSQL spells a uuid. */
const idsIn = (breach: Breach, relation: RelationName): ReadonlyArray<string> => {
	if (breach.kind === "capacity") {
		return relation === "Slot"
			? [breach.slot, ...breach.others]
			: relation === "Claim"
				? breach.held
				: []
	}
	return relation === "Doc"
		? [breach.doc, ...Arr.map(breach.others, (o) => o.doc)]
		: relation === "Note"
			? [
					breach.doc,
					...Arr.map(breach.notes, (n) => n.id),
					...Arr.flatMap(breach.others, (o) => [o.doc, o.note])
				]
			: []
}

/** The ids the transaction's write was given. */
const sentIds = (breach: Breach): ReadonlyArray<string> =>
	breach.kind === "selected-source" ? [breach.doc] : [breach.claim]

const relationNames: ReadonlyArray<RelationName> = ["Doc", "Note", "Slot", "Claim"]

/** The ids of facts outside the world of whoever acts, less those its own write was given. */
const hiddenIds = (breach: Breach, acting: Acting): ReadonlyArray<string> => {
	const held = heldBy(acting)
	const shown = Arr.flatMap(held, (r) => idsIn(breach, r))
	const outside = Arr.flatMap(
		Arr.filter(relationNames, (r) => !held.includes(r)),
		(r: RelationName) => idsIn(breach, r)
	)
	return Arr.dedupe(
		Arr.filter(outside, (id) => !shown.includes(id) && !sentIds(breach).includes(id))
	)
}

/** The key of the fact a breach's law names: the first pinned Note in key order, or the Slot. */
const witnessKey = (breach: Breach): string =>
	breach.kind === "selected-source"
		? defined(
				Option.getOrUndefined(
					Arr.head(
						Arr.sort(
							Arr.map(
								Arr.filter(breach.notes, (n) => n.pinned),
								(n) => n.id
							),
							Order.String
						)
					)
				),
				"a pinned Note"
			)
		: breach.slot

layer(Substrate.layer, { excludeTestServices: true })(
	"a residual law's witness at a direct writer's COMMIT",
	(it) => {
		it.effect(
			"names the witness's key exactly to an identity holding its relation whole, and quotes no value outside its world",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const f = yield* openFixture(Witnesses, [desk], bareFixture)
						const names = namesOf(f.installed)
						const roleIdent = (r: RoleName): string =>
							quoteIdent(
								f.installed.world(r === "remover" ? remover : r === "claimer" ? claimer : auditor)
									.role
							)
						const codecOf = (breach: Breach) => {
							const law = lawIdOf(
								Witnesses,
								breach.kind === "selected-source" ? pinnedNotes : slotClaims
							)
							const residual = defined(
								Option.getOrUndefined(
									Arr.findFirst(f.installed.installation.laws.residuals, (r) => r.lawId === law)
								),
								`the residual law ${law}`
							)
							return { law, codec: namedDetail(residual.detail) }
						}
						const factsOf = (breach: Breach) => {
							switch (breach.kind) {
								case "selected-source":
									return [
										...Arr.map([breach.doc, ...Arr.map(breach.others, (o) => o.doc)], (doc) => ({
											sql: `INSERT INTO ${names.table(Doc)} (${names.column(Doc, "id")}) VALUES ($1::uuid)`,
											params: [doc]
										})),
										...Arr.map(
											[
												...Arr.map(breach.notes, (n) => [n.id, breach.doc, n.pinned] as const),
												...Arr.map(breach.others, (o) => [o.note, o.doc, true] as const)
											],
											([id, doc, pinned]) => ({
												sql: `INSERT INTO ${names.table(Note)} (${names.column(Note, "id")}, ${names.column(Note, "doc")}, ${names.column(Note, "pinned")}) VALUES ($1::uuid, $2::uuid, $3::boolean)`,
												params: [id, doc, pinned]
											})
										)
									]
								case "capacity":
									return [
										...Arr.map([breach.slot, ...breach.others], (slot, i) => ({
											sql: `INSERT INTO ${names.table(Slot)} (${names.column(Slot, "id")}, ${names.column(Slot, "code")}, ${names.column(Slot, "lane")}) VALUES ($1::uuid, $2::integer, 1)`,
											params: [slot, i + 1]
										})),
										...Arr.map(breach.held, (who) => ({
											sql: `INSERT INTO ${names.table(Claim)} (${names.column(Claim, "code")}, ${names.column(Claim, "lane")}, ${names.column(Claim, "who")}) VALUES (1, 1, $1::uuid)`,
											params: [who]
										}))
									]
							}
						}
						const writeOf = (breach: Breach): string =>
							breach.kind === "selected-source"
								? `DELETE FROM ${names.table(Doc)} WHERE ${names.column(Doc, "id")} = '${breach.doc}'::uuid`
								: `INSERT INTO ${names.table(Claim)} (${names.column(Claim, "code")}, ${names.column(Claim, "lane")}, ${names.column(Claim, "who")}) VALUES (1, 1, '${breach.claim}'::uuid)`
						const turnSql = (turn: RoleTurn): string => {
							switch (turn.kind) {
								case "reset-role":
									return "RESET ROLE"
								case "set-role-none":
									return "SET ROLE NONE"
								case "set-role":
									return `SET ROLE ${roleIdent(turn.role)}`
							}
						}
						const moveSql = (move: Move): ReadonlyArray<string> => {
							switch (move.kind) {
								case "turn":
									return [turnSql(move.turn)]
								case "session-authorization-default":
									return ["SET SESSION AUTHORIZATION DEFAULT"]
								case "undone":
									return ["SAVEPOINT moved", turnSql(move.turn), "ROLLBACK TO SAVEPOINT moved"]
							}
						}
						const w = yield* f.psql(remover)
						const admin = (yield* Substrate).admin
						return yield* explore(
							{
								suite: "direct-writers/witness",
								draw: drawn(caseGen),
								literal: Formatter.format,
								kept: [
									{
										note: "the writer resets its role before COMMIT: the law function took role none for the owner and named a fact the login cannot see",
										sketch: claimed([{ kind: "turn", turn: { kind: "reset-role" } }]),
										draws: "",
										reaches: ["capacity withheld", "judged as the login"]
									},
									{
										note: "SET SESSION AUTHORIZATION DEFAULT reads as role none too",
										sketch: removed([{ kind: "session-authorization-default" }]),
										draws: "",
										reaches: ["selected-source withheld", "judged as the login"]
									},
									{
										note: "another role of the login that holds the witness relation whole",
										sketch: removed([
											{ kind: "turn", turn: { kind: "set-role", role: "auditor" } }
										]),
										draws: "",
										reaches: [
											"selected-source shown to a holder",
											"judged as another role of the login"
										]
									},
									{
										note: "a holder's role rolled back to its savepoint, then the holder's role taken on",
										sketch: claimed([
											{ kind: "undone", turn: { kind: "set-role", role: "auditor" } },
											{ kind: "turn", turn: { kind: "set-role", role: "auditor" } }
										]),
										draws: "",
										reaches: ["capacity shown to a holder", "a move undone"]
									}
								],
								runs: 60,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang,
								coverage: required<WitnessFeature>(
									[
										"selected-source shown to a holder",
										"selected-source withheld",
										"capacity shown to a holder",
										"capacity withheld",
										"judged as the login",
										"judged as another role of the login",
										"a move undone"
									],
									{ cases: 480, sense: notesOnly }
								)
							},
							(c, cx) =>
								Effect.gen(function* () {
									yield* replaceRows(admin, installationGroup(names), factsOf(c.breach))
									const writer = writerOf(c.breach)
									yield* w.run("SET SESSION AUTHORIZATION DEFAULT")
									yield* w.run(`SET ROLE ${roleIdent(writer)}`)
									yield* w.begin
									yield* w.run(writeOf(c.breach))
									for (const move of c.moves) {
										for (const sql of moveSql(move)) {
											yield* w.run(sql)
										}
									}
									const refused = yield* failure(w.commit)
									const acting = actingAfter(c)
									const { law, codec } = codecOf(c.breach)
									assert.equal(refused.code, sqlstates.integrityConstraintViolation)
									assert.ok(refused.constraint === law, `refused by ${String(refused.constraint)}`)
									const detail = defined(Option.getOrUndefined(refused.detail), "a DETAIL")
									const holds = heldBy(acting).includes(witnessRelation(c.breach))
									assert.equal(withholds(codec, detail), !holds, detail)
									if (holds) {
										assert.deepEqual(strictDetail(codec, detail), [witnessKey(c.breach)])
									}
									const texts = [
										refused.message,
										detail,
										...Option.toArray(refused.hint),
										...Option.toArray(refused.where)
									]
									for (const id of hiddenIds(c.breach, acting)) {
										for (const text of texts) {
											assert.ok(
												!Str.includes(id)(text),
												`${text} quotes ${id}, outside the world of ${acting.kind === "login" ? "the login" : acting.role}`
											)
										}
									}
									cx.note(
										c.breach.kind === "selected-source"
											? holds
												? "selected-source shown to a holder"
												: "selected-source withheld"
											: holds
												? "capacity shown to a holder"
												: "capacity withheld"
									)
									if (acting.kind === "login") {
										cx.note("judged as the login")
									} else if (acting.role !== writer) {
										cx.note("judged as another role of the login")
									}
									if (Arr.some(c.moves, (m) => m.kind === "undone")) {
										cx.note("a move undone")
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
