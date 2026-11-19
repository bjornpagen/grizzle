/**
 * The fin lemmas' boxes and searches (fin.test.ts): the RFC's lowerings by label, each box's generator and the
 * situations it reaches, the templates every case's seats clone, and the judgment of one case of each, PostgreSQL's
 * verdict against the families theorem and the model of each transaction (fin.ts predicted).
 */
import { appendAll, indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, deepEquals, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	type Answer,
	accepted,
	type Machine,
	type Real,
	refused,
	runProgram,
	took,
	type Verdict as StepVerdict
} from "@bjornpagen/testing/commands"
import { element, type Gen, int, shuffled, boolean } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import type { Swarm } from "@bjornpagen/testing/swarm"
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import { quoteString } from "#compiler/core/text.ts"
import {
	appliedTo,
	canonical,
	constraintNamed,
	constraintsOf,
	ddlOf,
	type Direction,
	emptyStored,
	type Lowering,
	type Mutation,
	type Predicted,
	predicted,
	readSql,
	sqlOf,
	sqlstateOf,
	storedOfRows,
	writeOf
} from "#test/pg/substrate/fin.ts"
import {
	BREAKING_FORMS,
	type Form,
	LAWFUL_FORMS,
	machineOf,
	type Moment,
	type Mutations,
	type Program,
	type ProgramSpace,
	programGen,
	run,
	type MutationStatement
} from "#test/support/families/mutate.ts"
import {
	breachesOf,
	type Constraint,
	type Families,
	type FamilyRow,
	SHAPES,
	type Shape,
	type Stored,
	storedOf
} from "#test/support/families/theorem.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	type Attempted,
	attempt,
	momentText,
	qualified,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { TemplateNames } from "#test/support/substrate/names.ts"
import { fixtureGroup, noTables, type ResetGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import {
	installTemplate,
	ownerSession,
	Substrate,
	type SubstrateCase,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"

/** The box: owners 0 and 1, counts 0 to 3, at most four rows, indices 0 to 4. */
const box = { owners: [0, 1], counts: [0, 1, 2, 3], rows: 4, ats: [0, 1, 2, 3, 4] } as const

/** The RFC's lowering of a direction for a family shape: §5.1's deferral, the closure restricted as §5.2 states it. */
const rfc = (direction: Direction, shape: "ordered" | "counted"): Lowering => ({
	direction,
	copy: "statement",
	last: "commit",
	closure: shape === "ordered" ? "statement" : "commit",
	restriction: "restricted"
})

/** A lowering's verdict on one transaction, as a feature: committed, or refused, naming the constraint PostgreSQL named. */
type Verdict = "committed" | `refused ${Constraint}`

/** PostgreSQL's disagreement with a model or with the theorem, with both sides spelt out. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** What PostgreSQL did with a transaction the model agreed with, and its verdict as a feature. */
interface Judged {
	readonly real: Attempted
	readonly verdict: Verdict
}

/** A lowering installed in a schema of its own, and the session a case's transactions run on, its seats' one. */
export interface Seat<L extends string> {
	readonly label: L
	readonly lowering: Lowering
	readonly schema: string
	readonly session: RawSession
}

const predictedText = (model: Predicted): string =>
	model.kind === "committed"
		? "commit"
		: `refusal ${momentText(model.moment)} by any of ${Arr.join(
				Arr.dedupe(Arr.map(model.violations, (v) => v.constraint)),
				", "
			)}`

const attemptedText = (real: Attempted): string =>
	real.kind === "committed"
		? "commit"
		: `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`

/**
 * One transaction of `mutations` on a seat whose committed state is `before`, judged against the model: the same
 * verdict, a refusal at the same moment with the SQLSTATE of a constraint the model allows there, and a committed state
 * that reads back as the model's. A case that commits leaves its state, which its seat empties after the case.
 */
const judged = <L extends string>(
	seat: Seat<L>,
	before: Stored,
	mutations: ReadonlyArray<Mutation>
): Effect.Effect<Judged, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const model = predicted(seat.lowering, before, mutations)
		const real = yield* attempt(
			seat.session,
			Arr.map(mutations, (m) => sqlOf(seat.schema, m))
		)
		const disagree = (why: string) =>
			Effect.fail(
				new Disagreed({
					message: `${seat.label}: ${why}; the model predicts ${predictedText(model)}, PostgreSQL gave ${attemptedText(real)}, for ${Formatter.format(mutations)} over ${Formatter.format(canonical(before))}`
				})
			)
		if (model.kind === "committed" && real.kind === "committed") {
			const rows = yield* seat.session.values(readSql(seat.schema), [])
			const read = storedOfRows(rows)
			if (!deepEquals(canonical(read), canonical(model.after))) {
				return yield* disagree(
					`the committed state reads back as ${Formatter.format(canonical(read))}`
				)
			}
			return { real, verdict: "committed" }
		}
		if (model.kind === "refused" && real.kind === "refused") {
			if (!sameMoment(model.moment, real.moment)) {
				return yield* disagree("the moments differ")
			}
			const named = constraintNamed(real.fields.constraint)
			if (
				Option.isNone(named) ||
				!Arr.some(model.violations, (v) => v.constraint === named.value) ||
				real.fields.code !== sqlstateOf[named.value]
			) {
				return yield* disagree("PostgreSQL names a constraint or SQLSTATE the model does not allow")
			}
			return { real, verdict: `refused ${named.value}` }
		}
		return yield* disagree("the verdicts differ")
	})

/**
 * Whether a direction's lemma holds of a stored state, by the theorem's breaches: within, no orphan and nothing beyond a
 * count; covers, no gap, and no slot two rows hold, since the closure's and the last slot's target is the key (g, at)
 * (§3.4); mirrors, no breach. Covers also needs every row to have an owner: its closure reads the copy ‹n›, so the copy's
 * foreign key comes with it, and refuses a row no owner holds, though fin(O, n) ⊆ F[g, at] says nothing of such a row.
 */
const holds = (direction: Direction, stored: Stored): boolean => {
	const kinds = new Set(Arr.map(breachesOf(stored), (b) => b.kind))
	switch (direction) {
		case "within":
			return !kinds.has("orphan") && !kinds.has("beyond")
		case "covers":
			return !kinds.has("gap") && !kinds.has("twice") && !kinds.has("orphan")
		case "mirrors":
			return kinds.size === 0
	}
}

/**
 * Whether fin(O, n) ⊆ F[g, at] holds alone, read as §5.2 states it: every slot below a count holds a row, and no slot
 * holds two, with nothing said of a row whose group no owner holds.
 */
const coveredAlone = (stored: Stored): boolean =>
	Arr.every(breachesOf(stored), (b) => b.kind !== "gap" && b.kind !== "twice")

/** Whether every row's copy is its owner's count, as every write grizzle sends leaves it. */
const copiesRight = (stored: Stored): boolean =>
	Arr.every(stored.rows, (r) => stored.owners.get(r.group) === r.copy)

/** An owner's place in a drawn state: absent, or present with a count. */
type Presence = { readonly kind: "absent" } | { readonly kind: "present"; readonly count: number }

const presences = (most: number): Arr.NonEmptyReadonlyArray<Presence> => [
	{ kind: "absent" },
	...Arr.map(
		Arr.filter(box.counts, (c) => c <= most),
		(count): Presence => ({ kind: "present", count })
	)
]

/**
 * A state of the box as a sketch: each owner's presence, and the rows as (group, at) pairs, a multiset in ascending
 * order, so each state of the box is drawn exactly once.
 */
export interface StateSketch {
	readonly owners: ReadonlyArray<readonly [owner: number, count: number]>
	readonly rows: ReadonlyArray<readonly [group: number, at: number]>
}

export const stateGen: Gen<StateSketch> = (source) => {
	const owners: Array<readonly [number, number]> = []
	for (const owner of box.owners) {
		const presence = source.draw(element(presences(box.counts.length)))
		if (presence.kind === "present") {
			owners.push([owner, presence.count])
		}
	}
	const slots = box.owners.length * box.ats.length
	const rows: Array<readonly [number, number]> = []
	let from = 0
	for (let i = source.draw(int(0, box.rows)); i > 0; i--) {
		const slot = source.draw(int(from, slots - 1))
		rows.push([Math.floor(slot / box.ats.length), slot % box.ats.length])
		from = slot
	}
	return { owners, rows }
}

/**
 * The stored state a sketch draws: each row a member of its own, copying its owner's count, as the host writes it. An
 * orphan has no owner to copy, so it copies one past its index: its bound holds, and the copy's foreign key alone names
 * it.
 */
const storedOfSketch = (sketch: StateSketch): Stored => {
	const owners = new Map(sketch.owners)
	return {
		owners,
		rows: Arr.map(sketch.rows, ([group, at], member) => {
			const count = owners.get(group)
			return { group, at, member, copy: count ?? at + 1 }
		})
	}
}

/**
 * Every family state the box holds: each owner absent or counting rows 0 … n − 1, four rows in all at most, the members
 * numbered in slot order, owner 0's first.
 */
const FAMILY_STATES: Arr.NonEmptyReadonlyArray<Families> = nonEmpty(
	Arr.flatMap(presences(box.rows), (first) =>
		Arr.map(
			presences(first.kind === "present" ? box.rows - first.count : box.rows),
			(second): Families => {
				const families: Array<{ readonly owner: number; readonly members: ReadonlyArray<number> }> =
					[]
				let next = 0
				for (const [owner, presence] of [
					[0, first],
					[1, second]
				] as const) {
					if (presence.kind === "present") {
						families.push({ owner, members: Arr.map(indices(presence.count), (i) => next + i) })
						next += presence.count
					}
				}
				return families
			}
		)
	),
	"the box holds a family state"
)

/**
 * Every single statement that changes one field of a stored state, or adds or removes one row or owner: an absent
 * owner created with any count; an owner dropped or recounted; a new row at any slot of either group copying its
 * owner's count, one more or one less; and each row deleted, moved to another index, moved to the other group, or given
 * a copy one off.
 */
const mutationsOf = (stored: Stored): Arr.NonEmptyReadonlyArray<Mutation> => {
	const fresh = Arr.reduce(stored.rows, 0, (m, r) => Math.max(m, r.member + 1))
	const out: Array<Mutation> = []
	for (const owner of box.owners) {
		const count = stored.owners.get(owner)
		if (count === undefined) {
			appendAll(
				out,
				Arr.map(box.counts, (c): Mutation => ({ kind: "create", owner, count: c }))
			)
		} else {
			out.push({ kind: "drop", owner })
			appendAll(
				out,
				Arr.map(
					Arr.filter([...box.counts, box.rows], (c) => c !== count),
					(c): Mutation => ({ kind: "count", owner, count: c })
				)
			)
		}
		for (const at of box.ats) {
			const right = count ?? at + 1
			for (const copy of Arr.dedupe([right, right + 1, ...(right > 0 ? [right - 1] : [])])) {
				out.push({ kind: "insert", rows: [{ member: fresh, group: owner, at, copy }] })
			}
		}
	}
	for (const row of stored.rows) {
		out.push({ kind: "delete", members: [row.member] })
		appendAll(
			out,
			Arr.map(
				Arr.filter(box.ats, (a) => a !== row.at),
				(at): Mutation => ({ kind: "move", member: row.member, at })
			)
		)
		out.push({ kind: "regroup", member: row.member, group: 1 - row.group })
		appendAll(
			out,
			Arr.map(
				Arr.filter([row.copy + 1, row.copy - 1], (c) => c >= 0),
				(copy): Mutation => ({ kind: "recopy", member: row.member, copy })
			)
		)
	}
	return nonEmpty(out, "a state of the box has a mutation")
}

/**
 * The RFC's lowering of every direction and family shape the box judges, by label: every state and every single
 * mutation of a family state is judged under each.
 */
const RFC_LOWERINGS = {
	within: rfc("within", "ordered"),
	"covers ordered": rfc("covers", "ordered"),
	"covers counted": rfc("covers", "counted"),
	"mirrors ordered": rfc("mirrors", "ordered"),
	"mirrors counted": rfc("mirrors", "counted")
} as const satisfies Record<string, Lowering>

export type RfcLabel = keyof typeof RFC_LOWERINGS

export type StateFeature =
	| `${RfcLabel} ${Verdict}`
	| `${"covers ordered" | "covers counted"} refuses an orphan of a covered state`

/** The constraints a direction's states can break alone in the box: every one but the member's own key. */
const refusable = (direction: Direction): ReadonlyArray<Constraint> =>
	Arr.filter(constraintsOf[direction], (c) => c !== "identity")

export type MutationFeature = `${RfcLabel} ${Verdict}`

/** A single mutation of a family state of the box. */
export interface MutationCase {
	readonly families: Families
	readonly mutation: Mutation
}

export const mutationGen: Gen<MutationCase> = (source) => {
	const families = source.draw(element(FAMILY_STATES))
	return { families, mutation: source.draw(element(mutationsOf(storedOf(families)))) }
}

/** A family state with every one of its rows sent in one insert, in one order of them. */
export interface OrderCase {
	readonly families: Families
	readonly rows: ReadonlyArray<FamilyRow>
}

/** Every family state of the box with every order of its rows. */
export const orderGen: Gen<OrderCase> = (source) => {
	const families = source.draw(element(FAMILY_STATES))
	const rows = storedOf(families).rows
	return { families, rows: source.draw(shuffled(rows, { min: rows.length, max: rows.length })) }
}

/** Whether some row is sent before the row one slot below it in its family. */
const successorFirst = (rows: ReadonlyArray<FamilyRow>): boolean =>
	Arr.some(rows, (row, i) =>
		Arr.some(rows.slice(i + 1), (later) => later.group === row.group && later.at === row.at - 1)
	)

export type OrderFeature = "committed" | "committed with a successor sent first"

/**
 * The two ways a member leaves its family, as fin.md §4.5 writes them: an ordered family's suffix rewrite (`shrink`:
 * delete the suffix from it, lower the count, insert the rest of the suffix one slot down), and a counted family's
 * swap-with-last (`swap`: delete the member, move the last row into its slot, lower the count).
 */
type Rewrite = "shrink" | "swap"

/** A rewrite of one member of a family state, its statements sent in one order of them. */
export interface RewriteCase {
	readonly families: Families
	readonly rewrite: Rewrite
	readonly prescribed: Arr.NonEmptyReadonlyArray<Mutation>
	readonly sent: ReadonlyArray<Mutation>
}

/** A rewrite's statements in the order §4.5 prescribes: deletes, then the move, then the count, then inserts. */
const prescribedOf = (
	rewrite: Rewrite,
	owner: number,
	members: ReadonlyArray<number>,
	at: number
): Arr.NonEmptyReadonlyArray<Mutation> => {
	const n = members.length
	switch (rewrite) {
		case "shrink": {
			const rest = members.slice(at + 1)
			const inserted = Arr.sort(
				Arr.map(rest, (member, i) => ({ member, group: owner, at: at + i, copy: n - 1 })),
				Order.mapInput(Order.flip(Order.Number), (r: FamilyRow) => r.at)
			)
			return [
				{ kind: "delete", members: nonEmpty(members.slice(at)) },
				{ kind: "count", owner, count: n - 1 },
				...(Arr.isReadonlyArrayNonEmpty(inserted)
					? [{ kind: "insert", rows: inserted } satisfies Mutation]
					: [])
			]
		}
		case "swap": {
			const last = Arr.getUnsafe(members, n - 1)
			return [
				{ kind: "delete", members: [Arr.getUnsafe(members, at)] },
				...(at < n - 1 ? [{ kind: "move", member: last, at } satisfies Mutation] : []),
				{ kind: "count", owner, count: n - 1 }
			]
		}
	}
}

/** The family states of the box with an owner of a non-empty family. */
const REWRITABLE = nonEmpty(
	Arr.filter(FAMILY_STATES, (families) => Arr.some(families, (f) => f.members.length > 0)),
	"the box holds a non-empty family"
)

export const rewriteGen: Gen<RewriteCase> = (source) => {
	const families = source.draw(element(REWRITABLE))
	const family = source.draw(element(nonEmpty(Arr.filter(families, (f) => f.members.length > 0))))
	const at = source.draw(int(0, family.members.length - 1))
	const rewrite = source.draw(element<Rewrite>(["shrink", "swap"]))
	const prescribed = prescribedOf(rewrite, family.owner, family.members, at)
	return {
		families,
		rewrite,
		prescribed,
		sent: source.draw(shuffled(prescribed, { min: prescribed.length, max: prescribed.length }))
	}
}

/**
 * The RFC's lowerings of mirrors, by the family shape whose closure they defer or not: what a rewrite, a cycle, one
 * insert of a family's rows and a program of family mutations run under.
 */
const MIRRORS = {
	ordered: rfc("mirrors", "ordered"),
	counted: rfc("mirrors", "counted")
} as const satisfies Record<Shape, Lowering>

/** A misorder's verdict where the contract fixes only that it is refused, not which of its keys PostgreSQL names. */
type Outcome = "committed" | "refused"

export type RewriteFeature =
	| `${Shape} ${Rewrite} prescribed ${Verdict}`
	| `${Shape} ${Rewrite} count before delete ${Verdict}`
	| `${Shape} swap move before delete ${Verdict}`
	| `${Shape} shrink insert before delete ${Outcome}`
	| `${Shape} ${Rewrite} otherwise ${Outcome}`

/** Where the first statement of a kind is sent, or none when the rewrite sends none. */
const indexOfKind = (
	sent: ReadonlyArray<Mutation>,
	kind: Mutation["kind"]
): Option.Option<number> => Arr.findFirstIndex(sent, (m) => m.kind === kind)

/** Whether a statement of kind `first` is sent before every statement of kind `then`. */
const sentBefore = (
	sent: ReadonlyArray<Mutation>,
	first: Mutation["kind"],
	then: Mutation["kind"]
): boolean =>
	Option.match(Option.all([indexOfKind(sent, first), indexOfKind(sent, then)]), {
		onNone: () => false,
		onSome: ([a, b]) => a < b
	})

/**
 * A rewrite's order as a feature: prescribed; the count before the delete, which the count's cascade refuses on the row
 * at n − 1; the move before the delete, which collides on (g, at); the insert before the delete, which collides on a
 * member's or a slot's key, whichever PostgreSQL checks first; or another order.
 */
const rewriteFeature = (label: Shape, c: RewriteCase, verdict: Verdict): RewriteFeature => {
	const outcome: Outcome = verdict === "committed" ? "committed" : "refused"
	if (deepEquals(c.sent, c.prescribed)) {
		return `${label} ${c.rewrite} prescribed ${verdict}`
	}
	if (sentBefore(c.sent, "count", "delete")) {
		return `${label} ${c.rewrite} count before delete ${verdict}`
	}
	if (sentBefore(c.sent, "move", "delete")) {
		return `${label} swap move before delete ${verdict}`
	}
	if (sentBefore(c.sent, "insert", "delete")) {
		return `${label} shrink insert before delete ${outcome}`
	}
	return `${label} ${c.rewrite} otherwise ${outcome}`
}

/**
 * The transactions of the owner ↔ family cycle: a family state created from nothing (each owner, then its rows), and
 * dropped either rows first or owners first.
 */
type CycleOperation = "create" | "drop rows first" | "drop owners first"

export interface CycleCase {
	readonly families: Families
	readonly operation: CycleOperation
}

const CYCLIC = nonEmpty(
	Arr.filter(FAMILY_STATES, (families) => Arr.some(families, (f) => f.members.length > 0)),
	"the box holds a cycle"
)

export const cycleGen: Gen<CycleCase> = (source) => ({
	families: source.draw(element(CYCLIC)),
	operation: source.draw(
		element<CycleOperation>(["create", "drop rows first", "drop owners first"])
	)
})

export type CycleFeature = `${CycleOperation} ${Verdict}`

/** A cycle operation's statements over its family state. */
const cycleStatements = (c: CycleCase): ReadonlyArray<Mutation> => {
	const members = Arr.flatMap(c.families, (f) => f.members)
	const rows: ReadonlyArray<Mutation> = Arr.isReadonlyArrayNonEmpty(members)
		? [{ kind: "delete", members }]
		: []
	const owners = Arr.map(c.families, (f): Mutation => ({ kind: "drop", owner: f.owner }))
	switch (c.operation) {
		case "create":
			return writeOf(storedOf(c.families))
		case "drop rows first":
			return [...rows, ...owners]
		case "drop owners first":
			return [...owners, ...rows]
	}
}

/** The RI measurement's load: owners 1 to 2,000, each with three rows, and the most owners a write touches. */
const riLoad = { owners: 2000, slots: 3, touched: 100 } as const

/** The names an RI write's SQL reads, in the seat's schema. */
interface RiNames {
	readonly owner: string
	readonly fam: string
}

/**
 * A write over the committed load, of a run of `count` owners from `from`, which fires PostgreSQL's referential
 * integrity against the family (utils/adt/ri_triggers.c), its saved plans custom or forced generic:
 *
 * - `count`: each owner's count grows by one, which the copy's foreign key cascades, one `UPDATE ONLY fam SET g, copy
 *   WHERE g = $ AND copy = $` per owner;
 * - `rows`: each owner's rows from slot `slot` on are deleted, a suffix, so the closure holds; the closure's NO ACTION
 *   check on each deleted row first looks for a row that still holds its key (ri_Check_Pk_Match, `… WHERE g = $ AND at
 *   = $`) and then for a row that references it (`SELECT 1 FROM ONLY fam WHERE g = $ AND p = $ FOR KEY SHARE`), two
 *   queries a row;
 * - `owners`: each owner's rows are deleted first, then the owners, whose copy's NO ACTION check per owner reads the
 *   owner by its key and the family by `… WHERE g = $ AND copy = $`, one query of the family an owner.
 *
 * Each statement finds its own rows by a primary key, never by (g, at), so every scan of fam_key is an RI query's.
 */
export type RiWrite = Readonly<{
	kind: "count" | "rows" | "owners"
	from: number
	count: number
	slot: number
	generic: boolean
}>

export const riWriteGen: Gen<RiWrite> = (source) => {
	const count = source.draw(int(1, riLoad.touched))
	return {
		kind: source.draw(element(["count", "rows", "owners"] as const)),
		from: source.draw(int(1, riLoad.owners - count + 1)),
		count,
		slot: source.draw(int(0, riLoad.slots - 1)),
		generic: source.draw(boolean)
	}
}

/** The owners a write touches, as an int4 array. */
const touchedOwners = (w: RiWrite): string =>
	`ARRAY(SELECT pg_catalog.generate_series(${w.from}, ${w.from + w.count - 1}))`

/** The members of the owners a write touches from slot `slot` on, as an int4 array. */
const touchedMembers = (w: RiWrite, slot: number): string =>
	`ARRAY(SELECT o * ${riLoad.slots} + a FROM pg_catalog.generate_series(${w.from}, ${w.from + w.count - 1}) AS o, pg_catalog.generate_series(${slot}, ${riLoad.slots - 1}) AS a)`

/** The statements before the measured one, and the measured one. */
const riStatements = (
	w: RiWrite,
	n: RiNames
): Readonly<{ before: ReadonlyArray<string>; measured: string }> => {
	switch (w.kind) {
		case "count":
			return {
				before: [],
				measured: `UPDATE ${n.owner} SET n = n + 1 WHERE id = ANY (${touchedOwners(w)})`
			}
		case "rows":
			return {
				before: [],
				measured: `DELETE FROM ${n.fam} WHERE member = ANY (${touchedMembers(w, w.slot)})`
			}
		case "owners":
			return {
				before: [`DELETE FROM ${n.fam} WHERE member = ANY (${touchedMembers(w, 0)})`],
				measured: `DELETE FROM ${n.owner} WHERE id = ANY (${touchedOwners(w)})`
			}
	}
}

/** The RI queries of the family a write's measured statement makes: one per owner, or two per deleted row. */
const riQueries = (w: RiWrite): number => {
	switch (w.kind) {
		case "count":
		case "owners":
			return w.count
		case "rows":
			return 2 * w.count * (riLoad.slots - w.slot)
	}
}

export type RiFeature = `${RiWrite["kind"]}, ${"custom" | "generic"} plans`

/**
 * A refusal of the program search, named by its moment: at a statement of the transaction by its index, or at commit.
 * A real refusal whose constraint the model does not allow there fails its step's judgment before it is named.
 */
type ProgramRefusal = "at commit" | `at statement ${number}`

const refusalNamed = (moment: Moment): ProgramRefusal =>
	moment.kind === "commit" ? "at commit" : `at statement ${moment.index}`

/** A command's parameters as every one of the families model's commands draws them: the statements it sends. */
interface Sends {
	readonly statements: ReadonlyArray<MutationStatement>
}

/**
 * The families model's machine (mutate.ts machineOf), its every command judged by the model's transaction (mutate.ts
 * run): accepted with the families it commits to, or refused at the moment it is refused, so a program search checks
 * that PostgreSQL refuses exactly the steps the model refuses, where the model refuses them.
 */
const namingMachine = (
	shape: Shape,
	families: Families,
	forms: Swarm<Form>
): Machine<Families, Mutations, ProgramRefusal> => {
	const base = machineOf(shape, families, forms)
	const judge = (model: Families, parameters: Sends): StepVerdict<Families, ProgramRefusal> => {
		const outcome = run(shape, model, parameters.statements)
		return outcome.kind === "committed"
			? accepted(outcome.after)
			: refused(refusalNamed(outcome.moment))
	}
	const c = base.commands
	return {
		initial: base.initial,
		commands: {
			create: { ...c.create, judge },
			append: { ...c.append, judge },
			remove: { ...c.remove, judge },
			"insert-at": { ...c["insert-at"], judge },
			swap: { ...c.swap, judge },
			replace: { ...c.replace, judge },
			drop: { ...c.drop, judge },
			"count-edit": { ...c["count-edit"], judge },
			beyond: { ...c.beyond, judge },
			gap: { ...c.gap, judge },
			twice: { ...c.twice, judge },
			orphan: { ...c.orphan, judge },
			misorder: { ...c.misorder, judge }
		}
	}
}

/** What a program may hold: up to three owners, long families of three to five rows, one to eight steps. */
const programSpace: ProgramSpace = {
	families: { owners: { min: 0, max: 3 }, long: { min: 3, max: 5 } },
	steps: { min: 1, max: 8 }
}

export const programsGen: Gen<Program> = (source) =>
	source.draw(programGen(source.draw(element(SHAPES)), programSpace))

export type ProgramFeature = `${Shape} ${Form} ${"committed" | "refused"}`

/** Writes `families` on a seat and requires it to commit: a family state is lawful under every lowering here. */
const written = <L extends string>(
	seat: Seat<L>,
	families: Families
): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.flatMap(judged(seat, emptyStored, writeOf(storedOf(families))), ({ real }) =>
		real.kind === "committed"
			? Effect.void
			: Effect.fail(
					new Disagreed({
						message: `${seat.label}: writing ${Formatter.format(families)} was refused: ${attemptedText(real)}`
					})
				)
	)

/** A lowering installed in the schema its label names, as a template's build installs it. */
interface Installed<L extends string> {
	readonly label: L
	readonly lowering: Lowering
	readonly schema: string
}

/** A template's lowerings, each in a schema of its own, and every table of them, which a case's seat empties after it. */
export interface Lowered<L extends string> {
	readonly installed: Arr.NonEmptyReadonlyArray<Installed<L>>
	readonly tables: ResetGroup
}

/** A lowering's label as a schema label, a lowercase word of letters joined by underscores (substrate/names.ts). */
const schemaLabel = (label: string): string => Arr.join(Str.split(label, " "), "_")

/** Every lowering of `lowerings` installed under the names a template's build allocates it by its label. */
const installedUnder = <L extends string>(
	lowerings: Readonly<Record<L, Lowering>>,
	names: TemplateNames
): Arr.NonEmptyReadonlyArray<Installed<L>> =>
	nonEmpty(
		Arr.map(Rec.keys(lowerings), (label): Installed<L> => ({
			label,
			lowering: lowerings[label],
			schema: names.labelled(schemaLabel(label))
		})),
		"a template installs a lowering"
	)

/** Installs each lowering's DDL in the schema the build allocates by its label. */
const installEach = <L extends string>(
	installed: Arr.NonEmptyReadonlyArray<Installed<L>>
): Effect.Effect<void, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		for (const { label, lowering } of installed) {
			const schema = yield* s.schema({ create: true, label: schemaLabel(label) })
			for (const statement of ddlOf(schema, lowering)) {
				yield* s.admin.query(statement, [])
			}
		}
	})

/** Every table a lowering's DDL creates: its owner and its family. */
const tablesOf = (schema: string): ReadonlyArray<string> => [
	qualified(schema, "owner"),
	qualified(schema, "fam")
]

/**
 * `lowerings` installed once per member, each in a schema of its own (substrate.ts installTemplate), where each search
 * installed a schema of each before its cases: a case's seats are the worker's clone of them, every table emptied after
 * the case (seatsIn).
 */
const loweringsTemplate = <L extends string>(
	name: string,
	lowerings: Readonly<Record<L, Lowering>>
): SubstrateTemplate<Lowered<L>> =>
	installTemplate({
		declaredIn: import.meta,
		name,
		content: { lowerings: Rec.keys(lowerings) },
		plan: (names) => Effect.succeed(installedUnder(lowerings, names)),
		install: (installed) => installEach(installed),
		bind: (installed) => ({
			installed,
			tables: fixtureGroup(
				nonEmpty(
					Arr.flatMap(installed, (i) => tablesOf(i.schema)),
					"a lowering has tables"
				)
			)
		}),
		reset: (lowered) => lowered.tables
	})

/** The RFC's lowering of every direction and shape (RFC_LOWERINGS), the boxes of states and single mutations' seats. */
export const rfcTemplate = loweringsTemplate("fin rfc lowerings", RFC_LOWERINGS)

/** The RFC's lowerings of mirrors (MIRRORS), the rewrites', the cycle's, the row orders' and the programs' seats. */
export const mirrorsTemplate = loweringsTemplate("fin mirrors lowerings", MIRRORS)

/**
 * The seats of a case over its clone of a lowerings template: each lowering in its schema, all on one owner session of
 * the case's own, its transactions sent one at a time.
 */
export const seatsIn = <L extends string>(
	taken: SubstrateCase<Lowered<L>>
): Effect.Effect<Arr.NonEmptyReadonlyArray<Seat<L>>, SqlError, Scope.Scope> =>
	Effect.map(taken.substrate.session({ ...ownerSession(), label: "fin" }), (session) =>
		Arr.map(taken.value.installed, (i): Seat<L> => ({ ...i, session }))
	)

/** The seat of a case of one lowering of a template, by its label. */
export const seatNamed = <L extends string>(
	seats: Arr.NonEmptyReadonlyArray<Seat<L>>,
	label: L
): Seat<L> =>
	Option.getOrThrowWith(
		Arr.findFirst(seats, (seat) => seat.label === label),
		() => new Error(`no seat is labelled ${label}`)
	)

/** Every situation a lowering's verdicts reach: committed, and refused by each constraint it can break alone. */
const verdictsOf = (label: RfcLabel): ReadonlyArray<`${RfcLabel} ${Verdict}`> => [
	`${label} committed`,
	...Arr.map(refusable(RFC_LOWERINGS[label].direction), (c) => `${label} refused ${c}` as const)
]

/** What the box of states must reach: every lowering's every verdict, and each covers lowering refusing an orphan. */
export const stateSituations: ReadonlyArray<StateFeature> = [
	...Arr.flatMap(Rec.keys(RFC_LOWERINGS), verdictsOf),
	"covers ordered refuses an orphan of a covered state",
	"covers counted refuses an orphan of a covered state"
]

/** What the box of single mutations must reach: every lowering's every verdict. */
export const mutationSituations: ReadonlyArray<MutationFeature> = Arr.flatMap(
	Rec.keys(RFC_LOWERINGS),
	verdictsOf
)

/**
 * A state of the box written from nothing on every seat: PostgreSQL commits it exactly where the seat's direction's
 * lemma holds, a covers seat noting a refusal of an orphan whose state fin(O, n) ⊆ F[g, at] alone holds of.
 */
export const stateCase = (
	seats: ReadonlyArray<Seat<RfcLabel>>,
	sketch: StateSketch,
	c: Case<StateFeature>
): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.forEach(
		seats,
		(seat) =>
			Effect.gen(function* () {
				const stored = storedOfSketch(sketch)
				const { real, verdict } = yield* judged(seat, emptyStored, writeOf(stored))
				c.note(`${seat.label} ${verdict}`)
				const lemma = holds(seat.lowering.direction, stored)
				const committed = real.kind === "committed"
				if (committed !== lemma) {
					return yield* new Disagreed({
						message: `${seat.label}: PostgreSQL ${verdict} a state whose ${seat.lowering.direction} lemma ${lemma ? "holds" : "fails"}: ${Formatter.format(sketch)}`
					})
				}
				if (
					(seat.label === "covers ordered" || seat.label === "covers counted") &&
					!committed &&
					coveredAlone(stored)
				) {
					c.note(`${seat.label} refuses an orphan of a covered state`)
				}
			}),
		{ discard: true }
	)

/**
 * A single mutation of a family state on every seat, the state written first: PostgreSQL commits it exactly when the
 * state it leaves satisfies the seat's lemma with every copy its owner's count.
 */
export const mutationCase = (
	seats: ReadonlyArray<Seat<RfcLabel>>,
	sketch: MutationCase,
	c: Case<MutationFeature>
): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.forEach(
		seats,
		(seat) =>
			Effect.gen(function* () {
				yield* written(seat, sketch.families)
				const before = storedOf(sketch.families)
				const { real, verdict } = yield* judged(seat, before, [sketch.mutation])
				c.note(`${seat.label} ${verdict}`)
				const after = appliedTo(before, sketch.mutation)
				const lawful = holds(seat.lowering.direction, after) && copiesRight(after)
				if ((real.kind === "committed") !== lawful) {
					return yield* new Disagreed({
						message: `${seat.label}: PostgreSQL ${verdict} ${Formatter.format(sketch.mutation)} over ${Formatter.format(sketch.families)}, which leaves a state where the lemma with right copies ${lawful ? "holds" : "fails"}`
					})
				}
			}),
		{ discard: true }
	)

/** A family state's owners, then every one of its rows in one insert in the case's order: PostgreSQL commits it. */
export const orderCase = (
	seat: Seat<Shape>,
	sketch: OrderCase,
	c: Case<OrderFeature>
): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const creates = Arr.filter(writeOf(storedOf(sketch.families)), (m) => m.kind === "create")
		const sent: ReadonlyArray<Mutation> = Arr.isReadonlyArrayNonEmpty(sketch.rows)
			? [...creates, { kind: "insert", rows: sketch.rows }]
			: creates
		const { verdict } = yield* judged(seat, emptyStored, sent)
		if (verdict !== "committed") {
			return yield* new Disagreed({
				message: `one insert of ${Formatter.format(sketch.rows)} was ${verdict}`
			})
		}
		c.note(successorFirst(sketch.rows) ? "committed with a successor sent first" : "committed")
	})

/**
 * A rewrite of a member of a family state on both mirrors seats, the state written first: the prescribed order
 * commits wherever its family's closure allows it (shrink everywhere, swap-with-last under the counted family's
 * deferred closure alone), and no order commits a state the theorem refuses.
 */
export const rewriteCase = (
	seats: ReadonlyArray<Seat<Shape>>,
	sketch: RewriteCase,
	c: Case<RewriteFeature>
): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.forEach(
		seats,
		(seat) =>
			Effect.gen(function* () {
				yield* written(seat, sketch.families)
				const before = storedOf(sketch.families)
				const { real, verdict } = yield* judged(seat, before, sketch.sent)
				c.note(rewriteFeature(seat.label, sketch, verdict))
				const prescribedLawful = seat.label === "counted" || sketch.rewrite === "shrink"
				if (
					deepEquals(sketch.sent, sketch.prescribed) &&
					prescribedLawful &&
					real.kind !== "committed"
				) {
					return yield* new Disagreed({
						message: `${seat.label}: the prescribed ${sketch.rewrite} was ${verdict}: ${Formatter.format(sketch)}`
					})
				}
				if (
					real.kind === "committed" &&
					!holds("mirrors", Arr.reduce(sketch.sent, before, appliedTo))
				) {
					return yield* new Disagreed({
						message: `${seat.label}: a ${sketch.rewrite} committed a state the theorem refuses: ${Formatter.format(sketch)}`
					})
				}
			}),
		{ discard: true }
	)

/** A cycle operation on the RFC's ordered mirrors seat, a drop over its family state written first. */
export const cycleCase = (
	seat: Seat<Shape>,
	sketch: CycleCase,
	c: Case<CycleFeature>
): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const dropping = sketch.operation !== "create"
		if (dropping) {
			yield* written(seat, sketch.families)
		}
		const before = dropping ? storedOf(sketch.families) : emptyStored
		const { verdict } = yield* judged(seat, before, cycleStatements(sketch))
		c.note(`${sketch.operation} ${verdict}`)
	})

/** The names an RI write's SQL reads in a seat's schema. */
const riNames = (schema: string): RiNames => ({
	owner: qualified(schema, "owner"),
	fam: qualified(schema, "fam")
})

/**
 * The RI measurement's load, owners 1 to 2,000 with three rows each, written on the RFC's ordered mirrors lowering
 * and analyzed once per member (substrate.ts installTemplate), where the search wrote and analyzed it before its
 * cases. Its seat empties no table: a case rolls its write back.
 */
export const riTemplate: SubstrateTemplate<Lowered<"ordered">> = installTemplate({
	declaredIn: import.meta,
	name: "fin ri load",
	content: { lowering: "mirrors ordered", load: riLoad },
	plan: (names) => Effect.succeed(installedUnder({ ordered: MIRRORS.ordered }, names)),
	install: (installed) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			yield* installEach(installed)
			const schema = Arr.headNonEmpty(installed).schema
			const names = riNames(schema)
			yield* s.admin.query(
				`INSERT INTO ${names.owner} (id, n) SELECT o, ${riLoad.slots} FROM pg_catalog.generate_series(1, ${riLoad.owners}) AS o`,
				[]
			)
			yield* s.admin.query(
				`INSERT INTO ${names.fam} (member, g, at, copy) SELECT o * ${riLoad.slots} + a, o, a, ${riLoad.slots} FROM pg_catalog.generate_series(1, ${riLoad.owners}) AS o, pg_catalog.generate_series(0, ${riLoad.slots - 1}) AS a`,
				[]
			)
			yield* s.admin.query(`ANALYZE ${names.owner}, ${names.fam}`, [])
		}),
	bind: (installed) => ({ installed, tables: noTables }),
	reset: (lowered) => lowered.tables
})

/** What the RI search must reach: every kind of write, its saved plans custom and generic. */
export const riSituations: ReadonlyArray<RiFeature> = Arr.flatMap(
	["count", "rows", "owners"] as const,
	(kind) => Arr.map(["custom", "generic"] as const, (mode): RiFeature => `${kind}, ${mode} plans`)
)

/**
 * A write over the committed load in a transaction rolled back after it: PostgreSQL's scans of the family during its
 * measured statement are its RI queries', each through fam_key, none sequential.
 */
export const riCase = (
	seat: Seat<"ordered">,
	w: RiWrite,
	c: Case<RiFeature>
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const { before, measured } = riStatements(w, riNames(seat.schema))
		const scans = Effect.map(
			seat.session.values(
				`SELECT ${Arr.join(
					Arr.map(
						["fam", "fam_key"],
						(r) =>
							`pg_catalog.pg_stat_get_xact_numscans(${quoteString(qualified(seat.schema, r))}::regclass)::int4`
					),
					", "
				)}`,
				[]
			),
			(rows) => Arr.map(defined(rows[0]), Number)
		)
		yield* seat.session.begin
		if (w.generic) {
			yield* seat.session.query("SET LOCAL plan_cache_mode = force_generic_plan", [])
		}
		for (const statement of before) {
			yield* seat.session.query(statement, [])
		}
		const [heapBefore, keyBefore] = yield* scans
		yield* seat.session.query(measured, [])
		const [heapAfter, keyAfter] = yield* scans
		yield* seat.session.rollback
		assert.equal(
			defined(heapAfter) - defined(heapBefore),
			0,
			`${w.kind} scans the family sequentially`
		)
		assert.equal(
			defined(keyAfter) - defined(keyBefore),
			riQueries(w),
			`${w.kind} scans fam_key once per RI query`
		)
		c.note(`${w.kind}, ${w.generic ? "generic" : "custom"} plans`)
	})

/** What the program search must reach: every lawful form committed and every breaking form refused, per shape. */
export const programSituations: ReadonlyArray<ProgramFeature> = Arr.flatMap(
	SHAPES,
	(shape): ReadonlyArray<ProgramFeature> => [
		...Arr.map(
			Arr.filter(LAWFUL_FORMS, (f) => shape === "ordered" || (f !== "insert-at" && f !== "swap")),
			(f): ProgramFeature => `${shape} ${f} committed`
		),
		...Arr.map(BREAKING_FORMS, (f): ProgramFeature => `${shape} ${f} refused`),
		`${shape} misorder committed`,
		`${shape} misorder refused`
	]
)

/**
 * One step on PostgreSQL: its transaction judged against the model as every proof here judges one, which requires a
 * refusal's constraint to be one the model allows there; then PostgreSQL's answer, named by the moment it refused.
 */
const stepOn =
	(seat: Seat<Shape>) =>
	(
		parameters: Sends,
		before: Families
	): Effect.Effect<Answer<ProgramRefusal>, SqlError | TransactionRolledBack | Disagreed> =>
		Effect.map(
			judged(seat, storedOf(before), parameters.statements),
			({ real }): Answer<ProgramRefusal> =>
				real.kind === "committed" ? took : refused(refusalNamed(real.moment))
		)

/**
 * A program of family mutations on its shape's seat, its families written first: PostgreSQL refuses exactly the steps
 * the families model refuses, where it refuses them, and commits the rest to the model's families.
 */
export const programCase = (
	seats: Arr.NonEmptyReadonlyArray<Seat<Shape>>,
	p: Program,
	c: Case<ProgramFeature>
) =>
	Effect.gen(function* () {
		const seat = seatNamed(seats, p.shape)
		const step = stepOn(seat)
		yield* written(seat, p.families)
		const real: Real<
			Families,
			Mutations,
			ProgramRefusal,
			SqlError | TransactionRolledBack | Disagreed,
			never
		> = {
			create: step,
			append: step,
			remove: step,
			"insert-at": step,
			swap: step,
			replace: step,
			drop: step,
			"count-edit": step,
			beyond: step,
			gap: step,
			twice: step,
			orphan: step,
			misorder: step
		}
		const ran = yield* runProgram(namingMachine(p.shape, p.families, p.forms), real, p.steps)
		for (const [i, feature] of ran.verdicts.entries()) {
			const form = Arr.getUnsafe(p.steps, i).command
			c.note(`${p.shape} ${form} ${Str.endsWith(" accepted")(feature) ? "committed" : "refused"}`)
		}
	})
