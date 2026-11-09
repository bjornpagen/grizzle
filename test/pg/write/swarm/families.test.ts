import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Result } from "effect"
import { apply } from "#adapter/apply/index.ts"
import { openDbContext } from "#adapter/db/open.ts"
import type { FamilyName, StaleCause } from "#compiler/core/causes.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { caseGen, stepsGen } from "#test/pg/write/swarm/case.ts"
import { changeSetOf, membershipIn, putsOf } from "#test/pg/write/swarm/changes.ts"
import {
	expectStep,
	familyWrites,
	hostSchema,
	justified,
	type Laws,
	nothingStored,
	type State,
	type Step,
	type StepVerdict,
	storedRows,
	type SwarmCase
} from "#test/pg/write/swarm/oracle.ts"
import {
	buildSwarm,
	type BuiltSwarm,
	familyOf,
	nonEmptyRelations,
	type SwarmFeature,
	type SwarmSpec,
	swarmInstanceGen
} from "#test/pg/write/swarm/spec.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { familyNamed, type InstanceRow, writesVerdict } from "#test/support/families/fill.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld, loginLayer } from "#test/support/worlds.ts"

/**
 * A differential search over grizzle's family writer and its write schedule at the scale and in the shapes a
 * downstream tier found seven defects in, which the narrower searches never drew: a swarm of schemas of up to 24
 * relations, every family kind, owners of several families, members owning families, cycles of families, copies of
 * copies, fold ends of sum, count, max and or, and laws between family and plain relations; and of ChangeSets of up to
 * three strata mixing plain inserts, puts and deletes with family inserts (nested, one member per fact, every fact
 * twice), deletes, moves, recounts, owner column changes, a query's insert, a put from a query and a delete of
 * everything, at up to 150 facts and more (test/pg/write/swarm/spec.ts and case.ts).
 *
 * Every ChangeSet runs through db.apply on PostgreSQL, from the state the accepted ones before it leave, and is judged
 * by the oracle (oracle.ts), which never consults grizzle's writer:
 * - a lawful write is accepted (no-change where nothing changes), and every relation then stores exactly the reference
 *   writer's rows (test/support/families/fill.ts writtenRows) and the plain rows the ChangeSet leaves;
 * - an unlawful one is invariant-rejected naming only laws its rows break, by the law model's judgement
 *   (test/support/laws/model.ts) of every law at the end and every immediate law at the end of each stratum, two facts
 *   at one key the key's, a member naming no owner its family's; each statement's law is the one the naming door
 *   names for it (test/support/kernel/naming.ts lawOf), so a refusal by a family, tree, fold, key, check or
 *   containment names exactly the law of its statement;
 * - a refusal when it compiles is justified by the oracle's own statement: StaleDerivedRead where the reference finds
 *   a refill of an immutable relation's rows or a put from a query leaving a value stale (fill.ts writesVerdict), and
 *   UnorderableStratum where every order of its cycle is one the stratum's writes require (oracle.ts justified).
 *
 * Its kept cases are the seven downstream defects' shapes; planted in a scratch copy, the total chain of a stratum's
 * family statements, the pair rule's edges on a deferred owner axis and a nested fact's signature without its own texts
 * each fail the search.
 */

/** What the search reached: shapes written, refusals justified, and the downstream defects' shapes. */
type Situation =
	| "a lawful first insert accepted"
	| "an insert of 150 facts or more accepted"
	| "a cycle of families written"
	| "an owner of several families written"
	| "a member owning a family written"
	| "a max end folded"
	| "an or end folded"
	| "an or end over counted members inserted beside their owner"
	| "a law on a cycle with an owner axis kept"
	| "a pure set and the family rows it holds written in one stratum"
	| "a selection over a copy judged"
	| "a check over a drawn count judged"
	| "plain writes in strata around the family's"
	| "a follow-up accepted"
	| "a follow-up refilling a value"
	| "an owner's column changed beside an append to its family"
	| "an ordered member deleted"
	| "a member moved to another owner"
	| "a query's insert accepted"
	| "a put from a query accepted"
	| "a put from a query refused for a value it leaves stale"
	| "a refill of an immutable relation refused"
	| "a delete of everything accepted"
	| "an unlawful write refused by a law it breaks"
	| "two facts at one key refused by its key"
	| "a member naming no owner refused by its family"
	| "every fact stated twice written once"
	| "one member per fact"
	| "a stratum no order keeps refused"
	| "a refill after an earlier stratum refused"
	| "refills reaching a family again refused"
	| "a refill of a tree's values refused"
	| "a refill reading another refill's change refused"

const situations: Arr.NonEmptyReadonlyArray<Situation> = [
	"a lawful first insert accepted",
	"an insert of 150 facts or more accepted",
	"a cycle of families written",
	"an owner of several families written",
	"a member owning a family written",
	"a max end folded",
	"an or end folded",
	"an or end over counted members inserted beside their owner",
	"a law on a cycle with an owner axis kept",
	"a pure set and the family rows it holds written in one stratum",
	"a selection over a copy judged",
	"a check over a drawn count judged",
	"plain writes in strata around the family's",
	"a follow-up accepted",
	"a follow-up refilling a value",
	"an owner's column changed beside an append to its family",
	"an ordered member deleted",
	"a member moved to another owner",
	"a query's insert accepted",
	"a put from a query accepted",
	"a put from a query refused for a value it leaves stale",
	"a refill of an immutable relation refused",
	"a delete of everything accepted",
	"an unlawful write refused by a law it breaks",
	"two facts at one key refused by its key",
	"a member naming no owner refused by its family",
	"every fact stated twice written once",
	"one member per fact"
]

/** Whether the reference states `cause` among an uncompiled step's causes, a family it names by its owner and count. */
const statesCause = (
	spec: SwarmSpec,
	expected: Extract<StepVerdict, { readonly kind: "uncompiled" }>,
	cause: StaleCause
): boolean => {
	const among = (families: ReadonlyArray<number>, name: FamilyName): boolean =>
		Arr.some(families, (k) => {
			const named = familyNamed(spec.fill, k)
			return named.owner === name.owner && named.count === name.count
		})
	switch (cause.kind) {
		case "immutable":
			return expected.immutable.includes(cause.relation)
		case "query":
			return expected.query
		case "cycle":
			return expected.cycle
		case "tree":
			return among(expected.trees, cause.tree)
		case "chained":
			return among(expected.refills, cause.refill)
	}
}

/** The situation a stale value's refusal reaches, by its cause. */
const causeNote = (cause: StaleCause): Situation => {
	switch (cause.kind) {
		case "immutable":
			return "a refill of an immutable relation refused"
		case "query":
			return "a put from a query refused for a value it leaves stale"
		case "cycle":
			return "refills reaching a family again refused"
		case "tree":
			return "a refill of a tree's values refused"
		case "chained":
			return "a refill reading another refill's change refused"
	}
}

/** Whether the families of a spec form a cycle: an owner reaches itself through families' owner-to-member steps. */
const familyCycle = (spec: SwarmSpec): boolean =>
	Arr.some(spec.fill.families, (start) => {
		if (start.owner === start.member) {
			return false
		}
		const seen = new Set<number>([start.member])
		const pending = [start.member]
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			if (at === start.owner) {
				return true
			}
			for (const f of spec.fill.families) {
				if (f.owner === at && f.member !== f.owner && !seen.has(f.member)) {
					seen.add(f.member)
					pending.push(f.member)
				}
			}
		}
		return false
	})

/** The shapes an accepted first insert of `rows` reaches. */
const insertShapes = (
	spec: SwarmSpec,
	rows: ReadonlyArray<InstanceRow>,
	step: Step
): ReadonlyArray<Situation> => {
	const owns = (r: number) => Arr.filter(spec.fill.families, (f) => f.owner === r && f.member !== r)
	const stored = (r: number) => Arr.some(rows, (x) => x.relation === r)
	const hasMembers = (f: number) => Arr.some(rows, (x) => membershipIn(x, f) !== undefined)
	return [
		"a lawful first insert accepted",
		...(rows.length >= 150 ? (["an insert of 150 facts or more accepted"] as const) : []),
		...(familyCycle(spec) && Arr.every(spec.fill.families, (_, f) => hasMembers(f))
			? (["a cycle of families written"] as const)
			: []),
		...(Arr.some(spec.fill.relations, (_, r) => owns(r).length >= 2 && stored(r))
			? (["an owner of several families written"] as const)
			: []),
		...(Arr.some(
			spec.fill.families,
			(f, k) => owns(f.member).length > 0 && hasMembers(k) && f.member !== f.owner
		)
			? (["a member owning a family written"] as const)
			: []),
		...(Arr.some(spec.ends, (e) => e.monoid === "max" && hasMembers(e.family))
			? (["a max end folded"] as const)
			: []),
		...(Arr.some(spec.ends, (e) => e.monoid === "or" && hasMembers(e.family))
			? (["an or end folded"] as const)
			: []),
		...(Arr.some(
			spec.ends,
			(e) =>
				e.monoid === "or" && familyOf(spec, e.family).kind === "counted" && hasMembers(e.family)
		)
			? (["an or end over counted members inserted beside their owner"] as const)
			: []),
		...(Arr.some(spec.laws, (l) => l.kind === "owner into members" && hasMembers(l.family))
			? (["a law on a cycle with an owner axis kept"] as const)
			: []),
		...(step.kind === "insert" &&
		Arr.some(spec.laws, (l) => l.kind === "into set" && stored(l.relation)) &&
		Arr.some(step.plain, (o) => o.at === "with" && o.row.kind === "set")
			? (["a pure set and the family rows it holds written in one stratum"] as const)
			: []),
		...(Arr.some(spec.laws, (l) => l.kind === "selected")
			? (["a selection over a copy judged"] as const)
			: []),
		...(Arr.some(spec.laws, (l) => l.kind === "check" && l.family !== undefined)
			? (["a check over a drawn count judged"] as const)
			: [])
	]
}

/** The shapes an accepted step reaches. */
const stepShapes = (
	spec: SwarmSpec,
	state: State,
	step: Step,
	expected: StepVerdict
): ReadonlyArray<Situation> => {
	const strata = step.kind !== "delete all" && Arr.some(step.plain, (o) => o.at !== "with")
	const shaped =
		step.kind === "insert" || step.kind === "follow"
			? [
					...(step.shape.repeat ? (["every fact stated twice written once"] as const) : []),
					...(step.shape.split ? (["one member per fact"] as const) : [])
				]
			: []
	const common: ReadonlyArray<Situation> = [
		...(strata ? (["plain writes in strata around the family's"] as const) : []),
		...shaped
	]
	switch (step.kind) {
		case "insert":
			return [
				...common,
				...insertShapes(spec, expected.kind === "written" ? expected.next.rows : [], step)
			]
		case "follow": {
			const f = step.followUp
			if (f === undefined) {
				return [
					...common,
					...(step.query === undefined ? [] : (["a query's insert accepted"] as const))
				]
			}
			const verdict = writesVerdict(spec.fill, familyWrites(spec, state, step))
			return [
				...common,
				"a follow-up accepted",
				...(Arr.isReadonlyArrayNonEmpty(verdict.stale)
					? (["a follow-up refilling a value"] as const)
					: []),
				...(Option.isSome(f.put) &&
				(Arr.isReadonlyArrayNonEmpty(f.inserted) || Option.isSome(f.appended))
					? (["an owner's column changed beside an append to its family"] as const)
					: []),
				...(Option.isSome(f.removed) ? (["an ordered member deleted"] as const) : []),
				...(Option.isSome(f.moved) ? (["a member moved to another owner"] as const) : []),
				...(step.query === undefined ? [] : (["a query's insert accepted"] as const))
			]
		}
		case "query put":
			return [...common, "a put from a query accepted"]
		case "delete all":
			return ["a delete of everything accepted"]
	}
}

/** Every relation's stored rows equal the oracle's after `what`. */
const storesExactly = (
	done: Effect.Success<ReturnType<typeof installMigrated>>,
	spec: SwarmSpec,
	built: BuiltSwarm,
	state: State,
	what: string
) =>
	Effect.gen(function* () {
		const expected = storedRows(spec, state)
		for (const [name, rows] of expected) {
			const stored = yield* tableState(done, defined(built.relations[name], `the relation ${name}`))
			unorderedEqual(stored, rows, `${name}'s rows after ${what}, as the oracle states them`)
		}
	})

/** The case a witness runs: its drawn one, or, while a situation `aims` reaches is pending, an aimed one. */
const aimedCase = (drawnCase: SwarmCase, c: Case<Situation>): SwarmCase => {
	const pending = Option.getOrUndefined(c.steering)
	const aim = Arr.findFirst(aims, ([situation]) => pending?.has(situation) === true)
	return Option.isNone(aim) ? drawnCase : c.draw(aim.value[1])
}

/** A case over a fixed spec, its ChangeSets drawn under `on` at full weight. */
const over =
	(spec: SwarmSpec, on: ReadonlyArray<SwarmFeature>): Gen<SwarmCase> =>
	(source) => ({ spec, steps: source.draw(stepsGen(fullSwarm(on), false, spec)) })

const relationFlags = (mutable: boolean) => ({ generated: false, mutable })

/** A family core over relations of the given mutability, its families, copies and steps. */
const coreOf = (
	mutable: ReadonlyArray<boolean>,
	families: SwarmSpec["fill"]["families"],
	copies: SwarmSpec["fill"]["copies"],
	steps: SwarmSpec["fill"]["steps"]
): SwarmSpec["fill"] => ({
	relations: nonEmptyRelations(Arr.map(mutable, relationFlags)),
	families,
	copies,
	steps
})

/** A spec of a core alone. */
const bare = (fill: SwarmSpec["fill"]): SwarmSpec => ({ fill, ends: [], plains: [], laws: [] })

/** R0 owning an ordered family of R1 and a counted family of R2, every relation mutable. */
const twoFamilies = coreOf(
	[true, true, true],
	[
		{ kind: "ordered", owner: 0, member: 1, fold: "none" },
		{ kind: "counted", owner: 0, member: 2, fold: "sum" }
	],
	[],
	[]
)

/** R0 owning an ordered family of R1 whose members copy R0's `v` along its owner axis and that copy along their
 * predecessor axis, so a put of R0 leaves the predecessor copy stale; R1 mutable or not. */
const staleCopies = (mutable: boolean): SwarmSpec["fill"] =>
	coreOf(
		[true, mutable],
		[{ kind: "ordered", owner: 0, member: 1, fold: "none" }],
		[
			{ family: 0, axis: "owner", source: { kind: "caller" } },
			{ family: 0, axis: "predecessor", source: { kind: "copy", copy: 0 } }
		],
		[]
	)

/** A mutable owner R0 of a counted family of R1 whose sum fold steps R1's copy of R0's `v`. */
const steppedCopy = coreOf(
	[true, true],
	[{ kind: "counted", owner: 0, member: 1, fold: "sum" }],
	[{ family: 0, axis: "owner", source: { kind: "caller" } }],
	[{ family: 0, copy: 0 }]
)

/** A mutable owner R0 of a counted family of R1, itself the owner of a counted family of R2 whose sum fold steps R2's
 * copy of R1's copy of R0's `v`: a put of R0 reaches the fold along two owner axes. */
const twoHopCopy = coreOf(
	[true, true, true],
	[
		{ kind: "counted", owner: 0, member: 1, fold: "none" },
		{ kind: "counted", owner: 1, member: 2, fold: "sum" }
	],
	[
		{ family: 0, axis: "owner", source: { kind: "caller" } },
		{ family: 1, axis: "owner", source: { kind: "copy", copy: 0 } }
	],
	[{ family: 1, copy: 1 }]
)

/** A case over `spec` whose first insert of a drawn instance of at least `least` top rows per relation breaks a law
 * as `how` says: one top fact stated twice at its key, or a counted member naming no owner. */
const brokenFirst =
	(spec: SwarmSpec, how: "conflict" | "orphan"): Gen<SwarmCase> =>
	(source) => {
		const rows = source.draw(swarmInstanceGen(spec.fill, 24, 1, 1))
		const candidates = Arr.filter(rows, (r) =>
			how === "conflict"
				? r.memberOf.length === 0
				: Arr.some(r.memberOf, (m) => familyOf(spec, m.family).kind === "counted")
		)
		const chosen = Arr.isReadonlyArrayNonEmpty(candidates)
			? defined(candidates[source.draw(int(0, candidates.length - 1))], "a broken row").id
			: undefined
		return {
			spec,
			steps: [
				{
					kind: "insert",
					rows,
					plain: [],
					conflict: how === "conflict" ? chosen : undefined,
					orphan: how === "orphan" ? chosen : undefined,
					shape: { split: source.draw(boolean), repeat: false }
				}
			]
		}
	}

/** A case over `spec` whose first insert holds at least `least` top rows per relation, under at most `bound` rows. */
const large =
	(spec: SwarmSpec, bound: number, least: number): Gen<SwarmCase> =>
	(source) => ({
		spec,
		steps: [
			{
				kind: "insert",
				rows: source.draw(swarmInstanceGen(spec.fill, bound, 1, least)),
				plain: [],
				conflict: undefined,
				orphan: undefined,
				shape: { split: source.draw(boolean), repeat: false }
			}
		]
	})

/**
 * Several situations a case reaches together: R0 owning an ordered family of R1 and a counted family of R2 under a
 * check over its count, a pure set R1 and R2 read and a referrer into R1's rows, its ChangeSets in strata, each fact
 * twice, with follow-ups and a query's insert.
 */
const together = over(
	{
		...bare(twoFamilies),
		plains: [
			{ kind: "set", mutable: false },
			{ kind: "referrer", mutable: true }
		],
		laws: [
			{ kind: "check", relation: 0, family: 1 },
			{ kind: "into set", relation: 1, plain: 0 },
			{ kind: "into set", relation: 2, plain: 0 },
			{ kind: "into rows", plain: 1, relation: 1 }
		]
	},
	["follow-ups", "strata", "query insert", "repeated fact"]
)

/** The situations the drawn cases reach only now and then, each with the case a witness draws to reach it. */
const aims: ReadonlyArray<readonly [Situation, Gen<SwarmCase>]> = [
	["every fact stated twice written once", together],
	["plain writes in strata around the family's", together],
	["a query's insert accepted", together],
	["a check over a drawn count judged", together],
	[
		"a cycle of families written",
		over(
			bare(
				coreOf(
					[true, true],
					[
						{ kind: "ordered", owner: 1, member: 0, fold: "none" },
						{ kind: "counted", owner: 0, member: 1, fold: "sum" }
					],
					[],
					[]
				)
			),
			["follow-ups"]
		)
	],
	[
		"an or end over counted members inserted beside their owner",
		over(
			{
				...bare(
					coreOf([true, true], [{ kind: "counted", owner: 0, member: 1, fold: "none" }], [], [])
				),
				ends: [{ family: 0, monoid: "or" }]
			},
			["follow-ups", "split members"]
		)
	],
	[
		"a max end folded",
		over(
			{
				...bare(twoFamilies),
				ends: [
					{ family: 0, monoid: "max" },
					{ family: 1, monoid: "max" }
				]
			},
			["follow-ups"]
		)
	],
	[
		"an insert of 150 facts or more accepted",
		large(
			bare(coreOf([true, true], [{ kind: "ordered", owner: 0, member: 1, fold: "sum" }], [], [])),
			320,
			90
		)
	],
	["two facts at one key refused by its key", brokenFirst(bare(twoFamilies), "conflict")],
	["a member naming no owner refused by its family", brokenFirst(bare(twoFamilies), "orphan")],
	[
		"a put from a query accepted",
		over(
			bare(coreOf([true, true], [{ kind: "counted", owner: 0, member: 1, fold: "count" }], [], [])),
			["query put"]
		)
	],
	[
		"a put from a query refused for a value it leaves stale",
		over(bare(staleCopies(true)), ["query put"])
	],
	["a refill of an immutable relation refused", over(bare(staleCopies(false)), ["follow-ups"])],
	[
		"a delete of everything accepted",
		over(
			{
				...bare(twoFamilies),
				plains: [
					{ kind: "set", mutable: false },
					{ kind: "referrer", mutable: true }
				],
				laws: [
					{ kind: "into set", relation: 2, plain: 0 },
					{ kind: "into rows", plain: 1, relation: 1 }
				]
			},
			["delete all", "follow-ups"]
		)
	],
	[
		"a law on a cycle with an owner axis kept",
		over(
			{
				...bare(
					coreOf([true, true], [{ kind: "counted", owner: 0, member: 1, fold: "none" }], [], [])
				),
				laws: [
					{ kind: "owner into members", family: 0, selected: true },
					{ kind: "member key", family: 0 }
				]
			},
			["follow-ups"]
		)
	],
	[
		"a selection over a copy judged",
		over(
			{
				...bare(steppedCopy),
				plains: [{ kind: "set", mutable: true }],
				laws: [{ kind: "selected", copy: 0, plain: 0 }]
			},
			["follow-ups"]
		)
	],
	[
		"a check over a drawn count judged",
		over({ ...bare(twoFamilies), laws: [{ kind: "check", relation: 0, family: 1 }] }, [
			"follow-ups"
		])
	],
	[
		"a pure set and the family rows it holds written in one stratum",
		over(
			{
				...bare(twoFamilies),
				plains: [{ kind: "set", mutable: false }],
				laws: [
					{ kind: "into set", relation: 1, plain: 0 },
					{ kind: "into set", relation: 2, plain: 0 }
				]
			},
			["follow-ups"]
		)
	],
	[
		"plain writes in strata around the family's",
		over(
			{
				...bare(twoFamilies),
				plains: [
					{ kind: "set", mutable: false },
					{ kind: "referrer", mutable: true }
				],
				laws: [
					{ kind: "into set", relation: 1, plain: 0 },
					{ kind: "into members", plain: 1, family: 1 },
					{ kind: "member key", family: 1 }
				]
			},
			["follow-ups", "strata"]
		)
	],
	["a follow-up refilling a value", over(bare(steppedCopy), ["follow-ups"])],
	[
		"an owner's column changed beside an append to its family",
		over(bare(steppedCopy), ["follow-ups"])
	],
	["a member moved to another owner", over(bare(twoFamilies), ["follow-ups"])],
	["an ordered member deleted", over(bare(twoFamilies), ["follow-ups"])],
	[
		"a query's insert accepted",
		over(
			{
				...bare(twoFamilies),
				plains: [{ kind: "set", mutable: false }],
				laws: [{ kind: "into set", relation: 2, plain: 0 }]
			},
			["follow-ups", "query insert"]
		)
	],
	["an owner of several families written", over(bare(twoFamilies), [])],
	[
		"a member owning a family written",
		over(
			bare(
				coreOf(
					[true, true, true],
					[
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{ kind: "counted", owner: 1, member: 2, fold: "count" }
					],
					[],
					[]
				)
			),
			["follow-ups"]
		)
	],
	[
		"every fact stated twice written once",
		over(bare(twoFamilies), ["repeated fact", "follow-ups"])
	],
	["one member per fact", over(bare(twoFamilies), ["split members", "follow-ups"])]
]

/** A first insert of `rows`, as one ChangeSet states it whole or one member per fact. */
const inserted = (
	rows: ReadonlyArray<InstanceRow>,
	split: boolean,
	conflict: number | undefined
): Step => ({
	kind: "insert",
	rows,
	plain: [],
	conflict,
	orphan: undefined,
	shape: { split, repeat: false }
})

/** The seven downstream defects' shapes, then the shapes this search found, each kept by value. */
const kept: ReadonlyArray<Kept<SwarmCase, Situation>> = [
	{
		note: "two counted families on a cycle, each a member of the other's owner and each copying its owner's caller field, both rows inserted by their slots: each additions statement read the other's rows from the table, so each followed the other and the stratum was refused as UnorderableStratum, where the slots hold every value copied",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true)],
					families: [
						{ kind: "counted", owner: 1, member: 0, fold: "none" },
						{ kind: "counted", owner: 0, member: 1, fold: "none" }
					],
					copies: [
						{ family: 0, axis: "owner", source: { kind: "caller" } },
						{ family: 1, axis: "owner", source: { kind: "caller" } }
					],
					steps: []
				},
				ends: [],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 1n, memberOf: [{ family: 0, owner: 2, slot: 0 }] },
						{ relation: 1, id: 2, v: 2n, memberOf: [{ family: 1, owner: 1, slot: 0 }] }
					],
					false,
					undefined
				)
			]
		},
		draws: "",
		reaches: ["a lawful first insert accepted"]
	},
	{
		note: "TEST_SEED=2029266199's case 2: a cycle of families, a counted family whose members copy their owner's caller field and a sequence of its owners nested under them, inserted with no rows: its additions read the copied owners' rows after the statement that nests them, which follows theirs by its owner axis, so the stratum was refused as UnorderableStratum",
		sketch: {
			spec: {
				fill: {
					relations: [{ generated: true, mutable: true }, relationFlags(true)],
					families: [
						{ kind: "counted", owner: 1, member: 0, fold: "none" },
						{ kind: "ordered", owner: 0, member: 1, fold: "count" }
					],
					copies: [{ family: 0, axis: "owner", source: { kind: "caller" } }],
					steps: []
				},
				ends: [{ family: 0, monoid: "or" }],
				plains: [],
				laws: []
			},
			steps: [inserted([], false, undefined)]
		},
		draws: "",
		reaches: ["a lawful first insert accepted"]
	},
	{
		note: "TEST_SEED=1608381433's case 10: an ordered member's put beside an append to the counted family it owns, whose count its stored members copy, the owner axis deferred since the put re-places the owner; the planner on the host refused it, its members' copies left stale",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true), relationFlags(true)],
					families: [
						{ kind: "ordered", owner: 1, member: 0, fold: "sum" },
						{ kind: "counted", owner: 0, member: 2, fold: "sum" }
					],
					copies: [],
					steps: []
				},
				ends: [],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 1, id: 1, v: 0n, memberOf: [] },
						{ relation: 0, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
						{ relation: 0, id: 3, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 1 }] },
						{ relation: 2, id: 4, v: 3n, memberOf: [{ family: 1, owner: 2, slot: 0 }] }
					],
					true,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 0,
						row: 2,
						put: Option.some(-1n),
						inserted: [
							{ relation: 2, id: 5, v: -1n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
							{ relation: 2, id: 6, v: 1n, memberOf: [{ family: 1, owner: 2, slot: 0 }] }
						],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a follow-up accepted", "an owner's column changed beside an append to its family"]
	},
	{
		note: "1bf3dbb: a counted family's or end, its owner inserted beside its members, one member per fact",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true)],
					families: [{ kind: "counted", owner: 0, member: 1, fold: "none" }],
					copies: [],
					steps: []
				},
				ends: [{ family: 0, monoid: "or" }],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 1, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
						{ relation: 1, id: 3, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
					],
					true,
					undefined
				)
			]
		},
		draws: "",
		reaches: ["an or end folded", "an or end over counted members inserted beside their owner"]
	},
	{
		note: "e9227af: the owners with one member contained in their members, on a cycle with the counted family's owner axis, and an owner's check over its count",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true)],
					families: [{ kind: "counted", owner: 0, member: 1, fold: "none" }],
					copies: [],
					steps: []
				},
				ends: [],
				plains: [],
				laws: [
					{ kind: "owner into members", family: 0, selected: true },
					{ kind: "member key", family: 0 },
					{ kind: "check", relation: 0, family: 0 }
				]
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 1n, memberOf: [] },
						{ relation: 1, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
					],
					false,
					undefined
				)
			]
		},
		draws: "",
		reaches: ["a law on a cycle with an owner axis kept", "a check over a drawn count judged"]
	},
	{
		note: "8310ede: an ordered member deleted, a counted member inserted and their counts, beside a pure set both read gaining a value, in one stratum",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true), relationFlags(true)],
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{ kind: "counted", owner: 0, member: 2, fold: "none" }
					],
					copies: [],
					steps: []
				},
				ends: [],
				plains: [{ kind: "set", mutable: false }],
				laws: [
					{ kind: "into set", relation: 1, plain: 0 },
					{ kind: "into set", relation: 2, plain: 0 }
				]
			},
			steps: [
				{
					kind: "insert",
					rows: [
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 1, id: 2, v: -2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
						{ relation: 1, id: 3, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 1 }] },
						{ relation: 2, id: 4, v: 0n, memberOf: [{ family: 1, owner: 1, slot: 0 }] }
					],
					plain: [
						{ op: "insert", row: { kind: "set", plain: 0, x: -2n }, at: "with" },
						{ op: "insert", row: { kind: "set", plain: 0, x: 0n }, at: "with" }
					],
					conflict: undefined,
					orphan: undefined,
					shape: { split: false, repeat: false }
				},
				{
					kind: "follow",
					followUp: {
						owner: 0,
						row: 1,
						put: Option.none(),
						inserted: [{ relation: 2, id: 5, v: 3n, memberOf: [{ family: 1, owner: 1, slot: 0 }] }],
						removed: Option.some({ id: 2, family: 0 }),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [{ op: "insert", row: { kind: "set", plain: 0, x: 3n }, at: "with" }],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: [
			"a pure set and the family rows it holds written in one stratum",
			"a follow-up accepted",
			"an ordered member deleted"
		]
	},
	{
		note: "75fed88: a cycle of families, R1 owning an ordered family of R0 and R0 a counted family of R1, written by one nested insert",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true)],
					families: [
						{ kind: "ordered", owner: 1, member: 0, fold: "none" },
						{ kind: "counted", owner: 0, member: 1, fold: "none" }
					],
					copies: [],
					steps: []
				},
				ends: [],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 1, id: 1, v: 0n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
						{ relation: 0, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
					],
					false,
					undefined
				)
			]
		},
		draws: "",
		reaches: ["a cycle of families written"]
	},
	{
		note: "an ordered member's delete re-places the next, which owns a counted member copying its index along an owner axis",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true), relationFlags(true)],
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{ kind: "counted", owner: 1, member: 2, fold: "none" }
					],
					copies: [{ family: 1, axis: "owner", source: { kind: "index", family: 0 } }],
					steps: []
				},
				ends: [],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 1n, memberOf: [] },
						{ relation: 1, id: 2, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
						{ relation: 1, id: 3, v: 3n, memberOf: [{ family: 0, owner: 1, slot: 1 }] },
						{ relation: 2, id: 4, v: 4n, memberOf: [{ family: 1, owner: 3, slot: 0 }] }
					],
					false,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 0,
						row: 1,
						put: Option.none(),
						inserted: [],
						removed: Option.some({ id: 2, family: 0 }),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a follow-up refilling a value", "an ordered member deleted"]
	},
	{
		note: "72f7d03: an owner fact stated twice at its key with another v and the same nested member",
		sketch: {
			spec: {
				fill: {
					relations: [relationFlags(true), relationFlags(true)],
					families: [{ kind: "ordered", owner: 0, member: 1, fold: "none" }],
					copies: [],
					steps: []
				},
				ends: [],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 1, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
					],
					false,
					1
				)
			]
		},
		draws: "",
		reaches: [
			"two facts at one key refused by its key",
			"an unlawful write refused by a law it breaks"
		]
	},
	{
		note: "refill: an owner's put changing the v its counted members copy, which their fold steps, beside two more members inserted under it",
		sketch: {
			spec: {
				fill: {
					relations: [
						relationFlags(true),
						relationFlags(true),
						relationFlags(true),
						relationFlags(true),
						{ generated: true, mutable: false }
					],
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "none" },
						{ kind: "counted", owner: 2, member: 3, fold: "sum" }
					],
					copies: [{ family: 1, axis: "owner", source: { kind: "caller" } }],
					steps: [{ family: 1, copy: 0 }]
				},
				ends: [],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 2, id: 2, v: -1n, memberOf: [] },
						{ relation: 2, id: 3, v: 0n, memberOf: [] },
						{ relation: 3, id: 4, v: 1n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
						{ relation: 3, id: 5, v: -1n, memberOf: [{ family: 1, owner: 3, slot: 0 }] },
						{ relation: 4, id: 6, v: -2n, memberOf: [] },
						{ relation: 4, id: 7, v: -1n, memberOf: [] }
					],
					false,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 2,
						row: 2,
						put: Option.some(1n),
						inserted: [
							{ relation: 3, id: 8, v: -1n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
							{ relation: 3, id: 9, v: 3n, memberOf: [{ family: 1, owner: 2, slot: 0 }] }
						],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: [
			"a follow-up refilling a value",
			"an owner's column changed beside an append to its family"
		]
	},
	{
		note: "found: a counted member inserted beside a pure set its relation reads trading one value for another, refused as unorderable through an update in place that changes no value the key reads",
		sketch: {
			spec: {
				fill: coreOf(
					[true, true],
					[{ kind: "counted", owner: 0, member: 1, fold: "none" }],
					[],
					[]
				),
				ends: [],
				plains: [{ kind: "set", mutable: false }],
				laws: [{ kind: "into set", relation: 1, plain: 0 }]
			},
			steps: [
				{
					kind: "insert",
					rows: [
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 1, id: 2, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
					],
					plain: [
						{ op: "insert", row: { kind: "set", plain: 0, x: 0n }, at: "with" },
						{ op: "insert", row: { kind: "set", plain: 0, x: 5n }, at: "with" }
					],
					conflict: undefined,
					orphan: undefined,
					shape: { split: false, repeat: false }
				},
				{
					kind: "follow",
					followUp: {
						owner: 0,
						row: 1,
						put: Option.none(),
						inserted: [{ relation: 1, id: 3, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [
						{ op: "insert", row: { kind: "set", plain: 0, x: 1n }, at: "with" },
						{ op: "delete", row: { kind: "set", plain: 0, x: 5n }, at: "with" }
					],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: [
			"a follow-up accepted",
			"a pure set and the family rows it holds written in one stratum"
		]
	},
	{
		note: "found: a counted member that owns a sequence appended to a stored owner's group, on a cycle of families, dies binding its edit",
		sketch: {
			spec: bare(
				coreOf(
					[true, true],
					[
						{ kind: "ordered", owner: 1, member: 0, fold: "none" },
						{ kind: "counted", owner: 0, member: 1, fold: "sum" }
					],
					[],
					[]
				)
			),
			steps: [
				inserted(
					[
						{ relation: 1, id: 1, v: 0n, memberOf: [{ family: 1, owner: 3, slot: 0 }] },
						{ relation: 1, id: 2, v: 0n, memberOf: [{ family: 1, owner: 3, slot: 0 }] },
						{ relation: 0, id: 3, v: 0n, memberOf: [{ family: 0, owner: 2, slot: 0 }] }
					],
					false,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 0,
						row: 3,
						put: Option.none(),
						inserted: [{ relation: 1, id: 4, v: 0n, memberOf: [{ family: 1, owner: 3, slot: 0 }] }],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a cycle of families written", "a follow-up accepted"]
	},
	{
		note: "found: a put from a query into a relation with a generated field dies compiling its insert",
		sketch: {
			spec: bare({
				relations: [{ generated: true, mutable: true }],
				families: [],
				copies: [],
				steps: []
			}),
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 0, id: 2, v: 1n, memberOf: [] }
					],
					false,
					undefined
				),
				{ kind: "query put", relation: 0, rows: [{ id: 1, v: 2n }], plain: [] }
			]
		},
		draws: "",
		reaches: ["a put from a query accepted"]
	},
	{
		note: "found: a put of an ordered member whose g its owner's last copy reads, read again by a tree's last copy, beside a referrer's put: once refused as a refill cycle naming the referrer's put as its write, then refilled on the host from a read, now refused when it compiles as a refill of the tree's values",
		sketch: {
			spec: {
				fill: {
					relations: [
						{ generated: true, mutable: true },
						{ generated: true, mutable: true }
					],
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: "sum" },
						{ kind: "tree", owner: 0, member: 0, fold: "count" }
					],
					copies: [
						{ family: 1, axis: "predecessor", source: { kind: "count", family: 1 } },
						{ family: 0, axis: "last", source: { kind: "generated" } },
						{ family: 0, axis: "owner", source: { kind: "copy", copy: 0 } },
						{ family: 1, axis: "last", source: { kind: "copy", copy: 1 } }
					],
					steps: []
				},
				ends: [],
				plains: [{ kind: "referrer", mutable: true }],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 1, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
					],
					false,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 1,
						row: 2,
						put: Option.some(2n),
						inserted: [],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [
						{
							op: "put",
							row: { kind: "referrer", plain: 0, id: 6000, r: 2, x: 0n },
							at: "with"
						}
					],
					query: undefined,
					shape: { split: true, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a refill of a tree's values refused"]
	},
	{
		note: "found: a counted family's sum fold stepping its member's copy along an ordered family's owner axis, once refused as unfillable where the reference admits it, written and refilled after the ordered owner's put",
		sketch: {
			spec: bare(
				coreOf(
					[true, true, true],
					[
						{ kind: "ordered", owner: 2, member: 0, fold: "none" },
						{ kind: "counted", owner: 1, member: 0, fold: "sum" }
					],
					[{ family: 0, axis: "owner", source: { kind: "caller" } }],
					[{ family: 1, copy: 0 }]
				)
			),
			steps: [
				inserted(
					[
						{ relation: 2, id: 1, v: 1n, memberOf: [] },
						{ relation: 1, id: 2, v: 0n, memberOf: [] },
						{
							relation: 0,
							id: 3,
							v: 0n,
							memberOf: [
								{ family: 0, owner: 1, slot: 0 },
								{ family: 1, owner: 2, slot: 0 }
							]
						}
					],
					false,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 2,
						row: 1,
						put: Option.some(2n),
						inserted: [],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: [
			"a lawful first insert accepted",
			"a follow-up accepted",
			"a follow-up refilling a value"
		]
	},
	{
		note: "found: a first counted member inserted under a stored owner whose members copy the owner's generated field dies encoding the edit",
		sketch: {
			spec: bare({
				relations: [
					{ generated: true, mutable: true },
					{ generated: true, mutable: true }
				],
				families: [{ kind: "counted", owner: 0, member: 1, fold: "sum" }],
				copies: [{ family: 0, axis: "owner", source: { kind: "generated" } }],
				steps: []
			}),
			steps: [
				inserted([{ relation: 0, id: 1, v: 2n, memberOf: [] }], true, undefined),
				{
					kind: "follow",
					followUp: {
						owner: 0,
						row: 1,
						put: Option.none(),
						inserted: [{ relation: 1, id: 2, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a follow-up accepted"]
	},
	{
		note: "found: an immutable counted member that owns a counted family, inserted beside its own members, once inserted at its empty family's count and max end, which its members' owner axis refuses",
		sketch: {
			spec: {
				fill: coreOf(
					[true, false, true],
					[
						{ kind: "counted", owner: 0, member: 1, fold: "none" },
						{ kind: "counted", owner: 1, member: 2, fold: "none" }
					],
					[],
					[]
				),
				ends: [{ family: 1, monoid: "max" }],
				plains: [],
				laws: []
			},
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 1, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
						{ relation: 2, id: 3, v: 2n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
						{ relation: 2, id: 4, v: 0n, memberOf: [{ family: 1, owner: 2, slot: 0 }] }
					],
					false,
					undefined
				)
			]
		},
		draws: "",
		reaches: ["a member owning a family written", "a max end folded"]
	},
	{
		note: "found: a mutable owner's counted members, immutable, owning it back in a counted family with a sum fold, all inserted in one stratum, once refused for the immutable owner's empty count",
		sketch: {
			spec: {
				fill: coreOf(
					[true, false],
					[
						{ kind: "counted", owner: 0, member: 1, fold: "count" },
						{ kind: "counted", owner: 1, member: 0, fold: "sum" }
					],
					[],
					[]
				),
				ends: [{ family: 0, monoid: "or" }],
				plains: [{ kind: "set", mutable: false }],
				laws: [
					{ kind: "member key", family: 0 },
					{ kind: "into set", relation: 0, plain: 0 }
				]
			},
			steps: [
				{
					kind: "insert",
					rows: [
						{ relation: 0, id: 1, v: 0n, memberOf: [{ family: 1, owner: 3, slot: 0 }] },
						{ relation: 1, id: 2, v: -1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
						{ relation: 1, id: 3, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
					],
					plain: [{ op: "insert", row: { kind: "set", plain: 0, x: 0n }, at: "with" }],
					conflict: undefined,
					orphan: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a cycle of families written", "a member owning a family written"]
	},
	{
		note: "found: a counted member's members inserted beside it, named before it, their owner axis immediate, once appended by a statement that ran before their owner's, as the relations' names ordered them",
		sketch: {
			spec: bare(
				coreOf(
					[false, true, true],
					[
						{ kind: "counted", owner: 2, member: 1, fold: "none" },
						{ kind: "counted", owner: 0, member: 2, fold: "none" }
					],
					[],
					[]
				)
			),
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 0n, memberOf: [] },
						{ relation: 2, id: 2, v: 1n, memberOf: [{ family: 1, owner: 1, slot: 0 }] },
						{ relation: 1, id: 3, v: 2n, memberOf: [{ family: 0, owner: 2, slot: 0 }] }
					],
					false,
					undefined
				)
			]
		},
		draws: "",
		reaches: ["a member owning a family written"]
	},
	{
		note: "found: a put of a stored ordered member that owns a counted family, beside a member appended to it, once written with the put fact's count at its start over the stored one by the family planner",
		sketch: {
			spec: bare(
				coreOf(
					[false, true, true, true, false],
					[
						{ kind: "counted", owner: 1, member: 2, fold: "sum" },
						{ kind: "ordered", owner: 3, member: 1, fold: "count" }
					],
					[{ family: 0, axis: "owner", source: { kind: "index", family: 1 } }],
					[]
				)
			),
			steps: [
				inserted(
					[
						{ relation: 3, id: 1, v: 0n, memberOf: [] },
						{ relation: 3, id: 2, v: 0n, memberOf: [] },
						{ relation: 1, id: 3, v: -2n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
						{ relation: 1, id: 4, v: 2n, memberOf: [{ family: 1, owner: 2, slot: 1 }] }
					],
					false,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 1,
						row: 4,
						put: Option.some(1n),
						inserted: [
							{ relation: 2, id: 6, v: -2n, memberOf: [{ family: 0, owner: 4, slot: 0 }] }
						],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a follow-up refilling a value", "a member owning a family written"]
	},
	{
		note: "a put of an owner whose v two owner axes carry into a counted family's members' copies, which its sum fold steps: the refill reaches the fold through the middle relation's rows, which the stratum neither puts nor deletes, and rides in the call's one flight",
		sketch: {
			spec: bare(twoHopCopy),
			steps: [
				inserted(
					[
						{ relation: 0, id: 1, v: 1n, memberOf: [] },
						{ relation: 1, id: 2, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
						{ relation: 2, id: 3, v: 2n, memberOf: [{ family: 1, owner: 2, slot: 0 }] }
					],
					false,
					undefined
				),
				{
					kind: "follow",
					followUp: {
						owner: 0,
						row: 1,
						put: Option.some(5n),
						inserted: [],
						removed: Option.none(),
						appended: Option.none(),
						moved: Option.none()
					},
					plain: [],
					query: undefined,
					shape: { split: false, repeat: false }
				}
			]
		},
		draws: "",
		reaches: ["a follow-up accepted", "a follow-up refilling a value"]
	}
]

layer(Substrate.layer, { excludeTestServices: true })("the family writer under a swarm", (it) => {
	it.effect(
		"every lawful ChangeSet stores the reference's rows, every unlawful one is refused by a law it breaks, and every refusal when it compiles is one the oracle states",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/write/swarm/families",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Situation>(situations, { cases: 160, sense: notesOnly }),
						kept: kept,
						runs: 24,
						shrink: boundedShrink(60),
						concurrency: 1,
						steerEvery: 8,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "the reference writer (families/fill.ts writtenRows) and the law model (laws/model.ts) over the facts written"
						}
					},
					(drawnCase, c) =>
						Effect.gen(function* () {
							const { spec, steps } = aimedCase(drawnCase, c)
							const built = buildSwarm(spec)
							const declared = built.rename("Swarm")
							const done = yield* installMigrated(declared, {
								ambient: ordinarySession,
								label: "swarm",
								logins: [fullWorld(declared, {}).server],
								extensions: []
							})
							const value = built.rename(done.schema)
							const names = namesOf(done)
							const lawNames = lawNamesOf(value)
							const laws: Laws = {
								of: (s) => lawNames.lawOf(s),
								primaryKey: (name) => lawNames.primaryKeyLaw({ name })
							}
							const host = hostSchema(spec, built, laws)
							const world = fullWorld(value, {})
							yield* Effect.gen(function* () {
								const { ctx: opened } = yield* openDbContext(world.server.roles.app, {})
								const flight = yield* oneFlight(opened, done.as(world.server))
								let state = nothingStored
								for (const [i, step] of steps.entries()) {
									const label = `step ${String(i)} (${step.kind}) of ${Formatter.format(spec)}`
									const expected = expectStep(spec, built, laws, host, state, step)
									const { changes, params } = changeSetOf(spec, built, value, state, step)
									const applied = yield* Effect.result(
										flight.judged(label, apply(flight.context, changes, changes.reads, params))
									)
									if (Result.isFailure(applied)) {
										const failure = applied.failure
										if (
											failure._tag !== "ExecutionFailure" ||
											failure.reason._tag !== "CompileError"
										) {
											return assert.fail(`${label} failed with ${failure._tag}: ${failure.message}`)
										}
										const reason = failure.reason.reason
										if (reason._tag === "UnorderableStratum") {
											const cycle = reason.cycle
											for (const [k, at] of cycle.entries()) {
												const next = defined(
													cycle[(k + 1) % cycle.length],
													"the cycle's next write"
												)
												assert.ok(
													justified(spec, putsOf(spec, state, step), at, next),
													`${label}: refused with UnorderableStratum, whose order ${at.relation} ${at.op} before ${next.relation} ${next.op} no write of the stratum requires; the cycle: ${Formatter.format(cycle)}`
												)
											}
											c.note("a stratum no order keeps refused")
											return
										}
										if (expected.kind === "uncompiled") {
											if (reason._tag === "UnsupportedOperation" && expected.later) {
												c.note("a refill after an earlier stratum refused")
												return
											}
											if (reason._tag === "StaleDerivedRead") {
												const cause = reason.cause
												assert.ok(
													statesCause(spec, expected, cause),
													`${label}: refused as stale (${Formatter.format(cause)}), a cause the reference does not state: ${Formatter.format(expected)}`
												)
												assert.ok(
													Arr.some(
														expected.origins,
														(w) => w.relation === reason.member && w.op === reason.op
													),
													`${label}: the refusal names a ${reason.op} of ${reason.member} as the write that leaves a value stale, none of the writes whose path first reaches a refill (${Formatter.format(expected.origins)}): ${failure.reason.message}`
												)
												c.note(causeNote(cause))
												return
											}
										}
										return assert.fail(
											`${label}: refused when it compiles, ${failure.reason.message}, where the oracle expects ${expected.kind}`
										)
									}
									const outcome = applied.success
									switch (expected.kind) {
										case "uncompiled":
											return assert.fail(
												`${label}: ${outcome.kind}, where the reference finds a refill it cannot draw or plan: ${Formatter.format(expected)}`
											)
										case "refused": {
											assert.equal(
												outcome.kind,
												"invariant-rejected",
												`${label}: the laws ${Formatter.format([...expected.laws])} are broken`
											)
											if (outcome.kind !== "invariant-rejected") {
												return
											}
											const named = Arr.map(refusedLaws(outcome.refused), (law): LawId =>
												names.reported(law)
											)
											const broken = (law: LawId) => expected.laws.has(law)
											assert.ok(
												outcome.refused.kind === "every"
													? Arr.every(named, broken)
													: Arr.some(named, broken),
												`${label}: refused by ${Formatter.format(named)} (${outcome.refused.kind}), where the laws broken are ${Formatter.format([...expected.laws])}`
											)
											yield* storesExactly(done, spec, built, state, `the refused ${label}`)
											c.note("an unlawful write refused by a law it breaks")
											if (step.kind === "insert" && step.conflict !== undefined) {
												c.note("two facts at one key refused by its key")
											}
											if (step.kind === "insert" && step.orphan !== undefined) {
												c.note("a member naming no owner refused by its family")
											}
											return
										}
										case "written": {
											assert.equal(outcome.kind, expected.changed ? "accepted" : "no-change", label)
											yield* storesExactly(done, spec, built, expected.next, label)
											c.noteAll(stepShapes(spec, state, step, expected))
											state = expected.next
										}
									}
								}
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(loginLayer(done, world.server)), (scope) =>
										Effect.provideContext(body, scope)
									),
								Effect.scoped
							)
						}).pipe(Effect.scoped)
				)
			)
	)
})
