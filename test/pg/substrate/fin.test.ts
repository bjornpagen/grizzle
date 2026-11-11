/**
 * The fin lemmas of fin.md §5.2, proved against PostgreSQL 19rc1 inside a stated box: the lowering's DDL written by hand
 * (test/pg/substrate/fin.ts), every state and every single mutation the box holds sent to PostgreSQL, and PostgreSQL's
 * verdict judged by two oracles.
 *
 * - **The specification turned into a checker:** the families theorem (test/support/families/theorem.ts), per
 *   direction. F[g, at] ⊆ fin(O, n) holds when every row has an owner and an index below its count; fin(O, n) ⊆ F[g, at]
 *   when every slot below a count holds a row; mirrors when both hold and no slot holds two rows. PostgreSQL must accept
 *   exactly the states where the direction's lemma holds and refuse every other one.
 * - **A second implementation:** the model of each transaction (fin.ts predicted), which applies the statements to a
 *   state on the host and checks each constraint at the moment the lowering declares, so it says whether PostgreSQL
 *   commits, and where it refuses with which SQLSTATE and which constraints it may name. PostgreSQL must agree on the
 *   verdict, the moment, the SQLSTATE and a constraint the model allows, and a committed state must read back as the
 *   model's.
 *
 * The box (doctrine rules 6, 9): at most two owners, counts 0 to 3, at most four rows, indices 0 to 4, so every count
 * has a slot above it. Its invalid states are the theorem's named breaches: a slot two rows hold (twice), a row with no
 * owner (orphan), a row at or past its count (beyond), and a slot below the count no row holds (gap). The RFC's
 * lowering is the minimal deferral §5.1 states: the owner's last slot deferred (the owner ↔ family cycle), an ordered
 * family's closure immediate and a counted family's deferred, and the copy's foreign key immediate, since every write
 * updates the count before it inserts, which the families model (mutate.ts checkedAt) states. A lowering that defers
 * the copy as well is judged beside the RFC's.
 *
 * Plants (main's test phase): substrate-fin-bound-at-or-below-count.patch.
 */
import { layer } from "@effect/vitest"
import {
	type Answer,
	accepted,
	type Machine,
	type Real,
	refused,
	runProgram,
	took,
	type Verdict as StepVerdict
} from "@grizzle/testing/commands"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Swarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { appendAll, indices } from "#compiler/core/array.ts"
import { quoteString } from "#compiler/sql/print.ts"
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
import { assert, deepEquals, defined, nonEmpty } from "#test/support/assert.ts"
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
	type Constraint,
	type Families,
	type FamilyRow,
	SHAPES,
	type Shape,
	type Stored
} from "#test/support/families/theorem.ts"
import { breachesOf, storedOf } from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"
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
import { clearRows, type ResetGroup, schemaGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

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

/** A lowering installed in a schema of its own, with every table of it and the session its transactions run on. */
interface Seat<L extends string> {
	readonly label: L
	readonly lowering: Lowering
	readonly schema: string
	readonly tables: ResetGroup
	readonly session: RawSession
}

/** Installs each lowering in a fresh schema, with an owner session of its own, so the lowerings' cases run at once. */
const seatsOf = <L extends string>(lowerings: Readonly<Record<L, Lowering>>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		return yield* Effect.forEach(Rec.keys(lowerings), (label) =>
			Effect.gen(function* () {
				const schema = yield* s.schema(freshSchema)
				const lowering = lowerings[label]
				for (const statement of ddlOf(schema, lowering)) {
					yield* s.admin.query(statement, [])
				}
				const tables = yield* schemaGroup(s.admin, schema)
				const session = yield* s.session({ ...ownerSession(), label })
				return { label, lowering, schema, tables, session } satisfies Seat<L>
			})
		)
	})

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
 * that reads back as the model's. A case that commits leaves its state for its caller to clear.
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

/** Clears a seat's tables for the next case. */
const cleared = <L extends string>(seat: Seat<L>): Effect.Effect<void, SqlError> =>
	clearRows(seat.session, seat.tables)

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
interface StateSketch {
	readonly owners: ReadonlyArray<readonly [owner: number, count: number]>
	readonly rows: ReadonlyArray<readonly [group: number, at: number]>
}

const stateGen: Gen<StateSketch> = (source) => {
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

/** The lowerings every state of the box is judged under, the RFC's and two whose closure is unrestricted. */
const STATE_LOWERINGS = {
	within: rfc("within", "ordered"),
	"covers ordered": rfc("covers", "ordered"),
	"covers counted": rfc("covers", "counted"),
	"mirrors ordered": rfc("mirrors", "ordered"),
	"mirrors counted": rfc("mirrors", "counted"),
	"covers unrestricted": { ...rfc("covers", "ordered"), restriction: "unrestricted" },
	"mirrors unrestricted": { ...rfc("mirrors", "ordered"), restriction: "unrestricted" }
} as const satisfies Record<string, Lowering>

type StateLabel = keyof typeof STATE_LOWERINGS

type StateFeature =
	| `${StateLabel} ${Verdict}`
	| "covers unrestricted refuses a covered state"
	| `${"covers ordered" | "covers counted"} refuses an orphan of a covered state`

/** The constraints a direction's states can break alone in the box: every one but the member's own key. */
const refusable = (direction: Direction): ReadonlyArray<Constraint> =>
	Arr.filter(constraintsOf[direction], (c) => c !== "identity")

/** The lowerings every single mutation of a family state is judged under: the RFC's, and its copy deferred. */
const MUTATION_LOWERINGS = {
	within: rfc("within", "ordered"),
	"covers ordered": rfc("covers", "ordered"),
	"covers counted": rfc("covers", "counted"),
	"mirrors ordered": rfc("mirrors", "ordered"),
	"mirrors counted": rfc("mirrors", "counted"),
	"mirrors ordered, copy deferred": { ...rfc("mirrors", "ordered"), copy: "commit" },
	"mirrors counted, copy deferred": { ...rfc("mirrors", "counted"), copy: "commit" }
} as const satisfies Record<string, Lowering>

type MutationLabel = keyof typeof MUTATION_LOWERINGS

type MutationFeature = `${MutationLabel} ${Verdict}`

/** A single mutation of a family state of the box. */
interface MutationCase {
	readonly families: Families
	readonly mutation: Mutation
}

const mutationGen: Gen<MutationCase> = (source) => {
	const families = source.draw(element(FAMILY_STATES))
	return { families, mutation: source.draw(element(mutationsOf(storedOf(families)))) }
}

/** A family state with every one of its rows sent in one insert, in one order of them. */
interface OrderCase {
	readonly families: Families
	readonly rows: ReadonlyArray<FamilyRow>
}

/** Every family state of the box with every order of its rows. */
const orderGen: Gen<OrderCase> = (source) => {
	const families = source.draw(element(FAMILY_STATES))
	const rows = storedOf(families).rows
	return { families, rows: source.draw(shuffled(rows, { min: rows.length, max: rows.length })) }
}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))

/** Whether some row is sent before the row one slot below it in its family. */
const successorFirst = (rows: ReadonlyArray<FamilyRow>): boolean =>
	Arr.some(rows, (row, i) =>
		Arr.some(rows.slice(i + 1), (later) => later.group === row.group && later.at === row.at - 1)
	)

type OrderFeature = "committed" | "committed with a successor sent first"

/**
 * The two ways a member leaves its family, as fin.md §4.5 writes them: an ordered family's suffix rewrite (`shrink`:
 * delete the suffix from it, lower the count, insert the rest of the suffix one slot down), and a counted family's
 * swap-with-last (`swap`: delete the member, move the last row into its slot, lower the count).
 */
type Rewrite = "shrink" | "swap"

/** A rewrite of one member of a family state, its statements sent in one order of them. */
interface RewriteCase {
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

const rewriteGen: Gen<RewriteCase> = (source) => {
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

/** The two RFC lowerings of mirrors a rewrite runs under, by the family shape whose closure they defer or not. */
const REWRITE_LOWERINGS = {
	ordered: rfc("mirrors", "ordered"),
	counted: rfc("mirrors", "counted")
} as const satisfies Record<string, Lowering>

type RewriteLabel = keyof typeof REWRITE_LOWERINGS

/** A misorder's verdict where the contract fixes only that it is refused, not which of its keys PostgreSQL names. */
type Outcome = "committed" | "refused"

type RewriteFeature =
	| `${RewriteLabel} ${Rewrite} prescribed ${Verdict}`
	| `${RewriteLabel} ${Rewrite} count before delete ${Verdict}`
	| `${RewriteLabel} swap move before delete ${Verdict}`
	| `${RewriteLabel} shrink insert before delete ${Outcome}`
	| `${RewriteLabel} ${Rewrite} otherwise ${Outcome}`

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
const rewriteFeature = (label: RewriteLabel, c: RewriteCase, verdict: Verdict): RewriteFeature => {
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

interface CycleCase {
	readonly families: Families
	readonly operation: CycleOperation
}

const CYCLIC = nonEmpty(
	Arr.filter(FAMILY_STATES, (families) => Arr.some(families, (f) => f.members.length > 0)),
	"the box holds a cycle"
)

const cycleGen: Gen<CycleCase> = (source) => ({
	families: source.draw(element(CYCLIC)),
	operation: source.draw(
		element<CycleOperation>(["create", "drop rows first", "drop owners first"])
	)
})

/**
 * The cycle's lowerings: the RFC's (the last slot deferred, the copy immediate), the copy deferred too, and the
 * control with neither deferred, under which no owner of a non-empty family can be written at all.
 */
const CYCLE_LOWERINGS = {
	rfc: rfc("mirrors", "ordered"),
	"copy deferred": { ...rfc("mirrors", "ordered"), copy: "commit" },
	"nothing deferred": { ...rfc("mirrors", "ordered"), last: "statement" }
} as const satisfies Record<string, Lowering>

type CycleLabel = keyof typeof CYCLE_LOWERINGS

type CycleFeature = `${CycleLabel} ${CycleOperation} ${Verdict}`

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
type RiWrite = Readonly<{
	kind: "count" | "rows" | "owners"
	from: number
	count: number
	slot: number
	generic: boolean
}>

const riWriteGen: Gen<RiWrite> = (source) => {
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

type RiFeature = `${RiWrite["kind"]}, ${"custom" | "generic"} plans`

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

/** The lowerings the program search runs under: the RFC's lowering, which the families model now states. */
const PROGRAM_LOWERINGS = {
	ordered: rfc("mirrors", "ordered"),
	counted: rfc("mirrors", "counted")
} as const satisfies Record<Shape, Lowering>

/** What a program may hold: up to three owners, long families of three to five rows, one to eight steps. */
const programSpace: ProgramSpace = {
	families: { owners: { min: 0, max: 3 }, long: { min: 3, max: 5 } },
	steps: { min: 1, max: 8 }
}

const programsGen: Gen<Program> = (source) =>
	source.draw(programGen(source.draw(element(SHAPES)), programSpace))

type ProgramFeature = `${Shape} ${Form} ${"committed" | "refused"}`

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

layer(Substrate.layer)("the fin lemmas of fin.md §5.2 on PostgreSQL 19rc1", (it) => {
	it.effect(
		"accept exactly the states of the box where the lowered direction's lemma holds, and refuse every other with a constraint the model allows",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(STATE_LOWERINGS)
					const labels = Rec.keys(STATE_LOWERINGS)
					const situations: ReadonlyArray<StateFeature> = [
						...Arr.flatMap(labels, (label): ReadonlyArray<StateFeature> => [
							`${label} committed`,
							...Arr.map(
								refusable(STATE_LOWERINGS[label].direction),
								(c): StateFeature => `${label} refused ${c}`
							)
						]),
						"covers unrestricted refuses a covered state",
						"covers ordered refuses an orphan of a covered state",
						"covers counted refuses an orphan of a covered state"
					]
					return yield* exhaust(
						{
							box: "every state of two owners, each absent or counting 0 to 3 rows, with at most four rows at indices 0 to 4, under each direction's lowering",
							oracle: {
								kind: "specification",
								name: "the families theorem per direction (test/support/families/theorem.ts), and the model of each transaction (fin.ts predicted)"
							},
							suite: "substrate/fin-states",
							generator: stateGen,
							literal: Formatter.format,
							coverage: requiredInSpace(nonEmpty(situations)),
							caseHang
						},
						(sketch, c) =>
							Effect.forEach(
								seats,
								(seat) =>
									Effect.gen(function* () {
										const stored = storedOfSketch(sketch)
										const { real, verdict } = yield* judged(seat, emptyStored, writeOf(stored))
										c.note(`${seat.label} ${verdict}`)
										const lemma = holds(seat.lowering.direction, stored)
										const committed = real.kind === "committed"
										if (seat.label === "covers unrestricted") {
											if (committed && !lemma) {
												return yield* new Disagreed({
													message: `the unrestricted closure accepts a state whose covers lemma fails: ${Formatter.format(sketch)}`
												})
											}
											if (!committed && lemma) {
												c.note("covers unrestricted refuses a covered state")
											}
										} else if (committed !== lemma) {
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
										if (committed) {
											yield* cleared(seat)
										}
									}),
								{ concurrency: "unbounded", discard: true }
							)
					)
				})
			)
	)

	it.effect(
		"commit a single mutation of a family state exactly when the state it leaves satisfies the lemma with every copy its owner's count",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(MUTATION_LOWERINGS)
					const labels = Rec.keys(MUTATION_LOWERINGS)
					const situations: ReadonlyArray<MutationFeature> = Arr.flatMap(
						labels,
						(label): ReadonlyArray<MutationFeature> => [
							`${label} committed`,
							...Arr.map(
								refusable(MUTATION_LOWERINGS[label].direction),
								(c): MutationFeature => `${label} refused ${c}`
							)
						]
					)
					return yield* exhaust(
						{
							box: "every single mutation of every family state of the box, each named",
							oracle: {
								kind: "second-implementation",
								name: "the model of each transaction (fin.ts predicted): its verdict, its moment, its SQLSTATE and a constraint it allows, and the theorem over the state it leaves"
							},
							suite: "substrate/fin-mutations",
							generator: mutationGen,
							literal: Formatter.format,
							coverage: requiredInSpace(nonEmpty(situations)),
							caseHang
						},
						(sketch, c) =>
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
										yield* cleared(seat)
									}),
								{ concurrency: "unbounded", discard: true }
							)
					)
				})
			)
	)
	it.effect(
		"pass the immediate predecessor key on one insert of a family's rows in every order, successor first included",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const [seat] = yield* Effect.map(
						seatsOf({ ordered: rfc("mirrors", "ordered") }),
						nonEmpty
					)
					return yield* exhaust(
						{
							box: "every family state of the box with every order of its rows in one insert",
							oracle: {
								kind: "second-implementation",
								name: "the model of each transaction (fin.ts predicted)"
							},
							suite: "substrate/fin-row-order",
							generator: orderGen,
							literal: Formatter.format,
							coverage: requiredInSpace<OrderFeature>([
								"committed",
								"committed with a successor sent first"
							]),
							caseHang
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const creates = Arr.filter(
									writeOf(storedOf(sketch.families)),
									(m) => m.kind === "create"
								)
								const sent: ReadonlyArray<Mutation> = Arr.isReadonlyArrayNonEmpty(sketch.rows)
									? [...creates, { kind: "insert", rows: sketch.rows }]
									: creates
								const { verdict } = yield* judged(seat, emptyStored, sent)
								if (verdict !== "committed") {
									return yield* new Disagreed({
										message: `one insert of ${Formatter.format(sketch.rows)} was ${verdict}`
									})
								}
								c.note(
									successorFirst(sketch.rows)
										? "committed with a successor sent first"
										: "committed"
								)
								yield* cleared(seat)
							})
					)
				})
			)
	)

	it.effect(
		"commit a member's suffix rewrite and swap-with-last in the prescribed order, refuse the count before the delete, and need the counted family's deferred closure for swap-with-last",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(REWRITE_LOWERINGS)
					return yield* exhaust(
						{
							box: "each member of each non-empty family of the box, both rewrites, every order of their statements",
							oracle: {
								kind: "second-implementation",
								name: "the model of each transaction (fin.ts predicted) under the RFC's lowering and its controls"
							},
							suite: "substrate/fin-rewrites",
							generator: rewriteGen,
							literal: Formatter.format,
							coverage: requiredInSpace<RewriteFeature>([
								"ordered shrink prescribed committed",
								"counted shrink prescribed committed",
								"counted swap prescribed committed",
								"ordered swap prescribed refused closure",
								"ordered shrink count before delete refused bound",
								"counted swap count before delete refused bound",
								"counted swap move before delete refused key",
								"ordered shrink insert before delete refused"
							]),
							caseHang
						},
						(sketch, c) =>
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
										yield* cleared(seat)
									}),
								{ concurrency: "unbounded", discard: true }
							)
					)
				})
			)
	)

	it.effect(
		"create and drop an owner with its family in one transaction through the deferred last slot, and refuse both with nothing deferred",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(CYCLE_LOWERINGS)
					return yield* exhaust(
						{
							box: "every family state of the box with a non-empty family, created from nothing or dropped rows first or owners first",
							oracle: {
								kind: "second-implementation",
								name: "the model of each transaction (fin.ts predicted) under the RFC's lowering, the copy deferred too, and the control with nothing deferred"
							},
							suite: "substrate/fin-cycle",
							generator: cycleGen,
							literal: Formatter.format,
							coverage: requiredInSpace<CycleFeature>([
								"rfc create committed",
								"rfc drop rows first committed",
								"rfc drop owners first refused copy",
								"copy deferred create committed",
								"copy deferred drop rows first committed",
								"copy deferred drop owners first committed",
								"nothing deferred create refused last"
							]),
							caseHang
						},
						(sketch, c) =>
							Effect.forEach(
								seats,
								(seat) =>
									Effect.gen(function* () {
										const dropping = sketch.operation !== "create"
										if (dropping && seat.label === "nothing deferred") {
											return
										}
										if (dropping) {
											yield* written(seat, sketch.families)
										}
										const before = dropping ? storedOf(sketch.families) : emptyStored
										const { real, verdict } = yield* judged(seat, before, cycleStatements(sketch))
										c.note(`${seat.label} ${sketch.operation} ${verdict}`)
										if (dropping || real.kind === "committed") {
											yield* cleared(seat)
										}
									}),
								{ concurrency: "unbounded", discard: true }
							)
					)
				})
			)
	)
	it.effect(
		"run every referential-integrity query against the family by the g prefix of UNIQUE (g, at), with no sequential scan, its saved plans custom or generic",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const [seat] = yield* Effect.map(
						seatsOf({ ordered: rfc("mirrors", "ordered") }),
						nonEmpty
					)
					const names: RiNames = {
						owner: qualified(seat.schema, "owner"),
						fam: qualified(seat.schema, "fam")
					}
					const loaded = yield* attempt(seat.session, [
						`INSERT INTO ${names.owner} (id, n) SELECT o, ${riLoad.slots} FROM pg_catalog.generate_series(1, ${riLoad.owners}) AS o`,
						`INSERT INTO ${names.fam} (member, g, at, copy) SELECT o * ${riLoad.slots} + a, o, a, ${riLoad.slots} FROM pg_catalog.generate_series(1, ${riLoad.owners}) AS o, pg_catalog.generate_series(0, ${riLoad.slots - 1}) AS a`
					])
					assert.equal(loaded.kind, "committed", "the load is a family state")
					yield* s.admin.query(`ANALYZE ${names.owner}, ${names.fam}`, [])
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
					return yield* explore(
						{
							suite: "substrate/fin-ri-prefix",
							draw: drawn(riWriteGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the RI queries ri_triggers.c makes of the family per touched owner or deleted row, counted against PostgreSQL's scans of fam and fam_key"
							},
							coverage: required<RiFeature>(
								nonEmpty(
									Arr.flatMap(["count", "rows", "owners"] as const, (kind) =>
										Arr.map(
											["custom", "generic"] as const,
											(mode): RiFeature => `${kind}, ${mode} plans`
										)
									)
								),
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(w, c) =>
							Effect.gen(function* () {
								const { before, measured } = riStatements(w, names)
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
					)
				})
			)
	)

	it.effect(
		"refuse exactly the steps of a random program of family mutations the model refuses, where it refuses them, and commit the rest to the model's families",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* seatsOf(PROGRAM_LOWERINGS)
					const seatOf = (shape: Shape): Seat<Shape> =>
						Option.getOrThrow(Arr.findFirst(seats, (seat) => seat.label === shape))
					/**
					 * One step on PostgreSQL: its transaction judged against the model as every proof here judges one, which
					 * requires a refusal's constraint to be one the model allows there; then PostgreSQL's answer, named by
					 * the moment it refused.
					 */
					const stepOn =
						(seat: Seat<Shape>) =>
						(
							parameters: Sends,
							before: Families
						): Effect.Effect<
							Answer<ProgramRefusal>,
							SqlError | TransactionRolledBack | Disagreed
						> =>
							Effect.map(
								judged(seat, storedOf(before), parameters.statements),
								({ real }): Answer<ProgramRefusal> =>
									real.kind === "committed" ? took : refused(refusalNamed(real.moment))
							)
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the families model of each step (fin.ts predicted): where it refuses, and the families it commits"
							},
							suite: "substrate/fin-programs",
							draw: drawn(programsGen),
							literal: Formatter.format,
							coverage: required<ProgramFeature>(
								nonEmpty(
									Arr.flatMap(SHAPES, (shape): ReadonlyArray<ProgramFeature> => [
										...Arr.map(
											Arr.filter(
												LAWFUL_FORMS,
												(f) => shape === "ordered" || (f !== "insert-at" && f !== "swap")
											),
											(f): ProgramFeature => `${shape} ${f} committed`
										),
										...Arr.map(BREAKING_FORMS, (f): ProgramFeature => `${shape} ${f} refused`),
										`${shape} misorder committed`,
										`${shape} misorder refused`
									])
								),
								{ cases: 400, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(p, c) =>
							Effect.gen(function* () {
								const seat = seatOf(p.shape)
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
								const ran = yield* runProgram(
									namingMachine(p.shape, p.families, p.forms),
									real,
									p.steps
								)
								for (const [i, feature] of ran.verdicts.entries()) {
									const form = Arr.getUnsafe(p.steps, i).command
									c.note(
										`${p.shape} ${form} ${Str.endsWith(" accepted")(feature) ? "committed" : "refused"}`
									)
								}
								yield* cleared(seat)
							})
					)
				})
			)
	)
})
