/** What the properties of families.test.ts read: its spaces, models and helpers. */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Option } from "effect"
import type { FamilyName, StaleCause } from "#compiler/core/causes.ts"
import { stepsGen } from "#test/pg/write/swarm/case.ts"
import {
	familyWrites,
	type State,
	type Step,
	type StepVerdict,
	storedRows,
	type SwarmCase
} from "#test/pg/write/swarm/oracle.ts"
import {
	familyNamed,
	generationOfV,
	type InstanceRow,
	membershipIn,
	movingGen,
	noGeneration,
	writesVerdict
} from "#test/support/families/fill.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import {
	type BuiltSwarm,
	familyOf,
	nonEmptyRelations,
	type SwarmFeature,
	swarmInstanceGen,
	type SwarmSpec
} from "#test/support/pg/write/swarm/spec.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * A differential search over grizzle's family writer and its write schedule at the scale and in the shapes a
 * downstream tier found seven defects in, which the narrower searches never drew: a swarm of schemas of up to 24
 * relations, every family kind, owners of several families, members owning families, cycles of families, copies of
 * copies, fold ends of sum, count, max and or, laws between family and plain relations, and a family relation naming
 * a counted member's rows whole, an immediate foreign key into the member that lands its rows before the naming
 * relation's and that relation's own members after them (pantry's importWrite); and of ChangeSets of up to
 * three strata mixing plain inserts, puts and deletes with family inserts (nested, one member per fact, every fact
 * twice), deletes, moves, recounts, owner column changes, a query's insert, a put from a query and a delete of
 * everything, its rows as arrays or each top relation whole by a field-equality selection (ChangeSet.deleteWhere), at up
 * to 150 facts and more (test/support/pg/write/swarm/spec.ts and case.ts).
 *
 * Every ChangeSet is served as an application writes it (changes.ts): the first member of an op and relation an array
 * member and every further one a query member over a relation parameter of its own, but where the served compile
 * refuses that member from a query, whose facts join its array member's. Where a counted family's owner's further facts
 * join it for the family's append in their stratum alone, the member's own write or one nested under another relation's
 * insert, the same strata with one such owner's further facts from queries are compiled too, owner by owner, and must
 * be refused as QueriedOwnerAppend naming that owner's write, a family of its and that family's member (changes.ts
 * ownerAppends). It is compiled as the one member of
 * a served workload of its own and applied on PostgreSQL with its call's facts and parameters, from the state the
 * accepted ones before it leave, and is judged by the oracle (oracle.ts), which never consults grizzle's writer:
 * - a lawful write is accepted (unchanged where nothing changes), and every relation then stores exactly the reference
 *   writer's rows (test/support/families/fill.ts writtenRows) and the plain rows the ChangeSet leaves;
 * - an unlawful one is refused naming only laws its rows break, by the law model's judgement
 *   (test/support/laws/model.ts) of every law at the end and every immediate law at the end of each stratum, two facts
 *   at one key the key's, a member naming no owner its family's; each statement's law is the one the naming door
 *   names for it (test/support/kernel/naming.ts lawOf), so a refusal by a family, tree, fold, key, check or
 *   containment names exactly the law of its statement;
 * - a refusal when it compiles, the served compile's, is justified by the oracle's own statement: StaleDerivedRead
 *   where the reference finds a refill of an immutable relation's rows or a put from a query leaving a value stale
 *   (fill.ts writesVerdict), UnorderableStratum where every order of its cycle is one the stratum's writes require
 *   (oracle.ts justified), and UnsupportedOperation where a delete of everything names no relation owning a family
 *   that a relation nested under its whole deletes is a member of, whose groups it would leave partial, as the README
 *   refuses it (oracle.ts leavesGroupsPartial).
 *
 * Its kept cases are the seven downstream defects' shapes and pantry's importWrite, nested and not; planted in a
 * scratch copy, the total chain of a stratum's family statements, the pair rule's edges on a deferred owner axis, a
 * nested fact's signature without its own texts and an action placed before the family rows it references immediately
 * each fail the search. The oracle reads which keys are immediate off the installation (oracle.ts immediateKeysOf), so
 * a deferral the compile gets wrong is caught by what it does, not by a second statement of the rule: an owner axis a
 * refill writes around installed immediate (laws/model/plan.ts, refillDeferred dropped from the owner axis's
 * deferral) fails the drawn cases alone, the steered phase's case 4 refused as UnorderableStratum on an order its writes
 * do not require ("R0 put before R1 delete"), and the kept refill case besides.
 */

/** What the search reached: shapes written, refusals justified, and the downstream defects' shapes. */
export type Situation =
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
	| "a member's row named by an owner, inserted between it and the owner's members"
	| "plain writes in strata around the family's"
	| "a follow-up accepted"
	| "a follow-up refilling a value"
	| "an owner's column changed beside an append to its family"
	| "an ordered member deleted"
	| "a member moved to another owner"
	| "a member owning a family moved between owners"
	| "a query's insert accepted"
	| "an owner's write from a query beside its family's append refused"
	| "a put from a query accepted"
	| "a put from a query refused for a value it leaves stale"
	| "a refill of an immutable relation refused"
	| "a delete of everything accepted"
	| "a delete of everything by field equality accepted"
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
	| "a member's own write reaching another family's value refused"
	| "a delete leaving another owner's groups partial refused"

export const situations: Arr.NonEmptyReadonlyArray<Situation> = [
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
	"a member's row named by an owner, inserted between it and the owner's members",
	"plain writes in strata around the family's",
	"a follow-up accepted",
	"a follow-up refilling a value",
	"an owner's column changed beside an append to its family",
	"an ordered member deleted",
	"a member moved to another owner",
	"a member owning a family moved between owners",
	"a query's insert accepted",
	"an owner's write from a query beside its family's append refused",
	"a put from a query accepted",
	"a put from a query refused for a value it leaves stale",
	"a refill of an immutable relation refused",
	"a delete of everything accepted",
	"a delete of everything by field equality accepted",
	"an unlawful write refused by a law it breaks",
	"two facts at one key refused by its key",
	"a member naming no owner refused by its family",
	"every fact stated twice written once",
	"one member per fact"
]

/** Whether the reference states `cause` among an uncompiled step's causes, a family it names by its owner and count. */
export const statesCause = (
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
		case "edit":
			return among(expected.edits, cause.family)
		case "passed":
		case "rewritten":
		case "edits":
			return false
	}
}

/** The situation a stale value's refusal reaches, by its cause. */
export const causeNote = (cause: StaleCause): Situation => {
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
		case "edit":
			return "a member's own write reaching another family's value refused"
		case "passed":
		case "rewritten":
		case "edits":
			return assert.fail(
				`refused as stale (${cause.kind}), a way the swarm's ChangeSets, which write a family's members in one stratum beside no member they reach, never draw`
			)
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
			: []),
		...(Arr.some(
			spec.laws,
			(l) =>
				l.kind === "into member rows" &&
				stored(l.relation) &&
				hasMembers(l.family) &&
				Arr.some(
					spec.fill.families,
					(f, k) => f.owner === l.relation && f.member !== l.relation && hasMembers(k)
				)
		)
			? (["a member's row named by an owner, inserted between it and the owner's members"] as const)
			: [])
	]
}

/** The shapes an accepted step reaches. */
export const stepShapes = (
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
				...(Option.exists(f.moved, (moved) =>
					Arr.some(state.rows, (y) => Arr.some(y.memberOf, (m) => m.owner === moved.id))
				)
					? (["a member owning a family moved between owners"] as const)
					: []),
				...(step.query === undefined ? [] : (["a query's insert accepted"] as const))
			]
		}
		case "query put":
			return [...common, "a put from a query accepted"]
		case "delete all":
			return [
				"a delete of everything accepted",
				...(step.by === "selection"
					? (["a delete of everything by field equality accepted"] as const)
					: [])
			]
	}
}

/** Every relation's stored rows equal the oracle's after `what`. */
export const storesExactly = (
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

/** A case over a fixed spec, its ChangeSets drawn under `on` at full weight. */
const over =
	(spec: SwarmSpec, on: ReadonlyArray<SwarmFeature>): Gen<SwarmCase> =>
	(source) => ({ spec, steps: source.draw(stepsGen(fullSwarm(on), false, spec)) })

const relationFlags = (mutable: boolean) => ({ generated: noGeneration, mutable })

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
const bare = (fill: SwarmSpec["fill"]): SwarmSpec => ({
	fill,
	ends: [],
	plains: [],
	laws: []
})

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

/** An immutable owner R0 of a counted family of R2, whose members a mutable R1 nests in an ordered family of its own:
 * an insert of R1 appends to R0's family, as R2's own insert would. */
const nestedCounted = coreOf(
	[false, true, true],
	[
		{ kind: "counted", owner: 0, member: 2, fold: "none" },
		{ kind: "ordered", owner: 1, member: 2, fold: "none" }
	],
	[],
	[]
)

/** A mutable owner R0 of a counted family of R1 whose sum fold steps R1's copy of R0's `v`. */
const steppedCopy = coreOf(
	[true, true],
	[{ kind: "counted", owner: 0, member: 1, fold: "sum" }],
	[{ family: 0, axis: "owner", source: { kind: "caller" } }],
	[{ kind: "copy", family: 0, copy: 0 }]
)

/** A mutable owner R0 of an ordered family of R1, itself the owner of a counted family of R2 whose sum fold steps R2's
 * copy of R1's copy of R0's `v`: a put of R0 reaches the fold along two owner axes. The first family is a sequence,
 * whose walk fills R1's copy before the counted family's fill reads it; a counted family's copy of another counted
 * family's is no column a fill reaches (UnfillableField). */
const twoHopCopy = coreOf(
	[true, true, true],
	[
		{ kind: "ordered", owner: 0, member: 1, fold: "none" },
		{ kind: "counted", owner: 1, member: 2, fold: "sum" }
	],
	[
		{ family: 0, axis: "owner", source: { kind: "caller" } },
		{ family: 1, axis: "owner", source: { kind: "copy", copy: 0 } }
	],
	[{ kind: "copy", family: 1, copy: 1 }]
)

/** A mutable owner R0 of a counted family of R1 whose members copy R0's `v` along its owner axis, which their sum fold
 * steps: a put of R0 refills the fold, and an append recounts the owner, whose count ‹n› the stored members copy. The
 * axis carries the count once, as ‹n›: a copy of the count beside it is UnsupportedLawFamily. */
const copiedCount = coreOf(
	[true, true],
	[{ kind: "counted", owner: 0, member: 1, fold: "sum" }],
	[{ family: 0, axis: "owner", source: { kind: "caller" } }],
	[{ kind: "copy", family: 0, copy: 0 }]
)

/** A mutable owner R0 of an ordered family of R1, itself the owner of a counted family of R2 folded by count: a member
 * owning a family, which a follow-up moves to another owner's group. */
const memberOwning = coreOf(
	[true, true, true],
	[
		{ kind: "ordered", owner: 0, member: 1, fold: "none" },
		{ kind: "counted", owner: 1, member: 2, fold: "count" }
	],
	[],
	[]
)

/**
 * A case over `memberOwning` whose first insert is an instance of two or three R0 rows, each with up to two R1 members
 * nested and the first with one at least, and one to four R2 members, each of a drawn R1 row; then a follow-up that
 * moves an R1 member owning R2 members to the end of another R0 row's group (fill.ts movingGen), that row's `v` put or
 * not. So the instance holds such a move by construction.
 */
const ownerMoved: Gen<SwarmCase> = (source) => {
	const spec = bare(memberOwning)
	const rows: Array<InstanceRow> = []
	const v = () => BigInt(source.draw(int(-2, 3)))
	const owners = source.draw(int(2, 3))
	for (let o = 0; o < owners; o += 1) {
		const owner = rows.length + 1
		rows.push({ relation: 0, id: owner, v: v(), memberOf: [] })
		const members = source.draw(int(o === 0 ? 1 : 0, 2))
		for (let slot = 0; slot < members; slot += 1) {
			rows.push({
				relation: 1,
				id: rows.length + 1,
				v: v(),
				memberOf: [{ family: 0, owner, slot }]
			})
		}
	}
	const r1 = Arr.filter(rows, (r) => r.relation === 1)
	if (!Arr.isReadonlyArrayNonEmpty(r1)) {
		return assert.fail("the first R0 row holds an R1 member by construction")
	}
	const counted = source.draw(int(1, 4))
	for (let i = 0; i < counted; i += 1) {
		rows.push({
			relation: 2,
			id: rows.length + 1,
			v: v(),
			memberOf: [{ family: 1, owner: source.draw(element(r1)).id, slot: 0 }]
		})
	}
	const moved = defined(
		Option.getOrUndefined(source.draw(movingGen(spec.fill, rows, 0))),
		"a move of an R1 member owning R2 members, which the instance holds by construction"
	)
	const target = defined(
		Option.getOrUndefined(Arr.findFirst(rows, (r) => r.id === moved.row)),
		"the R0 row a member moves to"
	)
	return {
		spec,
		steps: [
			{
				kind: "insert",
				rows,
				plain: [],
				conflict: undefined,
				orphan: undefined,
				shape: { split: source.draw(boolean), repeat: false }
			},
			{
				kind: "follow",
				followUp: {
					...moved,
					put: source.draw(boolean) ? Option.some(target.v + 1n) : Option.none()
				},
				plain: [],
				query: undefined,
				shape: { split: source.draw(boolean), repeat: false }
			}
		]
	}
}

/**
 * Pantry's importWrite shape: R0 owns a counted family of R1, whose rows R2 names whole (an immediate foreign key into
 * R1's every field), and R2 owns a counted family of R3, so one stratum lands R1's rows before R2's and R3's after
 * them.
 */
const importWriteFamilies: SwarmSpec["fill"]["families"] = [
	{ kind: "counted", owner: 0, member: 1, fold: "none" },
	{ kind: "counted", owner: 2, member: 3, fold: "none" }
]

/** The importWrite shape with R0 owning an ordered family of R4 too, nested in R0's insert, as pantry's holds one. */
const nestedImportWriteFamilies: SwarmSpec["fill"]["families"] = [
	...importWriteFamilies,
	{ kind: "ordered", owner: 0, member: 4, fold: "none" }
]

/** A spec of `families` over relations of the given mutability, R2 naming R1's rows whole. */
const importWrite = (
	mutable: ReadonlyArray<boolean>,
	families: SwarmSpec["fill"]["families"]
): SwarmSpec => ({
	...bare(coreOf(mutable, families, [], [])),
	laws: [{ kind: "into member rows", relation: 2, family: 0 }]
})

/** The importWrite shape, nested or not, each relation mutable as drawn, with follow-ups and a delete of everything. */
const importWrites: Gen<SwarmCase> = (source) => {
	const families = source.draw(element([importWriteFamilies, nestedImportWriteFamilies]))
	const relations = 1 + Arr.reduce(families, 0, (most, f) => Math.max(most, f.owner, f.member))
	return source.draw(
		over(
			importWrite(
				upTo(relations, () => source.draw(boolean)),
				families
			),
			["follow-ups", "delete all"]
		)
	)
}

/** A case over `spec` whose first insert of a drawn instance of at least `least` top rows per relation breaks a law
 * as `how` says: one top fact stated twice at its key, or a counted member naming no owner. */
const brokenFirst =
	(spec: SwarmSpec, how: "conflict" | "orphan"): Gen<SwarmCase> =>
	(source) => {
		const rows = source.draw(swarmInstanceGen(spec, 24, 1, 1))
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
				rows: source.draw(swarmInstanceGen(spec, bound, 1, least)),
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

/**
 * The situations the drawn cases reach only now and then, each with the case a witness whose turn aims at it draws
 * (aimed), the case it runs, prints and keeps.
 */
export const aims: ReadonlyArray<readonly [Situation, Gen<SwarmCase>]> = [
	["every fact stated twice written once", together],
	["a member's row named by an owner, inserted between it and the owner's members", importWrites],
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
		"a delete of everything by field equality accepted",
		over(importWrite([true, true, true, true, true], nestedImportWriteFamilies), [
			"delete all",
			"delete where"
		])
	],
	[
		"a delete of everything accepted",
		over(
			{
				...bare(twoFamilies),
				plains: [
					{ kind: "set", mutable: true },
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
	["a member owning a family written", over(bare(memberOwning), ["follow-ups"])],
	["a member owning a family moved between owners", ownerMoved],
	[
		"every fact stated twice written once",
		over(bare(twoFamilies), ["repeated fact", "follow-ups"])
	],
	["one member per fact", over(bare(twoFamilies), ["split members", "follow-ups"])],
	[
		"an owner's write from a query beside its family's append refused",
		over(bare(nestedCounted), ["split members"])
	]
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

/**
 * The swarm cases kept by value that the space reaches beyond toolchain-test keep, each a real bug the property once
 * caught, recorded beside the space (gen.ts recorded): 26 keep never found, within 790 to 2720 s each, then five whose
 * tokens keep had found went stale under 0d63f3740's fill generators, none found again in 1162 s; the one keep finds
 * again is kept by its token. A case whose steps delete holds every relation they remove open, as a closed relation's
 * facts are never deleted.
 */
export const recordedSwarmCases: Arr.NonEmptyReadonlyArray<SwarmCase> = [
	{
		spec: {
			fill: {
				relations: [
					relationFlags(true),
					relationFlags(false),
					relationFlags(false),
					relationFlags(true),
					{ generated: generationOfV, mutable: false }
				],
				families: [{ kind: "ordered", owner: 3, member: 4, fold: "none" }],
				copies: [
					{ family: 0, axis: "owner", source: { kind: "caller" } },
					{ family: 0, axis: "last", source: { kind: "copy", copy: 0 } }
				],
				steps: []
			},
			ends: [{ family: 0, monoid: "or" }],
			plains: [{ kind: "referrer", mutable: true }],
			laws: [
				{ kind: "into members", plain: 0, family: 0 },
				{ kind: "member key", family: 0 }
			]
		},
		steps: [
			inserted(
				[
					{ relation: 3, id: 1, v: 0n, memberOf: [] },
					{ relation: 4, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 4, id: 3, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 1 }] }
				],
				false,
				undefined
			),
			{
				kind: "follow",
				followUp: {
					owner: 3,
					row: 1,
					put: Option.some(5n),
					inserted: [],
					removed: Option.none(),
					appended: Option.none(),
					moved: Option.none()
				},
				plain: [],
				query: undefined,
				shape: { split: false, repeat: true }
			}
		]
	},
	{
		spec: importWrite([true, true, true, true, true], nestedImportWriteFamilies),
		steps: [
			inserted(
				[
					{ relation: 0, id: 1, v: 0n, memberOf: [] },
					{ relation: 4, id: 2, v: 1n, memberOf: [{ family: 2, owner: 1, slot: 0 }] },
					{ relation: 4, id: 3, v: 2n, memberOf: [{ family: 2, owner: 1, slot: 1 }] },
					{ relation: 1, id: 4, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 1, id: 5, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 2, id: 6, v: 0n, memberOf: [] },
					{ relation: 2, id: 7, v: 1n, memberOf: [] },
					{ relation: 3, id: 8, v: 0n, memberOf: [{ family: 1, owner: 6, slot: 0 }] },
					{ relation: 3, id: 9, v: 1n, memberOf: [{ family: 1, owner: 6, slot: 0 }] }
				],
				false,
				undefined
			),
			{ kind: "delete all", by: "rows" }
		]
	},
	{
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
	{
		spec: {
			fill: {
				relations: [{ generated: generationOfV, mutable: true }, relationFlags(true)],
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
	{
		spec: {
			fill: {
				relations: [relationFlags(true), { generated: generationOfV, mutable: true }],
				families: [
					{ kind: "counted", owner: 1, member: 0, fold: "none" },
					{ kind: "ordered", owner: 0, member: 1, fold: "none" }
				],
				copies: [{ family: 0, axis: "owner", source: { kind: "generated" } }],
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
					{ relation: 1, id: 2, v: 2n, memberOf: [{ family: 1, owner: 1, slot: 0 }] },
					{ relation: 1, id: 3, v: -1n, memberOf: [{ family: 1, owner: 1, slot: 1 }] },
					{ relation: 0, id: 4, v: 0n, memberOf: [{ family: 0, owner: 3, slot: 0 }] },
					{ relation: 0, id: 5, v: 3n, memberOf: [{ family: 0, owner: 2, slot: 0 }] }
				],
				false,
				undefined
			)
		]
	},
	{
		spec: {
			fill: {
				relations: [relationFlags(false), relationFlags(false)],
				families: [
					{ kind: "counted", owner: 0, member: 1, fold: "sum" },
					{ kind: "counted", owner: 1, member: 0, fold: "none" }
				],
				copies: [{ family: 0, axis: "owner", source: { kind: "caller" } }],
				steps: [{ kind: "copy", family: 0, copy: 0 }]
			},
			ends: [],
			plains: [],
			laws: []
		},
		steps: [
			inserted(
				[
					{ relation: 0, id: 1, v: 1n, memberOf: [{ family: 1, owner: 2, slot: 0 }] },
					{ relation: 1, id: 2, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
				],
				false,
				undefined
			)
		]
	},
	{
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
	{
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
	{
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
	{
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
	{
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
	{
		spec: {
			fill: {
				relations: [
					relationFlags(true),
					relationFlags(true),
					relationFlags(true),
					relationFlags(true),
					{ generated: generationOfV, mutable: false }
				],
				families: [
					{ kind: "ordered", owner: 0, member: 1, fold: "none" },
					{ kind: "counted", owner: 2, member: 3, fold: "sum" }
				],
				copies: [{ family: 1, axis: "owner", source: { kind: "caller" } }],
				steps: [{ kind: "copy", family: 1, copy: 0 }]
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
	{
		spec: {
			fill: coreOf([true, true], [{ kind: "counted", owner: 0, member: 1, fold: "none" }], [], []),
			ends: [],
			plains: [{ kind: "set", mutable: true }],
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
	{
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
	{
		spec: bare({
			relations: [{ generated: generationOfV, mutable: true }],
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
	{
		spec: {
			fill: {
				relations: [
					{ generated: generationOfV, mutable: true },
					{ generated: generationOfV, mutable: true }
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
	{
		spec: bare(
			coreOf(
				[true, true, true],
				[
					{ kind: "ordered", owner: 2, member: 0, fold: "none" },
					{ kind: "counted", owner: 1, member: 0, fold: "sum" }
				],
				[{ family: 0, axis: "owner", source: { kind: "caller" } }],
				[{ kind: "copy", family: 1, copy: 0 }]
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
	{
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
	{
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
	{
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
					inserted: [{ relation: 2, id: 6, v: -2n, memberOf: [{ family: 0, owner: 4, slot: 0 }] }],
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
	{
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
	{
		spec: bare(staleCopies(true)),
		steps: [
			inserted(
				[
					{ relation: 0, id: 1, v: 1n, memberOf: [] },
					{ relation: 1, id: 2, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 1, id: 3, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 1 }] },
					{ relation: 1, id: 4, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 2 }] }
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
					removed: Option.some({ id: 3, family: 0 }),
					appended: Option.none(),
					moved: Option.none()
				},
				plain: [],
				query: undefined,
				shape: { split: false, repeat: false }
			}
		]
	},
	{
		spec: bare(copiedCount),
		steps: [
			inserted(
				[
					{ relation: 0, id: 1, v: 1n, memberOf: [] },
					{ relation: 1, id: 2, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 1, id: 3, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 1 }] }
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
					inserted: [{ relation: 1, id: 4, v: 3n, memberOf: [{ family: 0, owner: 1, slot: 2 }] }],
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
	{
		spec: {
			fill: {
				relations: [
					{ generated: noGeneration, mutable: false },
					{ generated: generationOfV, mutable: false },
					{ generated: noGeneration, mutable: false },
					{ generated: noGeneration, mutable: false },
					{ generated: noGeneration, mutable: false },
					{ generated: noGeneration, mutable: false },
					{ generated: noGeneration, mutable: false },
					{ generated: noGeneration, mutable: false },
					{ generated: generationOfV, mutable: false },
					{ generated: noGeneration, mutable: false }
				],
				families: [
					{ kind: "counted", owner: 1, member: 3, fold: "none" },
					{ kind: "ordered", owner: 3, member: 4, fold: "none" },
					{ kind: "ordered", owner: 6, member: 8, fold: "none" },
					{ kind: "ordered", owner: 3, member: 6, fold: "none" },
					{ kind: "counted", owner: 5, member: 6, fold: "none" },
					{ kind: "counted", owner: 4, member: 9, fold: "none" },
					{ kind: "counted", owner: 5, member: 6, fold: "none" },
					{ kind: "tree", owner: 2, member: 2, fold: "none" }
				],
				copies: [
					{ family: 0, axis: "owner", source: { kind: "caller" } },
					{ family: 2, axis: "owner", source: { kind: "caller" } },
					{ family: 0, axis: "owner", source: { kind: "generated" } },
					{ family: 2, axis: "last", source: { kind: "caller" } },
					{ family: 2, axis: "last", source: { kind: "generated" } },
					{ family: 3, axis: "last", source: { kind: "caller" } },
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
					{ relation: 1, id: 1, v: 0n, memberOf: [] },
					{ relation: 2, id: 2, v: 0n, memberOf: [] },
					{ relation: 2, id: 3, v: 0n, memberOf: [] },
					{ relation: 2, id: 4, v: 0n, memberOf: [{ family: 7, owner: 3, slot: 0 }] },
					{ relation: 2, id: 5, v: 0n, memberOf: [{ family: 7, owner: 4, slot: 0 }] },
					{ relation: 2, id: 6, v: 0n, memberOf: [] },
					{ relation: 2, id: 7, v: 0n, memberOf: [] },
					{ relation: 2, id: 8, v: 0n, memberOf: [{ family: 7, owner: 7, slot: 0 }] },
					{ relation: 3, id: 9, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{
						relation: 6,
						id: 10,
						v: 0n,
						memberOf: [
							{ family: 3, owner: 9, slot: 0 },
							{ family: 4, owner: 24, slot: 0 },
							{ family: 6, owner: 24, slot: 0 }
						]
					},
					{ relation: 8, id: 11, v: 0n, memberOf: [{ family: 2, owner: 10, slot: 0 }] },
					{ relation: 3, id: 12, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 3, id: 13, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 4, id: 14, v: 0n, memberOf: [{ family: 1, owner: 13, slot: 0 }] },
					{ relation: 4, id: 15, v: 0n, memberOf: [{ family: 1, owner: 13, slot: 1 }] },
					{ relation: 3, id: 16, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{
						relation: 6,
						id: 17,
						v: 0n,
						memberOf: [
							{ family: 3, owner: 16, slot: 0 },
							{ family: 4, owner: 24, slot: 0 },
							{ family: 6, owner: 25, slot: 0 }
						]
					},
					{
						relation: 6,
						id: 18,
						v: 0n,
						memberOf: [
							{ family: 3, owner: 16, slot: 1 },
							{ family: 4, owner: 24, slot: 0 },
							{ family: 6, owner: 24, slot: 0 }
						]
					},
					{ relation: 8, id: 19, v: 0n, memberOf: [{ family: 2, owner: 18, slot: 0 }] },
					{ relation: 3, id: 20, v: 0n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{
						relation: 6,
						id: 21,
						v: 0n,
						memberOf: [
							{ family: 3, owner: 20, slot: 0 },
							{ family: 4, owner: 24, slot: 0 },
							{ family: 6, owner: 24, slot: 0 }
						]
					},
					{ relation: 8, id: 22, v: 0n, memberOf: [{ family: 2, owner: 21, slot: 0 }] },
					{ relation: 8, id: 23, v: 0n, memberOf: [{ family: 2, owner: 21, slot: 1 }] },
					{ relation: 5, id: 24, v: 0n, memberOf: [] },
					{ relation: 5, id: 25, v: 0n, memberOf: [] },
					{ relation: 5, id: 26, v: 0n, memberOf: [] },
					{ relation: 5, id: 27, v: 0n, memberOf: [] },
					{ relation: 5, id: 28, v: 0n, memberOf: [] },
					{ relation: 7, id: 29, v: 0n, memberOf: [] },
					{ relation: 7, id: 30, v: 0n, memberOf: [] },
					{ relation: 9, id: 31, v: 0n, memberOf: [{ family: 5, owner: 14, slot: 0 }] }
				],
				true,
				undefined
			)
		]
	},
	{
		spec: {
			fill: {
				relations: [
					{ generated: generationOfV, mutable: true },
					{ generated: noGeneration, mutable: true },
					{ generated: noGeneration, mutable: true },
					{ generated: noGeneration, mutable: true },
					{ generated: generationOfV, mutable: true }
				],
				families: [
					{ kind: "tree", owner: 4, member: 4, fold: "none" },
					{ kind: "counted", owner: 0, member: 2, fold: "none" },
					{ kind: "tree", owner: 1, member: 1, fold: "none" },
					{ kind: "counted", owner: 2, member: 1, fold: "none" },
					{ kind: "counted", owner: 4, member: 1, fold: "none" },
					{ kind: "tree", owner: 0, member: 0, fold: "none" },
					{ kind: "counted", owner: 4, member: 2, fold: "sum" },
					{ kind: "tree", owner: 2, member: 2, fold: "none" },
					{ kind: "counted", owner: 0, member: 3, fold: "none" }
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
					{ relation: 0, id: 1, v: 0n, memberOf: [] },
					{ relation: 0, id: 2, v: 1n, memberOf: [{ family: 5, owner: 1, slot: 0 }] }
				],
				true,
				undefined
			),
			{ kind: "delete all", by: "selection" }
		]
	},
	{
		spec: {
			fill: {
				relations: [relationFlags(true), relationFlags(true), relationFlags(true)],
				families: [
					{ kind: "counted", owner: 1, member: 2, fold: "none" },
					{ kind: "counted", owner: 2, member: 0, fold: "none" },
					{ kind: "ordered", owner: 0, member: 1, fold: "none" },
					{ kind: "ordered", owner: 2, member: 0, fold: "none" }
				],
				copies: [
					{ family: 1, axis: "owner", source: { kind: "count", family: 3 } },
					{ family: 2, axis: "owner", source: { kind: "index", family: 3 } }
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
					{ relation: 2, id: 1, v: 1n, memberOf: [{ family: 0, owner: 14, slot: 0 }] },
					{ relation: 2, id: 2, v: 0n, memberOf: [{ family: 0, owner: 8, slot: 0 }] },
					{
						relation: 0,
						id: 3,
						v: 2n,
						memberOf: [
							{ family: 3, owner: 2, slot: 0 },
							{ family: 1, owner: 5, slot: 0 }
						]
					},
					{ relation: 2, id: 4, v: 1n, memberOf: [{ family: 0, owner: 7, slot: 0 }] },
					{ relation: 2, id: 5, v: 0n, memberOf: [{ family: 0, owner: 7, slot: 0 }] },
					{
						relation: 0,
						id: 6,
						v: 3n,
						memberOf: [
							{ family: 3, owner: 5, slot: 0 },
							{ family: 1, owner: 1, slot: 0 }
						]
					},
					{ relation: 1, id: 7, v: 0n, memberOf: [{ family: 2, owner: 6, slot: 0 }] },
					{ relation: 1, id: 8, v: 0n, memberOf: [{ family: 2, owner: 6, slot: 1 }] },
					{
						relation: 0,
						id: 9,
						v: 3n,
						memberOf: [
							{ family: 3, owner: 5, slot: 1 },
							{ family: 1, owner: 10, slot: 0 }
						]
					},
					{ relation: 2, id: 10, v: 3n, memberOf: [{ family: 0, owner: 7, slot: 0 }] },
					{ relation: 2, id: 11, v: 0n, memberOf: [{ family: 0, owner: 8, slot: 0 }] },
					{ relation: 2, id: 12, v: 1n, memberOf: [{ family: 0, owner: 7, slot: 0 }] },
					{
						relation: 0,
						id: 13,
						v: -1n,
						memberOf: [
							{ family: 3, owner: 12, slot: 0 },
							{ family: 1, owner: 10, slot: 0 }
						]
					},
					{ relation: 1, id: 14, v: 3n, memberOf: [{ family: 2, owner: 13, slot: 0 }] },
					{
						relation: 0,
						id: 15,
						v: 3n,
						memberOf: [
							{ family: 3, owner: 12, slot: 1 },
							{ family: 1, owner: 11, slot: 0 }
						]
					}
				],
				true,
				undefined
			),
			{
				kind: "follow",
				followUp: undefined,
				plain: [],
				query: undefined,
				shape: { split: true, repeat: false }
			},
			{
				kind: "follow",
				followUp: {
					owner: 1,
					row: 7,
					put: Option.some(-3n),
					inserted: [
						{ relation: 2, id: 16, v: 0n, memberOf: [{ family: 0, owner: 7, slot: 0 }] },
						{ relation: 2, id: 17, v: -1n, memberOf: [{ family: 0, owner: 7, slot: 0 }] }
					],
					removed: Option.none(),
					appended: Option.none(),
					moved: Option.none()
				},
				plain: [],
				query: undefined,
				shape: { split: true, repeat: false }
			}
		]
	},
	{
		spec: importWrite([false, false, false, false], importWriteFamilies),
		steps: [
			inserted(
				[
					{ relation: 0, id: 1, v: 0n, memberOf: [] },
					{ relation: 1, id: 2, v: 1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 1, id: 3, v: 2n, memberOf: [{ family: 0, owner: 1, slot: 0 }] },
					{ relation: 2, id: 4, v: 0n, memberOf: [] },
					{ relation: 2, id: 5, v: 1n, memberOf: [] },
					{ relation: 3, id: 6, v: 0n, memberOf: [{ family: 1, owner: 4, slot: 0 }] },
					{ relation: 3, id: 7, v: 1n, memberOf: [{ family: 1, owner: 4, slot: 0 }] }
				],
				false,
				undefined
			)
		]
	},
	{
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
	{
		spec: bare({
			relations: [
				{ generated: generationOfV, mutable: true },
				{ generated: generationOfV, mutable: true }
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
	{
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
	{
		spec: {
			fill: {
				relations: [
					{ generated: generationOfV, mutable: true },
					{ generated: generationOfV, mutable: true }
				],
				families: [{ kind: "counted", owner: 0, member: 1, fold: "sum" }],
				copies: [{ family: 0, axis: "owner", source: { kind: "generated" } }],
				steps: [{ kind: "copy", family: 0, copy: 0 }]
			},
			ends: [],
			plains: [],
			laws: []
		},
		steps: [
			inserted(
				[
					{ relation: 0, id: 1, v: 0n, memberOf: [] },
					{ relation: 1, id: 2, v: -1n, memberOf: [{ family: 0, owner: 1, slot: 0 }] }
				],
				false,
				undefined
			),
			{
				kind: "follow",
				followUp: {
					owner: 0,
					row: 1,
					put: Option.some(1n),
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
	}
]
