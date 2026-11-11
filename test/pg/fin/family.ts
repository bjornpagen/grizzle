/**
 * A family of the fin suites as grizzle lowers it: an owner `Owner(id, n)` counting a member relation `Member(member,
 * g, at)` grouped by `g`, ordered (`at` its drawn index) or counted (its index the hidden law column ‹i›), installed
 * through grizzle's first migration, with the families model's statements (test/support/families/mutate.ts) as the SQL
 * a direct writer sends to it, and its stored state read back as the model's (theorem.ts Stored).
 *
 * Each installed constraint is read as the families model's constraint by the roles of its columns (installed.ts): the
 * member's primary key is `identity`, UNIQUE (g, i) is `key`, CHECK (i < ‹n›) is `bound`, the owner axis (g, ‹n›) →
 * (id, n) is `copy`, the last axis (id, ‹pn›) → (g, i) is `last`, and the predecessor axis (g, ‹p›) → (g, i) is
 * `closure`, with i the index (`at` or ‹i›). The owner's own keys are no constraint of the model, which never writes two
 * owners of one key.
 */
import { Array as Arr, Data, Effect, Formatter, Option, type Scope } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { counted, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import {
	type Catalogued,
	constraintText,
	type End,
	ended,
	endOf,
	replaced,
	type Seat,
	type Start,
	sameRoles,
	seatOf
} from "#test/pg/fin/installed.ts"
import { canonical, emptyStored, sqlstateOf } from "#test/pg/substrate/fin.ts"
import { deepEquals } from "#test/support/assert.ts"
import type { Moment, Settled, MutationStatement } from "#test/support/families/mutate.ts"
import type { Constraint, FamilyRow, Shape, Stored } from "#test/support/families/theorem.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	type Attempted,
	type Checked,
	momentText,
	refusalText,
	sameMoment
} from "#test/support/substrate.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

const Owner = relation("Owner", { id: pg.int4, n: drawn(natural) }, ["id"])

const OrderedMember = relation("Member", { member: pg.int4, g: pg.int4, at: drawn(natural) }, [
	"member"
])

const CountedMember = relation("Member", { member: pg.int4, g: pg.int4 }, ["member"])

/** The ordered family: each owner's members indexed by their drawn `at`. */
const OrderedFamily = schema("fin_ordered", { Owner, Member: OrderedMember }, [
	ordered(on(OrderedMember, "g", "at"), fin(Owner, "n"))
])

/** The counted family: each owner's members indexed by the hidden ‹i›. */
const CountedFamily = schema("fin_counted", { Owner, Member: CountedMember }, [
	counted(on(CountedMember, "g"), fin(Owner, "n"))
])

export const FAMILY_RELATIONS = ["Owner", "Member"] as const

/** A family seat: an installed shape, its index's role, and the family's own law. */
export interface FamilySeat {
	readonly shape: Shape
	readonly seat: Seat
	/** `at` for an ordered family, `‹i›` for a counted one. */
	readonly index: string
	readonly law: string
}

/** Installs a shape's family in a schema of its own. */
export const familySeat = (
	shape: Shape,
	label: string
): Effect.Effect<
	FamilySeat,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const seat = yield* seatOf(
			shape === "ordered" ? OrderedFamily : CountedFamily,
			FAMILY_RELATIONS,
			label
		)
		const [law, ...more] = seat.lawsOf("family")
		if (law === undefined || more.length > 0) {
			return yield* Effect.die(
				`${label}: the schema holds ${seat.lawsOf("family").length} family laws, not one`
			)
		}
		return { shape, seat, index: shape === "ordered" ? "at" : "‹i›", law }
	})

/** The families model's constraint an installed constraint is, by its columns' roles; none for the owner's keys. */
export const constraintOf = (f: FamilySeat, c: Catalogued): Option.Option<Constraint> => {
	const is = (roles: ReadonlyArray<string>) => sameRoles(c.columns, roles)
	switch (c.kind) {
		case "primary":
			return c.relation === "Member" && is(["member"]) ? Option.some("identity") : Option.none()
		case "unique":
			return c.relation === "Member" && is(["g", f.index]) ? Option.some("key") : Option.none()
		case "check":
			return c.relation === "Member" && is([f.index, "‹n›"]) ? Option.some("bound") : Option.none()
		case "foreign": {
			const target = Option.getOrUndefined(c.target)
			if (target === undefined) {
				return Option.none()
			}
			if (c.relation === "Member" && target.relation === "Owner") {
				return Option.some("copy")
			}
			if (c.relation === "Owner" && target.relation === "Member") {
				return Option.some("last")
			}
			return c.relation === "Member" && target.relation === "Member"
				? Option.some("closure")
				: Option.none()
		}
	}
}

/** The installed constraint that is a model constraint, or the defect naming what the seat installed. */
export const installedOf = (f: FamilySeat, constraint: Constraint): Catalogued => {
	const found = Arr.filter(f.seat.constraints, (c) =>
		Option.contains(constraintOf(f, c), constraint)
	)
	const [one, ...more] = found
	if (one === undefined || more.length > 0) {
		throw new Error(
			`${f.seat.label}: ${found.length} installed constraints are the family's ${constraint}`
		)
	}
	return one
}

const list = (values: ReadonlyArray<number>): string =>
	`(${Arr.join(Arr.map(values, String), ", ")})`

/** A families-model statement's SQL on a seat. An insert lists its rows in the order the statement states. */
const statementSql = (f: FamilySeat, statement: MutationStatement): string => {
	const { seat } = f
	const owner = seat.table("Owner")
	const member = seat.table("Member")
	const c = (relation: string, role: string) => seat.column(relation, role)
	switch (statement.kind) {
		case "create":
			return `INSERT INTO ${owner} (${c("Owner", "id")}, ${c("Owner", "n")}) VALUES (${statement.owner}, ${statement.count})`
		case "drop":
			return `DELETE FROM ${owner} WHERE ${c("Owner", "id")} = ${statement.owner}`
		case "count":
			return `UPDATE ${owner} SET ${c("Owner", "n")} = ${statement.count} WHERE ${c("Owner", "id")} = ${statement.owner}`
		case "insert":
			return `INSERT INTO ${member} (${c("Member", "member")}, ${c("Member", "g")}, ${c("Member", f.index)}, ${c("Member", "‹n›")}) VALUES ${Arr.join(
				Arr.map(statement.rows, (r) => list([r.member, r.group, r.at, r.copy])),
				", "
			)}`
		case "delete":
			return `DELETE FROM ${member} WHERE ${c("Member", "member")} IN ${list(statement.members)}`
		case "move":
			return `UPDATE ${member} SET ${c("Member", f.index)} = ${statement.at} WHERE ${c("Member", "member")} = ${statement.member}`
	}
}

/** The read of a seat's stored state, owners then rows. */
export const storedSql = (f: FamilySeat): string => {
	const c = (relation: string, role: string) => f.seat.column(relation, role)
	return `SELECT 0, ${c("Owner", "id")}::int8, ${c("Owner", "n")}::int8, 0::int8, 0::int8 FROM ${f.seat.table("Owner")} UNION ALL SELECT 1, ${c("Member", "member")}::int8, ${c("Member", "g")}::int8, ${c("Member", f.index)}::int8, ${c("Member", "‹n›")}::int8 FROM ${f.seat.table("Member")}`
}

/** The stored state the read returns. */
export const familyStoredOf = (rows: ReadonlyArray<ReadonlyArray<unknown>>): Stored => {
	const owners = new Map<number, number>()
	const members: Array<FamilyRow> = []
	for (const [table, a, b, c, d] of rows) {
		if (Number(table) === 0) {
			owners.set(Number(a), Number(b))
		} else {
			members.push({ member: Number(a), group: Number(b), at: Number(c), copy: Number(d) })
		}
	}
	return { owners, rows: members }
}

/**
 * The statements that write a stored state from no state: each owner with its count, in order of key, then one insert
 * of every row in descending slot order, so a row never arrives before a row it references.
 */
const writeOf = (stored: Stored): ReadonlyArray<MutationStatement> => {
	const rows = Arr.sort(stored.rows, (a: FamilyRow, b: FamilyRow) =>
		a.at > b.at ? -1 : a.at < b.at ? 1 : 0
	)
	return [
		...Arr.map(
			Arr.sort([...stored.owners], (a: readonly [number, number], b: readonly [number, number]) =>
				a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
			),
			([owner, count]): MutationStatement => ({ kind: "create", owner, count })
		),
		...(Arr.isReadonlyArrayNonEmpty(rows)
			? [{ kind: "insert", rows } satisfies MutationStatement]
			: [])
	]
}

/** PostgreSQL's disagreement with the families model or the theorem, spelt out with the SQL. */
export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** A verdict as a feature: committed, or refused naming the model's constraint PostgreSQL named. */
export type FamilyVerdict = "committed" | `refused ${Constraint}`

/** What PostgreSQL did with a transaction the model agreed with, and how the transaction ended. */
export interface FamilyJudged {
	readonly verdict: FamilyVerdict
	readonly committed: boolean
	readonly moment: Option.Option<Moment>
	/** The installed constraint PostgreSQL named, when it refused. */
	readonly refusedBy: Option.Option<Catalogued>
	readonly end: End
}

const outcomeText = (outcome: Settled): string =>
	outcome.kind === "committed"
		? "commit"
		: `refusal ${momentText(outcome.moment)} by any of ${Arr.join(
				Arr.dedupe(Arr.map(outcome.violations, (v) => v.constraint)),
				", "
			)}`

const attemptedText = (real: Attempted | Checked<unknown>): string =>
	real.kind === "committed"
		? "commit"
		: `refusal ${momentText(real.moment)}: ${refusalText(real.fields)}`

/**
 * Sends `statements` as one transaction from `start`, an empty seat or one whose rows are first replaced by the state
 * before (installed.ts Start), ended as its own text chooses (installed.ts endOf, by the model's outcome), and judges
 * PostgreSQL against the model's settled outcome: the same verdict; a refusal at the model's moment by an installed
 * constraint that is one of the model's violations there, with its SQLSTATE and the family's law (the identity, the
 * member's primary key); a commit that reads back as the state the model commits to, lawless or not (a mutant's model
 * may commit a breach).
 */
export const judgedFamily = (
	f: FamilySeat,
	start: Start<Stored>,
	statements: ReadonlyArray<MutationStatement>,
	outcome: Settled
): Effect.Effect<FamilyJudged, SqlError | TransactionRolledBack | Disagreed> =>
	Effect.gen(function* () {
		const { seat } = f
		const sql = (s: ReadonlyArray<MutationStatement>) => Arr.map(s, (st) => statementSql(f, st))
		const before = start.kind === "empty" ? emptyStored : start.before
		const end = endOf(
			Formatter.format([before, statements]),
			outcome.kind === "refused" && outcome.moment.kind === "commit"
		)
		const text = Arr.join(["BEGIN", ...sql(statements), "COMMIT"], ";\n")
		const disagree = (why: string, real: Attempted | Checked<unknown>) =>
			new Disagreed({
				message: `${seat.label}, its ${end} end: ${why}; the model predicts ${outcomeText(outcome)}, PostgreSQL gave ${attemptedText(real)}, over ${Formatter.format(before)}, for\n${text}`
			})
		if (start.kind === "replaced") {
			const setup = yield* replaced(seat, FAMILY_RELATIONS, sql(writeOf(start.before)))
			if (setup.kind !== "committed") {
				return yield* disagree("writing the state before was refused", setup)
			}
		}
		const real = yield* ended(
			seat,
			FAMILY_RELATIONS,
			start.kind,
			sql(statements),
			end,
			seat.session.values(storedSql(f), [])
		)
		yield* seat.session.resetStatements
		if (outcome.kind === "committed" && real.kind === "committed") {
			const read = familyStoredOf(real.read)
			if (!deepEquals(canonical(read), canonical(outcome.stored))) {
				return yield* disagree(`the committed state reads back as ${Formatter.format(read)}`, real)
			}
			return {
				verdict: "committed",
				committed: true,
				moment: Option.none(),
				refusedBy: Option.none(),
				end
			}
		}
		if (outcome.kind === "refused" && real.kind === "refused") {
			if (!sameMoment(outcome.moment, real.moment)) {
				return yield* disagree("the moments differ", real)
			}
			const named = seat.refusedBy(real.fields)
			const constraint = Option.flatMap(named, (c) => constraintOf(f, c))
			if (Option.isNone(named) || Option.isNone(constraint)) {
				return yield* disagree(
					`PostgreSQL names ${Option.match(named, {
						onNone: () => "no constraint the installation holds",
						onSome: (c) => `${constraintText(c)}, no constraint of the family`
					})}`,
					real
				)
			}
			if (
				!Arr.some(outcome.violations, (v) => v.constraint === constraint.value) ||
				real.fields.code !== sqlstateOf[constraint.value]
			) {
				return yield* disagree(
					`PostgreSQL names the ${constraint.value}, which the model does not allow there`,
					real
				)
			}
			if (constraint.value !== "identity" && !Option.contains(named.value.law, f.law)) {
				return yield* disagree(
					`the ${constraint.value} reports ${Formatter.format(named.value.law)}, not the family's law ${f.law}`,
					real
				)
			}
			return {
				verdict: `refused ${constraint.value}`,
				committed: false,
				moment: Option.some(real.moment),
				refusedBy: named,
				end
			}
		}
		return yield* disagree("the verdicts differ", real)
	})
