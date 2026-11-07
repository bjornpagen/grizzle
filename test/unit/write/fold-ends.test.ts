import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import type { Family } from "#compiler/ir/family.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	type EditTarget,
	type Edited,
	type FillContext,
	foldRecounts,
	ownersOf,
	planEdits,
	recountValues
} from "#compiler/write/family/edit.ts"
import { columnKey, familyKey, fieldKey } from "#compiler/write/family/fold.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, deepEquals, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	type Cell,
	type CellLabel,
	cellLabel,
	foldOf,
	foldSchema,
	type Group,
	hostOf,
	identityOf,
	type PlaneKind,
	type Steps,
	stepFacts,
	stepOf,
	stepsGen,
	times,
	type Value
} from "#test/support/families/ends.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A counted family's fill of every fold (write/family/edit.ts planEdits, foldRecounts and recountValues), for owners a
 * ChangeSet inserts with their members as separate inserts: each member's slot, its copy of the count and every hidden
 * running value, and each owner's count and every end, the values its insert row carries (write/program/bind.ts
 * carried), held to the README's fold (test/support/families/ends.ts), a host model that never runs the filler.
 *
 * The space is ends.ts's counted schema: every commutative monoid over every plane its admission accepts, sets over
 * rosters of one code to nine. An exhaustion holds each cell over a box: one owner of up to three members, each step
 * one of four values of its plane, a set's every subset of its first and its last code (two hex digits apart from five
 * codes on). A search then draws up to three owners of up to six members each, every step over its whole plane, a
 * set's over every subset, every family at once.
 */

const counted = foldSchema("counted")

const value = counted.value("FoldEnds")

const artifacts = succeeded(testArtifacts(value, testCompile))

/** The program of a ChangeSet that inserts owners and every monoid's members, compiled once. */
const program: CompiledWrite = succeeded(
	compileWrite(
		checking(value),
		descOf(
			Arr.reduce(counted.groups, ChangeSet.empty(value).insert(counted.owner, []), (cs, g) =>
				cs.insert(g.member, [])
			)
		),
		realityWrite(artifacts)
	)
)

const ctx: FillContext = { codes: program.frontend.codes, evaluate: program.frontend.evaluate }

/** A member of a case: its owner's key and its steps. */
interface Member {
	readonly owner: number
	readonly steps: Steps
}

/** A case: owners 1 to `owners`, and each monoid's members, in the order the ChangeSet inserts them. */
interface Inserted {
	readonly owners: number
	readonly members: ReadonlyArray<{ readonly monoid: Group["monoid"]; readonly member: Member }>
}

const targetOf = (g: Group): EditTarget =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(program.edits, (e) => e.target.relation.name === g.member.name)
		),
		`the edit of ${g.member.name}`
	).target

/** A group's one family. */
const familyOf = (target: EditTarget): Family =>
	defined(Option.getOrUndefined(Arr.head(target.families)), "the member's family").family

/** Each group's members of a case, each with its key, the member's position among the case's members plus one. */
const keyed = (c: Inserted, g: Group): ReadonlyArray<Member & { readonly id: number }> =>
	Arr.flatMap(c.members, (m, i) => (m.monoid === g.monoid ? [{ ...m.member, id: i + 1 }] : []))

/** The fill of one group of a case: its members' rows and its owners' recounts, folded into the inserted owners. */
const filledOf = (c: Inserted, g: Group): Edited => {
	const target = targetOf(g)
	const ownerFacts = times(c.owners, (i) => ({ id: i + 1, label: 0 }))
	const facts = Arr.map(keyed(c, g), (m) => ({ id: m.id, o: m.owner, ...stepFacts(g, m.steps) }))
	const edited = succeeded(
		planEdits(
			ctx,
			target,
			{ inserts: facts, puts: [], deletes: [], nested: [] },
			new Map(),
			(family) => ({
				stated: ownersOf(ctx, family, ownerFacts),
				plain: true,
				recounted: new Map()
			}),
			{ current: new Map(), refilled: () => false }
		)
	)
	return defined(foldRecounts([{ target, edited }])[0], "the edited relation")
}

/** A value the fill wrote where the README's fold gives another: its owner, its column, and both values. */
interface Disagreement {
	readonly owner: number
	readonly column: string
	readonly filled: unknown
	readonly folded: unknown
}

/**
 * Every disagreement of one group's fill with the README's fold: each owner's count and ends as its insert row carries
 * them (recountValues of its recount, or the starts of an owner whose family stays empty, which draws no recount), and
 * each member's slot, its copy of the count and its hidden running values, its slot the order the inserts appended it.
 */
const disagreementsOf = (c: Inserted, g: Group): ReadonlyArray<Disagreement> => {
	const target = targetOf(g)
	const family = familyOf(target)
	const edited = filledOf(c, g)
	const write = Option.getOrUndefined(
		Arr.findFirst(edited.owners, (w) => familyKey(w.family) === familyKey(family.id))
	)
	const rows = [...edited.rows.inserts.values()]
	const out: Array<Disagreement> = []
	for (const owner of times(c.owners, (i) => i + 1)) {
		const mine = Arr.filter(keyed(c, g), (m) => m.owner === owner)
		const [group] = ownersOf(ctx, family, [{ id: owner, label: 0 }]).keys()
		const recount = write?.recounts.get(defined(group, "the owner's group"))
		const drawnValues = recount === undefined ? undefined : recountValues(family, recount)
		const check = (column: string, filled: unknown, folded: unknown): void => {
			if (!deepEquals(filled, folded)) {
				out.push({ owner, column, filled, folded })
			}
		}
		check(family.count.name, drawnValues?.get(family.count.name) ?? 0n, BigInt(mine.length))
		for (const cell of g.cells) {
			const folded = foldOf(
				cell,
				Arr.map(mine, (m) => stepOf(cell, m.steps))
			)
			const fold = defined(
				Option.getOrUndefined(
					Arr.findFirst(family.folds, (f) =>
						Arr.some(f.planes, (p) => p.end.name === Arr.headNonEmpty(cell.ends))
					)
				),
				`the fold of ${cellLabel(cell)}`
			)
			for (const [p, plane] of fold.planes.entries()) {
				const identity = defined(identityOf(cell)[p], "a plane's identity")
				check(
					plane.end.name,
					drawnValues === undefined
						? hostOf(cell.plane, identity)
						: drawnValues.get(plane.end.name),
					hostOf(cell.plane, defined(folded.end[p], "a plane's end"))
				)
				for (const [slot, m] of mine.entries()) {
					const running = defined(folded.running[slot], "a member's running values")
					const row = defined(
						Option.getOrUndefined(
							Arr.findFirst(rows, (r) => r.values.get(fieldKey("id")) === m.id)
						),
						`member ${m.id}'s row`
					)
					const at = (column: string, filled: unknown, folded: unknown) =>
						check(`${column} of member ${m.id}`, filled, folded)
					at("its slot", row.values.get(columnKey(family.index)), BigInt(slot))
					at("its count", row.values.get(`law:${family.copy}`), BigInt(mine.length))
					at(
						columnKey(plane.before),
						row.values.get(columnKey(plane.before)),
						hostOf(cell.plane, defined(running.before[p], "a before"))
					)
					at(
						columnKey(plane.after),
						row.values.get(columnKey(plane.after)),
						hostOf(cell.plane, defined(running.after[p], "an after"))
					)
				}
			}
		}
	}
	return out
}

/** A cell's box: four values of its plane, a set's the subsets of its first and its last code. */
const boxGen = (p: PlaneKind): Gen<Value> => {
	switch (p.kind) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "money":
			return (source) => BigInt(source.draw(int(-1, 2)))
		case "natural":
		case "code":
			return (source) => BigInt(source.draw(int(0, 3)))
		case "text":
			return (source) => Str.slice(0, source.draw(int(0, 3)))("abc")
		case "bits":
			return (source) => {
				const mask = source.draw(int(0, 3))
				return BigInt(mask & 1) | (mask >= 2 ? 1n << BigInt(p.width - 1) : 0n)
			}
	}
}

/** Every cell of the counted schema, with its group. */
const cells: Arr.NonEmptyReadonlyArray<readonly [Group, Cell]> = nonEmpty(
	Arr.flatMap(counted.groups, (g) => Arr.map(g.cells, (c) => [g, c] as const))
)

/** A box case: one cell, and its owner's members' values at its step, every other step at the plane's first value. */
interface BoxCase {
	readonly cell: number
	readonly values: ReadonlyArray<Value>
}

const boxCaseGen: Gen<BoxCase> = (source) => {
	const cell = source.draw(int(0, cells.length - 1))
	const [, c] = defined(cells[cell], "a cell")
	return { cell, values: times(source.draw(int(0, 3)), () => source.draw(boxGen(c.plane))) }
}

/** A box case's size: each cell's members, zero to three, over its plane's four values. */
const boxCases = cells.length * (1 + 4 + 16 + 64)

/** A box case as an insert: owner 1, its members' values at the cell's step, every other step of its group zero. */
const insertedOfBox = (b: BoxCase): readonly [Group, Inserted] => {
	const [g, c] = defined(cells[b.cell], "a cell")
	const zero = (cell: Cell): Value => (cell.plane.kind === "text" ? "" : 0n)
	return [
		g,
		{
			owners: 1,
			members: Arr.map(b.values, (v) => ({
				monoid: g.monoid,
				member: {
					owner: 1,
					steps: Rec.fromEntries(
						Arr.flatMap(g.cells, (other) =>
							other.step === undefined ? [] : [[other.step, other === c ? v : zero(other)] as const]
						)
					)
				}
			}))
		}
	]
}

/** A drawn case: up to three owners, each with up to six members of every family, every step over its whole plane. */
const insertedGen: Gen<Inserted> = (source) => {
	const owners = source.draw(int(1, 3))
	return {
		owners,
		members: Arr.flatMap(counted.groups, (g) =>
			Arr.flatten(
				times(owners, (o) =>
					times(source.draw(int(0, 6)), () => ({
						monoid: g.monoid,
						member: { owner: o + 1, steps: source.draw(stepsGen(g)) }
					}))
				)
			)
		)
	}
}

type Situation =
	| `${CellLabel} filled for an owner of ${"no" | "one" | "several"} members`
	| "several owners filled in one insert"

const sizeOf = (n: number): "no" | "one" | "several" =>
	n === 0 ? "no" : n === 1 ? "one" : "several"

describe("a counted family's fill of every fold (write/family/edit.ts)", () => {
	it.effect(
		"fills every member's running values and every owner's count and end as the README's fold of its members, over a box of every cell",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/fold-ends/box",
						generator: boxCaseGen,
						literal: Formatter.format,
						limit: boxCases,
						box: "every cell of the counted schema, one owner of zero to three members, each step one of four values of its plane",
						oracle: {
							kind: "specification",
							name: "the README's fold of each family's members (test/support/families/ends.ts)"
						},
						coverage: requiredInSpace<Situation>(
							Arr.flatMap(cells, ([, c]) =>
								Arr.map(
									["no", "one", "several"] as const,
									(n): Situation => `${cellLabel(c)} filled for an owner of ${n} members`
								)
							)
						),
						caseHang
					},
					(b, c) =>
						Effect.sync(() => {
							const [g, inserted] = insertedOfBox(b)
							assert.deepEqual(disagreementsOf(inserted, g), [], Formatter.format(b))
							const [, cell] = defined(cells[b.cell], "a cell")
							c.note(`${cellLabel(cell)} filled for an owner of ${sizeOf(b.values.length)} members`)
						})
				)
			)
	)

	it.effect(
		"fills every family of several owners at once, every step over its whole plane, as the README's fold of each owner's members",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/fold-ends/drawn",
						draw: drawn(insertedGen),
						literal: Formatter.format,
						coverage: required<Situation>(["several owners filled in one insert"], {
							cases: 20,
							sense: notesOnly
						}),
						kept: [],
						runs: 60,
						shrink: boundedShrink(80),
						concurrency: 1,
						steerEvery: 8,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the README's fold of each family's members (test/support/families/ends.ts)"
						}
					},
					(inserted, c) =>
						Effect.sync(() => {
							for (const g of counted.groups) {
								assert.deepEqual(disagreementsOf(inserted, g), [], g.member.name)
							}
							if (inserted.owners > 1) {
								c.note("several owners filled in one insert")
							}
						})
				)
			)
	)
})
