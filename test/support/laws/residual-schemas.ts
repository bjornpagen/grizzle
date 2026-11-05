import { boolean, constant, type Gen, int, subarray, weighted } from "@grizzle/testing/gen"
import { Array as Arr } from "effect"
import {
	alternatives,
	type AuthoredStatementDesc,
	capacity,
	closed,
	contained,
	f,
	mirrors,
	mutable,
	on,
	onSelected,
	relation,
	type SchemaDesc,
	within
} from "#test/support/fixtures/ir/desc.ts"

/**
 * How a drawn roster arms its handles: every one; every one but the last; exactly one; or a subset of the rest beside
 * the first, which is always armed.
 */
export type Armed = "all" | "all but one" | "one" | "some"

/** One arm relation of a drawn alternatives law: the handles it is the payload of, at least one, and its mutability. */
export interface ArmSketch {
	readonly handles: Arr.NonEmptyReadonlyArray<number>
	readonly mutable: boolean
}

/**
 * A drawn alternatives law: the parent's key width, its roster's size, how the roster is armed, and its arm relations,
 * each the payload of its own handles, no handle of two; every relation's mutability.
 */
export interface AlternativesSketch {
	readonly kind: "alternatives"
	readonly keyWidth: 1 | 2
	readonly roster: number
	readonly armed: Armed
	readonly parentMutable: boolean
	readonly arms: Arr.NonEmptyReadonlyArray<ArmSketch>
}

/** A drawn point of each other residual family, two relations each, with each relation's mutability. */
export type OtherSketch = {
	readonly kind: "selectedSource" | "mirrors" | "capacity" | "coverage"
	readonly firstMutable: boolean
	readonly secondMutable: boolean
}

/**
 * A named invalid point: a drawn alternatives law whose parent is also the arm of its first handle. The compiler refuses
 * it, since an arm is keyed by a key of its relation, so a parent that is its own arm holds that handle in every fact
 * and every other handle of its roster is dead.
 */
export interface ParentArmSketch {
	readonly kind: "parentArm"
	readonly law: AlternativesSketch
}

/** A drawn residual law's schema, or the named invalid point beside them. */
export type ResidualSketch = AlternativesSketch | OtherSketch | ParentArmSketch

/** The armed handles of a roster of `size`: a nonempty subset, by how it is armed. */
const armedHandles = (size: number, armed: Armed): Gen<Arr.NonEmptyReadonlyArray<number>> => {
	const handles = Arr.makeBy(size, (i) => i)
	switch (armed) {
		case "all":
			return constant<Arr.NonEmptyReadonlyArray<number>>([0, ...handles.slice(1)])
		case "all but one":
			return constant<Arr.NonEmptyReadonlyArray<number>>([0, ...handles.slice(1, -1)])
		case "one":
			return constant<Arr.NonEmptyReadonlyArray<number>>([0])
		case "some":
			return (s) => [0, ...s.draw(subarray(handles.slice(1)))]
	}
}

/** Arm relations over the armed handles: one per handle, or one of them the payload of the first two. */
const armRelations =
	(armed: Arr.NonEmptyReadonlyArray<number>): Gen<Arr.NonEmptyReadonlyArray<ArmSketch>> =>
	(s) => {
		const [first, second, ...rest] = armed
		const shared = second !== undefined && s.draw(boolean)
		const lead: ArmSketch = {
			handles: shared ? [first, second] : [first],
			mutable: s.draw(boolean)
		}
		const others = shared ? rest : second === undefined ? [] : [second, ...rest]
		return [
			lead,
			...Arr.map(others, (h): ArmSketch => ({ handles: [h], mutable: s.draw(boolean) }))
		]
	}

/** An armed mode a roster of `size` can take: "all but one" needs two handles, and "some" a handle beside the first. */
const armedGen = (size: number): Gen<Armed> =>
	size === 1
		? constant<Armed>("all")
		: weighted<Armed>([
				[3, constant<Armed>("all")],
				[3, constant<Armed>("all but one")],
				[2, constant<Armed>("one")],
				[2, constant<Armed>("some")]
			])

/**
 * A drawn alternatives law, swarm-style: a roster of 1 to 24 handles, the large ones weighted on their own; its armed
 * handles all, all but one, one or some; arm relations distinct or one shared by two handles; each relation's mutability
 * drawn on its own.
 */
export const alternativesGen: Gen<AlternativesSketch> = (s) => {
	const roster = s.draw(
		weighted([
			[4, int(1, 4)],
			[3, int(5, 7)],
			[2, int(8, 24)]
		])
	)
	const armed = s.draw(armedGen(roster))
	return {
		kind: "alternatives",
		keyWidth: s.draw(boolean) ? 2 : 1,
		roster,
		armed,
		parentMutable: s.draw(boolean),
		arms: s.draw(armRelations(s.draw(armedHandles(roster, armed))))
	}
}

/** A drawn alternatives law of at least 8 handles, every one armed but the last. */
const largeUnarmedGen: Gen<AlternativesSketch> = (s) => {
	const roster = s.draw(int(8, 24))
	return {
		kind: "alternatives",
		keyWidth: s.draw(boolean) ? 2 : 1,
		roster,
		armed: "all but one",
		parentMutable: s.draw(boolean),
		arms: s.draw(armRelations(s.draw(armedHandles(roster, "all but one"))))
	}
}

/** A drawn alternatives law, every handle armed, whose first arm relation is the mutable payload of its first two. */
const sharedMutableGen: Gen<AlternativesSketch> = (s) => {
	const roster = s.draw(int(2, 7))
	return {
		kind: "alternatives",
		keyWidth: s.draw(boolean) ? 2 : 1,
		roster,
		armed: "all",
		parentMutable: s.draw(boolean),
		arms: [
			{ handles: [0, 1], mutable: true },
			...Arr.makeBy(roster - 2, (i): ArmSketch => ({ handles: [i + 2], mutable: s.draw(boolean) }))
		]
	}
}

const otherGen =
	(kind: OtherSketch["kind"]): Gen<OtherSketch> =>
	(s) => ({ kind, firstMutable: s.draw(boolean), secondMutable: s.draw(boolean) })

/**
 * A drawn residual law: an alternatives law most often, among them a large roster with an unarmed handle and a mutable
 * arm relation shared by two handles, each a combination the free draw pairs rarely; one point of each other family
 * and the named invalid point beside it.
 */
export const residualSketchGen: Gen<ResidualSketch> = weighted<ResidualSketch>([
	[12, alternativesGen],
	[1, largeUnarmedGen],
	[1, sharedMutableGen],
	[1, otherGen("selectedSource")],
	[1, otherGen("mirrors")],
	[1, otherGen("capacity")],
	[1, otherGen("coverage")],
	[1, (s): ParentArmSketch => ({ kind: "parentArm", law: s.draw(alternativesGen) })]
])

/** The handle name of roster position `i`. */
export const handleName = (i: number): string => `h${i}`

/** The arm relation name of arm position `j`. */
const armName = (j: number): string => `Arm${j}`

/** The `mutable` statements of the relations a list of (relation, mutability) pairs declares mutable. */
const mutables = (
	pairs: ReadonlyArray<readonly [string, boolean]>
): ReadonlyArray<AuthoredStatementDesc> =>
	Arr.flatMap(pairs, ([name, declared]) => (declared ? [mutable(name)] : []))

/**
 * The schema of a drawn alternatives law, over the public law statements' descriptions; with `parentArm`, the parent is
 * the arm of the first handle in place of its drawn arm relation.
 */
const alternativesSchema = (a: AlternativesSketch, parentArm: boolean): SchemaDesc => {
	const key = a.keyWidth === 2 ? ["k1", "k2"] : ["k1"]
	const keyFields = a.keyWidth === 2 ? { k1: f.integer, k2: f.integer } : { k1: f.integer }
	const handles = Arr.makeBy(a.roster, handleName)
	const Roster = closed("Roster", handles)
	const Node = relation("Node", { ...keyFields, kind: f.closedId("Roster"), note: f.integer }, key)
	const arms = Arr.map(a.arms, (arm, j) => ({
		arm,
		desc: relation(armName(j), { ...keyFields, amount: f.integer }, key)
	}))
	const byHandle: Record<
		string,
		{ readonly name: string; readonly primaryKey: ReadonlyArray<string> }
	> = {}
	for (const { arm, desc } of arms) {
		for (const h of arm.handles) {
			byHandle[handleName(h)] = desc
		}
	}
	if (parentArm) {
		byHandle[handleName(0)] = Node
	}
	return {
		name: "Alternatives",
		relations: [Roster, Node, ...Arr.map(arms, (x) => x.desc)],
		statements: [
			...alternatives(Node, "kind", Roster, byHandle),
			...mutables([
				["Node", a.parentMutable],
				...Arr.map(arms, (x): readonly [string, boolean] => [x.desc.name, x.arm.mutable])
			])
		],
		extends: undefined
	}
}

/** The schema of a drawn point of another residual family. */
const otherSchema = (o: OtherSketch): SchemaDesc => {
	const two = (first: string, second: string) =>
		mutables([
			[first, o.firstMutable],
			[second, o.secondMutable]
		])
	switch (o.kind) {
		case "selectedSource":
			return {
				name: "Staffing",
				relations: [
					relation("Assignment", { id: f.integer, worker: f.integer, active: f.boolean }, ["id"]),
					relation("Worker", { id: f.integer, name: f.integer }, ["id"])
				],
				statements: [
					contained(onSelected("Assignment", ["worker"], { active: true }), on("Worker", ["id"])),
					...two("Assignment", "Worker")
				],
				extends: undefined
			}
		case "mirrors":
			return {
				name: "Reasons",
				relations: [
					relation("Line", { id: f.integer, flagged: f.boolean }, ["id"]),
					relation("Reason", { id: f.integer, line: f.integer }, ["id"])
				],
				statements: [
					mirrors(onSelected("Line", ["id"], { flagged: true }), on("Reason", ["line"])),
					...two("Line", "Reason")
				],
				extends: undefined
			}
		case "capacity":
			return {
				name: "Teams",
				relations: [
					relation("Team", { id: f.integer, cap: f.integer }, ["id"]),
					relation("Member", { id: f.integer, team: f.integer }, ["id"])
				],
				statements: [
					capacity(on("Team", ["id"]), on("Member", ["team"]), within(1n, "cap"), {
						kind: "count"
					}),
					...two("Team", "Member")
				],
				extends: undefined
			}
		case "coverage":
			return {
				name: "Visits",
				relations: [
					relation(
						"Visit",
						{
							id: f.integer,
							site: f.integer,
							during: f.span(f.bigint, undefined),
							billable: f.boolean
						},
						["id"]
					),
					relation("Shift", { site: f.integer, during: f.span(f.bigint, undefined) }, [
						"site",
						"during"
					])
				],
				statements: [
					contained(
						onSelected("Visit", ["site", "during"], { billable: true }),
						on("Shift", ["site", "during"])
					),
					...two("Visit", "Shift")
				],
				extends: undefined
			}
	}
}

/**
 * The schema of a drawn residual law: one alternatives law over a parent keyed by `k1` (and `k2`), its roster `Roster`
 * of handles `h0`.., and its arm relations `Arm0`.., each keyed like the parent; or one law of another residual family
 * over its two relations; or the named invalid point, whose parent is the arm of `h0`.
 *
 * The residual schemas of the law suites, as Descriptions, built from a sketch the generator draws: every sketch but the
 * named invalid point is a schema the compiler admits, so a sketch's invariants are the harness's (an arm relation
 * serves at least one handle, no handle two), never the compiler's expected behaviour.
 */
export const residualSchema = (sketch: ResidualSketch): SchemaDesc => {
	switch (sketch.kind) {
		case "alternatives":
			return alternativesSchema(sketch, false)
		case "parentArm":
			return alternativesSchema(sketch.law, true)
		case "selectedSource":
		case "mirrors":
		case "capacity":
		case "coverage":
			return otherSchema(sketch)
	}
}
