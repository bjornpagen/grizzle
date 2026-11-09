/**
 * Write races: grizzle ChangeSets and direct SQL writers, all SERIALIZABLE, in orders the one concurrency driver
 * chooses, each run judged by the serial model.
 *
 * Property: every run is serializable as the model means it. Some order of the committed operations, with every
 * refusal at a place among them, respecting real time, explains each outcome, each row count, each refusal's law or
 * SQLSTATE and the committed state; every abort is 40001, 40P01 or a TransientFailure reason the write's shape allows,
 * beside a concurrent operation; and every generated serial value lies past the explicit values earlier writes stored.
 *
 * A case installs the schedule schema, opens two grizzle writers and two direct sessions, and runs one
 * race: a lawful initial state and two or three sessions, each a grizzle writer's one or two ChangeSets (each its own
 * transaction, which the caller calls again after each TransientFailure until it answers, as an application does) or a
 * direct writer's one transaction of one or two statements. A race of few moves runs in every order (partial-order reduced); a larger one
 * under a drawn PCT schedule. Which deadlock victim PostgreSQL picks is nature's branch, judged like any run.
 *
 * The races are drawn over small domains, so keys, candidate keys, serial values and spans meet, or planted from the
 * dictionary of shapes (PlantedRace): an insert in flight at the key, a deletion before a put of the
 * fact, an anchor replaced by DELETE and INSERT beside a reference to it, a candidate key raced beside the arbiter
 * (UnseenOccupant), a direct writer's deletion and insert beside a concurrent occupant of the key it inserts (a 23505
 * its snapshot cannot explain), two puts of one key, an exact repeat beside a deletion of it, generated serial values
 * beside explicit ones (GeneratedSerialUnique), a generated addition beside a deletion of its label's concurrent
 * occupant (UnseenOccupant), a span put overlapping another key, and an update beside a put in place (each in-place
 * target).
 *
 * Features: each put target and pair reason the compiler chose (PutChoice), each answer, each
 * TransientFailure reason met, each direct SQLSTATE, waits, deadlocks, nature's branches, a write held between its
 * strata by a blocker, generated and explicit serials, and each planted shape.
 */

import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	shuffled,
	subarray,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { pctSchedule } from "@grizzle/testing/interleave"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Cause,
	Data,
	Effect,
	Formatter,
	Option,
	pipe,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import type { ApplyError, OpenError, TransientFailure } from "#adapter/errors/execution.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import {
	columnsOf,
	type DirectAnswer,
	emptyState,
	type Fact,
	type GrizzleAnswer,
	type GrizzleOp,
	judgeRun,
	type LawSpec,
	type Member,
	type Observed,
	type Rel,
	relationNames,
	type State,
	type Statement
} from "#test/schedules/write/model.ts"

import {
	Code,
	codeKey,
	Item,
	Note,
	type Opened,
	open,
	openApp,
	Ref,
	Room,
	refItem,
	Ticket,
	ticketLabel,
	Zed
} from "#test/schedules/write/support.ts"
import { defined } from "#test/support/assert.ts"
import { reportedLawId } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { applyValue, type PutRealization, putRealizations } from "#test/support/oracle/write/run.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { type Retried, untilAnswered } from "#test/support/schedules/grizzle.ts"
import {
	allowed,
	every,
	exploreInterleavings,
	type Footprint,
	type Interleaving,
	movesOf,
	type OpStep,
	refusedJudgment,
	relationsFootprint,
	runawayInterleavings,
	interleaveStep,
	type Strategy,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { type StepOutcome } from "#test/support/schedules/types.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const ids = ["1", "2", "3"] as const
const labels = ["a", "b", "c"] as const
const rooms = ["1", "2"] as const
const blockers = ["1", "2"] as const
/** Spans [start, end): three disjoint ones and two overlapping their neighbours. */
const spans: Arr.NonEmptyReadonlyArray<readonly [string, string]> = [
	["0", "2"],
	["2", "4"],
	["4", "6"],
	["1", "3"],
	["3", "5"]
]

const idGen = element(ids)
const labelGen = element(labels)
const factGens: Readonly<Record<Rel, Gen<Fact>>> = {
	Item: (source) => [source.draw(idGen), source.draw(labelGen)],
	Note: (source) => [source.draw(idGen), source.draw(labelGen)],
	Code: (source) => [source.draw(idGen), source.draw(idGen)],
	Ticket: (source) => [source.draw(idGen), source.draw(labelGen)],
	Room: (source) => {
		const room = source.draw(element(rooms))
		const [start, end] = source.draw(element(spans))
		return [room, start, end, source.draw(labelGen)]
	},
	Ref: (source) => [source.draw(idGen), source.draw(idGen)],
	Zed: map(element(blockers), (z): Fact => [z])
}

/** Facts at the given keys, each with a drawn cell. */
const keyed =
	(keys: ReadonlyArray<string>, cell: Gen<string>): Gen<ReadonlyArray<Fact>> =>
	(source) =>
		Arr.map(keys, (k): Fact => [k, source.draw(cell)])

/** References to the stored Items `items`, at keys 1 and 2: none when no Item is stored. */
const refsGen = (items: ReadonlyArray<string>): Gen<ReadonlyArray<Fact>> => {
	const [first, ...rest] = items
	if (first === undefined) {
		return constant([])
	}
	const item = element([first, ...rest])
	return (source) => Arr.map(source.draw(subarray(["1", "2"])), (r): Fact => [r, source.draw(item)])
}

/**
 * A lawful initial state by construction: keys, codes and Ticket labels distinct, each room's spans disjoint, every
 * reference to a stored Item, Zed empty so every blocker is free.
 */
const initialGen: Gen<State> = (source) => {
	const item = source.draw(keyed(source.draw(subarray(ids)), labelGen))
	const note = source.draw(keyed(source.draw(subarray(ids)), labelGen))
	const codeKeys = source.draw(subarray(ids))
	const codes = source.draw(shuffled(ids, { min: 3, max: 3 }))
	const ticketKeys = source.draw(subarray(["1", "2"]))
	const ticketLabels = source.draw(shuffled(labels, { min: 2, max: 2 }))
	const perRoom = Arr.map(rooms, (r) =>
		Arr.map(source.draw(subarray(spans.slice(0, 3))), ([start, end]): Fact => [r, start, end])
	)
	const room = Arr.map(perRoom.flat(), (f): Fact => [...f, source.draw(labelGen)])
	return {
		...emptyState,
		Item: item,
		Note: note,
		Code: Arr.map(codeKeys, (k, i): Fact => [k, codes[i] ?? k]),
		Ticket: Arr.zipWith(ticketKeys, ticketLabels, (k, l): Fact => [k, l]),
		Room: room,
		Ref: source.draw(refsGen(Arr.map(item, (f) => f[0] ?? "")))
	}
}

/** Grizzle members, each drawn over the domains; a generated member's labels are given later (labelGenerated). */
const enumerated = (op: "insert" | "delete" | "put", relation: Rel, most: number): Gen<Member> =>
	map(array(factGens[relation], { min: 1, max: most }), (facts): Member => ({
		kind: "enumerated",
		op,
		relation,
		facts
	}))

const memberGen: Gen<Member> = oneOf([
	enumerated("insert", "Item", 2),
	enumerated("delete", "Item", 2),
	enumerated("put", "Item", 2),
	enumerated("put", "Note", 2),
	(source): Member => ({ kind: "move", id: source.draw(idGen), label: source.draw(labelGen) }),
	(source): Member => ({
		kind: "scoped",
		facts: source.draw(array(factGens.Note, { min: 1, max: 2 })),
		scope: source.draw(labelGen)
	}),
	map(idGen, (id): Member => ({ kind: "copied", id })),
	enumerated("insert", "Code", 1),
	enumerated("put", "Code", 1),
	map(int(1, 2), (n): Member => ({ kind: "generated", labels: Arr.makeBy(n, () => "") })),
	enumerated("insert", "Ticket", 1),
	enumerated("insert", "Room", 1),
	enumerated("put", "Room", 1),
	enumerated("insert", "Ref", 1),
	enumerated("delete", "Ref", 1),
	enumerated("put", "Zed", 1)
])

/** The relation a member writes. */
const writtenBy = (m: Member): Rel => {
	switch (m.kind) {
		case "enumerated":
			return m.relation
		case "generated":
			return "Ticket"
		case "move":
		case "scoped":
		case "copied":
			return "Note"
	}
}

const blockerStratum = (z: string): ReadonlyArray<Member> => [
	{ kind: "enumerated", op: "insert", relation: "Zed", facts: [[z]] }
]

/**
 * The draws a ChangeSet's second member may take to find a relation its first does not write: seven relations, the most
 * likely holding a quarter of the members, so twenty draws all meeting it is a chance of about 10^-12.
 */
const memberAttempts = 20

/** A ChangeSet: one or two members of distinct relations, then, maybe, a blocker's stratum. */
const opGen: Gen<GrizzleOp> = (source) => {
	const members = source.draw(uniqueArray(memberGen, writtenBy, { min: 1, max: 2 }, memberAttempts))
	return {
		strata: Option.match(source.draw(option(element(blockers))), {
			onNone: () => [members],
			onSome: (blocker) => [members, blockerStratum(blocker)]
		})
	}
}

/** The relations a direct DELETE draws its key from: every one but Ticket, whose serial a direct writer never deletes. */
const deletable: Arr.NonEmptyReadonlyArray<Rel> = ["Item", "Note", "Code", "Room", "Ref", "Zed"]

const statementGen: Gen<Statement> = weighted([
	[
		6,
		(source): Statement => {
			const relation = source.draw(element(relationNames))
			return { kind: "insert", relation, fact: source.draw(factGens[relation]) }
		}
	],
	[
		4,
		(source): Statement => {
			const relation = source.draw(element(deletable))
			const f = source.draw(factGens[relation])
			return { kind: "delete", relation, key: relation === "Room" ? f.slice(0, 3) : f.slice(0, 1) }
		}
	],
	[
		2,
		(source): Statement => ({
			kind: "update",
			id: source.draw(idGen),
			label: source.draw(labelGen)
		})
	],
	[
		1,
		(source): Statement => ({
			kind: "updateImmutable",
			id: source.draw(idGen),
			label: source.draw(labelGen)
		})
	]
])

type GrizzleActorName = "app" | "app2"
type DirectActorName = "d1" | "d2"

type Session =
	| {
			readonly kind: "grizzle"
			readonly actor: GrizzleActorName
			readonly ops: ReadonlyArray<GrizzleOp>
	  }
	| {
			readonly kind: "direct"
			readonly actor: DirectActorName
			readonly statements: ReadonlyArray<Statement>
	  }

/** The dictionary of planted shapes (see the header). Every case runs each of them once, over values of its own. */
const plantedRaces = [
	"insert in flight, equal",
	"insert in flight, different",
	"deletion before a put",
	"anchor replaced",
	"candidate key race",
	"candidate key put",
	"a deletion before an insert beside a concurrent occupant",
	"two puts of one key",
	"repeat beside a deletion",
	"generated beside explicit",
	"generated beside a deletion of its label's occupant",
	"span put over another key",
	"update beside an ON CONFLICT put",
	"update beside an UPDATE ... FROM put",
	"update beside a MERGE put",
	"pure set put beside its insert",
	"copied put beside a deletion of its source"
] as const
type PlantedRace = (typeof plantedRaces)[number]

interface Race {
	readonly origin:
		| { readonly kind: "drawn" }
		| { readonly kind: "planted"; readonly name: PlantedRace }
	readonly initial: State
	readonly sessions: ReadonlyArray<Session>
}

const ops = (...strata: ReadonlyArray<ReadonlyArray<Member>>): GrizzleOp => ({ strata })
const put = (relation: Rel, ...facts: ReadonlyArray<Fact>): Member => ({
	kind: "enumerated",
	op: "put",
	relation,
	facts
})

const ins = (relation: Rel, ...facts: ReadonlyArray<Fact>): Member => ({
	kind: "enumerated",
	op: "insert",
	relation,
	facts
})

const del = (relation: Rel, ...facts: ReadonlyArray<Fact>): Member => ({
	kind: "enumerated",
	op: "delete",
	relation,
	facts
})

const grizzle = (actor: GrizzleActorName, ...gs: ReadonlyArray<GrizzleOp>): Session => ({
	kind: "grizzle",
	actor,
	ops: gs
})

const direct = (actor: DirectActorName, ...statements: ReadonlyArray<Statement>): Session => ({
	kind: "direct",
	actor,
	statements
})

const generated = (...named: ReadonlyArray<string>): Member => ({
	kind: "generated",
	labels: named
})

/** A planted race's drawn values: two distinct keys, three distinct labels and a blocker. */
interface PlantedValues {
	readonly k: string
	readonly k2: string
	readonly l1: string
	readonly l2: string
	readonly l3: string
	readonly z: string
}

/** The planted race `name` over its drawn values. */
const plantedRace = (name: PlantedRace, { k, k2, l1, l2, l3, z }: PlantedValues): Race => {
	const race = (initial: Partial<State>, ...sessions: ReadonlyArray<Session>): Race => ({
		origin: { kind: "planted", name },
		initial: { ...emptyState, ...initial },
		sessions
	})
	const update = direct("d1", { kind: "update", id: k, label: l2 })
	switch (name) {
		case "insert in flight, equal":
		case "insert in flight, different":
			return race(
				{},
				direct("d1", { kind: "insert", relation: "Item", fact: [k, l1] }),
				grizzle("app", ops([ins("Item", [k, name === "insert in flight, equal" ? l1 : l2])]))
			)
		case "deletion before a put":
			return race(
				{ Item: [[k, l1]] },
				direct("d1", { kind: "delete", relation: "Item", key: [k] }),
				grizzle("app", ops([put("Item", [k, l1])]), ops([ins("Item", [k2, l2])]))
			)
		case "anchor replaced":
			return race(
				{ Item: [[k, l1]] },
				direct(
					"d1",
					{ kind: "delete", relation: "Item", key: [k] },
					{ kind: "insert", relation: "Item", fact: [k, l2] }
				),
				grizzle("app", ops([ins("Ref", [k2, k])]))
			)
		case "candidate key race":
		case "candidate key put":
			return race(
				{},
				direct("d1", { kind: "insert", relation: "Code", fact: [k2, k] }),
				grizzle("app", ops([(name === "candidate key race" ? ins : put)("Code", [k, k])]))
			)
		case "a deletion before an insert beside a concurrent occupant":
			return race(
				{},
				direct(
					"d1",
					{ kind: "delete", relation: "Code", key: [k2] },
					{ kind: "insert", relation: "Code", fact: [k, k] }
				),
				direct("d2", { kind: "insert", relation: "Code", fact: [k2, k] })
			)
		case "two puts of one key":
			return race(
				{ Item: [[k, l1]] },
				direct("d1", { kind: "insert", relation: "Zed", fact: [z] }),
				grizzle("app", ops([put("Item", [k, l2])], blockerStratum(z))),
				grizzle("app2", ops([put("Item", [k, l3])]))
			)
		case "repeat beside a deletion":
			return race(
				{ Item: [[k, l1]] },
				direct("d1", { kind: "insert", relation: "Zed", fact: [z] }),
				grizzle("app", ops([ins("Item", [k, l1], [k2, l1])], blockerStratum(z))),
				grizzle("app2", ops([del("Item", [k, l1], [k2, l1])]))
			)
		case "generated beside explicit":
			return race(
				{ Ticket: [["1", l1]] },
				direct("d1", { kind: "insert", relation: "Ticket", fact: ["2", l2] }),
				grizzle("app", ops([generated("ga", "gb")])),
				grizzle("app2", ops([ins("Ticket", ["3", l3])]))
			)
		case "generated beside a deletion of its label's occupant":
			return race(
				{},
				direct("d1", { kind: "insert", relation: "Ticket", fact: ["9", l1] }),
				grizzle("app", ops([del("Ticket", ["9", l1]), generated(l1)]))
			)
		case "span put over another key":
			return race(
				{ Room: [["1", "0", "2", l1]] },
				grizzle(
					"app",
					ops([put("Room", ["1", "1", "3", l2])]),
					ops([put("Room", ["1", "0", "2", l3])])
				),
				direct("d1", { kind: "insert", relation: "Room", fact: ["1", "2", "4", l3] })
			)
		case "update beside an ON CONFLICT put":
			return race({ Note: [[k, l1]] }, update, grizzle("app", ops([put("Note", [k, l3])])))
		case "update beside an UPDATE ... FROM put":
			return race(
				{ Note: [[k, l1]] },
				update,
				grizzle("app", ops([{ kind: "move", id: k, label: l3 }]))
			)
		case "update beside a MERGE put":
			return race(
				{ Note: [[k, l1]] },
				update,
				grizzle("app", ops([{ kind: "scoped", facts: [[k, l3]], scope: l1 }]))
			)
		case "pure set put beside its insert":
			return race(
				{},
				direct("d1", { kind: "insert", relation: "Zed", fact: [z] }),
				grizzle("app", ops([put("Zed", [z])]))
			)
		case "copied put beside a deletion of its source":
			return race(
				{ Item: [[k, l1]] },
				direct("d1", { kind: "delete", relation: "Item", key: [k] }),
				grizzle("app", ops([{ kind: "copied", id: k }]))
			)
	}
}

/** A planted race of `name` over its drawn values: two keys, three distinct labels and a blocker. */
const plantedRaceGen =
	(name: PlantedRace): Gen<Race> =>
	(source) => {
		const keys = source.draw(shuffled(ids, { min: 2, max: 2 }))
		const named = source.draw(shuffled(labels, { min: 3, max: 3 }))
		return plantedRace(name, {
			k: defined(keys[0], "a first key"),
			k2: defined(keys[1], "a second key"),
			l1: defined(named[0], "a first label"),
			l2: defined(named[1], "a second label"),
			l3: defined(named[2], "a third label"),
			z: source.draw(element(blockers))
		})
	}

const actorNames: ReadonlyArray<GrizzleActorName | DirectActorName> = ["app", "app2", "d1", "d2"]

/**
 * A drawn race: a lawful initial state, then two or three of the actors in their own order (a uniform choice of how
 * many, then of which), each with one or two ChangeSets or statements.
 */
const drawnRaceGen: Gen<Race> = (source) => {
	const initial = source.draw(initialGen)
	const picked = source.draw(shuffled(actorNames, { min: 2, max: 3 }))
	const sessions = Arr.map(
		Arr.filter(actorNames, (actor) => picked.includes(actor)),
		(actor): Session =>
			actor === "app" || actor === "app2"
				? { kind: "grizzle", actor, ops: source.draw(array(opGen, { min: 1, max: 2 })) }
				: {
						kind: "direct",
						actor,
						statements: source.draw(array(statementGen, { min: 1, max: 2 }))
					}
	)
	return { origin: { kind: "drawn" }, initial, sessions }
}

/**
 * Each generated member's labels in a drawn race, distinct across the race and from every explicit label: "g" and a
 * letter. A planted race states its own.
 */
const labelGenerated = (race: Race): Race => {
	let next = 0
	const fresh = (): string => `g${String.fromCharCode(97 + next++)}`
	return {
		...race,
		sessions: Arr.map(race.sessions, (s) =>
			s.kind === "direct"
				? s
				: {
						...s,
						ops: Arr.map(s.ops, (op) => ({
							strata: Arr.map(op.strata, (stratum) =>
								Arr.map(stratum, (m): Member =>
									m.kind === "generated"
										? { kind: "generated", labels: Arr.map(m.labels, fresh) }
										: m
								)
							)
						}))
					}
		)
	}
}

/**
 * A case: every planted race, then one drawn race, on one installation. A race of too many moves to run in every order
 * draws its PCT schedule in the property, once its sessions are known.
 */
interface RaceCase {
	readonly races: ReadonlyArray<Race>
}

const raceCaseGen: Gen<RaceCase> = (source) => ({
	races: [
		...Arr.map(plantedRaces, (name) => source.draw(plantedRaceGen(name))),
		labelGenerated(source.draw(drawnRaceGen))
	]
})

const relationOf = { Item, Note, Code, Ticket, Room, Ref, Zed } as const

/** A fact as the record a ChangeSet member gives. */
const recordOf = (relation: Rel, f: Fact): Readonly<Record<string, unknown>> => {
	const cell = (i: number): string => f[i] ?? ""
	switch (relation) {
		case "Item":
		case "Note":
			return { id: Number(cell(0)), label: cell(1) }
		case "Code":
			return { id: Number(cell(0)), code: Number(cell(1)) }
		case "Ticket":
			return { no: BigInt(cell(0)), label: cell(1) }
		case "Room":
			return {
				room: Number(cell(0)),
				during: { start: BigInt(cell(1)), end: BigInt(cell(2)) },
				label: cell(3)
			}
		case "Ref":
			return { id: Number(cell(0)), item: Number(cell(1)) }
		case "Zed":
			return { id: Number(cell(0)) }
	}
}

/** A fact as a VALUES row of its relation; labels are lowercase letters, so a literal needs no escaping. */
const valuesOf = (r: Rel, f: Fact): string => {
	const cell = (i: number): string => f[i] ?? ""
	switch (r) {
		case "Item":
		case "Note":
		case "Ticket":
			return `(${cell(0)}, '${cell(1)}')`
		case "Code":
		case "Ref":
			return `(${cell(0)}, ${cell(1)})`
		case "Room":
			return `(${cell(0)}, pg_catalog.int8range(${cell(1)}, ${cell(2)}), '${cell(3)}')`
		case "Zed":
			return `(${cell(0)})`
	}
}

/**
 * The installation's spelling of a relation's table and columns; labels are lowercase letters, so a literal needs no
 * escaping.
 */
const sqlOf = (o: Opened) => {
	const t = (r: Rel) => o.names.table(relationOf[r])
	const columns = (r: Rel): string => {
		switch (r) {
			case "Item":
			case "Note":
				return `${o.names.column(Item, "id")}, ${o.names.column(Item, "label")}`
			case "Code":
				return `${o.names.column(Code, "id")}, ${o.names.column(Code, "code")}`
			case "Ticket":
				return `${o.names.column(Ticket, "no")}, ${o.names.column(Ticket, "label")}`
			case "Room":
				return `${o.names.column(Room, "room")}, ${o.names.column(Room, "during")}, ${o.names.column(Room, "label")}`
			case "Ref":
				return `${o.names.column(Ref, "id")}, ${o.names.column(Ref, "item")}`
			case "Zed":
				return o.names.column(Zed, "id")
		}
	}
	const insert = (r: Rel, f: Fact): string =>
		`INSERT INTO ${t(r)} (${columns(r)})${r === "Ticket" ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ${valuesOf(r, f)}`
	const keyCondition = (r: Rel, key: Fact): string =>
		r === "Room"
			? `${o.names.column(Room, "room")} = ${key[0] ?? ""} AND ${o.names.column(Room, "during")} = pg_catalog.int8range(${key[1] ?? ""}, ${key[2] ?? ""})`
			: `${Str.split(columns(r), ", ")[0]} = ${key[0] ?? ""}`
	const statement = (s: Statement): string => {
		switch (s.kind) {
			case "insert":
				return insert(s.relation, s.fact)
			case "delete":
				return `DELETE FROM ${t(s.relation)} WHERE ${keyCondition(s.relation, s.key)}`
			case "update":
				return `UPDATE ${t("Note")} SET ${o.names.column(Note, "label")} = '${s.label}' WHERE ${o.names.column(Note, "id")} = ${s.id}`
			case "updateImmutable":
				return `UPDATE ${t("Item")} SET ${o.names.column(Item, "label")} = '${s.label}' WHERE ${o.names.column(Item, "id")} = ${s.id}`
		}
	}
	/**
	 * The owner's reset to a state, written whole (rig.replace truncates every relation's table): the state's facts
	 * loaded, Ticket's sequence behind every stored value.
	 */
	const reset = (state: State): ReadonlyArray<string> => [
		...Arr.flatMap(relationNames, (r) => Arr.map(state[r], (f) => insert(r, f))),
		`SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('${pipe(t("Ticket"), Str.replaceAll("'", "''"))}', '${o.names.columnIdent(Ticket, "no")}'), 1, false)`
	]
	/** Every relation's facts as text rows: the relation's name, then its columns, padded to four. */
	const read = Arr.join(
		[
			`SELECT 'Item'::text, ${o.names.column(Item, "id")}::text, ${o.names.column(Item, "label")}::text, NULL::text, NULL::text FROM ${t("Item")}`,
			`SELECT 'Note', ${o.names.column(Note, "id")}::text, ${o.names.column(Note, "label")}::text, NULL, NULL FROM ${t("Note")}`,
			`SELECT 'Code', ${o.names.column(Code, "id")}::text, ${o.names.column(Code, "code")}::text, NULL, NULL FROM ${t("Code")}`,
			`SELECT 'Ticket', ${o.names.column(Ticket, "no")}::text, ${o.names.column(Ticket, "label")}::text, NULL, NULL FROM ${t("Ticket")}`,
			`SELECT 'Room', ${o.names.column(Room, "room")}::text, pg_catalog.lower(${o.names.column(Room, "during")})::text, pg_catalog.upper(${o.names.column(Room, "during")})::text, ${o.names.column(Room, "label")}::text FROM ${t("Room")}`,
			`SELECT 'Ref', ${o.names.column(Ref, "id")}::text, ${o.names.column(Ref, "item")}::text, NULL, NULL FROM ${t("Ref")}`,
			`SELECT 'Zed', ${o.names.column(Zed, "id")}::text, NULL, NULL, NULL FROM ${t("Zed")}`
		],
		" UNION ALL "
	)
	return { statement, reset, read }
}

/**
 * The relations a write reaches: its own, with Item and Ref together, since the foreign key reads one for the other.
 */
const reaches = (relations: ReadonlyArray<Rel>): Footprint =>
	relationsFootprint(
		Arr.flatMap(relations, (r): ReadonlyArray<Rel> =>
			r === "Item" || r === "Ref" ? ["Item", "Ref"] : [r]
		)
	)

const statementRelation = (s: Statement): Rel => {
	switch (s.kind) {
		case "insert":
		case "delete":
			return s.relation
		case "update":
			return "Note"
		case "updateImmutable":
			return "Item"
	}
}

/** The laws of the schedule schema, by their declarations' meaning. */
const lawsOf = (o: Opened): ReadonlyArray<LawSpec> => [
	...Arr.map(["Item", "Note", "Code", "Ticket", "Ref", "Zed"] as const, (relation): LawSpec => ({
		kind: "unique",
		law: o.names.primaryKeyLaw(relationOf[relation]),
		relation,
		columns: [0]
	})),
	{ kind: "unique", law: o.names.lawOf(codeKey), relation: "Code", columns: [1] },
	{ kind: "unique", law: o.names.lawOf(ticketLabel), relation: "Ticket", columns: [1] },
	{ kind: "spanKey", law: o.names.primaryKeyLaw(Room), relation: "Room" },
	{ kind: "contained", law: o.names.lawOf(refItem), from: "Ref", column: 1, to: "Item", target: 0 }
]

/** A grizzle op as a ChangeSet value over the installed schema, with its parameters. */
const changeSetOf = (
	o: Opened,
	op: GrizzleOp
): { readonly changes: ChangeSetValue; readonly params: ParamMap } => {
	const schemaValue = o.rig.worlds.schema
	const params: Record<string, ReadonlyArray<unknown>> = {}
	const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
		Arr.reduce(
			members,
			ChangeSet.empty(schemaValue),
			(changes: ChangeSetValue, m, i): ChangeSetValue => {
				switch (m.kind) {
					case "enumerated": {
						const facts = Arr.map(m.facts, (f) => recordOf(m.relation, f))
						const relation = relationOf[m.relation]
						return m.op === "insert"
							? changes.insert(relation, facts)
							: m.op === "delete"
								? changes.delete(relation, facts)
								: changes.put(relation, facts)
					}
					case "generated":
						return changes.insert(
							Ticket,
							Arr.map(m.labels, (label) => ({ label }))
						)
					case "move":
						return changes.put(
							Note,
							query(schemaValue).rule((r: RuleValue) =>
								r.match(Note, { id: Number(m.id) }).find({ id: Number(m.id), label: m.label })
							)
						)
					case "scoped": {
						const name = `items${Rec.keys(params).length}_${i}`
						params[name] = Arr.map(m.facts, (f) => recordOf("Note", f))
						return changes
							.put(
								Note,
								query(schemaValue).rule((r: RuleValue) => {
									const { id, label } = v(Note, "note")
									return r.match(r.relation(name, Note), { id, label }).find({ id, label })
								})
							)
							.delete(
								Note,
								query(schemaValue).rule((r: RuleValue) => {
									const { id, label } = v(Note, "note")
									return r
										.match(Note, { id, label })
										.where(r.eq(label, m.scope))
										.where(r.not(r.relation(name, Note), { id }))
										.find({ id, label })
								})
							)
					}
					case "copied":
						return changes.put(
							Note,
							query(schemaValue).rule((r: RuleValue) => {
								const { label } = v(Item, "item")
								return r.match(Item, { id: Number(m.id), label }).find({ id: Number(m.id), label })
							})
						)
				}
			}
		)
	const [first, ...rest] = Arr.map(op.strata, stratumOf)
	if (first === undefined) {
		throw new Error("a grizzle op of no stratum")
	}
	return { changes: Arr.reduce(rest, first, (a, b) => ChangeSet.sequence(a, b)), params }
}

const describeMember = (m: Member): string => {
	switch (m.kind) {
		case "enumerated":
			return `${m.op} ${m.relation} ${Arr.join(
				Arr.map(m.facts, (f) => `(${Arr.join(f, ", ")})`),
				" "
			)}`
		case "generated":
			return `insert Ticket generated ${Arr.join(m.labels, " ")}`
		case "move":
			return `put Note at ${m.id} label ${m.label} (described over Note)`
		case "scoped":
			return `put Note ${Arr.join(
				Arr.map(m.facts, (f) => `(${Arr.join(f, ", ")})`),
				" "
			)} beside the deletion of scope ${m.scope}`
		case "copied":
			return `put Note copying Item ${m.id}`
	}
}

const describeOp = (op: GrizzleOp): string =>
	Arr.join(
		Arr.map(op.strata, (s) => Arr.join(Arr.map(s, describeMember), " + ")),
		" ; "
	)

const describeRace = (race: Race, sql: ReturnType<typeof sqlOf>): string =>
	Arr.join(
		[
			race.origin.kind === "planted" ? `planted: ${race.origin.name}` : "drawn",
			`initial: ${Arr.join(
				Arr.map(
					Arr.filter(relationNames, (r) => race.initial[r].length > 0),
					(r) =>
						`${r} ${Arr.join(
							Arr.map(race.initial[r], (f) => `(${Arr.join(f, ", ")})`),
							" "
						)}`
				),
				"; "
			)}`,
			...Arr.map(race.sessions, (s) =>
				s.kind === "grizzle"
					? `${s.actor}: ${Arr.join(Arr.map(s.ops, describeOp), " | ")}`
					: `${s.actor}: ${Arr.join(Arr.map(s.statements, sql.statement), "; ")}; COMMIT`
			)
		],
		"\n"
	)

type RaceFeature =
	| `put target ${PutRealization["target"]}`
	| `pair reason ${Extract<PutRealization, { readonly target: "deleteThenInsert" }>["reason"]}`
	| `grizzle ${GrizzleAnswer["kind"]}`
	| `transient ${TransientTag}`
	| `direct ${string}`
	| `planted ${PlantedRace}`
	| "a step waited"
	| "a deadlock broken"
	| "nature branched"
	| "a write held between its strata"
	| "generated serial committed"
	| "explicit serial committed"
	| "a generated addition met an unseen occupant"
	| "every order"
	| "pct"

/**
 * The features every case's planted races reach, so the suite fails when one stops reaching its shape: the noted ones
 * beyond them (direct SQLSTATEs, deadlocks, nature's branches, the other TransientFailure reasons, PCT) are counted
 * toward the residual risk.
 */
const situations: Arr.NonEmptyReadonlyArray<RaceFeature> = [
	"put target deleteThenInsert",
	"put target onConflictDoUpdate",
	"put target updateFrom",
	"put target merge",
	"pair reason immutable",
	"pair reason candidateKey",
	"pair reason spanKey",
	"pair reason pureSet",
	"pair reason unproved",
	"grizzle accepted",
	"grizzle no-change",
	"grizzle invariant-rejected",
	"transient GeneratedSerialUnique",
	"direct committed",
	"a step waited",
	"a write held between its strata",
	"generated serial committed",
	"explicit serial committed",
	"a generated addition met an unseen occupant",
	"every order",
	...Arr.map(plantedRaces, (name): RaceFeature => `planted ${name}`)
]

/** A race the model refused, or a case that could not run one, with the race and why. */
class RaceFailed extends Data.TaggedError("RaceFailed")<{ readonly message: string }> {}

/** What a grizzle write's retried call answered, its law read back to its LawId through the installation's laws. */
const answerOf = (
	described: ReadonlyMap<LawId, Law>,
	r: Result.Result<Retried<ApplyOutcome<unknown>>, Exclude<ApplyError, TransientFailure>>
): { readonly refused: ReadonlyArray<TransientTag>; readonly answer: GrizzleAnswer } => {
	if (Result.isFailure(r)) {
		return { refused: [], answer: { kind: "failed", what: r.failure._tag } }
	}
	const value = r.success.answered
	return { refused: r.success.refused, answer: grizzleAnswer(described, value) }
}

/** A write's answer as the model judges it: a refusal names its one law, so a refusal naming several is a failure. */
const grizzleAnswer = (
	described: ReadonlyMap<LawId, Law>,
	value: ApplyOutcome<unknown>
): GrizzleAnswer => {
	switch (value.kind) {
		case "invariant-rejected": {
			const [law, ...more] = value.refused.laws
			return more.length === 0
				? { kind: "invariant-rejected", law: reportedLawId(described, law) }
				: {
						kind: "failed",
						what: `a refusal naming ${Arr.length(value.refused.laws)} laws: ${Arr.join(
							Arr.map(value.refused.laws, (l) => reportedLawId(described, l)),
							", "
						)}`
					}
		}
		case "outside-world":
			return { kind: "failed", what: value.kind }
		case "accepted":
		case "no-change":
			return { kind: value.kind }
	}
}

/**
 * A direct transaction's answer from its recorded result: its statements' row counts once its COMMIT succeeded, or its
 * first failure's SQLSTATE at the move that failed.
 */
const directAnswerOf = (run: Interleaving, session: string, statements: number): DirectAnswer => {
	const result = run.results[session]
	if (result === undefined) {
		return { kind: "other", what: `${session} has no result` }
	}
	switch (result._tag) {
		case "Committed":
			return {
				kind: "committed",
				rowCounts: Arr.map(result.outcomes.slice(0, statements), (x) =>
					x._tag === "Ok" ? x.rowCount : -1
				)
			}
		case "RolledBack":
			return { kind: "other", what: `${session} rolled back` }
		case "Failed":
			return result.failure._tag === "PgError"
				? { kind: "failed", at: result.outcomes.length - 1, code: result.failure.fields.code }
				: { kind: "other", what: `${session} failed: ${result.failure._tag}` }
	}
}

const stateOf = (run: Interleaving): State => {
	if (run.state._tag !== "Read") {
		throw new Error("the race read no state")
	}
	const facts: Record<Rel, Array<Fact>> = {
		Item: [],
		Note: [],
		Code: [],
		Ticket: [],
		Room: [],
		Ref: [],
		Zed: []
	}
	for (const [relation, ...cells] of run.state.rows) {
		const r = Option.getOrThrowWith(
			Arr.findFirst(relationNames, (x) => x === relation),
			() => new Error(`a state row of no relation: ${String(relation)}`)
		)
		facts[r].push(Arr.map(cells.slice(0, columnsOf[r].length), (c) => c ?? ""))
	}
	return facts
}

const succeeded: StepOutcome = { _tag: "Ok", rows: [], rowCount: 0 }

type RaceError = CompileError | OpenError | SqlError | TransactionRolledBack | PsqlProcessError

const runRace = (
	rc: RaceCase,
	c: Case<RaceFeature>
): Effect.Effect<void, RaceFailed | RaceError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const o = yield* open
		const sql = sqlOf(o)
		const laws = lawsOf(o)
		const app = yield* o.rig.writer("app", openApp(o.rig))
		const app2 = yield* o.rig.writer("app2", openApp(o.rig))
		const directs = yield* openActors(s, {
			d1: { kind: "raw", as: o.rig.direct },
			d2: { kind: "raw", as: o.rig.direct }
		})
		const writers = { app, app2 }
		const raceRun = (race: Race) =>
			Effect.gen(function* () {
				const report = (why: string) =>
					new RaceFailed({ message: `${describeRace(race, sql)}\n${why}` })
				if (race.origin.kind === "planted") {
					c.note(`planted ${race.origin.name}`)
				}
				/** Each grizzle write's answer, by session and step, as the current run's calls gave it. */
				const seen = new Map<
					string,
					{ readonly refused: ReadonlyArray<TransientTag>; readonly answer: GrizzleAnswer }
				>()
				const txns: Array<Txn> = []
				for (const session of race.sessions) {
					if (session.kind === "direct") {
						txns.push({
							kind: "direct",
							session: session.actor,
							steps: Arr.map(session.statements, (st) =>
								interleaveStep(sql.statement(st), reaches([statementRelation(st)]))
							),
							end: "commit",
							after: undefined
						})
						continue
					}
					const ctx = writers[session.actor].ctx
					const steps: Array<OpStep> = []
					for (const [i, op] of session.ops.entries()) {
						const built = changeSetOf(o, op)
						const realizations = putRealizations(ctx, built.changes)
						if (Result.isFailure(realizations)) {
							return yield* report(
								`${describeOp(op)} does not compile: ${realizations.failure.message}`
							)
						}
						c.noteAll(
							Arr.flatMap(realizations.success, (realization): ReadonlyArray<RaceFeature> =>
								realization.target === "deleteThenInsert"
									? [`put target ${realization.target}`, `pair reason ${realization.reason}`]
									: [`put target ${realization.target}`]
							)
						)
						const key = `${session.actor}#${i}`
						steps.push({
							label: describeOp(op),
							outcome: Effect.map(
								Effect.result(untilAnswered(applyValue(ctx, built.changes, built.params))),
								(r) => {
									seen.set(key, answerOf(ctx.artifacts.described, r))
									return succeeded
								}
							),
							footprint: reaches(Arr.map(op.strata.flat(), writtenBy))
						})
					}
					txns.push({ kind: "grizzle", session: session.actor, steps, after: undefined })
				}
				const moves = movesOf(txns)
				const strategy: Strategy =
					moves <= 6
						? every
						: {
								kind: "pct",
								schedule: c.draw(
									pctSchedule(
										nonEmptyList(
											Arr.map(txns, (t) => t.session),
											"a race's sessions"
										),
										3,
										moves
									)
								),
								nature: c
							}
				c.note(strategy.kind === "every" ? "every order" : "pct")
				const reached: Array<RaceFeature> = []
				const observedOf = (run: Interleaving): ReadonlyArray<Observed> =>
					Arr.flatMap(race.sessions, (session): ReadonlyArray<Observed> => {
						if (session.kind === "direct") {
							/** Every session of a run that is not a stopped script makes its moves, so each has a span. */
							const span = defined(run.spans[session.actor], `${session.actor}'s span`)
							return [
								{
									kind: "direct",
									label: `${session.actor}'s transaction`,
									session: session.actor,
									statements: session.statements,
									span,
									answer: directAnswerOf(run, session.actor, session.statements.length)
								}
							]
						}
						return Arr.flatMap(session.ops, (op, i): ReadonlyArray<Observed> => {
							/** Every operation of a grizzle session runs, and its outcome never fails, so each finished. */
							const move = Option.getOrThrowWith(
								Arr.findFirst(run.moves, (m) => m.session === session.actor && m.step === i),
								() => new Error(`${session.actor}'s write ${i + 1} made no move`)
							)
							const answered = defined(
								seen.get(`${session.actor}#${i}`),
								`${session.actor}'s write ${i + 1}'s answer`
							)
							if (move.result._tag === "Unfinished") {
								throw new Error(
									`${session.actor}'s write ${i + 1} did not finish in a run that ran every move`
								)
							}
							return [
								{
									kind: "grizzle",
									label: `${session.actor}'s write ${i + 1}`,
									session: session.actor,
									op,
									span: { start: move.issued, end: move.result.at },
									refused: answered.refused,
									answer: answered.answer
								}
							]
						})
					})
				const noteRun = (run: Interleaving, observed: ReadonlyArray<Observed>): void => {
					appendAll(reached, runFeatures(race, run, observed))
				}
				yield* exploreInterleavings(
					o.rig.env,
					{
						direct: { d1: directs.d1, d2: directs.d2 },
						grizzle: { app: app.actor, app2: app2.actor }
					},
					{
						name: race.origin.kind === "planted" ? race.origin.name : "a drawn write race",
						txns,
						reset: Effect.andThen(
							Effect.sync(() => {
								seen.clear()
							}),
							o.rig.replace(sql.reset(race.initial))
						),
						state: { _tag: "Read", sql: sql.read },
						model: (run) =>
							Effect.sync(() => {
								const observed = observedOf(run)
								const problem = judgeRun(laws, race.initial, observed, stateOf(run))
								if (problem !== undefined) {
									return refusedJudgment(`${describeRace(race, sql)}\n${problem}`)
								}
								noteRun(run, observed)
								return allowed
							}),
						maxInterleavings: runawayInterleavings
					},
					strategy
				).pipe(
					Effect.catchTags({
						InterleavingFailed: (e) => Effect.fail(new RaceFailed({ message: e.message })),
						AfterCycle: (e) => Effect.fail(new RaceFailed({ message: e.message }))
					})
				)
				c.noteAll(reached)
			})
		for (const race of rc.races) {
			yield* raceRun(race)
		}
	})

/** What a passing run of a race reached: its waits, deadlocks and branches, and each operation's answer. */
const runFeatures = (
	race: Race,
	run: Interleaving,
	observed: ReadonlyArray<Observed>
): ReadonlyArray<RaceFeature> => {
	const heldBetweenStrata = Arr.some(
		run.moves,
		(m) =>
			m.observed._tag === "Waited" &&
			Arr.some(
				race.sessions,
				(x) =>
					x.actor === m.session &&
					x.kind === "grizzle" &&
					Arr.some(x.ops, (op, i) => i === m.step && op.strata.length > 1)
			)
	)
	const answers = Arr.flatMap(observed, (x): ReadonlyArray<RaceFeature> => {
		if (x.kind === "direct") {
			return x.answer.kind === "committed"
				? ["direct committed"]
				: x.answer.kind === "failed"
					? [`direct ${x.answer.code}`]
					: []
		}
		const members = x.answer.kind === "accepted" ? x.op.strata.flat() : []
		const generates = Arr.some(x.op.strata.flat(), (m) => m.kind === "generated")
		return [
			`grizzle ${x.answer.kind}`,
			...Arr.map(x.refused, (reason): RaceFeature => `transient ${reason}`),
			...(generates && x.refused.includes("UnseenOccupant")
				? ["a generated addition met an unseen occupant" as const]
				: []),
			...(Arr.some(members, (m) => m.kind === "generated")
				? ["generated serial committed" as const]
				: []),
			...(Arr.some(
				members,
				(m) => m.kind === "enumerated" && m.relation === "Ticket" && m.op === "insert"
			)
				? ["explicit serial committed" as const]
				: [])
		]
	})
	return [
		...(run.waits.length > 0 ? ["a step waited" as const] : []),
		...(run.deadlocks.length > 0 ? ["a deadlock broken" as const] : []),
		...(run.replay._tag === "Branched" ? ["nature branched" as const] : []),
		...(heldBetweenStrata ? ["a write held between its strata" as const] : []),
		...answers
	]
}

/**
 * The cases of each rotating stream: each installs its schema, opens four sessions and runs every planted race and one
 * drawn race in their orders.
 */
const runs = 8

layer(Substrate.layer, { excludeTestServices: true })(
	"write races, all SERIALIZABLE, judged by a serial model",
	(it) => {
		it.effect(
			`${runs} cases of planted and drawn races: every run is explained by a serial order`,
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "schedules/write/races",
							draw: drawn(raceCaseGen),
							literal: Formatter.format,
							coverage: required<RaceFeature>(situations, { cases: runs, sense: notesOnly }),
							kept: [],
							runs,
							shrink: { kind: "bounded", candidates: 40 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(rc, c) =>
							Effect.scoped(runRace(rc, c)).pipe(
								Effect.catchCause((cause) =>
									Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
								)
							)
					)
				)
		)
	}
)
