/**
 * A residual law's witness at a direct writer's COMMIT, over every identity the transaction can act as by then.
 *
 * README, "Direct SQL access" and "Security model": a residual law withholds its witness keys from a role that
 * does not hold the witness relation whole, and no refusal quotes a value from outside the world it is raised in. A
 * residual law is judged at COMMIT, by whoever the transaction acts as then, which the writer may have changed after its
 * write: RESET ROLE, SET ROLE NONE and SET SESSION AUTHORIZATION DEFAULT make it its login, which holds nothing, and
 * SET ROLE another role of its login.
 *
 * The schema holds a law whose witness is a fact the writer cannot see: a Slot, keyed by its code, holds at most two
 * Claims of its code and lane (a capacity over a strict superkey of Slot's key, whose witness is the Slot's id). Its
 * login `desk` holds `claimer`, which holds Claim whole and claims slots, and `auditor`, which holds Slot whole and
 * writes nothing. A case stores distinct drawn ids, has claimer make a Slot's third Claim, then makes up to three
 * moves, each a change of identity or one made in a savepoint and rolled back to it, and COMMITs. The COMMIT is refused
 * with 23000 under the law's identity, and:
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
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { namedDetail } from "#compiler/ir/law.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import {
	capacity,
	key,
	login,
	on,
	relation,
	role,
	schema,
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

const Slot = relation("Slot", { id: uuid, code: pg.integer, lane: pg.integer }, ["id"])
const Claim = relation("Claim", { code: pg.integer, lane: pg.integer, who: uuid }, [
	"code",
	"lane",
	"who"
])

const slotClaims = capacity(on(Slot, "code", "lane"), {
	from: on(Claim, "code", "lane"),
	within: within(0n, 2n)
})
const Witnesses = schema("Witnesses", { Slot, Claim }, [key(on(Slot, "code")), slotClaims])
const claimer = role(Witnesses, "claimer", { Claim }, { write: ["Claim"] })
const auditor = role(Witnesses, "auditor", { Slot })
const desk = login(Witnesses, "desk", [claimer, auditor])

type RoleName = "claimer" | "auditor"
type RelationName = "Slot" | "Claim"

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

/** The facts the writer's breach meets, every id distinct: the Slot it fills, its two Claims, the third, and others. */
interface Breach {
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
	| "shown to a holder"
	| "withheld"
	| "judged as the login"
	| "judged as another role of the login"
	| "a move undone"

const roleNames: Arr.NonEmptyReadonlyArray<RoleName> = ["claimer", "auditor"]

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

const breachGen: Gen<Breach> = (source) => {
	const ids = source.draw(uniqueArray(uuidGen(7), (id) => id, { min: 6, max: 6 }, 10))
	const others = source.draw(int(0, 2))
	const id = (i: number): string => Str.toLowerCase(elementAt(ids, i, "the case's ids"))
	return {
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
	breach: { slot: idOf(1), held: [idOf(2), idOf(3)], claim: idOf(4), others: [] },
	moves
})

/** The role the breach's write needs. */
const writer: RoleName = "claimer"

/** The relation whose fact the law names as its witness. */
const witnessRelation: RelationName = "Slot"

/** The relations a role holds whole. */
const heldBy = (acting: Acting): ReadonlyArray<RelationName> => {
	if (acting.kind === "login") {
		return []
	}
	switch (acting.role) {
		case "claimer":
			return ["Claim"]
		case "auditor":
			return ["Slot"]
	}
}

const turned = (turn: RoleTurn): Acting =>
	turn.kind === "set-role" ? { kind: "role", role: turn.role } : { kind: "login" }

/** Who the transaction acts as after its moves, from its writer. */
const actingAfter = (c: WitnessCase): Acting => {
	const start: Acting = { kind: "role", role: writer }
	return Arr.reduce(c.moves, start, (acting: Acting, move: Move): Acting => {
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
	switch (relation) {
		case "Slot":
			return [breach.slot, ...breach.others]
		case "Claim":
			return breach.held
	}
}

const relationNames: ReadonlyArray<RelationName> = ["Slot", "Claim"]

/** The ids of facts outside the world of whoever acts, less those its own write was given. */
const hiddenIds = (breach: Breach, acting: Acting): ReadonlyArray<string> => {
	const held = heldBy(acting)
	const shown = Arr.flatMap(held, (r) => idsIn(breach, r))
	const outside = Arr.flatMap(
		Arr.filter(relationNames, (r) => !held.includes(r)),
		(r: RelationName) => idsIn(breach, r)
	)
	return Arr.dedupe(Arr.filter(outside, (id) => !shown.includes(id) && id !== breach.claim))
}

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
							quoteIdent(f.installed.world(r === "claimer" ? claimer : auditor).role)
						const law = lawIdOf(Witnesses, slotClaims)
						const residual = defined(
							Option.getOrUndefined(
								Arr.findFirst(f.installed.installation.laws.residuals, (r) => r.lawId === law)
							),
							`the residual law ${law}`
						)
						const codec = namedDetail(residual.detail)
						const factsOf = (breach: Breach) => [
							...Arr.map([breach.slot, ...breach.others], (slot, i) => ({
								sql: `INSERT INTO ${names.table(Slot)} (${names.column(Slot, "id")}, ${names.column(Slot, "code")}, ${names.column(Slot, "lane")}) VALUES ($1::uuid, $2::integer, 1)`,
								params: [slot, i + 1]
							})),
							...Arr.map(breach.held, (who) => ({
								sql: `INSERT INTO ${names.table(Claim)} (${names.column(Claim, "code")}, ${names.column(Claim, "lane")}, ${names.column(Claim, "who")}) VALUES (1, 1, $1::uuid)`,
								params: [who]
							}))
						]
						const writeOf = (breach: Breach): string =>
							`INSERT INTO ${names.table(Claim)} (${names.column(Claim, "code")}, ${names.column(Claim, "lane")}, ${names.column(Claim, "who")}) VALUES (1, 1, '${breach.claim}'::uuid)`
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
						const w = yield* f.psql(claimer)
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
										reaches: ["withheld", "judged as the login"]
									},
									{
										note: "SET SESSION AUTHORIZATION DEFAULT reads as role none too",
										sketch: claimed([{ kind: "session-authorization-default" }]),
										draws: "",
										reaches: ["withheld", "judged as the login"]
									},
									{
										note: "another role of the login that holds the witness relation whole",
										sketch: claimed([
											{ kind: "turn", turn: { kind: "set-role", role: "auditor" } }
										]),
										draws: "",
										reaches: ["shown to a holder", "judged as another role of the login"]
									},
									{
										note: "a holder's role rolled back to its savepoint, then the holder's role taken on",
										sketch: claimed([
											{ kind: "undone", turn: { kind: "set-role", role: "auditor" } },
											{ kind: "turn", turn: { kind: "set-role", role: "auditor" } }
										]),
										draws: "",
										reaches: ["shown to a holder", "a move undone"]
									}
								],
								runs: 60,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang,
								coverage: required<WitnessFeature>(
									[
										"shown to a holder",
										"withheld",
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
									assert.equal(refused.code, sqlstates.integrityConstraintViolation)
									assert.ok(refused.constraint === law, `refused by ${String(refused.constraint)}`)
									const detail = defined(Option.getOrUndefined(refused.detail), "a DETAIL")
									const holds = heldBy(acting).includes(witnessRelation)
									assert.equal(withholds(codec, detail), !holds, detail)
									if (holds) {
										assert.deepEqual(strictDetail(codec, detail), [c.breach.slot])
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
									cx.note(holds ? "shown to a holder" : "withheld")
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
