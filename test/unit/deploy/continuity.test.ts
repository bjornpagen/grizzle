/**
 * Which roster a roster continues, drafted with no database: generated histories of two rosters and a stored relation T
 * whose fields r and q hold closed ids and s a set, each over a roster or moved to smallint. A step is one change and
 * exactly the declarations it needs, as a person types them: a handle added, removed (`--drop R#h`) or renamed
 * (`--rename R#h=k`); a roster renamed (`--rename R=S`), renamed without the declaration, which is its drop and a new
 * roster (`--drop R`), respelled to an alike name (no declaration), renamed to the name of another it drops (`--rename
 * R=S --drop S`), or swapped with another; a new roster; or a field moved to another roster or to or from smallint.
 *
 * The oracle is a second implementation of a roster's history: each roster of the model keeps its own codes, a handle
 * its code across every rename of its own or of its roster, a removed one a hole, a new one the next code, and a roster
 * that does not continue another starts afresh; each field knows the roster its stored values are handles of. Each step
 * is drafted as `grizzle generate` drafts it (the kit's draftCodes, compile and generate) from the snapshot the step
 * before wrote, read back as snapshot.json is read, and holds:
 *
 * - the draft is admitted: every step declares exactly what it drops and renames, in its codes' order;
 * - every roster's drafted codes are the model's, so a stored code of a field whose roster continues reads as the
 *   handle it was written as, renamed or not, or is a hole the migration's validation refuses, and never as another
 *   handle;
 * - a field whose values the model moves to a roster its own does not continue as, or to or from smallint, is converted
 *   at its placeholder, by the reviewer, and no other field is: a code is never cast into another roster's meaning. *
 * Plant (~/.cache/grizzle-release/BR06/plants): continuity-codes-restarted (every roster's codes drafted afresh, none
 * continued).
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	constant,
	type Gen,
	int,
	shuffled,
	type Weight,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { codebookOf, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import { assert } from "#test/support/assert.ts"
import { installedCodes } from "#test/support/compile.ts"
import {
	closed,
	f,
	type FixtureField,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	asDrafted,
	compile,
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	type Previous
} from "#test/support/migrate/kit.ts"
import { draftActions } from "#test/support/migrate/review.ts"

const handlePool = ["a", "b", "c", "d", "e", "f"] as const
type Handle = (typeof handlePool)[number]

/** The names a roster takes: each group two spellings of one conversion, one installed domain. */
const groups = [
	["KindA", "Kind_A"],
	["TierB", "Tier_B"],
	["ModeC", "Mode_C"],
	["PathD", "Path_D"]
] as const
type Group = (typeof groups)[number]

/** A roster of the model: its identity, which its declared renames keep, its name, and its codes in code order. */
interface RosterState {
	readonly id: number
	readonly group: Group
	readonly spelled: 0 | 1
	readonly codes: ReadonlyArray<CodeSlot>
}

const fieldNames = ["r", "s", "q"] as const
type FieldName = (typeof fieldNames)[number]

/** How each field holds its roster's values: r and q a closed id, s a set. */
const carriers: { readonly [F in FieldName]: "code" | "set" } = { r: "code", s: "set", q: "code" }

/** What a field's values are: handles of the roster of identity `roster`, or integers. */
type FieldType = { readonly kind: "roster"; readonly roster: number } | { readonly kind: "int" }

interface Model {
	readonly rosters: ReadonlyArray<RosterState>
	readonly fields: { readonly [F in FieldName]: FieldType }
	readonly nextId: number
}

const opKinds = [
	"add",
	"remove",
	"renameHandle",
	"rename",
	"replace",
	"respell",
	"take",
	"swap",
	"fresh",
	"move"
] as const
type OpKind = (typeof opKinds)[number]

/** One change, its choices picks the model reduces modulo what it holds, so every draw is a change or none. */
interface Op {
	readonly kind: OpKind
	readonly roster: number
	readonly pick: number
	readonly other: number
}

interface Sketch {
	readonly first: ReadonlyArray<Handle>
	readonly second: ReadonlyArray<Handle>
	readonly ops: ReadonlyArray<Op>
}

/** How often each change is drawn: a removal and the changes of a roster's name the likeliest, so a name changes over a
 * hole often. */
const opWeights: { readonly [K in OpKind]: Weight } = {
	add: 1,
	remove: 3,
	renameHandle: 1,
	rename: 2,
	replace: 1,
	respell: 2,
	take: 2,
	swap: 1,
	fresh: 1,
	move: 1
}

const opKindGen: Gen<OpKind> = weighted(
	Arr.map(opKinds, (kind) => [opWeights[kind], constant(kind)] as const)
)

const opGen: Gen<Op> = (source) => ({
	kind: source.draw(opKindGen),
	roster: source.draw(int(0, 3)),
	pick: source.draw(int(0, 7)),
	other: source.draw(int(0, 7))
})

const sketchGen: Gen<Sketch> = (source) => ({
	first: source.draw(shuffled(handlePool, { min: 3, max: 4 })),
	second: source.draw(shuffled(handlePool, { min: 3, max: 4 })),
	ops: source.draw(array(opGen, { min: 1, max: 6 }))
})

const featureNames = [
	"a roster renamed over a middle hole",
	"a roster respelled over a middle hole",
	"a dropped roster's name taken",
	"rosters swapped",
	"a roster renamed undeclared",
	"a handle renamed",
	"a field moved between rosters",
	"a field moved to or from smallint"
] as const
type Feature = (typeof featureNames)[number]

const nameOf = (r: RosterState): string => r.group[r.spelled]

const liveOf = (r: RosterState): ReadonlyArray<string> =>
	Arr.flatMap(r.codes, (slot) => (slot.kind === "live" ? [slot.handle] : []))

const freshCodes = (handles: ReadonlyArray<string>): ReadonlyArray<CodeSlot> =>
	Arr.map(handles, (handle): CodeSlot => ({ kind: "live", handle }))

/** Whether a roster's codes hold a hole a live code follows. */
const middleHole = (r: RosterState): boolean =>
	Arr.some(
		r.codes,
		(slot, code) =>
			slot.kind === "hole" && Arr.some(Arr.drop(r.codes, code), (s) => s.kind === "live")
	)

/** The `pick`-th of `values`, round. */
const nth = <A>(values: Arr.NonEmptyReadonlyArray<A>, pick: number): A =>
	Arr.getUnsafe(values, pick % values.length)

/** The groups no roster of the model names. */
const freeGroups = (m: Model): ReadonlyArray<Group> =>
	Arr.filter(groups, (g) => !Arr.some(m.rosters, (r) => r.group[0] === g[0]))

/** The pool's handles a roster holds no live code of. */
const unheld = (r: RosterState): ReadonlyArray<Handle> =>
	Arr.filter(handlePool, (h) => !liveOf(r).includes(h))

const withRoster = (m: Model, r: RosterState): Model => ({
	...m,
	rosters: Arr.map(m.rosters, (x) => (x.id === r.id ? r : x))
})

/** The fields of `m` over the roster `from`, moved to the roster `to`. */
const fieldsMoved = (m: Model, from: number, to: number): Model["fields"] => ({
	r: retarget(m.fields.r, from, to),
	s: retarget(m.fields.s, from, to),
	q: retarget(m.fields.q, from, to)
})

const retarget = (t: FieldType, from: number, to: number): FieldType =>
	t.kind === "roster" && t.roster === from ? { kind: "roster", roster: to } : t

const relationRename = (from: string, to: string): Declarations["renames"][number] => ({
	from: { kind: "relation", relation: parsedName(from) },
	to: { kind: "relation", relation: parsedName(to) }
})

const noneDeclared: Declarations = { renames: [], drops: [] }

/** A change applied: the model after it, what it declares, and the situation it reaches. */
interface Step {
	readonly next: Model
	readonly declared: Declarations
	readonly feature: Feature | undefined
}

/** A change to the model, or none where it does not apply. */
const stepOf = (m: Model, op: Op): Step | undefined => {
	if (!Arr.isReadonlyArrayNonEmpty(m.rosters)) {
		return assert.fail("the model holds a roster")
	}
	const x = nth(m.rosters, op.roster)
	const others = Arr.filter(m.rosters, (r) => r.id !== x.id)
	switch (op.kind) {
		case "add": {
			const free = unheld(x)
			if (!Arr.isReadonlyArrayNonEmpty(free)) {
				return undefined
			}
			const handle = nth(free, op.pick)
			return {
				next: withRoster(m, { ...x, codes: [...x.codes, { kind: "live", handle }] }),
				declared: noneDeclared,
				feature: undefined
			}
		}
		case "remove": {
			const live = liveOf(x)
			if (!Arr.isReadonlyArrayNonEmpty(live) || live.length < 2) {
				return undefined
			}
			const handle = nth(live, op.pick)
			return {
				next: withRoster(m, {
					...x,
					codes: Arr.map(x.codes, (slot): CodeSlot =>
						slot.kind === "live" && slot.handle === handle ? { kind: "hole" } : slot
					)
				}),
				declared: {
					renames: [],
					drops: [{ kind: "handle", roster: parsedName(nameOf(x)), handle }]
				},
				feature: undefined
			}
		}
		case "renameHandle": {
			const live = liveOf(x)
			const free = unheld(x)
			if (!Arr.isReadonlyArrayNonEmpty(live) || !Arr.isReadonlyArrayNonEmpty(free)) {
				return undefined
			}
			const from = nth(live, op.pick)
			const to = nth(free, op.other)
			return {
				next: withRoster(m, {
					...x,
					codes: Arr.map(x.codes, (slot): CodeSlot =>
						slot.kind === "live" && slot.handle === from ? { kind: "live", handle: to } : slot
					)
				}),
				declared: {
					renames: [
						{
							from: { kind: "handle", roster: parsedName(nameOf(x)), handle: from },
							to: { kind: "handle", roster: parsedName(nameOf(x)), handle: to }
						}
					],
					drops: []
				},
				feature: "a handle renamed"
			}
		}
		case "rename":
		case "replace": {
			const free = freeGroups(m)
			if (!Arr.isReadonlyArrayNonEmpty(free)) {
				return undefined
			}
			const group = nth(free, op.pick)
			const spelled = op.other % 2 === 0 ? 0 : 1
			if (op.kind === "rename") {
				const renamed: RosterState = { ...x, group, spelled }
				return {
					next: withRoster(m, renamed),
					declared: { renames: [relationRename(nameOf(x), nameOf(renamed))], drops: [] },
					feature: middleHole(x) ? "a roster renamed over a middle hole" : undefined
				}
			}
			const fresh: RosterState = { id: m.nextId, group, spelled, codes: freshCodes(liveOf(x)) }
			return {
				next: {
					rosters: [...others, fresh],
					fields: fieldsMoved(m, x.id, fresh.id),
					nextId: m.nextId + 1
				},
				declared: { renames: [], drops: [{ kind: "relation", relation: parsedName(nameOf(x)) }] },
				feature: "a roster renamed undeclared"
			}
		}
		case "respell":
			return {
				next: withRoster(m, { ...x, spelled: x.spelled === 0 ? 1 : 0 }),
				declared: noneDeclared,
				feature: middleHole(x) ? "a roster respelled over a middle hole" : undefined
			}
		case "take": {
			if (!Arr.isReadonlyArrayNonEmpty(others)) {
				return undefined
			}
			const dropped = nth(others, op.pick)
			const taker: RosterState = { ...x, group: dropped.group, spelled: dropped.spelled }
			return {
				next: {
					rosters: Arr.map(
						Arr.filter(m.rosters, (r) => r.id !== dropped.id),
						(r) => (r.id === x.id ? taker : r)
					),
					fields: fieldsMoved(m, dropped.id, x.id),
					nextId: m.nextId
				},
				declared: {
					renames: [relationRename(nameOf(x), nameOf(dropped))],
					drops: [{ kind: "relation", relation: parsedName(nameOf(dropped)) }]
				},
				feature: "a dropped roster's name taken"
			}
		}
		case "swap": {
			if (!Arr.isReadonlyArrayNonEmpty(others)) {
				return undefined
			}
			const y = nth(others, op.pick)
			return {
				next: withRoster(withRoster(m, { ...x, group: y.group, spelled: y.spelled }), {
					...y,
					group: x.group,
					spelled: x.spelled
				}),
				declared: {
					renames: [relationRename(nameOf(x), nameOf(y)), relationRename(nameOf(y), nameOf(x))],
					drops: []
				},
				feature: "rosters swapped"
			}
		}
		case "fresh": {
			const free = freeGroups(m)
			const handles = Arr.take(Arr.drop(handlePool, op.pick % 3), 2 + (op.other % 3))
			if (!Arr.isReadonlyArrayNonEmpty(free)) {
				return undefined
			}
			return {
				next: {
					...m,
					rosters: [
						...m.rosters,
						{ id: m.nextId, group: nth(free, op.other), spelled: 0, codes: freshCodes(handles) }
					],
					nextId: m.nextId + 1
				},
				declared: noneDeclared,
				feature: undefined
			}
		}
		case "move": {
			const field = nth(fieldNames, op.pick)
			const targets: Arr.NonEmptyReadonlyArray<FieldType> = [
				{ kind: "int" },
				...Arr.map(m.rosters, (r): FieldType => ({ kind: "roster", roster: r.id }))
			]
			const to = nth(targets, op.other)
			const was = m.fields[field]
			if (
				(to.kind === "int" && was.kind === "int") ||
				(to.kind === "roster" && was.kind === "roster" && to.roster === was.roster)
			) {
				return undefined
			}
			return {
				next: { ...m, fields: { ...m.fields, [field]: to } },
				declared: noneDeclared,
				feature:
					to.kind === "roster" && was.kind === "roster"
						? "a field moved between rosters"
						: "a field moved to or from smallint"
			}
		}
	}
}

const rosterNamed = (m: Model, id: number): RosterState =>
	Option.getOrElse(
		Arr.findFirst(m.rosters, (r) => r.id === id),
		() => assert.fail(`the model holds roster ${id}`)
	)

/** A field's declared type: a closed id or a set over its roster, under the roster's name, or smallint. */
const fieldOf = (m: Model, name: FieldName): FixtureField => {
	const t = m.fields[name]
	if (t.kind === "int") {
		return f.smallint
	}
	const roster = nameOf(rosterNamed(m, t.roster))
	return carriers[name] === "code" ? f.closedId(roster) : { kind: "bits", roster }
}

const descOf = (m: Model): SchemaDesc => ({
	name: "Continuity",
	relations: [
		...Arr.map(m.rosters, (r) => {
			const live = liveOf(r)
			return closed(nameOf(r), live)
		}),
		relation("T", { id: f.integer, r: fieldOf(m, "r"), s: fieldOf(m, "s"), q: fieldOf(m, "q") }, [
			"id"
		])
	],
	statements: [],
	extends: undefined
})

/** Whether a step moves a field's values to other meanings: to a roster other than the one they continue on, or to or
 * from smallint. */
const moves = (before: FieldType, after: FieldType): boolean =>
	before.kind === "int"
		? after.kind === "roster"
		: after.kind === "int" || after.roster !== before.roster

/** One step drafted from `previous` as `grizzle generate` drafts it, checked against the model; the snapshot it writes,
 * read back as snapshot.json is. */
const drafted = (
	previous: Previous,
	before: Model,
	after: Model,
	declared: Declarations,
	ordinal: number
): Previous => {
	const at = `step ${ordinal}`
	const desc = descOf(after)
	const codes = draftCodes(desc, previous, declared)
	if (!codes.ok) {
		return assert.fail(`${at}: the codes of a step in code order draft: ${codes.error.message}`)
	}
	const g = generate({
		installation: compile(desc, { ...asDrafted, codes: installedCodes(codes.value) }),
		name: `step_${ordinal}`,
		timestamp: draftedAt(ordinal),
		previous,
		workload: noWorkload,
		declared
	})
	if (!g.ok) {
		return assert.fail(
			`${at}: a step that declares what it drops and renames drafts: ${g.error.message}`
		)
	}
	const read = readSnapshot(g.value.snapshotFiles)
	if (Result.isFailure(read)) {
		return assert.fail(`${at}: the written snapshot reads back: ${read.failure.message}`)
	}
	const book = codebookOf(read.success.snapshot)
	for (const r of after.rosters) {
		assert.deepEqual(
			book.rosters.get(parsedName(nameOf(r)))?.codes,
			r.codes,
			`${at}: the codes of roster ${nameOf(r)} are its history's`
		)
	}
	const placeholders = Arr.flatMap(g.value.plan.steps, (s) =>
		Arr.flatMap(draftActions(s.draft), (a) =>
			a.kind === "fill"
				? Arr.map(a.fields, (f) => ({ column: f.column.name, reason: f.reason }))
				: []
		)
	)
	for (const field of fieldNames) {
		assert.deepEqual(
			Arr.filter(placeholders, (p) => p.column === field),
			moves(before.fields[field], after.fields[field]) ? [{ column: field, reason: "roster" }] : [],
			`${at}: field ${field} is converted at its placeholder, which names its roster as the reason a cast would misread it, exactly when its values move to other meanings`
		)
	}
	return fromSnapshot(read.success.snapshot)
}

const run = (sketch: Sketch, c: Case<Feature>): void => {
	if (!Arr.isReadonlyArrayNonEmpty(sketch.first) || !Arr.isReadonlyArrayNonEmpty(sketch.second)) {
		return assert.fail("a roster of the sketch holds a handle")
	}
	const [first, second] = groups
	let model: Model = {
		rosters: [
			{ id: 0, group: first, spelled: 0, codes: freshCodes(sketch.first) },
			{ id: 1, group: second, spelled: 0, codes: freshCodes(sketch.second) }
		],
		fields: {
			r: { kind: "roster", roster: 0 },
			s: { kind: "roster", roster: 0 },
			q: { kind: "roster", roster: 1 }
		},
		nextId: 2
	}
	let previous = drafted(fromEmpty, model, model, noneDeclared, 1)
	let ordinal = 1
	for (const op of sketch.ops) {
		const step = stepOf(model, op)
		if (step === undefined) {
			continue
		}
		ordinal += 1
		previous = drafted(previous, model, step.next, step.declared, ordinal)
		if (step.feature !== undefined) {
			c.note(step.feature)
		}
		model = step.next
	}
}

describe("roster continuity", () => {
	it.effect(
		"carries every roster's codes on through renames, respellings, takes and swaps, and converts a field whose values move to another roster's meaning at its placeholder",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a model of each roster's code history and of the roster each field's values are handles of"
						},
						suite: "unit/deploy/continuity",
						draw: drawn(sketchGen),
						literal: Formatter.format,
						coverage: required<Feature>(featureNames, { cases: 120, sense: notesOnly }),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) => Effect.sync(() => run(sketch, c))
				)
			)
	)
})
