import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Record as Rec, Result } from "effect"
import { apply } from "#adapter/apply/index.ts"
import { dbContext } from "#adapter/db/context.ts"
import { Db } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { bits, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { HeadShape } from "#compiler/types/query/terms.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	type MemberInput
} from "#compiler/write/changeset/value.ts"
import { caseGen, stepsGen } from "#test/pg/write/swarm/case.ts"
import {
	nothingStored,
	type StepVerdict,
	expectStep,
	familyWrites,
	hostSchema,
	justified,
	type Laws,
	orphaned,
	type PlainOp,
	type Placed,
	type State,
	type Step,
	storedRows,
	type SwarmCase
} from "#test/pg/write/swarm/oracle.ts"
import {
	buildSwarm,
	type BuiltRelation,
	type BuiltSwarm,
	countName,
	familyOf,
	groupName,
	holdsMask,
	Mask,
	idOfUuid,
	swarmInstanceGen,
	maskOf,
	nonEmptyRelations,
	plainFact,
	plainName,
	type SwarmFeature,
	type SwarmSpec
} from "#test/pg/write/swarm/spec.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import {
	followUpMembers,
	type InstanceRow,
	relationName,
	uuidOfRow,
	writesVerdict
} from "#test/support/families/fill.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
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
 *   at one key the key's, a member naming no owner its family's;
 * - a refusal when it compiles is justified by the oracle's own statement: StaleDerivedRead where the reference finds
 *   a refill of an immutable relation's rows or a put from a query leaving a value stale (fill.ts writesVerdict), and
 *   UnorderableStratum where every order of its cycle is one the stratum's writes require (oracle.ts justified).
 *
 * Its kept cases are the seven downstream defects' shapes; planted in a scratch copy, the total chain of a stratum's
 * family statements, the pair rule's edges on a deferred owner axis, and a nested fact's signature without its own
 * texts each fail the search.
 */

/** A fact as a ChangeSet states it. */
type Fact = { readonly [field: string]: unknown }

const membershipIn = (row: InstanceRow, f: number) =>
	Option.getOrUndefined(Arr.findFirst(row.memberOf, (m) => m.family === f))

/**
 * The top facts of an instance's rows by relation: each row no sequence nests, with its caller's fields, its set `b`,
 * its counted families' group fields, a tree root's own id as its root field, and each sequence's members nested at
 * its count field in slot order, each nested member its own caller's fields, set and counted group fields.
 */
const topFacts = (
	spec: SwarmSpec,
	rows: ReadonlyArray<InstanceRow>
): ReadonlyMap<number, ReadonlyArray<Fact>> => {
	const factOf = (row: InstanceRow, nested: boolean): Fact => {
		const fact: Record<string, unknown> = { id: uuidOfRow(row.id), v: row.v }
		if (holdsMask(spec, row.relation)) {
			fact["b"] = maskOf(row.id)
		}
		for (const m of row.memberOf) {
			if (familyOf(spec, m.family).kind === "counted") {
				fact[groupName(m.family)] = uuidOfRow(m.owner)
			}
		}
		for (const [f, family] of spec.fill.families.entries()) {
			if (family.kind === "tree" && family.member === row.relation && !nested) {
				fact[`d${f}`] = uuidOfRow(row.id)
			}
			if (family.owner !== row.relation || family.kind === "counted") {
				continue
			}
			fact[countName(f)] = Arr.map(
				Arr.sort(
					Arr.filter(rows, (r) => membershipIn(r, f)?.owner === row.id),
					(a: InstanceRow, b: InstanceRow) =>
						(membershipIn(a, f)?.slot ?? 0) < (membershipIn(b, f)?.slot ?? 0) ? -1 : 1
				),
				(member) => factOf(member, true)
			)
		}
		return fact
	}
	const out = new Map<number, Array<Fact>>()
	for (const row of rows) {
		if (Arr.some(row.memberOf, (m) => familyOf(spec, m.family).kind !== "counted")) {
			continue
		}
		const list = out.get(row.relation) ?? []
		list.push(factOf(row, false))
		out.set(row.relation, list)
	}
	return out
}

/** A stored row's caller fact, as a delete or a put states it: its `v`, its set and its group of every family. */
const callerFact = (spec: SwarmSpec, row: InstanceRow): Fact => ({
	id: uuidOfRow(row.id),
	v: row.v,
	...(holdsMask(spec, row.relation) ? { b: maskOf(row.id) } : {}),
	...Rec.fromEntries(
		Arr.map(row.memberOf, (m) => [groupName(m.family), uuidOfRow(m.owner)] as const)
	)
})

/** One member of a ChangeSet: its relation, its operation, and its rows, facts or a query. */
interface Member {
	readonly relation: BuiltRelation
	readonly op: "insert" | "put" | "delete"
	readonly rows: MemberInput
}

/** A ChangeSet and its parameters. */
interface Built {
	readonly changes: ChangeSetValue
	readonly params: ParamMap
}

/**
 * A step's ChangeSet over the installed schema `value`: its plain writes in the strata they are placed in, its family
 * writes in the middle one, each stratum a ChangeSet of its own and the strata in sequence, each list of facts one
 * member or, split, one member per fact, every member stated twice where the shape repeats it.
 */
const changeSetOf = (
	spec: SwarmSpec,
	built: BuiltSwarm,
	value: ReturnType<BuiltSwarm["rename"]>,
	state: State,
	step: Step
): Built => {
	const relationOf = (name: string): BuiltRelation =>
		defined(built.relations[name], `the relation ${name}`)
	const shape =
		step.kind === "insert" || step.kind === "follow" ? step.shape : { split: false, repeat: false }
	const spread = (
		relation: BuiltRelation,
		op: Member["op"],
		facts: ReadonlyArray<Fact>
	): ReadonlyArray<Member> => {
		const members: ReadonlyArray<Member> = shape.split
			? Arr.map(facts, (f): Member => ({ relation, op, rows: [f] }))
			: Arr.isReadonlyArrayNonEmpty(facts)
				? [{ relation, op, rows: facts }]
				: []
		return shape.repeat ? [...members, ...members] : members
	}
	const plainMembers = (ops: ReadonlyArray<PlainOp>): ReadonlyArray<Member> =>
		Arr.flatMap(ops, (o) => spread(relationOf(plainName(o.row.plain)), o.op, [plainFact(o.row)]))
	const plainAt = (at: Placed): ReadonlyArray<Member> =>
		step.kind === "delete all" ? [] : plainMembers(Arr.filter(step.plain, (o) => o.at === at))
	const queryAt = (at: Placed): ReadonlyArray<Member> => {
		const q = step.kind === "follow" ? step.query : undefined
		if (q?.at !== at) {
			return []
		}
		const read = relationOf(relationName(q.relation))
		return [
			{
				relation: relationOf(plainName(q.plain)),
				op: "insert",
				rows: query(value).rule((r) => {
					const x = defined(v(read, "row")["v"], "the v of the relation a query reads")
					const bound: Readonly<Record<string, typeof x>> = { v: x }
					const head: HeadShape = { x }
					return r.match(read, bound).find(head)
				})
			}
		]
	}
	const family = ((): {
		readonly members: ReadonlyArray<Member>
		readonly params: ParamMap
	} => {
		switch (step.kind) {
			case "insert": {
				const rows = orphaned(spec, step)
				const facts = topFacts(spec, rows)
				return {
					members: Arr.flatMap([...facts.entries()], ([r, list]) => {
						const conflicting = Arr.flatMap(list, (f) =>
							step.conflict !== undefined && f["id"] === uuidOfRow(step.conflict)
								? [{ ...f, v: (typeof f["v"] === "bigint" ? f["v"] : 0n) + 1n }]
								: []
						)
						return spread(relationOf(relationName(r)), "insert", [...list, ...conflicting])
					}),
					params: {}
				}
			}
			case "follow":
				return {
					members:
						step.followUp === undefined
							? []
							: Arr.flatMap(followUpMembers(spec.fill, state.rows, step.followUp), (m) =>
									spread(
										relationOf(relationName(m.relation)),
										m.op,
										Arr.map(m.facts, (f) =>
											holdsMask(spec, m.relation) ? { ...f, b: maskOf(idOfUuid(f["id"])) } : f
										)
									)
								),
					params: {}
				}
			case "query put": {
				const target = relationOf(relationName(step.relation))
				const masked = holdsMask(spec, step.relation)
				return {
					members: [
						{
							relation: target,
							op: "put",
							rows: masked
								? query(value).rule((r) => {
										const rows = r.relation("rows", { id: uuid, v: pg.bigint, b: bits(Mask) })
										const row = v(rows, "row")
										return r.match(rows, row).find(row)
									})
								: query(value).rule((r) => {
										const rows = r.relation("rows", { id: uuid, v: pg.bigint })
										const row = v(rows, "row")
										return r.match(rows, row).find(row)
									})
						}
					],
					params: {
						rows: Arr.map(step.rows, (p) => ({
							id: uuidOfRow(p.id),
							v: p.v,
							...(masked ? { b: maskOf(p.id) } : {})
						}))
					}
				}
			}
			case "delete all":
				return {
					members: [
						...Arr.flatMap(spec.fill.relations, (_, r) => {
							const own = Arr.filter(state.rows, (x) => x.relation === r)
							return Arr.isReadonlyArrayNonEmpty(own)
								? [
										{
											relation: relationOf(relationName(r)),
											op: "delete" as const,
											rows: Arr.map(own, (x) => callerFact(spec, x))
										}
									]
								: []
						}),
						...plainMembers(
							Arr.map(state.plain, (row): PlainOp => ({ op: "delete", row, at: "with" }))
						)
					],
					params: {}
				}
		}
	})()
	const stratumOf = (members: ReadonlyArray<Member>): ChangeSetValue =>
		Arr.reduce(members, ChangeSet.empty(value), (cs, m) => {
			switch (m.op) {
				case "insert":
					return cs.insert(m.relation, m.rows)
				case "put":
					return cs.put(m.relation, m.rows)
				case "delete":
					return cs.delete(m.relation, m.rows)
			}
		})
	const strata = Arr.filter(
		[
			[...plainAt("before"), ...queryAt("before")],
			[...family.members, ...plainAt("with"), ...queryAt("with")],
			[...plainAt("after"), ...queryAt("after")]
		],
		Arr.isReadonlyArrayNonEmpty
	)
	const [first, ...rest] = Arr.map(strata, stratumOf)
	return {
		changes: Arr.reduce(rest, first ?? ChangeSet.empty(value), (a, b) => ChangeSet.sequence(a, b)),
		params: family.params
	}
}

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

const relationFlags = (mutable: boolean) => ({ generated: false, mutable, key: false })

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

/** The situations the drawn cases reach only now and then, each with the case a witness draws to reach it. */
const aims: ReadonlyArray<readonly [Situation, Gen<SwarmCase>]> = [
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

/** The seven downstream defects' shapes, each kept by value. */
const kept: ReadonlyArray<Kept<SwarmCase, Situation>> = [
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
		note: "CHANGELOG: an ordered member's delete re-places the next, which owns a counted member copying its index along an owner axis",
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
						{ generated: true, mutable: false, key: false }
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
						coverage: required<Situation>(situations, { cases: 80, sense: notesOnly }),
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
								logins: [fullWorld(declared).server],
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
							const world = fullWorld(value)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(world.server.roles.app, {})
								const context = dbContext(db)
								if (context === undefined) {
									return yield* Effect.die(new Error("Db.open registered no context"))
								}
								let state = nothingStored
								for (const [i, step] of steps.entries()) {
									const label = `step ${String(i)} (${step.kind}) of ${Formatter.format(spec)}`
									const expected = expectStep(spec, built, laws, host, state, step)
									const { changes, params } = changeSetOf(spec, built, value, state, step)
									const applied = yield* Effect.result(
										apply(context, changes, changes.reads, params)
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
													justified(spec, at, next),
													`${label}: refused with UnorderableStratum, whose order ${at.relation} ${at.op} before ${next.relation} ${next.op} no write of the stratum requires; the cycle: ${Formatter.format(cycle)}`
												)
											}
											c.note("a stratum no order keeps refused")
											return
										}
										if (reason._tag === "StaleDerivedRead" && expected.kind === "stale") {
											if (reason.cause.kind === "immutable") {
												assert.ok(
													expected.immutable.includes(reason.cause.relation),
													`${label}: a refill of the immutable ${reason.cause.relation}, which the reference finds no refill updates: ${Formatter.format(expected.immutable)}`
												)
												c.note("a refill of an immutable relation refused")
												return
											}
											assert.ok(
												reason.cause.kind === "query" && expected.query,
												`${label}: refused as stale for ${reason.cause.kind}, which the reference does not state`
											)
											c.note("a put from a query refused for a value it leaves stale")
											return
										}
										return assert.fail(
											`${label}: refused when it compiles, ${failure.reason.message}, where the oracle expects ${expected.kind}`
										)
									}
									const outcome = applied.success
									switch (expected.kind) {
										case "stale":
											return assert.fail(
												`${label}: ${outcome.kind}, where the reference finds a refill it cannot draw (immutable ${Formatter.format(expected.immutable)}, query ${String(expected.query)})`
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
											const named = Arr.map(outcome.refused.laws, (law): LawId =>
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
