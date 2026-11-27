/** What the properties of stratum-edits.test.ts read: its spaces, models and helpers. */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { array, type Gen, subset, weighted } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { transactionClock } from "#compiler/ir/clock.ts"
import { strataAt, type StratumAt } from "#compiler/ir/stratum.ts"
import { drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	mutable,
	on,
	ordered,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import {
	compileChangeSet,
	type FrontendOptions,
	type WriteFrontend
} from "#compiler/write/frontend/compile.ts"
import type { FamilyNode } from "#compiler/write/frontend/schedule.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

const Club = relation("Club", { id: pg.integer, n: drawnField(natural) }, ["id"])

const Member = relation("Member", { m: pg.integer, club: pg.integer }, ["m"])

const Doc = relation("Doc", { id: Id, lines: drawnField(natural) }, ["id"])

const Line = relation("Line", { id: Id, doc: Id, at: drawnField(natural), qty: pg.bigint }, ["id"])

const Tag = relation("Tag", { id: pg.integer, label: pg.integer }, ["id"])

const Edits = schema(
	"StratumEdits",
	[Club, Member, Doc, Line, Tag],
	[
		counted(on(Member, "club"), fin(Club, "n")),
		ordered(on(Line, "doc", "at"), fin(Doc, "lines")),
		unit("Clubs", { id: pg.integer }),
		unit("Members", { m: pg.integer }),
		unit("Docs", { id: Id }),
		mutable(Club),
		mutable(Member),
		mutable(Doc),
		mutable(Line)
	]
)

const artifacts = succeeded(testArtifacts(Edits, testCompile))

const reality = realityWrite(artifacts)

const checked = checking(Edits)

/** The front end's options as compileWrite states them for reality (program/compile.ts compile). */
const frontendOptions: FrontendOptions = {
	claims: reality.claims,
	laws: reality.laws,
	derived: reality.derived,
	codes: artifacts.names.codes,
	clock: reality.clock,
	source: transactionClock
}

const memberOps = ["insert", "delete", "put"] as const

const lineOps = ["delete", "put"] as const

const insertable = ["Doc", "Tag", "Club"] as const

/** An operation the edits state of a Member. */
type MemberOp = (typeof memberOps)[number]

/** An operation the edits state of a Line, which is inserted only nested under its Doc. */
type LineOp = (typeof lineOps)[number]

/** A relation a stratum inserts: Docs, each nesting its Lines; Tags, of no family; Clubs, the counted family's owners. */
type Inserted = (typeof insertable)[number]

/** The edits' operations on Members and on Lines, at least one in all. */
interface EditOps {
	readonly member: ReadonlyArray<MemberOp>
	readonly line: ReadonlyArray<LineOp>
}

/** A case: the edits; the strata before and after theirs, each the relations it inserts, at least one; and what the
 * edits' own stratum inserts beside them. */
interface Sketch extends EditOps {
	readonly before: ReadonlyArray<ReadonlyArray<Inserted>>
	readonly beside: ReadonlyArray<Inserted>
	readonly after: ReadonlyArray<ReadonlyArray<Inserted>>
}

const editsGen: Gen<EditOps> = weighted<EditOps>([
	[1, (source) => ({ member: source.draw(subset(memberOps, { min: 1, max: 3 })), line: [] })],
	[1, (source) => ({ member: [], line: source.draw(subset(lineOps, { min: 1, max: 2 })) })],
	[
		1,
		(source) => ({
			member: source.draw(subset(memberOps, { min: 1, max: 3 })),
			line: source.draw(subset(lineOps, { min: 1, max: 2 }))
		})
	]
])

const otherGen: Gen<ReadonlyArray<Inserted>> = subset(insertable, { min: 1, max: 3 })

export const sketchGen: Gen<Sketch> = (source) => ({
	...source.draw(editsGen),
	before: source.draw(array(otherGen, { min: 0, max: 1 })),
	beside: source.draw(subset(insertable, { min: 0, max: 3 })),
	after: source.draw(array(otherGen, { min: 0, max: 1 }))
})

/** One stratum of a case: what it inserts, and the edits it states, none outside the edits' stratum. */
interface StratumWrites extends EditOps {
	readonly inserted: ReadonlyArray<Inserted>
}

/** The case's strata in order, the edits' at the position past every stratum before it. */
const strataOf = (sketch: Sketch): Arr.NonEmptyReadonlyArray<StratumWrites> =>
	Arr.appendAll(
		Arr.prependAll(
			[{ inserted: sketch.beside, member: sketch.member, line: sketch.line }],
			Arr.map(sketch.before, (inserted) => ({ inserted, member: [], line: [] }))
		),
		Arr.map(sketch.after, (inserted) => ({ inserted, member: [], line: [] }))
	)

const insertedRelations = { Doc, Tag, Club } as const

/** One stratum's ChangeSet: every member an array of no fact, which a call gives. */
const stratumChange = (writes: StratumWrites): ChangeSetValue =>
	Arr.reduce(
		writes.line,
		Arr.reduce(
			writes.member,
			Arr.reduce(writes.inserted, ChangeSet.empty(Edits), (value, name) =>
				value.insert(insertedRelations[name], [])
			),
			(value, op) => value[op](Member, [])
		),
		(value, op) => value[op](Line, [])
	)

/** The case's ChangeSet: its strata in sequence. */
const changeOf = (sketch: Sketch): ChangeSetValue => {
	const changes = Arr.map(strataOf(sketch), stratumChange)
	return Arr.reduce(Arr.tailNonEmpty(changes), Arr.headNonEmpty(changes), (value, next) =>
		ChangeSet.sequence(value, next)
	)
}

/** A family statement as the model names it: its stratum, what it does, and the relation it does it to. */
interface Planned {
	readonly stratum: number
	readonly statement: "additions" | "recount" | "removals" | "unit"
	readonly relation: string
}

/** A family node of `stratum` as the model names it. */
const plannedOf = (stratum: StratumAt, node: FamilyNode): Planned => {
	switch (node.kind) {
		case "additions":
			return {
				stratum,
				statement: node.appends === "rows" ? "additions" : "recount",
				relation: node.appends === "rows" ? node.members[0] : node.member
			}
		case "removals":
			return { stratum, statement: "removals", relation: node.member }
		case "unit":
			return { stratum, statement: "unit", relation: node.units[0].relation.name }
	}
}

/** The model (the header): each stratum's family statements, from its own edits and nested writes alone. */
const modelOf = (frontend: WriteFrontend): ReadonlyArray<Planned> =>
	Arr.flatMap(strataAt(frontend.ir.strata), ([stratum]) => {
		const own = Arr.filter(frontend.edits, (e) => e.stratum === stratum)
		const removed = Arr.flatMap(own, (e) =>
			Arr.some(e.slots, (s) => s.as !== "inserts") ? [e.relation.name] : []
		)
		const appended = Arr.dedupe([
			...Arr.flatMap(own, (e) =>
				Arr.some(e.slots, (s) => s.as !== "deletes") ? [e.relation.name] : []
			),
			...Arr.flatMap(frontend.nested, (n) =>
				n.stratum === stratum ? [...n.nesting.layouts.keys()] : []
			)
		])
		return [
			...Arr.map(removed, (relation): Planned => ({ stratum, statement: "removals", relation })),
			...Arr.map(appended, (relation): Planned => ({ stratum, statement: "additions", relation }))
		]
	})

/** An edit as the case states it: its stratum, its member relation, and which of its operations it holds. */
interface EditShape {
	readonly stratum: number
	readonly relation: string
	readonly inserts: boolean
	readonly puts: boolean
	readonly deletes: boolean
}

/** The edits the case states, all in the stratum past every one before it. */
const editsOf = (sketch: Sketch): ReadonlyArray<EditShape> => {
	const stratum = sketch.before.length
	const shape = (
		relation: string,
		ops: ReadonlyArray<MemberOp | LineOp>
	): ReadonlyArray<EditShape> =>
		Arr.isReadonlyArrayEmpty(ops)
			? []
			: [
					{
						stratum,
						relation,
						inserts: ops.includes("insert"),
						puts: ops.includes("put"),
						deletes: ops.includes("delete")
					}
				]
	return [...shape("Member", sketch.member), ...shape("Line", sketch.line)]
}

/** A source a family statement reads: a member slot or a stratum's nested rows of a relation, by name, the stratum it
 * is of, and the stratum of the statement that reads it. */
interface Read {
	readonly source: string
	readonly of: number
	readonly at: number
}

/** The name of a stratum's nested rows of `relation`. */
const nestedSource = (stratum: StratumAt, relation: string): string => `${stratum} ${relation}`

/** Every source the program's family statements read. */
const readsOf = (program: CompiledWrite): ReadonlyArray<Read> =>
	Arr.flatMap(program.placements, (placement) =>
		Arr.flatMap(placement.sql.params, (param): ReadonlyArray<Read> => {
			switch (param.kind) {
				case "scalar":
				case "relation":
				case "admission":
					return []
				case "member":
					return [
						{
							source: param.slot,
							of: defined(
								program.frontend.slotsById.get(param.slot),
								"a member slot of the front end"
							).group.stratum,
							at: placement.stratum
						}
					]
				case "nestedRows":
					return [
						{
							source: nestedSource(param.stratum, param.relation),
							of: param.stratum,
							at: placement.stratum
						}
					]
			}
		})
	)

export type Feature =
	| "a nested insert before the edits"
	| "a nested insert after the edits"
	| "a nested insert beside the edits"
	| "the edits beside a stratum of no family statement"
	| "a put Line nested in another stratum"
	| "edits of two families"

/** The header's property over one case. */
export const property = (sketch: Sketch, c: Case<Feature>) =>
	Effect.sync(() => {
		const strata = strataOf(sketch)
		const value = changeOf(sketch)
		const frontend = succeeded(
			compileChangeSet(checked, descOf(value), frontendOptions),
			"the case's front end compiles"
		)
		unorderedEqual(
			Arr.map(frontend.edits, (e): EditShape => ({
				stratum: e.stratum,
				relation: e.relation.name,
				inserts: Arr.some(e.slots, (s) => s.as === "inserts"),
				puts: Arr.some(e.slots, (s) => s.as === "puts"),
				deletes: Arr.some(e.slots, (s) => s.as === "deletes")
			})),
			editsOf(sketch),
			"the front end's edits are the case's"
		)
		unorderedEqual(
			Arr.map(frontend.nested, (n): number => n.stratum),
			Arr.flatMap(strata, (s, at) => (s.inserted.includes("Doc") ? [at] : [])),
			"the front end's nested writes are the case's Doc inserts"
		)
		assert.equal(frontend.refills.length, 0, "no stratum of the box refills")
		const model = modelOf(frontend)
		unorderedEqual(
			Arr.flatMap(strataAt(frontend.ir.strata), ([stratum, s]) =>
				Arr.map(s.family, ({ node }) => plannedOf(stratum, node))
			),
			model,
			"each stratum's family statements are its own inputs'"
		)
		const program = succeeded(compileWrite(checked, descOf(value), reality), "the case compiles")
		unorderedEqual(
			Arr.map(program.placements, (p) => plannedOf(p.stratum, p.node)),
			model,
			"the program places each stratum's own family statements"
		)
		const reads = readsOf(program)
		assert.deepEqual(
			Arr.filter(reads, (r) => r.of !== r.at),
			[],
			"every source a family statement reads is its own stratum's"
		)
		const sources = [
			...Arr.flatMap(program.frontend.edits, (e) =>
				Arr.map(e.slots, (s) => ({ source: s.slot, of: e.stratum }))
			),
			...Arr.flatMap(program.frontend.nested, (n) =>
				Arr.map([...n.nesting.layouts.keys()], (relation) => ({
					source: nestedSource(n.stratum, relation),
					of: n.stratum
				}))
			)
		]
		for (const { source, of } of sources) {
			assert.ok(
				Arr.some(reads, (r) => r.source === source && r.at === of),
				`${source} is read by a family statement of its stratum, ${of}`
			)
		}
		const editsAt = sketch.before.length
		const nestedAt = (side: ReadonlyArray<ReadonlyArray<Inserted>>) =>
			Arr.some(side, (s) => s.includes("Doc"))
		if (nestedAt(sketch.before)) {
			c.note("a nested insert before the edits")
		}
		if (nestedAt(sketch.after)) {
			c.note("a nested insert after the edits")
		}
		if (sketch.beside.includes("Doc")) {
			c.note("a nested insert beside the edits")
		}
		if (
			Arr.some(
				strataAt(frontend.ir.strata),
				([stratum, s]) => stratum !== editsAt && Arr.isReadonlyArrayEmpty(s.family)
			)
		) {
			c.note("the edits beside a stratum of no family statement")
		}
		if (sketch.line.includes("put") && (nestedAt(sketch.before) || nestedAt(sketch.after))) {
			c.note("a put Line nested in another stratum")
		}
		if (Arr.isReadonlyArrayNonEmpty(sketch.member) && Arr.isReadonlyArrayNonEmpty(sketch.line)) {
			c.note("edits of two families")
		}
	})
