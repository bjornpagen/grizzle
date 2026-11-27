/** What view-dependencies.test.ts reads: its schema, its box, and the dependencies a case's view is read with. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { viewContainments } from "#compiler/analysis/derived/drawn.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { ContainedDependency } from "#compiler/ir/keys.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import * as desc from "#test/support/fixtures/ir/desc.ts"
import { checking } from "#test/support/policy.ts"

const Learner = str.bytes(69, str.regex("^.+$", "su"))

/**
 * A ledger shaped as metis's assignment level: each learner's assignments, keyed by their number too; each sitting's
 * events, contained in its assignment; and loose marks of a learner's number at a step, which no containment holds and
 * no key of a number alone keys.
 */
const Assignment = relation("Assignment", { child: Learner, number: natural, test: pg.bigint }, [
	"child",
	"number"
])
const SittingEvent = relation("SittingEvent", { child: Learner, number: natural, step: natural }, [
	"child",
	"number",
	"step"
])
const Loose = relation("Loose", { child: Learner, number: natural, step: natural }, [
	"child",
	"number",
	"step"
])

const Ledger = schema(
	"ViewDependencies",
	[Assignment, SittingEvent, Loose],
	[
		key(on(Assignment, "number")),
		contained(on(SittingEvent, "child", "number"), on(Assignment, "child", "number"))
	]
)

/** Where a rule of a view draws a learner and a number from: an assignment, an event of it, or a loose mark. */
type Source = "assignment" | "event" | "loose"

/**
 * The views, each a union of rules drawing a learner and a number, `(child, number)`, from its sources in order, as
 * metis's AssignmentStatus draws a sitting's from its assignment and from its events.
 */
const AssignmentOnly = derived(
	"AssignmentOnly",
	query(Ledger).rule((r) => {
		const { child, number } = v(Assignment, "assignment")
		return r.match(Assignment, { child, number }).find({ child, number })
	})
)
const EventOnly = derived(
	"EventOnly",
	query(Ledger).rule((r) => {
		const { child, number } = v(SittingEvent, "event")
		return r.match(SittingEvent, { child, number }).find({ child, number })
	})
)
const LooseOnly = derived(
	"LooseOnly",
	query(Ledger).rule((r) => {
		const { child, number } = v(Loose, "loose")
		return r.match(Loose, { child, number }).find({ child, number })
	})
)
const AssignmentOrEvent = derived(
	"AssignmentOrEvent",
	query(Ledger)
		.rule((r) => {
			const { child, number } = v(Assignment, "assignment")
			return r.match(Assignment, { child, number }).find({ child, number })
		})
		.rule((r) => {
			const { child, number } = v(SittingEvent, "event")
			return r.match(SittingEvent, { child, number }).find({ child, number })
		})
)
const AssignmentOrLoose = derived(
	"AssignmentOrLoose",
	query(Ledger)
		.rule((r) => {
			const { child, number } = v(Assignment, "assignment")
			return r.match(Assignment, { child, number }).find({ child, number })
		})
		.rule((r) => {
			const { child, number } = v(Loose, "loose")
			return r.match(Loose, { child, number }).find({ child, number })
		})
)
const EventOrLoose = derived(
	"EventOrLoose",
	query(Ledger)
		.rule((r) => {
			const { child, number } = v(SittingEvent, "event")
			return r.match(SittingEvent, { child, number }).find({ child, number })
		})
		.rule((r) => {
			const { child, number } = v(Loose, "loose")
			return r.match(Loose, { child, number }).find({ child, number })
		})
)

const Views = schema.extend(
	[Ledger],
	"ViewDependencies_1",
	[AssignmentOnly, EventOnly, LooseOnly, AssignmentOrEvent, AssignmentOrLoose, EventOrLoose],
	[]
)

/** Each view by its rules' sources: the box, a dictionary of the views the schema declares. */
const views = [
	{ sources: ["assignment"], view: AssignmentOnly },
	{ sources: ["event"], view: EventOnly },
	{ sources: ["loose"], view: LooseOnly },
	{ sources: ["assignment", "event"], view: AssignmentOrEvent },
	{ sources: ["assignment", "loose"], view: AssignmentOrLoose },
	{ sources: ["event", "loose"], view: EventOrLoose }
] as const

export type Box = (typeof views)[number]

export type Feature = `${"every rule keyed" | "a rule unkeyed"}, ${1 | 2} rules`

export const boxGen: Gen<Box> = element(views)

/**
 * The dependencies the case's view is read with, as the checked schema reads it: the view's read, which the checker
 * stamps on every Base over its table (ir/keys.ts ViewRead determined, analysis/derived/drawn.ts viewDependencies).
 */
export const dependenciesOf = (box: Box): ReadonlyArray<ContainedDependency> => {
	const relation = checking(Views).relation(
		box.view.name,
		SourceLoc("view dependencies", [box.view.name])
	)
	return relation.kind === "derived" ? relation.analysis.read.determined : []
}

/** Whether every rule draws its learner and number from a relation a number keys: an assignment or its events. */
export const everyRuleKeyed = (box: Box): boolean =>
	Arr.every(box.sources, (s: Source) => s !== "loose")

/**
 * A root keyed by its value, and three relations each holding values of the root at marks, each contained in the root:
 * the paths a union's arm draws the root's value by, one through each relation it reads.
 */
const Paths = ownedFixture({
	name: "UnionDraws",
	relations: [
		desc.relation("Root", { x: desc.f.integer }, ["x"]),
		desc.relation("Via1", { x: desc.f.integer, mark: desc.f.integer }, ["x", "mark"]),
		desc.relation("Via2", { x: desc.f.integer, mark: desc.f.integer }, ["x", "mark"]),
		desc.relation("Via3", { x: desc.f.integer, mark: desc.f.integer }, ["x", "mark"])
	],
	statements: [
		desc.contained(desc.on("Via1", ["x"]), desc.on("Root", ["x"])),
		desc.contained(desc.on("Via2", ["x"]), desc.on("Root", ["x"])),
		desc.contained(desc.on("Via3", ["x"]), desc.on("Root", ["x"]))
	],
	bases: []
})

/** A union's arms and the relations each arm reads the root's value through. */
export interface UnionBox {
	readonly arms: number
	readonly paths: number
}

export type UnionFeature = `${"one arm" | "several arms"}, ${"one path" | "several paths"}`

/** Unions of one to six arms, each reading the root's value through one, two or three relations. */
export const unionGen: Gen<UnionBox> = (s) => ({
	arms: s.draw(element([1, 2, 3, 4, 5, 6] as const)),
	paths: s.draw(element([1, 2, 3] as const))
})

/**
 * The containments the union of `box` draws (analysis/derived/drawn.ts viewContainments), each its target and its pairs:
 * `arms` arms, the i-th a region binding x in each of the first `paths` relations at mark i, each reaching the root
 * through its own containment.
 */
export const unionDraws = (box: UnionBox): ReadonlyArray<string> => {
	const q = new Ir(new SchemaModel(Paths, {}))
	const vias = Arr.take(["Via1", "Via2", "Via3"] as const, box.paths)
	const arm = (i: number) =>
		q.region(
			Arr.map(vias, (via) => {
				const source = q.base(via)
				return { source, bind: { x: "x" }, constants: { mark: q.litFor(source, "mark", i + 1) } }
			}),
			conservativeMeta
		)
	const first = arm(0)
	const rest = Array.from({ length: box.arms - 1 }, (_, i) => arm(i + 1))
	const root = Arr.isReadonlyArrayNonEmpty(rest)
		? q.union([first, ...rest], [], conservativeMeta)
		: first
	return Arr.map(
		viewContainments(Paths.owned, root),
		(c) =>
			`${c.target}(${Arr.join(
				Arr.map(c.pairs, (p) => `${p.left}=${p.right}`),
				", "
			)})`
	)
}
