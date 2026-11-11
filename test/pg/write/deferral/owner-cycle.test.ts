import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, Record as Rec, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
import { check, type RowScalars, schema, type Statement } from "#compiler/public/schema.ts"
import { relation } from "#compiler/schema/relation.ts"
import {
	containedBuilder,
	countedBuilder,
	finBuilder,
	keyBuilder,
	mutableBuilder,
	onBuilder,
	orderedBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation, Relation } from "#compiler/types/schema/relation.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawIdOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A law's foreign key that closes a cycle with a family's owner axis is deferred, and a stratum's plain and family
 * statements run in one order every immediate foreign key between them keeps, so every lawful write is ordered and
 * accepted, and every unlawful one is refused naming a law it breaks.
 *
 * A family's owner axis references the owner from its members. A law that references a member from its owner, a
 * containment from the owner (or a selection of it) into the members (or into a key over a selection of them), or a
 * mirror of the two, closes a cycle of foreign keys with it: no order of an owner's insert and its members' inserts
 * keeps both at every statement, so grizzle defers every key on the cycle (laws/model/model.ts). The family is counted
 * or ordered; its members keyed by their own id or, counted, by their owner; and the owner's side every owner, those
 * with exactly one member, or those flagged, with or without a check that a member-less owner holds x = 0.
 *
 * A counted family's members keyed by their owner may hold their owner and x alone, so a foreign key into them naming
 * both is immediate; and a plain relation R, no family's, may hold facts each contained in a member at its (o, x), an
 * immediate key from a relation the stratum's own statements write into one its family statements write.
 *
 * Each case installs such a schema and writes drawn owners with their members and R's facts, in one ChangeSet (counted
 * members by their group key, ordered ones nested), or the owners first and the rest after, in a second (counted
 * members inserted, ordered ones put at the end of their owner's family); then deletes every owner, member and fact of
 * R in one more. Each ChangeSet is a member of the full role's served workload, its facts each call's. The oracle is a
 * model of the laws over the facts written: a lawful write is accepted, and an unlawful one is refused with a law the
 * model finds broken. A stratum whose plain statements all ran before its family statements would refuse at the server
 * an insert of R beside the members it names, and a deletion of owners beside their members.
 *
 * The downstream case (a counted family, its members keyed by their owner, the owners with one member contained in the
 * members, and an owner's check) is the kept case.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/owner-cycle-axis-out-of-cycle-graph.patch, the owner axis left out of the
 * deferral's cycle graph, refuses the lawful kept case at the server and must turn the property red.
 */

type FamilyKind = "counted" | "ordered"
type LawKind = "contained" | "mirrors" | "into a selected key"
type OwnerSide = "every owner" | "owners with one member" | "flagged owners"

interface Spec {
	readonly family: FamilyKind
	readonly law: LawKind
	readonly owners: OwnerSide
	/** Whether a counted family's members are keyed by their owner, so each owner has at most one. */
	readonly byOwner: boolean
	/** Whether each owner holds x = 0 unless it has exactly one member. */
	readonly checked: boolean
	/**
	 * Whether a counted family's members keyed by their owner hold their owner and x alone, so a foreign key into them
	 * that names both is immediate, its target a pure set of what it names.
	 */
	readonly bare: boolean
	/** Whether a plain relation R, no family's, holds facts each contained in a member at its (o, x), where the law
	 * reaches into a key over the flagged members, a flagged one. */
	readonly referrer: boolean
}

interface OwnerRow {
	readonly id: number
	readonly x: bigint
	readonly flag: boolean
}

interface MemberRow {
	readonly id: number
	readonly owner: number
	readonly x: bigint
	readonly flag: boolean
}

/** A fact of the plain relation R: its id, and the member's owner and x it names. */
interface ReferrerRow {
	readonly id: number
	readonly owner: number
	readonly x: bigint
}

interface Case {
	readonly spec: Spec
	readonly owners: ReadonlyArray<OwnerRow>
	readonly members: ReadonlyArray<MemberRow>
	readonly referrers: ReadonlyArray<ReferrerRow>
	/** Whether the owners are written first and their members in a second ChangeSet. */
	readonly separately: boolean
}

const specGen: Gen<Spec> = (source) => {
	const family = source.draw(element(["counted", "ordered"] as const))
	const law = source.draw(element(["contained", "mirrors", "into a selected key"] as const))
	const byOwner = family === "counted" && source.draw(boolean)
	return {
		family,
		law,
		owners: source.draw(
			element(["every owner", "owners with one member", "flagged owners"] as const)
		),
		byOwner,
		checked: source.draw(boolean),
		bare: byOwner && law !== "into a selected key" && source.draw(boolean),
		referrer: source.draw(boolean)
	}
}

/**
 * A case: a spec, its owners, and their members, drawn freely or, on the arm that every law holds on, one flagged
 * member per flagged owner at its owner's x, which every spec's laws admit.
 */
const caseGen: Gen<Case> = (source) => {
	const spec = source.draw(specGen)
	const lawful = source.draw(boolean)
	const owners = upTo(source.draw(int(1, 2)), (i) => ({
		id: i + 1,
		x: BigInt(source.draw(int(0, 1))),
		flag: lawful || source.draw(boolean)
	}))
	const referrersOf = (members: ReadonlyArray<MemberRow>): ReadonlyArray<ReferrerRow> =>
		spec.referrer ? Arr.map(members, (m, i) => ({ id: 20 + i, owner: m.owner, x: m.x })) : []
	if (lawful) {
		const members = Arr.map(owners, (o, i) => ({ id: 10 + i, owner: o.id, x: o.x, flag: true }))
		return {
			spec,
			owners,
			members,
			referrers: referrersOf(members),
			separately: source.draw(boolean)
		}
	}
	const members: Array<MemberRow> = []
	for (const o of owners) {
		for (let k = source.draw(int(0, spec.byOwner ? 1 : 2)); k > 0; k -= 1) {
			members.push({
				id: 10 + members.length,
				owner: o.id,
				x: BigInt(source.draw(int(0, 1))),
				flag: source.draw(boolean)
			})
		}
	}
	const referrers = spec.referrer
		? upTo(source.draw(int(0, 2)), (i) => ({
				id: 20 + i,
				owner: source.draw(int(1, owners.length)),
				x: BigInt(source.draw(int(0, 1)))
			}))
		: []
	return { spec, owners, members, referrers, separately: source.draw(boolean) }
}

/** A relation built at run time, as a check over one types it. */
type BuiltRelation = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The row a predicate reads, as a check over a relation built at run time reads it. */
type Row = RowScalars<BuiltRelation>

const schemaOf = (
	declared: string,
	relations: Readonly<Record<string, AnyRelation>>,
	statements: ReadonlyArray<Statement>
) => schema(declared, relations, statements)

/** A spec's schema, under any declared name, with its relations and the statements its laws are. */
interface Built {
	readonly O: AnyRelation
	readonly M: AnyRelation
	readonly R: AnyRelation
	readonly family: Statement
	/** R's containment into the members, where the spec holds R. */
	readonly refers: Statement | undefined
	/** The containment from the owners' side into the members. */
	readonly law: Statement
	/** A mirror's containment back, from the members into the owners' side; none for any other law. */
	readonly back: Statement | undefined
	readonly key: Statement | undefined
	readonly check: Statement | undefined
	readonly statements: ReadonlyArray<Statement>
	readonly rename: (declared: string) => ReturnType<typeof schemaOf>
}

const buildOf = (spec: Spec): Built => {
	const O = relation(
		"O",
		{ id: uuid, x: pg.bigint, flag: pg.boolean, n: drawnField(natural) },
		["id"],
		[]
	)
	const M = relation(
		"M",
		{
			...(spec.bare ? {} : { id: uuid, flag: pg.boolean }),
			o: uuid,
			x: pg.bigint,
			...(spec.family === "ordered" ? { at: drawnField(natural) } : {})
		},
		[spec.byOwner ? "o" : "id"],
		[]
	)
	const R = relation("R", { id: uuid, o: uuid, x: pg.bigint }, ["id"], [])
	const slots = finBuilder(O, "n")
	const family =
		spec.family === "counted"
			? countedBuilder(onBuilder(M, ["o"]), slots)
			: orderedBuilder(onBuilder(M, ["o", "at"]), slots)
	const owners = (() => {
		switch (spec.owners) {
			case "every owner":
				return O
			case "owners with one member":
				return selectBuilder(O, (o: Row) => o.eq(defined(o["n"], "n"), 1n))
			case "flagged owners":
				return selectBuilder(O, (o: Row) => o.eq(defined(o["flag"], "flag"), true))
		}
	})()
	const target =
		spec.law === "into a selected key"
			? selectBuilder(M, (m: Row) => m.eq(defined(m["flag"], "flag"), true))
			: M
	const key =
		spec.byOwner && spec.law !== "into a selected key"
			? undefined
			: keyBuilder(onBuilder(target, ["o", "x"]))
	const law = containedBuilder(onBuilder(owners, ["id", "x"]), onBuilder(target, ["o", "x"]))
	const refers = spec.referrer
		? containedBuilder(onBuilder(R, ["o", "x"]), onBuilder(target, ["o", "x"]))
		: undefined
	const back =
		spec.law === "mirrors"
			? containedBuilder(onBuilder(M, ["o", "x"]), onBuilder(owners, ["id", "x"]))
			: undefined
	const checked = spec.checked
		? check("OneOrNone", O, (o) => o.or(o.eq(o.n, 1n), o.eq(o.x, 0n)))
		: undefined
	const statements: ReadonlyArray<Statement> = [
		family,
		law,
		...(back === undefined ? [] : [back]),
		...(key === undefined ? [] : [key]),
		...(checked === undefined ? [] : [checked]),
		...(refers === undefined ? [] : [refers]),
		mutableBuilder(O),
		mutableBuilder(M),
		...(spec.referrer ? [mutableBuilder(R)] : [])
	]
	return {
		O,
		M,
		R,
		family,
		refers,
		law,
		back,
		key,
		check: checked,
		statements,
		rename: (declared) => schemaOf(declared, spec.referrer ? { O, M, R } : { O, M }, statements)
	}
}

/** The laws a state of the spec breaks, by the statements that state them, none when it is lawful. */
const brokenBy = (
	spec: Spec,
	built: Built,
	owners: ReadonlyArray<OwnerRow>,
	members: ReadonlyArray<MemberRow>,
	referrers: ReadonlyArray<ReferrerRow>
): ReadonlyArray<Statement> => {
	const membersOf = (o: OwnerRow) => Arr.filter(members, (m) => m.owner === o.id)
	const selectedOwner = (o: OwnerRow): boolean => {
		switch (spec.owners) {
			case "every owner":
				return true
			case "owners with one member":
				return membersOf(o).length === 1
			case "flagged owners":
				return o.flag
		}
	}
	const inTarget = (m: MemberRow): boolean =>
		spec.law !== "into a selected key" || (m.flag && !spec.bare)
	const contained = Arr.every(Arr.filter(owners, selectedOwner), (o) =>
		Arr.some(membersOf(o), (m) => m.x === o.x && inTarget(m))
	)
	const mirrored =
		spec.law !== "mirrors" ||
		Arr.every(members, (m) =>
			Arr.some(owners, (o) => o.id === m.owner && o.x === m.x && selectedOwner(o))
		)
	const keyed = Arr.every(Arr.filter(members, inTarget), (m) =>
		Arr.every(
			Arr.filter(members, inTarget),
			(n) => n.id === m.id || n.owner !== m.owner || n.x !== m.x
		)
	)
	const byOwner = !spec.byOwner || Arr.every(owners, (o) => membersOf(o).length <= 1)
	const owned = Arr.every(members, (m) => Arr.some(owners, (o) => o.id === m.owner))
	const checkHolds =
		!spec.checked || Arr.every(owners, (o) => membersOf(o).length === 1 || o.x === 0n)
	const referred = Arr.every(referrers, (r) =>
		Arr.some(members, (m) => m.owner === r.owner && m.x === r.x && inTarget(m))
	)
	return [
		...(referred || built.refers === undefined ? [] : [built.refers]),
		...(contained ? [] : [built.law]),
		...(mirrored || built.back === undefined ? [] : [built.back]),
		...(keyed || built.key === undefined ? [] : [built.key]),
		...(owned && byOwner ? [] : [built.family]),
		...(checkHolds || built.check === undefined ? [] : [built.check])
	]
}

/** The uuid a row's id is written as. */
const uuidOf = (id: number): string =>
	`00000000-0000-4000-8000-${pipe(id.toString(16), Str.padStart(12, "0"))}`

type Situation =
	| `${FamilyKind}: a lawful write accepted`
	| `${LawKind}: a lawful write accepted`
	| `${OwnerSide}: a lawful write accepted`
	| "an unlawful write refused with a law it breaks"
	| "owners and members written separately"
	| "owners, members and referrers deleted together"
	| "a plain relation keyed into members written beside them"

const situations: Arr.NonEmptyReadonlyArray<Situation> = [
	"counted: a lawful write accepted",
	"ordered: a lawful write accepted",
	"contained: a lawful write accepted",
	"mirrors: a lawful write accepted",
	"into a selected key: a lawful write accepted",
	"every owner: a lawful write accepted",
	"owners with one member: a lawful write accepted",
	"flagged owners: a lawful write accepted",
	"an unlawful write refused with a law it breaks",
	"owners and members written separately",
	"owners, members and referrers deleted together",
	"a plain relation keyed into members written beside them"
]

layer(Substrate.layer, { excludeTestServices: true })(
	"a law's key on a cycle with a family's owner axis",
	(it) => {
		it.effect(
			"is deferred, so every lawful write of owners and members is accepted and every other refused by its law",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/write/deferral/owner-cycle",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Situation>(situations, { cases: 60, sense: notesOnly }),
							kept: [
								{
									note: "downstream: a counted family keyed by its owner, the owners with one member contained in their members, and an owner's check",
									sketch: {
										spec: {
											family: "counted",
											law: "contained",
											owners: "owners with one member",
											byOwner: true,
											checked: true,
											bare: true,
											referrer: false
										},
										owners: [{ id: 1, x: 1n, flag: false }],
										members: [{ id: 10, owner: 1, x: 1n, flag: false }],
										referrers: [],
										separately: false
									},
									draws: "",
									reaches: [
										"counted: a lawful write accepted",
										"owners with one member: a lawful write accepted"
									]
								},
								{
									note: "found: an owner inserted with no member its mirror names, once an UnorderableStratum: the members' additions followed the owner's insert to recount it, and the owner's insert followed the additions by its law's immediate key",
									sketch: {
										spec: {
											family: "counted",
											law: "mirrors",
											owners: "every owner",
											byOwner: true,
											checked: false,
											bare: true,
											referrer: false
										},
										owners: [{ id: 1, x: 0n, flag: false }],
										members: [],
										referrers: [],
										separately: false
									},
									draws: "",
									reaches: ["an unlawful write refused with a law it breaks"]
								}
							],
							runs: 16,
							shrink: boundedShrink(40),
							concurrency: 1,
							steerEvery: 8,
							caseHang,
							oracle: {
								kind: "second-implementation",
								name: "the laws over the facts written, judged directly"
							}
						},
						(c, n) =>
							Effect.gen(function* () {
								const built = buildOf(c.spec)
								const declared = built.rename("Cycle")
								const done = yield* installMigrated(declared, {
									ambient: ordinarySession,
									label: "cycle",
									logins: [fullWorld(declared, {}).server],
									extensions: []
								})
								const value = built.rename(done.schema)
								const names = namesOf(done)
								const world = fullWorld(value, {})
								const lawOf = (s: Statement): LawId => lawIdOf(value, s)
								const ownerFact = (o: OwnerRow, nested: boolean) => ({
									id: uuidOf(o.id),
									x: o.x,
									flag: o.flag,
									...(c.spec.family === "ordered"
										? {
												n: nested
													? Arr.map(
															Arr.filter(c.members, (m) => m.owner === o.id),
															(m) => ({ id: uuidOf(m.id), x: m.x, flag: m.flag })
														)
													: []
											}
										: {})
								})
								const memberFact = (m: MemberRow) =>
									c.spec.bare
										? { o: uuidOf(m.owner), x: m.x }
										: { id: uuidOf(m.id), o: uuidOf(m.owner), x: m.x, flag: m.flag }
								const referrerFact = (r: ReferrerRow) => ({
									id: uuidOf(r.id),
									o: uuidOf(r.owner),
									x: r.x
								})
								const withReferrers = (changes: ReturnType<typeof ChangeSet.empty>) =>
									c.spec.referrer ? changes.insert(built.R, []) : changes
								/** R's facts under its relation where the spec holds R, none otherwise. */
								const referred = c.spec.referrer ? { R: Arr.map(c.referrers, referrerFact) } : {}
								const owners = (nested: boolean) => Arr.map(c.owners, (o) => ownerFact(o, nested))
								const members = Arr.map(c.members, memberFact)
								const everything = {
									owners: c.owners,
									members: c.members,
									referrers: c.referrers
								}
								/** Each step: the ChangeSet, its call's facts, and the state it leaves where it is lawful. */
								const steps = [
									...(c.separately
										? [
												{
													state: { owners: c.owners, members: [], referrers: [] },
													changes: ChangeSet.empty(value).insert(built.O, []),
													facts: { insert: { O: owners(false) } }
												},
												{
													state: everything,
													changes: withReferrers(
														c.spec.family === "counted"
															? ChangeSet.empty(value).insert(built.M, [])
															: ChangeSet.empty(value).put(built.M, [])
													),
													facts:
														c.spec.family === "counted"
															? { insert: { M: members, ...referred } }
															: {
																	put: { M: members },
																	...(c.spec.referrer ? { insert: referred } : {})
																}
												}
											]
										: [
												{
													state: everything,
													changes: withReferrers(
														c.spec.family === "counted"
															? ChangeSet.empty(value).insert(built.O, []).insert(built.M, [])
															: ChangeSet.empty(value).insert(built.O, [])
													),
													facts: {
														insert:
															c.spec.family === "counted"
																? { O: owners(false), M: members, ...referred }
																: { O: owners(true), ...referred }
													}
												}
											]),
									{
										state: { owners: [], members: [], referrers: [] },
										changes: (() => {
											const deleted = ChangeSet.empty(value).delete(built.O, []).delete(built.M, [])
											return c.spec.referrer ? deleted.delete(built.R, []) : deleted
										})(),
										facts: {
											delete: {
												O: Arr.map(c.owners, (o) => ({ id: uuidOf(o.id), x: o.x, flag: o.flag })),
												M: members,
												...referred
											}
										}
									}
								]
								/** Each step's ChangeSet, a member of the full role's workload under its index. */
								const workload = Rec.fromEntries(
									Arr.map(steps, (step, i): readonly [string, unknown] => [
										`step${String(i)}`,
										step.changes
									])
								)
								yield* withServedDb(done, world.server.roles.app, {}, ({ serve }) =>
									Effect.gen(function* () {
										const served = yield* serve(workload)
										let stored: ReadonlyArray<OwnerRow> = []
										let size = 0
										for (const [i, step] of steps.entries()) {
											const broken = brokenBy(
												c.spec,
												built,
												step.state.owners,
												step.state.members,
												step.state.referrers
											)
											const ops = member(served, `step${String(i)}`)
											const outcome = yield* ops.kind === "facts"
												? ops.ops.apply(step.facts, {})
												: ops.ops.apply({})
											const label = `${Formatter.format(c)}, step ${String(i)}`
											if (Arr.isReadonlyArrayNonEmpty(broken)) {
												assert.equal(outcome.kind, "invariant-rejected", label)
												if (outcome.kind === "invariant-rejected") {
													const laws = Arr.map(broken, lawOf)
													assert.ok(
														Arr.some(outcome.refused.laws, (law) =>
															laws.includes(names.reported(law))
														),
														`${label}: refused by ${Formatter.format(refusedLaws(outcome.refused))}, a law the model finds broken`
													)
												}
												n.note("an unlawful write refused with a law it breaks")
												return
											}
											const next =
												step.state.owners.length +
												step.state.members.length +
												step.state.referrers.length
											assert.equal(
												outcome.kind,
												step.state.owners === stored && next === size ? "no-change" : "accepted",
												label
											)
											stored = step.state.owners
											size = next
										}
										n.note("owners, members and referrers deleted together")
										if (c.spec.referrer && Arr.isReadonlyArrayNonEmpty(c.referrers)) {
											n.note("a plain relation keyed into members written beside them")
										}
										n.noteAll([
											`${c.spec.family}: a lawful write accepted`,
											`${c.spec.law}: a lawful write accepted`,
											`${c.spec.owners}: a lawful write accepted`
										])
										if (c.separately) {
											n.note("owners and members written separately")
										}
									})
								).pipe(Effect.scoped)
							}).pipe(Effect.scoped)
					)
				)
		)
	}
)
