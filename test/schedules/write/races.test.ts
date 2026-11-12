/**
 * Write races: grizzle ChangeSets and direct SQL writers, all SERIALIZABLE, in orders the one concurrency driver
 * chooses, each run judged by the serial model.
 *
 * Property: every run is serializable as the model means it. Some order of the committed operations, with every
 * refusal at a place among them, respecting real time, explains each outcome, each row count, each refusal's law or
 * SQLSTATE and the committed state; every abort is 40001, 40P01 or a TransientFailure reason the write's shape allows,
 * beside a concurrent operation; and every generated serial value lies past the explicit values earlier writes stored.
 *
 * A case installs the schedule schema, opens two grizzle writers on the served login and two direct sessions, and
 * runs one race: a lawful initial state and two or three sessions, each a grizzle writer's one or two ChangeSets (each
 * its own transaction, which the caller calls again after each TransientFailure until it answers, as an application
 * does) or a direct writer's one transaction of one or two statements. A race's ChangeSets are compiled into a served
 * file of the login before it runs, as generate compiles a workload, and each runs as its loaded member over its
 * writer's Db. A race of few moves runs in every order (partial-order reduced); a larger one under a drawn PCT
 * schedule. Which deadlock victim PostgreSQL picks is nature's branch, judged like any run.
 *
 * The races are drawn over small domains, so keys, candidate keys, serial values and spans meet, or planted from the
 * dictionary of shapes (PlantedRace): an insert in flight at the key, a deletion before a put of the
 * fact, an anchor replaced by DELETE and INSERT beside a reference to it, a candidate key raced beside the arbiter
 * (UnseenOccupant), a direct writer's deletion and insert beside a concurrent occupant of the key it inserts (a 23505
 * its snapshot cannot explain), two puts of one key, an exact repeat beside a deletion of it, generated serial values
 * beside explicit ones (GeneratedSerialUnique), a generated addition beside a deletion of its label's concurrent
 * occupant (a serialization failure where its arbiter, label, meets that occupant unseen), a span put overlapping
 * another key, and an update beside a put in place (each in-place
 * target).
 *
 * The claimer race: two calls of the certified READ COMMITTED `claimer`, each racing Claim and then Seat, both raced
 * (race), each in a statement of its own, under holders apart, the owner holding Gate beside them, in every order. The
 * model meets a raced table's held key and adds nothing there; each call answers on its one try, and its read-backs
 * show each raced table won, its own fact added and nothing met, or met, nothing added and the fact the final state
 * holds at its key met, so a call may win one table and meet the other.
 *
 * Features: each put target the served write runs (its statements' steps) and each pair reason the compile that
 * served it chose (PutChoice), each answer, each TransientFailure reason met, each direct SQLSTATE, waits, deadlocks,
 * nature's branches, a write held between its strata by a blocker, generated and explicit serials, and each planted
 * shape.
 *
 * Plants: ~/.cache/grizzle-release/BR08/plants/races-assignments-keep-stored-values.patch, every assignment of a put in
 * place keeping the stored value, must turn the races' property red;
 * ~/.cache/grizzle-release/BR08/plants/races-inserter-served-serializable.patch, the certified READ COMMITTED inserter
 * served its SERIALIZABLE projection, the inserters';
 * ~/.cache/grizzle-release/BR08/plants/races-inserter-begins-swapped.patch, each level's BEGIN sent for the other's,
 * the inserter alone's.
 */

import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
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
	option,
	shuffled,
	subarray,
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
	Order,
	Predicate,
	pipe,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import { onceCalls, type WrittenOutcome } from "#adapter/db/handles.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/served/compile.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { CallError } from "#compiler/live/index.ts"
import type { Refused, Witness } from "#compiler/plan/change.ts"
import { servedSession } from "#compiler/program/served.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { IdentifiedLaw } from "#compiler/types/changeset/changeset.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { PutChoice } from "#compiler/write/put/choose.ts"
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
	type RunProblem,
	relationNames,
	type Span,
	type State,
	type Statement
} from "#test/schedules/write/model.ts"

import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import {
	Badge,
	badgeCode,
	Claim,
	Code,
	codeKey,
	committedChanges,
	Gate,
	Item,
	Note,
	type Opened,
	open,
	openApp,
	openClaimer,
	openInserter,
	Ref,
	Room,
	refItem,
	type RoleChange,
	Seat,
	servedChanges,
	Ticket,
	ticketLabel,
	Zed
} from "#test/schedules/write/support.ts"
import { deepEquals, defined } from "#test/support/assert.ts"
import { type WriteAnswer, answered, writeOnce } from "#test/support/calls.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { type Retried, untilAnswered } from "#test/support/schedules/grizzle.ts"
import {
	allowed,
	every,
	exploreInterleavings,
	type Footprint,
	type Interleaving,
	type Judgment,
	movesOf,
	type OpStep,
	noSerialOrderJudgment,
	refusedJudgment,
	relationsFootprint,
	runawayInterleavings,
	interleaveStep,
	type Strategy,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { type StepOutcome } from "#test/support/schedules/types.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate, type TextRows } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { type FrontendMessage, makeTap } from "#test/support/wire-tap.ts"

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
	Zed: map(element(blockers), (z): Fact => [z]),
	Badge: (source) => [source.draw(idGen), source.draw(idGen)],
	Claim: (source) => [source.draw(idGen), source.draw(idGen)],
	Seat: (source) => [source.draw(idGen), source.draw(idGen)],
	Gate: map(element(blockers), (g): Fact => [g])
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

/** The relations a ChangeSet's member writes. */
type Written = "Item" | "Note" | "Code" | "Ticket" | "Room" | "Ref" | "Zed"

/** Each written relation's members: what a member drawn for it may be, each equally often. */
const membersOf: { readonly [R in Written]: Arr.NonEmptyReadonlyArray<Gen<Member>> } = {
	Item: [
		enumerated("insert", "Item", 2),
		enumerated("delete", "Item", 2),
		enumerated("put", "Item", 2)
	],
	Note: [
		enumerated("put", "Note", 2),
		(source): Member => ({ kind: "move", id: source.draw(idGen), label: source.draw(labelGen) }),
		(source): Member => ({
			kind: "scoped",
			facts: source.draw(array(factGens.Note, { min: 1, max: 2 })),
			scope: source.draw(labelGen)
		}),
		map(idGen, (id): Member => ({ kind: "copied", id }))
	],
	Code: [enumerated("insert", "Code", 1), enumerated("put", "Code", 1)],
	Ticket: [
		map(int(1, 2), (n): Member => ({ kind: "generated", labels: upTo(n, () => "") })),
		enumerated("insert", "Ticket", 1)
	],
	Room: [enumerated("insert", "Room", 1), enumerated("put", "Room", 1)],
	Ref: [enumerated("insert", "Ref", 1), enumerated("delete", "Ref", 1)],
	Zed: [enumerated("put", "Zed", 1)]
}

const written: Arr.NonEmptyReadonlyArray<Written> = [
	"Item",
	"Note",
	"Code",
	"Ticket",
	"Room",
	"Ref",
	"Zed"
]

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

/** A ChangeSet: one or two members of distinct relations, then, maybe, a blocker's stratum. */
const opGen: Gen<GrizzleOp> = (source) => {
	const members = Arr.map(source.draw(shuffled(written, { min: 1, max: 2 })), (relation) =>
		source.draw(oneOf(membersOf[relation]))
	)
	return {
		strata: Option.match(source.draw(option(element(blockers))), {
			onNone: () => [members],
			onSome: (blocker) => [members, blockerStratum(blocker)]
		})
	}
}

/**
 * An array member's operation and relation, the key a served call gives its facts under (adapter/served/load.ts
 * ChangeCall): an enumerated member's, or a generated addition's insert into Ticket; a query member has none.
 */
const arrayKey = (m: Member): string | undefined =>
	m.kind === "enumerated"
		? `${m.op} ${m.relation}`
		: m.kind === "generated"
			? "insert Ticket"
			: undefined

/**
 * A ChangeSet as a served workload can hold it (`servable`): each later stratum's array members of an operation and
 * relation an earlier stratum's already hold left out, and a stratum left empty with them; and what it left out
 * (`repeats`), each operation and relation once per stratum that repeats it, in strata order, which generate refuses
 * as `repeated` (write/program/served-members.ts servedMembers) and the types refuse at workload() (ArraysOnce). The
 * members of one operation and relation in one stratum are one member of the ChangeSet, so they repeat nothing.
 */
const servingOf = (
	op: GrizzleOp
): { readonly servable: GrizzleOp; readonly repeats: ReadonlyArray<string> } => {
	const held = new Set<string>()
	const repeats: Array<string> = []
	const strata: Array<ReadonlyArray<Member>> = []
	for (const stratum of op.strata) {
		const keys = Arr.dedupe(
			Arr.flatMap(stratum, (m) => {
				const key = arrayKey(m)
				return key === undefined ? [] : [key]
			})
		)
		const repeated = Arr.filter(keys, (key) => held.has(key))
		appendAll(repeats, repeated)
		const kept = Arr.filter(stratum, (m) => {
			const key = arrayKey(m)
			return key === undefined || !repeated.includes(key)
		})
		for (const key of keys) {
			held.add(key)
		}
		if (kept.length > 0) {
			strata.push(kept)
		}
	}
	return { servable: { strata }, repeats }
}

/** The relations a direct DELETE draws its key from: every one but Ticket, whose serial a direct writer never deletes. */
const deletable: Arr.NonEmptyReadonlyArray<Rel> = ["Item", "Note", "Code", "Room", "Ref", "Zed"]

/** The relations `app` and `direct` hold and write: every one but `inserter`'s Badge and Gate. */
const shared: Arr.NonEmptyReadonlyArray<Rel> = [
	"Item",
	"Note",
	"Code",
	"Ticket",
	"Room",
	"Ref",
	"Zed"
]

const statementGen: Gen<Statement> = weighted([
	[
		6,
		(source): Statement => {
			const relation = source.draw(element(shared))
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
	/**
	 * The ChangeSets of the case no served workload holds, each repeating an array member's operation and relation in
	 * a later stratum: the planted one, a first stratum's insert into Zed beside a blocker's, and each the drawn race
	 * drew, which its race runs as a served workload holds it (`servingOf`).
	 */
	readonly refused: ReadonlyArray<GrizzleOp>
}

const raceCaseGen: Gen<RaceCase> = (source) => {
	const drawn = labelGenerated(source.draw(drawnRaceGen))
	const planted = ops(
		[ins("Zed", [source.draw(element(blockers))])],
		blockerStratum(source.draw(element(blockers)))
	)
	const repeating = Arr.flatMap(drawn.sessions, (session) =>
		session.kind === "grizzle"
			? Arr.filter(session.ops, (op) => servingOf(op).repeats.length > 0)
			: []
	)
	return {
		races: [
			...Arr.map(plantedRaces, (name) => source.draw(plantedRaceGen(name))),
			{
				...drawn,
				sessions: Arr.map(drawn.sessions, (session) =>
					session.kind === "grizzle"
						? { ...session, ops: Arr.map(session.ops, (op) => servingOf(op).servable) }
						: session
				)
			}
		],
		refused: [planted, ...repeating]
	}
}

const relationOf = { Item, Note, Code, Ticket, Room, Ref, Zed, Badge, Gate, Claim, Seat } as const

/** A fact as the record a ChangeSet member gives. */
const recordOf = (relation: Rel, f: Fact): Readonly<Record<string, unknown>> => {
	const cell = (i: number): string => f[i] ?? ""
	switch (relation) {
		case "Item":
		case "Note":
			return { id: Number(cell(0)), label: cell(1) }
		case "Code":
		case "Badge":
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
		case "Gate":
			return { id: Number(cell(0)) }
		case "Claim":
		case "Seat":
			return { id: Number(cell(0)), holder: Number(cell(1)) }
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
		case "Badge":
		case "Claim":
		case "Seat":
			return `(${cell(0)}, ${cell(1)})`
		case "Room":
			return `(${cell(0)}, pg_catalog.int8range(${cell(1)}, ${cell(2)}), '${cell(3)}')`
		case "Zed":
		case "Gate":
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
			case "Badge":
				return `${o.names.column(Badge, "id")}, ${o.names.column(Badge, "code")}`
			case "Gate":
				return o.names.column(Gate, "id")
			case "Claim":
				return `${o.names.column(Claim, "id")}, ${o.names.column(Claim, "holder")}`
			case "Seat":
				return `${o.names.column(Seat, "id")}, ${o.names.column(Seat, "holder")}`
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
			`SELECT 'Zed', ${o.names.column(Zed, "id")}::text, NULL, NULL, NULL FROM ${t("Zed")}`,
			`SELECT 'Badge', ${o.names.column(Badge, "id")}::text, ${o.names.column(Badge, "code")}::text, NULL, NULL FROM ${t("Badge")}`,
			`SELECT 'Gate', ${o.names.column(Gate, "id")}::text, NULL, NULL, NULL FROM ${t("Gate")}`,
			`SELECT 'Claim', ${o.names.column(Claim, "id")}::text, ${o.names.column(Claim, "holder")}::text, NULL, NULL FROM ${t("Claim")}`,
			`SELECT 'Seat', ${o.names.column(Seat, "id")}::text, ${o.names.column(Seat, "holder")}::text, NULL, NULL FROM ${t("Seat")}`
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
	...Arr.map(
		["Item", "Note", "Code", "Ticket", "Ref", "Zed", "Badge", "Gate"] as const,
		(relation): LawSpec => ({
			kind: "unique",
			law: o.names.primaryKeyLaw(relationOf[relation]),
			relation,
			columns: [0]
		})
	),
	{ kind: "unique", law: o.names.lawOf(codeKey), relation: "Code", columns: [1] },
	{ kind: "unique", law: o.names.lawOf(badgeCode), relation: "Badge", columns: [1] },
	{ kind: "unique", law: o.names.lawOf(ticketLabel), relation: "Ticket", columns: [1] },
	{ kind: "spanKey", law: o.names.primaryKeyLaw(Room), relation: "Room" },
	{ kind: "contained", law: o.names.lawOf(refItem), from: "Ref", column: 1, to: "Item", target: 0 }
]

/** A grizzle op as a ChangeSet value over the role app's view of the installed schema, with its parameters. */
const changeSetOf = (
	o: Opened,
	op: GrizzleOp
): { readonly changes: ChangeSetValue; readonly params: ParamMap } => {
	const appRole = o.rig.worlds.app
	const params: Record<string, ReadonlyArray<unknown>> = {}
	const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
		Arr.reduce(
			members,
			ChangeSet.empty(appRole),
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
							query(appRole).rule((r: RuleValue) =>
								r.match(Note, { id: Number(m.id) }).find({ id: Number(m.id), label: m.label })
							)
						)
					case "scoped": {
						const name = `items${Rec.keys(params).length}_${i}`
						params[name] = Arr.map(m.facts, (f) => recordOf("Note", f))
						return changes
							.put(
								Note,
								query(appRole).rule((r: RuleValue) => {
									const { id, label } = v(Note, "note")
									return r.match(r.relation(name, Note), { id, label }).find({ id, label })
								})
							)
							.delete(
								Note,
								query(appRole).rule((r: RuleValue) => {
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
							query(appRole).rule((r: RuleValue) => {
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

/** A call's facts: under each op of a change member's array members, the rows of each, under its relation's name. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/**
 * A grizzle op's facts as its served call gives them (adapter/served/load.ts ChangeCall): each array member's records
 * under its operation and its relation, a generated addition's labels under Ticket's insert.
 */
const factsOf = (op: GrizzleOp): CallFacts => {
	const facts: Record<string, Record<string, Array<unknown>>> = {}
	const add = (
		kind: "insert" | "delete" | "put",
		relation: Rel,
		records: ReadonlyArray<unknown>
	) => {
		const byRelation = facts[kind] ?? {}
		byRelation[relation] = [...(byRelation[relation] ?? []), ...records]
		facts[kind] = byRelation
	}
	for (const m of op.strata.flat()) {
		if (m.kind === "enumerated") {
			add(
				m.op,
				m.relation,
				Arr.map(m.facts, (f) => recordOf(m.relation, f))
			)
		} else if (m.kind === "generated") {
			add(
				"insert",
				"Ticket",
				Arr.map(m.labels, (label) => ({ label }))
			)
		}
	}
	return facts
}

/**
 * The put targets a served write runs, as its statements' steps say them (runtime/write/steps.ts WriteStep): an
 * upsert's ON CONFLICT DO UPDATE, an update in place's UPDATE ... FROM, a MERGE, and a DELETE of the occupants a put
 * displaces, the pair's first half.
 */
const putTargetsOf = (change: RoleChange): ReadonlyArray<RaceFeature> =>
	Arr.flatMap(
		change.change.entry.program.flight.statements,
		({ step }): ReadonlyArray<RaceFeature> => {
			const writes =
				step.kind === "write"
					? [step]
					: step.kind === "single"
						? Arr.map(step.parts, (p) => p.step)
						: []
			return Arr.flatMap(writes, ({ result }): ReadonlyArray<RaceFeature> => {
				switch (result.kind) {
					case "upsert":
						return ["put target onConflictDoUpdate"]
					case "update":
						return ["put target updateFrom"]
					case "merge":
						return ["put target merge"]
					case "delete":
						return result.mode === "displacing" ? ["put target deleteThenInsert"] : []
					case "insert":
					case "spanClassify":
						return []
				}
			})
		}
	)

/** Why a race's ChangeSets do not serve: a compile's refusal at its place, or the refusal of loading what it served. */
const refusalText = (refused: ServedRefusal | CompileError | OpenError): string =>
	"place" in refused
		? `${Formatter.format(refused.place)}: ${Formatter.format(refused.error)}`
		: refused.message

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
	| `put target ${PutChoice["target"]}`
	| `pair reason ${Extract<PutChoice, { readonly target: "deleteThenInsert" }>["reason"]}`
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
	| "a generated addition met its label's occupant unseen"
	| "a repeat across strata refused"
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
	"grizzle unchanged",
	"grizzle refused",
	"transient GeneratedSerialUnique",
	"direct committed",
	"a step waited",
	"a write held between its strata",
	"generated serial committed",
	"explicit serial committed",
	"a generated addition met its label's occupant unseen",
	"a repeat across strata refused",
	"every order",
	...Arr.map(plantedRaces, (name): RaceFeature => `planted ${name}`)
]

/** A race the model refused, or a case that could not run one, with the race and why. */
class RaceFailed extends Data.TaggedError("RaceFailed")<{ readonly message: string }> {}

/** What a grizzle write's retried call answered, its law read back to its LawId through the installation's laws. */
const answerOf = (
	reported: (refused: IdentifiedLaw) => LawId,
	r: Result.Result<Retried<WriteAnswer<WrittenOutcome>>, CallError>
): { readonly refused: ReadonlyArray<TransientTag>; readonly answer: GrizzleAnswer } => {
	if (Result.isFailure(r)) {
		return { refused: [], answer: { kind: "failed", what: r.failure.kind } }
	}
	const value = r.success.answered
	return { refused: r.success.refused, answer: grizzleAnswer(reported, value) }
}

/** A write's answer as the model judges it: a refusal names its one law, so a refusal naming several is a failure. */
const grizzleAnswer = (
	reported: (refused: IdentifiedLaw) => LawId,
	value: WriteAnswer<WrittenOutcome>
): GrizzleAnswer => {
	switch (value.kind) {
		case "refused": {
			const [law, ...more] = value.refused.laws
			return more.length === 0
				? { kind: "refused", law: reported(law) }
				: {
						kind: "failed",
						what: `a refusal naming ${Arr.length(value.refused.laws)} laws: ${Arr.join(
							Arr.map(value.refused.laws, reported),
							", "
						)}`
					}
		}
		case "outsideWorld":
		case "refreshed":
			return { kind: "failed", what: value.kind }
		case "accepted":
		case "unchanged":
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
	return stateOfRows(run.state.rows)
}

/** A state from the rows of the state's read (sqlOf read): each relation's name, then its columns, padded to four. */
const stateOfRows = (rows: TextRows): State => {
	const facts: Record<Rel, Array<Fact>> = {
		Item: [],
		Note: [],
		Code: [],
		Ticket: [],
		Room: [],
		Ref: [],
		Zed: [],
		Badge: [],
		Gate: [],
		Claim: [],
		Seat: []
	}
	for (const [relation, ...cells] of rows) {
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
		const app = yield* o.rig.servedWriter("app", openApp(o.rig), (db) =>
			answered(db.workload.noop.once({ params: {}, facts: {} }))
		)
		const app2 = yield* o.rig.servedWriter("app2", openApp(o.rig), (db) =>
			answered(db.workload.noop.once({ params: {}, facts: {} }))
		)
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
				/** Each grizzle write of the race, by session and step, and the ChangeSet its op is. */
				const built = new Map(
					Arr.flatMap(race.sessions, (session) =>
						session.kind === "grizzle"
							? Arr.map(session.ops, (op, i): readonly [string, ReturnType<typeof changeSetOf>] => [
									`${session.actor}_${i}`,
									changeSetOf(o, op)
								])
							: []
					)
				)
				const served = yield* Effect.mapError(
					servedChanges(
						o,
						"app",
						Rec.fromEntries(Arr.map([...built], ([name, b]) => [name, b.changes]))
					),
					(refused) => report(`the race's ChangeSets do not serve: ${refusalText(refused)}`)
				)
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
						const name = `${session.actor}_${i}`
						const { params } = defined(built.get(name), `the ChangeSet of ${name}`)
						const change = defined(served.changes.get(name), `the served change ${name}`)
						c.noteAll([
							...Arr.flatMap(
								defined(served.choices.get(name), `the put choices of ${name}`),
								(choice): ReadonlyArray<RaceFeature> =>
									choice.target === "deleteThenInsert" ? [`pair reason ${choice.reason}`] : []
							),
							...putTargetsOf(change)
						])
						const key = `${session.actor}#${i}`
						steps.push({
							label: describeOp(op),
							outcome: writeOnce(onceCalls(ctx, change.member))({
								params,
								facts: factsOf(op)
							}).pipe(
								answered,
								untilAnswered,
								Effect.result,
								Effect.map((r) => {
									seen.set(key, answerOf(o.names.reported, r))
									return succeeded
								})
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
							const answer = defined(
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
									refused: answer.refused,
									answer: answer.answer
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
									return judgedProblem(describeRace(race, sql), problem)
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
						RunRefused: (e) => Effect.fail(new RaceFailed({ message: e.message })),
						NoSerialOrder: (e) => Effect.fail(new RaceFailed({ message: e.message })),
						AfterCycle: (e) => Effect.fail(new RaceFailed({ message: e.message }))
					})
				)
				c.noteAll(reached)
			})
		for (const op of rc.refused) {
			const expected = Arr.sort(servingOf(op).repeats, Order.String)
			const served = yield* Effect.result(
				servedChanges(o, "app", { repeated: changeSetOf(o, op).changes })
			)
			const refused =
				Result.isFailure(served) &&
				"place" in served.failure &&
				served.failure.error._tag === "UnservedMember"
					? Arr.sort(
							Arr.map(served.failure.error.reasons, (r) =>
								r.kind === "repeated" ? `${r.op} ${r.relation}` : r.kind
							),
							Order.String
						)
					: undefined
			if (refused === undefined || Arr.join(refused, "\n") !== Arr.join(expected, "\n")) {
				return yield* new RaceFailed({
					message: `${describeOp(op)} repeats ${Arr.join(expected, ", ")} across its strata, which generate refuses as repeated; it ${
						refused === undefined
							? Result.isSuccess(served)
								? "served"
								: `was refused otherwise: ${refusalText(served.failure)}`
							: `was refused for ${Arr.join(refused, ", ")}`
					}`
				})
			}
			c.note("a repeat across strata refused")
		}
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
			...(generates &&
			x.refused.includes("SerializationFailure") &&
			race.origin.kind === "planted" &&
			race.origin.name === "generated beside a deletion of its label's occupant"
				? ["a generated addition met its label's occupant unseen" as const]
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
 * A call of the role `inserter`, which generate certifies READ COMMITTED: the Badge facts it states, then the Gate
 * facts it inserts after them, none or one.
 */
interface InserterCall {
	readonly badges: Arr.NonEmptyReadonlyArray<Fact>
	readonly gates: ReadonlyArray<Fact>
}

/** An inserter call as the model reads it: Badge's insertion, then Gate's where it states a Gate fact. */
const inserterOp = (call: InserterCall): GrizzleOp => ({
	strata: [
		[{ kind: "enumerated", op: "insert", relation: "Badge", facts: call.badges }],
		...(Arr.isReadonlyArrayNonEmpty(call.gates)
			? [
					[
						{
							kind: "enumerated" as const,
							op: "insert" as const,
							relation: "Gate" as const,
							facts: call.gates
						}
					]
				]
			: [])
	]
})

/** An inserter call's facts as its served call gives them: both of addBadges' array members, each maybe empty. */
const inserterFacts = (call: InserterCall): CallFacts => ({
	insert: {
		Badge: Arr.map(call.badges, (f) => recordOf("Badge", f)),
		Gate: Arr.map(call.gates, (f) => recordOf("Gate", f))
	}
})

/**
 * Badge facts drawn over the small domains, one to two at distinct ids drawn as such, so a call's facts collide only at
 * a code.
 */
const badgesGen: Gen<Arr.NonEmptyReadonlyArray<Fact>> = (source) =>
	nonEmptyList(
		Arr.map(source.draw(shuffled(ids, { min: 1, max: 2 })), (id): Fact => [id, source.draw(idGen)]),
		"an inserter call's Badge facts"
	)

const inserterCallGen: Gen<InserterCall> = (source) => ({
	badges: source.draw(badgesGen),
	gates: Option.match(source.draw(option(element(blockers))), {
		onNone: () => [],
		onSome: (g) => [[g]]
	})
})

/** A lawful Badge state: distinct ids, each with a distinct code. */
const badgeStateGen: Gen<ReadonlyArray<Fact>> = (source) => {
	const keys = source.draw(subarray(ids))
	const codes = source.draw(shuffled(ids, { min: 3, max: 3 }))
	return Arr.map(keys, (k, i): Fact => [k, codes[i] ?? k])
}

/**
 * Two calls of `inserter`, `ins1`'s and `ins2`'s, over a stored Badge state, and whether the owner holds Gate in SHARE
 * mode beside them: a call that inserts a Gate fact while the owner holds it waits there, its Badge rows written and
 * uncommitted, which is how the other call meets them in flight.
 */
interface InserterCase {
	readonly origin: "drawn" | "planted candidate key race" | "planted independent children"
	readonly initial: ReadonlyArray<Fact>
	readonly calls: readonly [InserterCall, InserterCall]
	readonly held: boolean
}

/** The candidate key race: ins1 inserts a code held at its gate, ins2 another id at the same code. */
const candidateKeyRaceGen: Gen<InserterCase> = (source) => {
	const [k1, k2] = source.draw(shuffled(ids, { min: 2, max: 2 }))
	const code = source.draw(idGen)
	return {
		origin: "planted candidate key race",
		initial: [],
		calls: [
			{ badges: [[k1 ?? "1", code]], gates: [[source.draw(element(blockers))]] },
			{ badges: [[k2 ?? "2", code]], gates: [] }
		],
		held: true
	}
}

/** Independent children: ins1 held at its gate, ins2 at another id and another code, which runs while ins1 waits. */
const independentChildrenGen: Gen<InserterCase> = (source) => {
	const [k1, k2] = source.draw(shuffled(ids, { min: 2, max: 2 }))
	const [c1, c2] = source.draw(shuffled(ids, { min: 2, max: 2 }))
	return {
		origin: "planted independent children",
		initial: [],
		calls: [
			{ badges: [[k1 ?? "1", c1 ?? "1"]], gates: [[source.draw(element(blockers))]] },
			{ badges: [[k2 ?? "2", c2 ?? "2"]], gates: [] }
		],
		held: true
	}
}

const inserterCaseGen: Gen<InserterCase> = weighted([
	[1, candidateKeyRaceGen],
	[1, independentChildrenGen],
	[
		1,
		(source) => ({
			origin: "drawn",
			initial: source.draw(badgeStateGen),
			calls: [source.draw(inserterCallGen), source.draw(inserterCallGen)],
			held: source.draw(boolean)
		})
	]
])

/** Whether two calls state no Badge id, no Badge code and no Gate fact in common: independent children. */
const independent = (a: InserterCall, b: InserterCall): boolean => {
	const cells = (call: InserterCall, i: number): ReadonlyArray<string> =>
		Arr.map(call.badges, (f) => f[i] ?? "")
	const meet = (x: ReadonlyArray<string>, y: ReadonlyArray<string>): boolean =>
		Arr.some(x, (v) => y.includes(v))
	return (
		!meet(cells(a, 0), cells(b, 0)) &&
		!meet(cells(a, 1), cells(b, 1)) &&
		!meet(
			Arr.map(a.gates, (f) => f[0] ?? ""),
			Arr.map(b.gates, (f) => f[0] ?? "")
		)
	)
}

/**
 * What an inserter call answered on its one try: its answer as the model judges it, a transient refusal among its
 * failures, and, where it was refused, how its laws were decided and its witness.
 */
interface InserterAnswer {
	readonly answer: GrizzleAnswer
	readonly rejection: Option.Option<{
		readonly decided: Refused["kind"]
		readonly witness: Witness
	}>
}

const inserterAnswerOf = (
	reported: (refused: IdentifiedLaw) => LawId,
	r: Result.Result<WriteAnswer<WrittenOutcome>, CallError>
): InserterAnswer => {
	if (Result.isFailure(r)) {
		return {
			answer: { kind: "failed", what: `${r.failure.kind}: ${r.failure.message}` },
			rejection: Option.none()
		}
	}
	const value = r.success
	return {
		answer: grizzleAnswer(reported, value),
		rejection:
			value.kind === "refused"
				? Option.some({ decided: value.refused.kind, witness: value.witness })
				: Option.none()
	}
}

/** A witness at Badge's code `code`, as a refusal at badgeCode reports it. */
const codeWitness = (code: string): Witness => ({
	kind: "key",
	relation: "Badge",
	values: { code: Number(code) }
})

/**
 * Why a refusal at badgeCode's witness is not one the call's facts allow, or undefined. A requested fact whose code a
 * visible row holds meets the probe, which witnesses that fact's own code; one whose code an in-flight insert holds
 * meets a 23505 once that insert commits, witnessed at the code the statement states where it states one, else
 * unreported (runtime/write/witness.ts uniqueJudgement). So a call stating one code is witnessed at it, and a call
 * stating several is witnessed at a code it states that another fact holds in the final state, or unreported.
 */
const witnessProblem = (call: InserterCall, witness: Witness, final: State): string | undefined => {
	const codes = Arr.dedupe(Arr.map(call.badges, (f) => f[1] ?? ""))
	const [code, ...more] = codes
	if (more.length === 0) {
		return deepEquals<Witness>(witness, codeWitness(code))
			? undefined
			: `its witness is ${Formatter.format(witness)}, where its one code ${code} is`
	}
	return witness.kind === "unreported" ||
		Arr.some(
			codes,
			(c) =>
				deepEquals<Witness>(witness, codeWitness(c)) && Arr.some(final.Badge, (f) => f[1] === c)
		)
		? undefined
		: `its witness is ${Formatter.format(witness)}, no code it states that another fact holds`
}

/**
 * Why a certified READ COMMITTED call broke the owner's item 1, or undefined: it commits or is refused by a law on its
 * one try, never failed, a transient refusal among its failures; and a refusal at badgeCode names it as decided,
 * `every`, with a witness its facts allow (witnessProblem) over the state the run left, `final`.
 */
const firstTryProblem = (
	label: string,
	call: InserterCall,
	answered: InserterAnswer,
	codeLaw: LawId,
	final: State
): string | undefined => {
	if (answered.answer.kind === "failed") {
		return `${label} failed: ${answered.answer.what}, where a certified READ COMMITTED call commits or is refused by a law on its one try`
	}
	if (answered.answer.kind !== "refused" || answered.answer.law !== codeLaw) {
		return undefined
	}
	return Option.match(answered.rejection, {
		onNone: () => `${label} was refused at badgeCode with no refusal`,
		onSome: (rejection) => {
			if (rejection.decided !== "every") {
				return `${label} was refused at badgeCode as ${rejection.decided}, where a unique object's refusal is decided, every`
			}
			const problem = witnessProblem(call, rejection.witness, final)
			return problem === undefined ? undefined : `${label} was refused at badgeCode: ${problem}`
		}
	})
}

/** The inserter search's notes: each answer, each witness, and the waits that make a call's run a race. */
type InserterFeature =
	| `inserter ${GrizzleAnswer["kind"]}`
	| "inserter witness reported"
	| "inserter witness unreported"
	| "an inserter waited on the other's insert"
	| "an inserter held at its gate"
	| "independent inserters ran at once"
	| "planted candidate key race"
	| "planted independent children"

/** The inserters' writers, by the session each runs. */
const inserterSessions = ["ins1", "ins2"] as const

/**
 * The inserter race: `inserter`'s change as `served` gives it (the served file's, or a plant's), run by two writers of
 * the role over the case's Badge state, the owner holding Gate beside them where the case says, in every order. Each
 * run is judged by the serial model, each call by the owner's item 1 (firstTryProblem), and two independent calls must
 * never wait on each other.
 */
const runInserters = (
	ic: InserterCase,
	c: Case<InserterFeature>
): Effect.Effect<void, RaceFailed | RaceError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const o = yield* open
		const sql = sqlOf(o)
		const laws = lawsOf(o)
		const codeLaw = o.names.lawOf(badgeCode)
		const change = yield* committedInserter(o)
		const ins1 = yield* o.rig.servedWriter("ins1", openInserter(o.rig), (db) =>
			answered(
				db.workload.addBadges.once({ params: {}, facts: { insert: { Badge: [], Gate: [] } } })
			)
		)
		const ins2 = yield* o.rig.servedWriter("ins2", openInserter(o.rig), (db) =>
			answered(
				db.workload.addBadges.once({ params: {}, facts: { insert: { Badge: [], Gate: [] } } })
			)
		)
		const writers = { ins1, ins2 }
		const actors = yield* openActors(s, {
			gate: { kind: "raw", as: o.rig.installed.ambientOwner.credentials }
		})
		const initial: State = { ...emptyState, Badge: ic.initial }
		const calls = Arr.zip(inserterSessions, ic.calls)
		const describe = Arr.join(
			[
				`over Badge ${Formatter.format(ic.initial)}${ic.held ? ", Gate held by the owner" : ""}`,
				...Arr.map(calls, ([actor, call]) => `${actor}: ${describeOp(inserterOp(call))}`)
			],
			"\n"
		)
		if (ic.origin !== "drawn") {
			c.note(ic.origin)
		}
		const seen = new Map<string, InserterAnswer>()
		const txns: ReadonlyArray<Txn> = [
			...Arr.map(calls, ([actor, call]): Txn => ({
				kind: "grizzle",
				session: actor,
				steps: [
					{
						label: describeOp(inserterOp(call)),
						outcome: Effect.map(
							Effect.result(
								answered(
									writeOnce(onceCalls(writers[actor].ctx, change.member))({
										params: {},
										facts: inserterFacts(call)
									})
								)
							),
							(r) => {
								seen.set(actor, inserterAnswerOf(o.names.reported, r))
								return succeeded
							}
						),
						footprint: reaches(["Badge", "Gate"])
					}
				],
				after: undefined
			})),
			...(ic.held
				? [
						{
							kind: "direct" as const,
							session: "gate",
							steps: [
								interleaveStep(`LOCK TABLE ${o.names.table(Gate)} IN SHARE MODE`, reaches(["Gate"]))
							],
							end: "commit" as const,
							after: undefined
						}
					]
				: [])
		]
		const reached: Array<InserterFeature> = []
		yield* exploreInterleavings(
			o.rig.env,
			{ direct: { gate: actors.gate }, grizzle: { ins1: ins1.actor, ins2: ins2.actor } },
			{
				name: `inserters ${ic.origin}`,
				txns,
				reset: Effect.andThen(
					Effect.sync(() => {
						seen.clear()
					}),
					o.rig.replace(sql.reset(initial))
				),
				state: { _tag: "Read", sql: sql.read },
				model: (run) =>
					Effect.sync(() => {
						const observed = Arr.map(calls, ([actor, call]): Observed => {
							const move = Option.getOrThrowWith(
								Arr.findFirst(run.moves, (m) => m.session === actor),
								() => new Error(`${actor}'s call made no move`)
							)
							if (move.result._tag === "Unfinished") {
								throw new Error(`${actor}'s call did not finish in a run that ran every move`)
							}
							const answer = defined(seen.get(actor), `${actor}'s answer`)
							return {
								kind: "grizzle",
								label: `${actor}'s call`,
								session: actor,
								op: inserterOp(call),
								span: { start: move.issued, end: move.result.at },
								refused: [],
								answer: answer.answer
							}
						})
						const final = stateOf(run)
						for (const [actor, call] of calls) {
							const problem = firstTryProblem(
								`${actor}'s call`,
								call,
								defined(seen.get(actor), `${actor}'s answer`),
								codeLaw,
								final
							)
							if (problem !== undefined) {
								return refusedJudgment(`${describe}\n${problem}`)
							}
						}
						const waitedOn = (on: string): boolean =>
							Arr.some(
								run.moves,
								(m) =>
									m.observed._tag === "Waited" &&
									m.session !== on &&
									m.session !== "gate" &&
									m.observed.on.includes(on)
							)
						const crossed = waitedOn("ins1") || waitedOn("ins2")
						const [first, second] = ic.calls
						if (crossed && independent(first, second)) {
							return refusedJudgment(
								`${describe}\none inserter waited on the other, where two calls stating no key, code or gate in common never wait`
							)
						}
						const judged = judgeRun(laws, initial, observed, final)
						if (judged !== undefined) {
							return judgedProblem(describe, judged)
						}
						appendAll(reached, [
							...Arr.flatMap([...seen.values()], (a): ReadonlyArray<InserterFeature> => [
								`inserter ${a.answer.kind}`,
								...Option.match(a.rejection, {
									onNone: (): ReadonlyArray<InserterFeature> => [],
									onSome: (r): ReadonlyArray<InserterFeature> => [
										r.witness.kind === "key"
											? "inserter witness reported"
											: "inserter witness unreported"
									]
								})
							]),
							...(crossed ? ["an inserter waited on the other's insert" as const] : []),
							...(waitedOn("gate") ? ["an inserter held at its gate" as const] : []),
							...(independent(first, second) &&
							Arr.some(observed, (x) =>
								Arr.some(observed, (y) => x.session !== y.session && overlap(x.span, y.span))
							)
								? ["independent inserters ran at once" as const]
								: [])
						])
						return allowed
					}),
				maxInterleavings: runawayInterleavings
			},
			every
		).pipe(
			Effect.catchTags({
				InterleavingFailed: (e) => Effect.fail(new RaceFailed({ message: e.message })),
				RunRefused: (e) => Effect.fail(new RaceFailed({ message: e.message })),
				NoSerialOrder: (e) => Effect.fail(new RaceFailed({ message: e.message })),
				AfterCycle: (e) => Effect.fail(new RaceFailed({ message: e.message }))
			})
		)
		c.noteAll(reached)
	})

/** Whether two spans of a run's clock overlap. */
const overlap = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end

/**
 * The role `inserter`'s changes as the served file holds them, where generate certified the role READ COMMITTED; any
 * other level fails the case, since an insert-only role writing tables no other role writes is certified READ
 * COMMITTED.
 */
const certifiedInserter = (
	o: Opened
): Effect.Effect<ReadonlyMap<string, RoleChange>, RaceFailed | OpenError> =>
	Effect.flatMap(committedChanges(o, "inserter"), (committed) =>
		committed.isolation === "readCommitted"
			? Effect.succeed(committed.changes)
			: Effect.fail(
					new RaceFailed({
						message: `generate certified inserter ${committed.isolation}, where an insert-only role writing tables no other role writes runs READ COMMITTED`
					})
				)
	)

/** The served file's own `inserter` change: what every writer of the role runs. */
const committedInserter = (
	o: Opened
): Effect.Effect<RoleChange, RaceFailed | RaceError, Substrate> =>
	Effect.map(certifiedInserter(o), (changes) =>
		defined(changes.get("addBadges"), "the served change addBadges")
	)

/**
 * A call of the role `claimer`, which generate certifies READ COMMITTED: the Claim it states and the Seat it states,
 * each raced in a statement of its own, both under the call's own holder, which no other call and no stored fact
 * holds, then the Gate fact it inserts after them, none or one.
 */
interface ClaimerCall {
	readonly claim: string
	readonly seat: string
	readonly holder: string
	readonly gates: ReadonlyArray<Fact>
}

/** A claimer call as the model reads it: Claim's insertion, Seat's, then Gate's where it states a Gate fact. */
const claimerOp = (call: ClaimerCall): GrizzleOp => ({
	strata: [
		[{ kind: "enumerated", op: "insert", relation: "Claim", facts: [[call.claim, call.holder]] }],
		[{ kind: "enumerated", op: "insert", relation: "Seat", facts: [[call.seat, call.holder]] }],
		...(Arr.isReadonlyArrayNonEmpty(call.gates)
			? [
					[
						{
							kind: "enumerated" as const,
							op: "insert" as const,
							relation: "Gate" as const,
							facts: call.gates
						}
					]
				]
			: [])
	]
})

/** A claimer call's facts as its served call gives them: each of claimSeat's array members. */
const claimerFacts = (call: ClaimerCall): CallFacts => ({
	insert: {
		Claim: [recordOf("Claim", [call.claim, call.holder])],
		Seat: [recordOf("Seat", [call.seat, call.holder])],
		Gate: Arr.map(call.gates, (f) => recordOf("Gate", f))
	}
})

/** The holder no call states, which the stored Claims and Seats hold. */
const storedHolder = "9"

/** A lawful Claim or Seat state: some of the ids, each held by the stored holder. */
const claimedStateGen: Gen<ReadonlyArray<Fact>> = (source) =>
	Arr.map(source.draw(subarray(ids)), (id): Fact => [id, storedHolder])

/**
 * Two calls of `claimer`, `cl1`'s and `cl2`'s, holders 1 and 2, over stored Claims and Seats, and whether the owner
 * holds Gate in SHARE mode beside them: a call that inserts a Gate fact while the owner holds it waits there, its Claim
 * and Seat written and uncommitted, which is how the other call meets them in flight.
 */
interface ClaimerCase {
	readonly origin: "drawn" | "planted won one and met the other" | "planted both met in flight"
	readonly claims: ReadonlyArray<Fact>
	readonly seats: ReadonlyArray<Fact>
	readonly calls: readonly [ClaimerCall, ClaimerCall]
	readonly held: boolean
}

/** cl1 claims and seats at its gate; cl2 claims another id at the same seat, so it wins one and meets the other. */
const wonAndMetGen: Gen<ClaimerCase> = (source) => {
	const [a, b] = source.draw(shuffled(ids, { min: 2, max: 2 }))
	const seat = source.draw(idGen)
	return {
		origin: "planted won one and met the other",
		claims: [],
		seats: [],
		calls: [
			{ claim: a ?? "1", seat, holder: "1", gates: [[source.draw(element(blockers))]] },
			{ claim: b ?? "2", seat, holder: "2", gates: [] }
		],
		held: true
	}
}

/** cl1 claims and seats at its gate; cl2 states the same Claim and Seat, which it meets in flight. */
const bothMetGen: Gen<ClaimerCase> = (source) => {
	const claim = source.draw(idGen)
	const seat = source.draw(idGen)
	return {
		origin: "planted both met in flight",
		claims: [],
		seats: [],
		calls: [
			{ claim, seat, holder: "1", gates: [[source.draw(element(blockers))]] },
			{ claim, seat, holder: "2", gates: [] }
		],
		held: true
	}
}

const claimerCallGen =
	(holder: string): Gen<ClaimerCall> =>
	(source) => ({
		claim: source.draw(idGen),
		seat: source.draw(idGen),
		holder,
		gates: Option.match(source.draw(option(element(blockers))), {
			onNone: () => [],
			onSome: (g) => [[g]]
		})
	})

const claimerCaseGen: Gen<ClaimerCase> = weighted([
	[1, wonAndMetGen],
	[1, bothMetGen],
	[
		2,
		(source) => ({
			origin: "drawn",
			claims: source.draw(claimedStateGen),
			seats: source.draw(claimedStateGen),
			calls: [source.draw(claimerCallGen("1")), source.draw(claimerCallGen("2"))],
			held: source.draw(boolean)
		})
	]
])

/** A row a claimer call reads back, `[id, holder]` as text, where `row` is one. */
const claimedRow = (row: unknown): Option.Option<Fact> =>
	Predicate.hasProperty(row, "id") &&
	Predicate.hasProperty(row, "holder") &&
	typeof row.id === "number" &&
	typeof row.holder === "number"
		? Option.some([String(row.id), String(row.holder)])
		: Option.none()

/** The rows of the read-back `name` of a claimer's outcome, none where it is no list of rows. */
const readBack = (reads: unknown, name: string): Option.Option<ReadonlyArray<Fact>> => {
	if (!Predicate.hasProperty(reads, name) || !Arr.isArray(reads[name])) {
		return Option.none()
	}
	return Option.all(Arr.map(reads[name], claimedRow))
}

/** What a claimer call answered on its one try: its answer as the model judges it, and its read-backs where it ran. */
interface ClaimerAnswer {
	readonly answer: GrizzleAnswer
	readonly reads: Option.Option<unknown>
}

const claimerAnswerOf = (
	reported: (refused: IdentifiedLaw) => LawId,
	r: Result.Result<WriteAnswer<WrittenOutcome>, CallError>
): ClaimerAnswer => {
	if (Result.isFailure(r)) {
		return {
			answer: { kind: "failed", what: `${r.failure.kind}: ${r.failure.message}` },
			reads: Option.none()
		}
	}
	const value = r.success
	return {
		answer: grizzleAnswer(reported, value),
		reads:
			value.kind === "accepted" || value.kind === "unchanged"
				? Option.some(value.reads)
				: Option.none()
	}
}

/** How a claimer call left one raced table: the row it added, or the row it met. */
type RaceEnd = "won" | "met"

/**
 * How a call that answered left the raced table `relation`, from what it read back, or why that is not the contract:
 * the fact it states added and nothing met, or nothing added and the one fact the final state holds at its key met,
 * another call's or a stored one, never its own.
 */
const raceEndOf = (
	reads: unknown,
	relation: "Claim" | "Seat",
	stated: Fact,
	final: State
): Result.Result<RaceEnd, string> => {
	const prefix = relation === "Claim" ? "claim" : "seat"
	const added = readBack(reads, `${prefix}Added`)
	const met = readBack(reads, `${prefix}Met`)
	if (Option.isNone(added) || Option.isNone(met)) {
		return Result.fail(
			`its read-backs of ${relation} are no lists of rows: ${Formatter.format(reads)}`
		)
	}
	const held = Arr.filter(final[relation], (f) => f[0] === stated[0])
	if (deepEquals(added.value, [stated]) && met.value.length === 0) {
		return Result.succeed("won")
	}
	if (added.value.length === 0 && deepEquals(met.value, held) && !deepEquals(held, [stated])) {
		return Result.succeed("met")
	}
	return Result.fail(
		`at ${relation} ${Formatter.format(stated)} it read back added ${Formatter.format(added.value)} and met ${Formatter.format(met.value)}, where the final state holds ${Formatter.format(held)} there`
	)
}

/** The claimer search's notes: each answer, how each call left the two raced tables, and the waits of a race. */
type ClaimerFeature =
	| `claimer ${GrizzleAnswer["kind"]}`
	| "a claimer won both raced tables"
	| "a claimer met both raced tables"
	| "a claimer won one raced table and met the other"
	| "a claimer waited on the other's race"
	| "a claimer held at its gate"
	| "planted won one and met the other"
	| "planted both met in flight"

/** The claimers' writers, by the session each runs. */
const claimerSessions = ["cl1", "cl2"] as const

/**
 * The claimer race: `claimer`'s served change, run by two writers of the role over the case's stored Claims and Seats,
 * the owner holding Gate beside them where the case says, in every order. Each run is judged by the serial model, in
 * which a raced table's insertion at a held key meets the fact there; each call answers on its one try, and its
 * read-backs show each raced table won, its own fact added, or met, the fact the final state holds at its key.
 */
const runClaimers = (
	cc: ClaimerCase,
	c: Case<ClaimerFeature>
): Effect.Effect<void, RaceFailed | RaceError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const o = yield* open
		const sql = sqlOf(o)
		const laws = lawsOf(o)
		const change = yield* committedClaimer(o)
		const cl1 = yield* o.rig.servedWriter("cl1", openClaimer(o.rig), (db) =>
			answered(
				db.workload.claimSeat.once({
					params: {},
					facts: { insert: { Claim: [], Seat: [], Gate: [] } }
				})
			)
		)
		const cl2 = yield* o.rig.servedWriter("cl2", openClaimer(o.rig), (db) =>
			answered(
				db.workload.claimSeat.once({
					params: {},
					facts: { insert: { Claim: [], Seat: [], Gate: [] } }
				})
			)
		)
		const writers = { cl1, cl2 }
		const actors = yield* openActors(s, {
			gate: { kind: "raw", as: o.rig.installed.ambientOwner.credentials }
		})
		const initial: State = { ...emptyState, Claim: cc.claims, Seat: cc.seats }
		const calls = Arr.zip(claimerSessions, cc.calls)
		const describe = Arr.join(
			[
				`over Claim ${Formatter.format(cc.claims)} and Seat ${Formatter.format(cc.seats)}${cc.held ? ", Gate held by the owner" : ""}`,
				...Arr.map(calls, ([actor, call]) => `${actor}: ${describeOp(claimerOp(call))}`)
			],
			"\n"
		)
		if (cc.origin !== "drawn") {
			c.note(cc.origin)
		}
		const seen = new Map<string, ClaimerAnswer>()
		const txns: ReadonlyArray<Txn> = [
			...Arr.map(calls, ([actor, call]): Txn => ({
				kind: "grizzle",
				session: actor,
				steps: [
					{
						label: describeOp(claimerOp(call)),
						outcome: Effect.map(
							Effect.result(
								answered(
									writeOnce(onceCalls(writers[actor].ctx, change.member))({
										params: {},
										facts: claimerFacts(call)
									})
								)
							),
							(r) => {
								seen.set(actor, claimerAnswerOf(o.names.reported, r))
								return succeeded
							}
						),
						footprint: reaches(["Claim", "Seat", "Gate"])
					}
				],
				after: undefined
			})),
			...(cc.held
				? [
						{
							kind: "direct" as const,
							session: "gate",
							steps: [
								interleaveStep(`LOCK TABLE ${o.names.table(Gate)} IN SHARE MODE`, reaches(["Gate"]))
							],
							end: "commit" as const,
							after: undefined
						}
					]
				: [])
		]
		const reached: Array<ClaimerFeature> = []
		yield* exploreInterleavings(
			o.rig.env,
			{ direct: { gate: actors.gate }, grizzle: { cl1: cl1.actor, cl2: cl2.actor } },
			{
				name: `claimers ${cc.origin}`,
				txns,
				reset: Effect.andThen(
					Effect.sync(() => {
						seen.clear()
					}),
					o.rig.replace(sql.reset(initial))
				),
				state: { _tag: "Read", sql: sql.read },
				model: (run) =>
					Effect.sync(() => {
						const final = stateOf(run)
						const notes: Array<ClaimerFeature> = []
						const observed = Arr.map(calls, ([actor, call]): Observed => {
							const move = Option.getOrThrowWith(
								Arr.findFirst(run.moves, (m) => m.session === actor),
								() => new Error(`${actor}'s call made no move`)
							)
							if (move.result._tag === "Unfinished") {
								throw new Error(`${actor}'s call did not finish in a run that ran every move`)
							}
							return {
								kind: "grizzle",
								label: `${actor}'s call`,
								session: actor,
								op: claimerOp(call),
								span: { start: move.issued, end: move.result.at },
								refused: [],
								answer: defined(seen.get(actor), `${actor}'s answer`).answer
							}
						})
						for (const [actor, call] of calls) {
							const got = defined(seen.get(actor), `${actor}'s answer`)
							if (got.answer.kind === "failed") {
								return refusedJudgment(
									`${describe}\n${actor}'s call failed: ${got.answer.what}, where a certified READ COMMITTED call answers on its one try`
								)
							}
							notes.push(`claimer ${got.answer.kind}`)
							if (Option.isSome(got.reads)) {
								const claim = raceEndOf(got.reads.value, "Claim", [call.claim, call.holder], final)
								const seat = raceEndOf(got.reads.value, "Seat", [call.seat, call.holder], final)
								if (Result.isFailure(claim)) {
									return refusedJudgment(`${describe}\n${actor}'s call: ${claim.failure}`)
								}
								if (Result.isFailure(seat)) {
									return refusedJudgment(`${describe}\n${actor}'s call: ${seat.failure}`)
								}
								notes.push(
									claim.success === seat.success
										? claim.success === "won"
											? "a claimer won both raced tables"
											: "a claimer met both raced tables"
										: "a claimer won one raced table and met the other"
								)
							}
						}
						const judged = judgeRun(laws, initial, observed, final)
						if (judged !== undefined) {
							return judgedProblem(describe, judged)
						}
						const waitedOn = (on: string): boolean =>
							Arr.some(
								run.moves,
								(m) =>
									m.observed._tag === "Waited" &&
									m.session !== on &&
									m.session !== "gate" &&
									m.observed.on.includes(on)
							)
						appendAll(reached, [
							...notes,
							...(waitedOn("cl1") || waitedOn("cl2")
								? ["a claimer waited on the other's race" as const]
								: []),
							...(waitedOn("gate") ? ["a claimer held at its gate" as const] : [])
						])
						return allowed
					}),
				maxInterleavings: runawayInterleavings
			},
			every
		).pipe(
			Effect.catchTags({
				InterleavingFailed: (e) => Effect.fail(new RaceFailed({ message: e.message })),
				RunRefused: (e) => Effect.fail(new RaceFailed({ message: e.message })),
				NoSerialOrder: (e) => Effect.fail(new RaceFailed({ message: e.message })),
				AfterCycle: (e) => Effect.fail(new RaceFailed({ message: e.message }))
			})
		)
		c.noteAll(reached)
	})

/**
 * The role `claimer`'s served change, where generate certified the role READ COMMITTED; any other level fails the
 * case, since an insert-only role writing tables only insert-only roles write is certified READ COMMITTED.
 */
const committedClaimer = (o: Opened): Effect.Effect<RoleChange, RaceFailed | OpenError> =>
	Effect.flatMap(committedChanges(o, "claimer"), (committed) =>
		committed.isolation === "readCommitted"
			? Effect.succeed(defined(committed.changes.get("claimSeat"), "the served change claimSeat"))
			: Effect.fail(
					new RaceFailed({
						message: `generate certified claimer ${committed.isolation}, where an insert-only role writing raced tables only insert-only roles write runs READ COMMITTED`
					})
				)
	)

/** Each level's BEGIN as PostgreSQL reads a change's: the oracle's own spelling. */
const beginTexts: { readonly [I in Isolation]: string } = {
	serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
	readCommitted: "BEGIN ISOLATION LEVEL READ COMMITTED"
}

/**
 * Why a call's one try sent other than at most one flight, opened by its level's BEGIN and closed by the next COMMIT
 * with every message inside it, or undefined. A call refused before the wire sends no flight.
 */
const framingProblem = (
	level: Isolation,
	answered: InserterAnswer,
	sent: ReadonlyArray<FrontendMessage>
): string | undefined => {
	const what = `it answered ${Formatter.format(answered.answer)} and sent ${Formatter.format(sent)}`
	let open = false
	let flights = 0
	for (const message of sent) {
		const begins = message.type === "Q" && Str.startsWith("BEGIN")(message.text)
		if (open === begins || (begins && message.text !== beginTexts[level])) {
			return `at ${level} ${Formatter.format(message)} came ${open ? "inside a flight, before its COMMIT" : `where a flight opens, with ${beginTexts[level]}`}; ${what}`
		}
		flights += begins ? 1 : 0
		open = begins || !(message.type === "Q" && message.text === "COMMIT")
	}
	if (open || flights > 1) {
		return `at ${level} its one try sent ${flights} flights${open ? ", the last never committed" : ""}; ${what}`
	}
	return undefined
}

/** One `inserter` call over a stored Badge state, alone: the framing search's case. */
interface InserterAlone {
	readonly initial: ReadonlyArray<Fact>
	readonly call: InserterCall
}

const inserterAloneGen: Gen<InserterAlone> = (source) => ({
	initial: source.draw(badgeStateGen),
	call: { badges: source.draw(badgesGen), gates: [] }
})

/** The framing search's notes: what the call answered. */
type AloneFeature = `alone ${GrizzleAnswer["kind"]}`

/**
 * The framing search's case: `inserter`'s served change run once over the drawn Badge state by a writer of the role
 * whose pool is tapped and sends `session`'s texts. Its one try must send one flight opened by READ COMMITTED's BEGIN,
 * the level generate certified, and closed by COMMIT, answer on that try (firstTryProblem), and answer and leave the
 * state the serial model says.
 */
const runInserterAlone = (
	ac: InserterAlone,
	c: Case<AloneFeature>
): Effect.Effect<void, RaceFailed | RaceError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const o = yield* open
		const sql = sqlOf(o)
		const changes = yield* certifiedInserter(o)
		const change = defined(changes.get("addBadges"), "the served change addBadges")
		const writer = yield* o.rig.servedWriter("ins1", openInserter(o.rig), (db) =>
			answered(
				db.workload.addBadges.once({ params: {}, facts: { insert: { Badge: [], Gate: [] } } })
			)
		)
		const tap = makeTap(s.cluster)
		const pool = yield* poolFor(o.rig.installed.as(o.rig.worlds.server), {
			...defaultPool,
			transport: { kind: "given", transport: tap.transport },
			pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 1 },
			session: servedSession
		})
		yield* Effect.orDie(
			Effect.scoped(
				Effect.flatMap(pool.lease, (leased) => rowsOn(leased, "SELECT 'warm'::text", []))
			)
		)
		const initial: State = { ...emptyState, Badge: ac.initial }
		yield* o.rig.replace(sql.reset(initial))
		const op = inserterOp(ac.call)
		const mark = tap.mark()
		const result = yield* Effect.result(
			answered(
				writeOnce(onceCalls({ ...writer.ctx, pool }, change.member))({
					params: {},
					facts: inserterFacts(ac.call)
				})
			)
		)
		const { frontend } = tap.since(mark)
		const stored = yield* s.superuserRead((rows) => rows(sql.read))
		const answer = inserterAnswerOf(o.names.reported, result)
		const final = stateOfRows(stored)
		const problem =
			framingProblem("readCommitted", answer, frontend) ??
			firstTryProblem("the call", ac.call, answer, o.names.lawOf(badgeCode), final) ??
			judgeRun(
				lawsOf(o),
				initial,
				[
					{
						kind: "grizzle",
						label: "the call",
						session: "ins1",
						op,
						span: { start: 0, end: 1 },
						refused: [],
						answer: answer.answer
					}
				],
				final
			)?.why
		if (problem !== undefined) {
			return yield* new RaceFailed({
				message: `${describeOp(op)} over Badge ${Formatter.format(ac.initial)}\n${problem}`
			})
		}
		c.note(`alone ${answer.answer.kind}`)
	})

/**
 * The serial model's problem with a run as the interleaving's judgment of it, after `what` the run was: its tag kept, so
 * a run no serial order explains fails as NoSerialOrder and every other problem as RunRefused.
 */
const judgedProblem = (what: string, problem: RunProblem): Judgment =>
	problem.tag === "NoSerialOrder"
		? noSerialOrderJudgment(`${what}\n${problem.why}`)
		: refusedJudgment(`${what}\n${problem.why}`)

/** The cases of each inserter search: each installs its schema and opens its writers. */
const inserterRuns = 12

/**
 * The cases of each rotating stream: each installs its schema, opens four sessions and runs every planted race and one
 * drawn race in their orders.
 */
const runs = 8

layer(Substrate.layer, { excludeTestServices: true })(
	"write races, judged by a serial model",
	(it) => {
		it.effect(
			`${inserterRuns} cases of certified READ COMMITTED inserters racing at Badge: every run serial, every call answered on its one try, and independent calls never waiting on each other`,
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the serial model (model.ts judgeRun): a real-time serial order of the calls explains every answer and the state, each call answered on its one try"
							},
							suite: "schedules/write/inserters",
							draw: drawn(inserterCaseGen),
							literal: Formatter.format,
							coverage: required<InserterFeature>(
								[
									"inserter accepted",
									"inserter refused",
									"inserter witness reported",
									"an inserter waited on the other's insert",
									"an inserter held at its gate",
									"independent inserters ran at once",
									"planted candidate key race",
									"planted independent children"
								],
								{ cases: inserterRuns, sense: notesOnly }
							),
							kept: [],
							runs: inserterRuns,
							shrink: { kind: "bounded", candidates: 20 },
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(ic, c) =>
							Effect.scoped(runInserters(ic, c)).pipe(
								Effect.catchCause((cause) =>
									Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
								)
							)
					)
				)
		)

		it.effect(
			`${inserterRuns} cases of certified READ COMMITTED claimers racing at Claim and Seat: every run serial with a raced table's held key met, every call answered on its one try, each raced table won or met as its read-backs show`,
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the serial model (model.ts judgeRun), raced tables meeting a held key, and each call's read-backs against the final state"
							},
							suite: "schedules/write/claimers",
							draw: drawn(claimerCaseGen),
							literal: Formatter.format,
							coverage: required<ClaimerFeature>(
								[
									"claimer accepted",
									"claimer unchanged",
									"a claimer won both raced tables",
									"a claimer met both raced tables",
									"a claimer won one raced table and met the other",
									"a claimer waited on the other's race",
									"a claimer held at its gate",
									"planted won one and met the other",
									"planted both met in flight"
								],
								{ cases: inserterRuns, sense: notesOnly }
							),
							kept: [],
							runs: inserterRuns,
							shrink: { kind: "bounded", candidates: 20 },
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(cc, c) =>
							Effect.scoped(runClaimers(cc, c)).pipe(
								Effect.catchCause((cause) =>
									Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
								)
							)
					)
				)
		)

		it.effect(
			`${inserterRuns} cases of an inserter call alone: one flight, begun READ COMMITTED as generate certified the role, answered as the serial model says`,
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the serial model (model.ts judgeRun) of the one call, and its one flight framed at the certified level"
							},
							suite: "schedules/write/inserter-alone",
							draw: drawn(inserterAloneGen),
							literal: Formatter.format,
							coverage: required<AloneFeature>(["alone accepted", "alone refused"], {
								cases: inserterRuns,
								sense: notesOnly
							}),
							kept: [],
							runs: inserterRuns,
							shrink: { kind: "bounded", candidates: 20 },
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(ac, c) =>
							Effect.scoped(runInserterAlone(ac, c)).pipe(
								Effect.catchCause((cause) =>
									Effect.fail(new RaceFailed({ message: Cause.pretty(cause) }))
								)
							)
					)
				)
		)

		it.effect(
			`${runs} cases of planted and drawn races: every run is explained by a serial order`,
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the serial model (model.ts judgeRun): a real-time serial order of the committed operations explains every outcome, refusal and the committed state"
							},
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
