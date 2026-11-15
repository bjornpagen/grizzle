import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { boundedShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	key,
	on,
	type Relation,
	relation,
	schema,
	type Statement
} from "#compiler/public/schema.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, deepEquals, defined, nonEmpty } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyArgumentsOf } from "#test/support/list.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A generated addition into a relation of several plain keys answers alike under every renaming of its fields, on
 * PostgreSQL 19rc2: no outcome depends on a key's name (write/insert/unique.ts generatedArbiter).
 *
 * A case draws a shape, R(id, p, q, r, note), whose `id` PostgreSQL draws by its `uuidv7()` default and whose other
 * fields are integers, keyed by plain keys over p, q and r: its primary key the drawn id, beside one to three keys, or
 * a plain key, beside none or one more; the facts a first call stores, lawful at every key; one request, a fact that
 * leaves the id out; and three renamings, each naming p, q, r and note anew from one pool, so the keys' laws sort in
 * another order under each. The schema holds the shape once under each renaming, T0, T1 and T2, installed together, and
 * each copy's generated insert is loaded and called alone: the first call stores the facts, the second states the
 * request.
 *
 * Property: every copy answers the same, read through its renaming back to the shape's roles: the load's refusal, or the
 * request's outcome, a refusal's laws by the keys they are (the primary key or a key by its roles) and its witness by
 * role, and the copy's rows by role but the drawn id. And that answer is the README's rule (Writes, serial columns): the
 * insert arbitrates at the primary key where it holds no drawn field, else at the one declared key, and a primary key
 * holding the drawn id beside several keys is refused when the insert loads (MalformedDescription), since only the
 * keys' names would rank them; at the arbiter an exact repeat of a stored fact at every field it states is `unchanged`,
 * and a stored fact at the request's arbiter key that differs elsewhere is the arbiter's law, its witness the request's
 * values there, whatever other key the request meets; a stored fact at the key beside the arbiter alone is that key's
 * law, its witness the request's values there; any other request is `accepted` and stored.
 *
 * Shapes draw at most one key beside a plain primary key. A request that conflicts at two keys beside its arbiter is
 * refused by one law, whose choice no declaration ranks and every single-law refusal makes by the keys' canonical
 * order, an order of names, for complete facts as well (write/insert/unique.ts probeOrder); the outcome that names
 * every such key is the probe's to report, not the arbiter's to choose.
 *
 * Oracle: the rule above, a model over the shape's roles (`expected`), and the copies held to each other. Features:
 * each way the request answers, the refused load where the keys' order differs between two renamings, and a request
 * meeting stored facts at its arbiter and at the key beside it at once.
 *
 * @plant test/plants/pg/write/renamed-keys/generated-arbiter-first-by-name.patch A generated addition whose primary key
 * holds the drawn id beside several keys arbitrates at the first of them in law order, as it did before
 * (write/insert/unique.ts generatedArbiter), so its load is never refused and a request meeting two of them is refused
 * by whichever key's name sorts first under each renaming; the property fails.
 */

/** A plain field of the shape by its role, keyed in turn. */
const plainRoles = ["p", "q", "r"] as const
type PlainRole = (typeof plainRoles)[number]

/** Every field the request states, by role: the plain fields and the payload `note`. */
const statedRoles = [...plainRoles, "note"] as const
type StatedRole = (typeof statedRoles)[number]

/** A key by the roles of its fields, in key order. */
type KeyRoles = Arr.NonEmptyReadonlyArray<PlainRole>

/** A shape: its primary key, the drawn id or a key of plain fields, and its declared keys beside it. */
type Shape =
	| { readonly primary: "drawn"; readonly keys: Arr.NonEmptyReadonlyArray<KeyRoles> }
	| { readonly primary: KeyRoles; readonly keys: ReadonlyArray<KeyRoles> }

/** The shapes a case draws among: disjoint keys over p, q and r, at most one beside a plain primary key. */
const shapes: Arr.NonEmptyReadonlyArray<Shape> = [
	{ primary: "drawn", keys: [["p"]] },
	{ primary: "drawn", keys: [["p", "q"]] },
	{ primary: "drawn", keys: [["p"], ["q"]] },
	{ primary: "drawn", keys: [["p"], ["q"], ["r"]] },
	{ primary: "drawn", keys: [["p", "q"], ["r"]] },
	{ primary: ["p"], keys: [] },
	{ primary: ["p"], keys: [["q"]] },
	{ primary: ["p", "q"], keys: [["r"]] },
	{ primary: ["p"], keys: [["q", "r"]] }
]

/** A fact as a call states it, by role: every field but the drawn id. */
type Fact = { readonly [R in StatedRole]: number }

/** A renaming: each stated role's name, distinct, none of them `id`. */
type Renaming = { readonly [R in StatedRole]: string }

/** The names a renaming draws from: more than the roles, so each renaming orders the keys anew. */
const namePool = ["a", "b", "c", "d", "e", "f", "g"] as const

/** A case: its shape, the facts the first call stores, the request, and the three renamings. */
interface RenamedCase {
	readonly shape: Shape
	readonly stored: ReadonlyArray<Fact>
	readonly request: Fact
	readonly renamings: readonly [Renaming, Renaming, Renaming]
}

/** A key's label by its roles, the same under every renaming. */
const keyLabel = (roles: KeyRoles): string => `key ${Arr.join(roles, ", ")}`

/** The primary key's label. */
const primaryLabel = "primary key"

/** The values of `f` at `roles`. */
const at = (f: Fact, roles: ReadonlyArray<StatedRole>): ReadonlyArray<number> =>
	Arr.map(roles, (role) => f[role])

/** Whether `a` and `b` agree at every role of `roles`. */
const agree = (a: Fact, b: Fact, roles: ReadonlyArray<StatedRole>): boolean =>
	Arr.every(roles, (role) => a[role] === b[role])

/** Every key of `shape` a fact is held apart at: its plain primary key, then its declared keys. */
const keysOf = (shape: Shape): ReadonlyArray<KeyRoles> =>
	shape.primary === "drawn" ? shape.keys : [shape.primary, ...shape.keys]

/** A key's label in `shape`: its primary key's, or a declared key's by its roles. */
const labelOf = (shape: Shape, roles: KeyRoles): string =>
	shape.primary !== "drawn" && deepEquals(shape.primary, roles) ? primaryLabel : keyLabel(roles)

/**
 * Where the generated addition meets stored facts (README, Writes, serial columns): its arbiter and the keys beside it
 * it probes, or a load refused, its primary key holding the drawn id beside several keys.
 */
type Arbitration =
	| {
			readonly kind: "arbiter"
			readonly arbiter: KeyRoles
			readonly beside: ReadonlyArray<KeyRoles>
	  }
	| { readonly kind: "refused" }

const arbitrationOf = (shape: Shape): Arbitration => {
	if (shape.primary !== "drawn") {
		return { kind: "arbiter", arbiter: shape.primary, beside: shape.keys }
	}
	const [only, ...more] = shape.keys
	return Arr.isReadonlyArrayNonEmpty(more)
		? { kind: "refused" }
		: { kind: "arbiter", arbiter: only, beside: [] }
}

/** A row by role, its drawn id left out: the stated fields' values. */
type RoleRow = ReadonlyArray<number>

/** What a copy answers, read back by role: its load refused, or its request's outcome and its rows after it. */
type Answer =
	| { readonly kind: "load refused" }
	| {
			readonly kind: "accepted" | "unchanged"
			readonly rows: ReadonlyArray<RoleRow>
	  }
	| {
			readonly kind: "refused"
			readonly laws: ReadonlyArray<string>
			readonly witness: Readonly<Record<string, number>> | "unreported"
			readonly rows: ReadonlyArray<RoleRow>
	  }

/** An answer, typed as one. */
const answer = (a: Answer): Answer => a

/** Rows in one order, so two answers compare as sets of rows. */
const sortedRows = (rows: ReadonlyArray<RoleRow>): ReadonlyArray<RoleRow> =>
	Arr.sort(rows, Arr.makeOrder(Order.Number))

/** The rows of `facts` by role. */
const rowsOf = (facts: ReadonlyArray<Fact>): ReadonlyArray<RoleRow> =>
	sortedRows(Arr.map(facts, (f) => at(f, statedRoles)))

/** The witness of a refusal at `roles`: the request's values there, by role. */
const witnessAt = (request: Fact, roles: KeyRoles): Readonly<Record<string, number>> =>
	Rec.fromEntries(Arr.map(roles, (role) => [role, request[role]] as const))

/** The rule's answer for `c` (see the header). */
const expected = (c: RenamedCase): Answer => {
	const arbitration = arbitrationOf(c.shape)
	if (arbitration.kind === "refused") {
		return { kind: "load refused" }
	}
	const stored = rowsOf(c.stored)
	if (Arr.some(c.stored, (s) => agree(s, c.request, statedRoles))) {
		return { kind: "unchanged", rows: stored }
	}
	const refusedAt = (roles: KeyRoles): Answer => ({
		kind: "refused",
		laws: [labelOf(c.shape, roles)],
		witness: witnessAt(c.request, roles),
		rows: stored
	})
	if (Arr.some(c.stored, (s) => agree(s, c.request, arbitration.arbiter))) {
		return refusedAt(arbitration.arbiter)
	}
	const beside = Arr.findFirst(arbitration.beside, (k) =>
		Arr.some(c.stored, (s) => agree(s, c.request, k))
	)
	return Option.match(beside, {
		onSome: refusedAt,
		onNone: (): Answer => ({ kind: "accepted", rows: rowsOf([...c.stored, c.request]) })
	})
}

/** What a case reached. */
const situations = [
	"the load refused, two renamings ordering the keys differently",
	"an exact repeat, unchanged",
	"refused at the arbiter",
	"refused at the arbiter, meeting the key beside it too",
	"refused at the key beside the arbiter",
	"accepted"
] as const
type Situation = (typeof situations)[number]

/** The key of `shape` whose law sorts first under `renaming`: the one whose field names sort first. */
const firstByName = (shape: Shape, renaming: Renaming): string => {
	const named = Arr.map(keysOf(shape), (k) => ({
		label: keyLabel(k),
		names: Arr.join(
			Arr.map(k, (role) => renaming[role]),
			","
		)
	}))
	return defined(
		Arr.sort(
			named,
			Order.mapInput(Order.String, (k: { readonly names: string }) => k.names)
		)[0],
		"a key"
	).label
}

/** The situations `c`, answered `answer`, reached. */
const situationsOf = (c: RenamedCase, answer: Answer): ReadonlyArray<Situation> => {
	switch (answer.kind) {
		case "load refused":
			return new Set(Arr.map(c.renamings, (r) => firstByName(c.shape, r))).size > 1
				? ["the load refused, two renamings ordering the keys differently"]
				: []
		case "unchanged":
			return ["an exact repeat, unchanged"]
		case "accepted":
			return ["accepted"]
		case "refused": {
			const arbitration = arbitrationOf(c.shape)
			if (arbitration.kind === "refused") {
				return []
			}
			const meets = (roles: KeyRoles) => Arr.some(c.stored, (s) => agree(s, c.request, roles))
			return meets(arbitration.arbiter)
				? Arr.some(arbitration.beside, meets)
					? ["refused at the arbiter, meeting the key beside it too"]
					: ["refused at the arbiter"]
				: ["refused at the key beside the arbiter"]
		}
	}
}

/** A value of a plain field or the note: few, so stored facts and the request meet at keys. */
const valueGen = int(1, 3)

const factGen: Gen<Fact> = (source) => ({
	p: source.draw(valueGen),
	q: source.draw(valueGen),
	r: source.draw(valueGen),
	note: source.draw(valueGen)
})

/** Up to three facts, each kept where it meets no fact kept before it at any key of `shape`: a lawful state. */
const storedGen =
	(shape: Shape): Gen<ReadonlyArray<Fact>> =>
	(source) => {
		const kept: Array<Fact> = []
		for (let i = source.draw(int(0, 3)); i > 0; i--) {
			const f = source.draw(factGen)
			if (!Arr.some(kept, (k) => Arr.some(keysOf(shape), (key) => agree(k, f, key)))) {
				kept.push(f)
			}
		}
		return kept
	}

/** A value no stored fact holds: past every value `valueGen` draws. */
const freshGen = int(4, 5)

/**
 * Where a request is aimed among the stored facts: at a stored fact whole (`repeat`); at one's arbiter key, apart
 * elsewhere (`arbiter`); at one's key beside the arbiter, apart at the arbiter (`beside`); at one's arbiter key and at
 * another's, or its own, key beside it (`both`); or each field a stored fact's value or a value of its own (`mixed`).
 */
const aims = ["repeat", "arbiter", "beside", "both", "mixed"] as const

/** The request of a case of `shape` over `stored`, aimed as drawn (`aims`). */
const requestGen =
	(shape: Shape, stored: ReadonlyArray<Fact>): Gen<Fact> =>
	(source) => {
		const storedFact = (): Fact | undefined =>
			Arr.isReadonlyArrayNonEmpty(stored)
				? stored[source.draw(int(0, stored.length - 1))]
				: undefined
		const fresh = (): Fact => ({
			p: source.draw(freshGen),
			q: source.draw(freshGen),
			r: source.draw(freshGen),
			note: source.draw(freshGen)
		})
		/** `base` with the values of `from` at `roles`. */
		const taking = (base: Fact, from: Fact, roles: ReadonlyArray<StatedRole>): Fact => ({
			p: roles.includes("p") ? from.p : base.p,
			q: roles.includes("q") ? from.q : base.q,
			r: roles.includes("r") ? from.r : base.r,
			note: roles.includes("note") ? from.note : base.note
		})
		const arbitration = arbitrationOf(shape)
		const arbiter = arbitration.kind === "arbiter" ? arbitration.arbiter : undefined
		const [beside] = arbitration.kind === "arbiter" ? arbitration.beside : []
		const s = storedFact()
		const aim = source.draw(element(aims))
		if (s === undefined || aim === "mixed" || arbiter === undefined) {
			const pick = (role: StatedRole): number => {
				const from = source.draw(int(0, 2)) > 0 ? storedFact() : undefined
				return from === undefined ? source.draw(valueGen) : from[role]
			}
			return { p: pick("p"), q: pick("q"), r: pick("r"), note: pick("note") }
		}
		switch (aim) {
			case "repeat":
				return s
			case "arbiter":
				return taking(fresh(), s, arbiter)
			case "beside":
				return beside === undefined ? taking(fresh(), s, arbiter) : taking(fresh(), s, beside)
			case "both": {
				const other = storedFact() ?? s
				const atArbiter = taking(fresh(), s, arbiter)
				return beside === undefined ? atArbiter : taking(atArbiter, other, beside)
			}
		}
	}

/** A renaming: four distinct names of the pool, one per stated role. */
const renamingGen: Gen<Renaming> = (source) => {
	const left: Array<string> = [...namePool]
	const take = (): string =>
		defined(left.splice(source.draw(int(0, left.length - 1)), 1)[0], "a name")
	return { p: take(), q: take(), r: take(), note: take() }
}

const caseGen: Gen<RenamedCase> = (source) => {
	const shape = source.draw(element(shapes))
	const stored = source.draw(storedGen(shape))
	return {
		shape,
		stored,
		request: source.draw(requestGen(shape, stored)),
		renamings: [source.draw(renamingGen), source.draw(renamingGen), source.draw(renamingGen)]
	}
}

/** A relation value of a copy, over any field names. */
type CopyValue = Relation<string, Record<string, FieldBase>, readonly [string, ...Array<string>]>

/** The copy of `shape` under `renaming`, named `name`: its relation and each declared key by its label. */
const copyOf = (shape: Shape, renaming: Renaming, name: string) => {
	const fields: Record<string, FieldBase> = { id: pg.uuidv7 }
	for (const role of statedRoles) {
		fields[renaming[role]] = pg.integer
	}
	const names = (roles: KeyRoles) => Arr.map(roles, (role) => renaming[role])
	const value: CopyValue = relation(
		name,
		fields,
		shape.primary === "drawn" ? ["id"] : nonEmpty(names(shape.primary), "the primary key")
	)
	const keys = Arr.map(
		shape.keys,
		(k) => [keyLabel(k), key(on(value, ...nonEmptyArgumentsOf(names(k))))] as const
	)
	return { name, renaming, value, keys }
}

/** The facts `facts` under `renaming`, as a call states them. */
const statedUnder = (facts: ReadonlyArray<Fact>, renaming: Renaming) =>
	Arr.map(facts, (f) =>
		Rec.fromEntries(Arr.map(statedRoles, (role) => [renaming[role], f[role]] as const))
	)

/** Copies of the case, one per renaming. */
const copiesOf = (c: RenamedCase) =>
	Arr.map(c.renamings, (renaming, i) => copyOf(c.shape, renaming, `T${i}`))

const situationList = nonEmpty([...situations], "the situations")

layer(Substrate.layer, { excludeTestServices: true })(
	"a generated addition into a relation of several plain keys",
	(it) => {
		it.effect(
			"answers alike under every renaming of its fields, as the README's rule says",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/write/renamed-keys",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Situation>(situationList, { cases: 64, sense: notesOnly }),
							kept: [
								{
									note: "a drawn primary key beside the keys p and q, whose names sort p first under one renaming and q first under another, the request at one stored fact's p and another's q: the load is refused under each, where arbitrating at the key whose name sorts first would refuse the request by p's law under one renaming and by q's under the other",
									sketch: {
										shape: { primary: "drawn", keys: [["p"], ["q"]] },
										stored: [
											{ p: 1, q: 1, r: 1, note: 1 },
											{ p: 2, q: 2, r: 2, note: 2 }
										],
										request: { p: 1, q: 2, r: 3, note: 3 },
										renamings: [
											{ p: "a", q: "b", r: "c", note: "d" },
											{ p: "b", q: "a", r: "c", note: "d" },
											{ p: "a", q: "b", r: "c", note: "d" }
										]
									},
									draws: "",
									reaches: ["the load refused, two renamings ordering the keys differently"]
								},
								{
									note: "a plain primary key p beside the key q, the request at a stored fact's p and another's q: the primary key's law, under every renaming",
									sketch: {
										shape: { primary: ["p"], keys: [["q"]] },
										stored: [
											{ p: 1, q: 1, r: 1, note: 1 },
											{ p: 2, q: 2, r: 2, note: 2 }
										],
										request: { p: 1, q: 2, r: 3, note: 3 },
										renamings: [
											{ p: "a", q: "b", r: "c", note: "d" },
											{ p: "b", q: "a", r: "c", note: "d" },
											{ p: "g", q: "a", r: "b", note: "c" }
										]
									},
									draws: "",
									reaches: ["refused at the arbiter, meeting the key beside it too"]
								},
								{
									note: "the same shape, the request at a stored fact's q alone, an exact repeat, and a fresh fact",
									sketch: {
										shape: { primary: ["p"], keys: [["q"]] },
										stored: [{ p: 1, q: 1, r: 1, note: 1 }],
										request: { p: 2, q: 1, r: 1, note: 1 },
										renamings: [
											{ p: "a", q: "b", r: "c", note: "d" },
											{ p: "b", q: "a", r: "c", note: "d" },
											{ p: "g", q: "a", r: "b", note: "c" }
										]
									},
									draws: "",
									reaches: ["refused at the key beside the arbiter"]
								}
							],
							runs: 16,
							shrink: boundedShrink(40),
							concurrency: 1,
							steerEvery: 8,
							caseHang,
							oracle: {
								kind: "specification",
								name: "the README's arbiter rule over the shape's roles (expected), and every renamed copy answering alike"
							}
						},
						(c, note: Case<Situation>) =>
							Effect.gen(function* () {
								const copies = copiesOf(c)
								const statements: ReadonlyArray<Statement> = Arr.flatMap(copies, (copy) =>
									Arr.map(copy.keys, ([, statement]) => statement)
								)
								const schemaNamed = (name: string) =>
									schema(
										name,
										Arr.map(copies, (copy) => copy.value),
										statements
									)
								const declared = schemaNamed("Renamed")
								const done = yield* installMigrated(declared, {
									ambient: ordinarySession,
									label: "renamed",
									logins: [fullWorld(declared, {}).server],
									extensions: []
								})
								const value = schemaNamed(done.schema)
								const world = fullWorld(value, {})
								const names = namesOf(done)
								const lawNames = lawNamesOf(value)
								const label = Formatter.format(c)
								const answers = yield* Effect.gen(function* () {
									const db = yield* openServedDb(done, world.server.roles.app, {})
									const flight = yield* oneFlight(db.ctx, done.as(world.server))
									const answerOf = (copy: (typeof copies)[number]) =>
										Effect.gen(function* () {
											const loaded = yield* Effect.result(
												db.load({ insert: ChangeSet.empty(value).insert(copy.value, []) })
											)
											if (Result.isFailure(loaded)) {
												const refusal = loaded.failure
												const reason =
													"place" in refusal && refusal.error._tag === "CompileError"
														? refusal.error.reason
														: undefined
												if (reason?._tag !== "MalformedDescription") {
													return assert.fail(
														`${label}: ${copy.name}'s insert refused by ${Formatter.format(refusal)}, not its arbiter's rule`
													)
												}
												assert.ok(
													Str.includes(`a generated addition into ${copy.name}`)(reason.what),
													`${label}: ${copy.name}'s load refusal names its generated addition: ${reason.what}`
												)
												return answer({ kind: "load refused" })
											}
											const call = (facts: ReadonlyArray<Fact>) =>
												answered(
													writeOnce(memberCalls(flight.context, member(loaded.success, "insert")))({
														params: {},
														facts: { insert: { [copy.name]: statedUnder(facts, copy.renaming) } }
													})
												)
											const first = yield* flight.judged(
												`${copy.name}'s stored facts`,
												call(c.stored)
											)
											assert.equal(
												first.kind,
												Arr.isReadonlyArrayNonEmpty(c.stored) ? "accepted" : "unchanged",
												`${label}: ${copy.name} stores its lawful facts`
											)
											const outcome = yield* flight.judged(
												`${copy.name}'s request`,
												call([c.request])
											)
											const stored = yield* tableState(done, copy.value)
											const rows = sortedRows(
												Arr.map(stored, (row) =>
													Arr.map(statedRoles, (role) => {
														const cell = row[copy.renaming[role]]
														return typeof cell === "number" ? cell : Number.NaN
													})
												)
											)
											const lawLabels: ReadonlyArray<readonly [LawId, string]> = [
												[lawNames.primaryKeyLaw({ name: copy.name }), primaryLabel],
												...Arr.map(
													copy.keys,
													([k, statement]) => [lawNames.lawOf(statement), k] as const
												)
											]
											const roleOf = Rec.fromEntries(
												Arr.map(statedRoles, (role) => [copy.renaming[role], role] as const)
											)
											switch (outcome.kind) {
												case "accepted":
												case "unchanged":
													return answer({ kind: outcome.kind, rows })
												case "refused": {
													const laws = Arr.map(outcome.refused.laws, (l) => {
														const id = names.reported(l)
														return defined(
															Option.getOrUndefined(
																Arr.findFirst(lawLabels, ([law]) => law === id)
															)?.[1],
															`${label}: ${copy.name}'s law ${id}`
														)
													})
													const witness = outcome.witness
													return answer({
														kind: "refused",
														laws,
														witness:
															witness.kind === "unreported"
																? "unreported"
																: Rec.fromEntries(
																		Arr.map(Rec.toEntries(witness.values), ([field, v]) => [
																			defined(
																				roleOf[field],
																				`${label}: the witness field ${field}`
																			),
																			typeof v === "number" ? v : Number.NaN
																		])
																	),
														rows
													})
												}
												case "outsideWorld":
												case "refreshed":
													return assert.fail(
														`${label}: ${copy.name}'s request answered ${outcome.kind}, which no insert of its world answers`
													)
											}
										})
									return yield* Effect.forEach(copies, answerOf)
								}).pipe(Effect.scoped)
								const [first, ...rest] = answers
								for (const [i, other] of rest.entries()) {
									assert.ok(
										deepEquals(other, first),
										`${label}: T${i + 1} answers ${Formatter.format(other)}, T0 ${Formatter.format(first)}: an outcome that depends on a key's name`
									)
								}
								const want = expected(c)
								assert.ok(
									deepEquals(first, want),
									`${label}: every copy answers ${Formatter.format(first)}, the rule ${Formatter.format(want)}`
								)
								note.noteAll(situationsOf(c, want))
							}).pipe(Effect.scoped)
					)
				)
		)
	}
)
