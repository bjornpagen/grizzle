/**
 * The fin lemmas of fin.md §5.2 as hand-written DDL, the statements a writer sends, and the model of what PostgreSQL
 * does with each transaction of them: the substrate proof's own reference (fin.test.ts), never grizzle's lowering.
 *
 * An owner relation `owner (id, n)` counts the slots of its family relation `fam (member, g, at)`, grouped by `g`. The
 * lowering adds three columns grizzle draws and the constraints of the direction stated (§5.2's table):
 *
 * - F[g, at] ⊆ fin(O, n), `within`: the copy ‹n› of the owner's count, `FOREIGN KEY (g, ‹n›) REFERENCES owner (id, n)
 *   ON UPDATE CASCADE`, and `CHECK (at < ‹n›)`;
 * - fin(O, n) ⊆ F[g, at], `covers`: the owner's last slot, `FOREIGN KEY (id, pred(n)) REFERENCES fam (g, at)`, and the
 *   downward closure `FOREIGN KEY (g, ‹p›) REFERENCES fam (g, at)`, where ‹p› is `CASE WHEN at > 0 AND at < ‹n› THEN at −
 *   1 END`; both reference fam's `UNIQUE (g, at)`, since a containment's target holds a key of its relation (§3.4), and
 *   ‹p› reads the copy, so the copy's foreign key comes too;
 * - `mirrors`: all of them.
 *
 * `natural` is a domain over int8, `CHECK (VALUE >= 0)`, typing the declared count and index; the columns grizzle
 * generates or copies are int8, its base type, as grizzle's law columns are. The model is the families theorem's
 * (test/support/families/theorem.ts) with the moment each constraint is checked a parameter of the lowering, so one
 * model judges the RFC's deferral and its alternatives.
 */
import { Array as Arr, Option, Order } from "effect"
import { applied, type Moment, type Statement, type Timing } from "#test/support/families/mutate.ts"
import {
	CONSTRAINTS,
	type Constraint,
	type FamilyRow,
	type Stored,
	type Violation,
	violations
} from "#test/support/families/theorem.ts"
import { qualified, tuple } from "#test/support/substrate.ts"

/** Which half of the bijection a lowering states, or both. */
export type Direction = "within" | "covers" | "mirrors"

/**
 * A lowering of a direction: when PostgreSQL checks each of its three foreign keys, and whether the closure's ‹p› is
 * restricted to indices below the copy, as §5.2 states it, or unrestricted, the variant §5.2 says would also forbid
 * gaps above n.
 */
export interface Lowering {
	readonly direction: Direction
	readonly copy: Timing
	readonly last: Timing
	readonly closure: Timing
	readonly restriction: "restricted" | "unrestricted"
}

/** The constraints a direction installs beside the owner's own keys. */
export const constraintsOf: Readonly<Record<Direction, ReadonlyArray<Constraint>>> = {
	within: ["identity", "copy", "bound"],
	covers: ["identity", "key", "copy", "last", "closure"],
	mirrors: ["identity", "key", "bound", "copy", "last", "closure"]
}

/** When PostgreSQL checks a constraint of a lowering: a key and a check at every statement, a foreign key as declared. */
const timingOf = (lowering: Lowering, constraint: Constraint): Timing => {
	switch (constraint) {
		case "identity":
		case "key":
		case "bound":
			return "statement"
		case "copy":
			return lowering.copy
		case "last":
			return lowering.last
		case "closure":
			return lowering.closure
	}
}

/** Each constraint's name in the DDL, which PostgreSQL reports a violation by. */
const constraintName: Readonly<Record<Constraint, string>> = {
	identity: "fam_identity",
	key: "fam_key",
	bound: "fam_bound",
	copy: "fam_copy",
	last: "owner_last",
	closure: "fam_closure"
}

/** The SQLSTATE PostgreSQL raises a constraint's violation with: 23505 for a key, 23514 for a check, 23503 for an FK. */
export const sqlstateOf: Readonly<Record<Constraint, string>> = {
	identity: "23505",
	key: "23505",
	bound: "23514",
	copy: "23503",
	last: "23503",
	closure: "23503"
}

/** The constraint a reported name is, or none for a name no lowering installs. */
export const constraintNamed = (name: string | undefined): Option.Option<Constraint> =>
	Arr.findFirst(CONSTRAINTS, (c) => constraintName[c] === name)

const deferral = (timing: Timing): string =>
	timing === "commit" ? "DEFERRABLE INITIALLY DEFERRED" : "NOT DEFERRABLE"

/** The DDL of a lowering in `schema`, in order: the natural domain, the owner, the family, and the last slot. */
export const ddlOf = (schema: string, lowering: Lowering): ReadonlyArray<string> => {
	const owner = qualified(schema, "owner")
	const fam = qualified(schema, "fam")
	const natural = qualified(schema, "natural")
	const present = new Set(constraintsOf[lowering.direction])
	const covering = present.has("closure")
	const p =
		lowering.restriction === "restricted"
			? "CASE WHEN at > 0 AND at < copy THEN at - 1 END"
			: "CASE WHEN at > 0 THEN at - 1 END"
	const famParts = [
		"member int4 NOT NULL",
		"g int4 NOT NULL",
		`at ${natural} NOT NULL`,
		"copy int8 NOT NULL",
		...(covering ? [`p int8 GENERATED ALWAYS AS (${p}) STORED`] : []),
		`CONSTRAINT fam_identity PRIMARY KEY (member)`,
		...(present.has("key") ? ["CONSTRAINT fam_key UNIQUE NULLS DISTINCT (g, at)"] : []),
		...(present.has("bound") ? ["CONSTRAINT fam_bound CHECK (at < copy)"] : []),
		`CONSTRAINT fam_copy FOREIGN KEY (g, copy) REFERENCES ${owner} (id, n) MATCH SIMPLE ON UPDATE CASCADE ${deferral(lowering.copy)}`,
		...(covering
			? [
					`CONSTRAINT fam_closure FOREIGN KEY (g, p) REFERENCES ${fam} (g, at) MATCH SIMPLE ${deferral(lowering.closure)}`
				]
			: [])
	]
	return [
		`CREATE DOMAIN ${natural} AS int8 CONSTRAINT natural_nonnegative CHECK (VALUE >= 0)`,
		`CREATE TABLE ${owner} (id int4 NOT NULL, n ${natural} NOT NULL${
			covering ? ", last int8 GENERATED ALWAYS AS (CASE WHEN n > 0 THEN n - 1 END) STORED" : ""
		}, CONSTRAINT owner_pk PRIMARY KEY (id), CONSTRAINT owner_slots UNIQUE NULLS DISTINCT (id, n))`,
		`CREATE TABLE ${fam} (${Arr.join(famParts, ", ")})`,
		...(covering
			? [
					`ALTER TABLE ${owner} ADD CONSTRAINT owner_last FOREIGN KEY (id, last) REFERENCES ${fam} (g, at) MATCH SIMPLE ${deferral(lowering.last)}`
				]
			: [])
	]
}

/**
 * One statement of a transaction: the families' statements (mutate.ts Statement) and the two single-field changes of a
 * row they never send, which a single mutation of a state may still make:
 *
 * - `regroup` moves one member's row to another group, keeping its index and copy;
 * - `recopy` changes one member's copy of its owner's count.
 */
export type Mutation =
	| Statement
	| { readonly kind: "regroup"; readonly member: number; readonly group: number }
	| { readonly kind: "recopy"; readonly member: number; readonly copy: number }

/** The state a mutation leaves, before any constraint is checked: what its SQL does to the rows it matches. */
export const appliedTo = (stored: Stored, mutation: Mutation): Stored => {
	switch (mutation.kind) {
		case "regroup":
			return {
				owners: stored.owners,
				rows: Arr.map(stored.rows, (r) =>
					r.member === mutation.member ? { ...r, group: mutation.group } : r
				)
			}
		case "recopy":
			return {
				owners: stored.owners,
				rows: Arr.map(stored.rows, (r) =>
					r.member === mutation.member ? { ...r, copy: mutation.copy } : r
				)
			}
		case "create":
		case "drop":
		case "count":
		case "insert":
		case "delete":
		case "move":
			return applied(stored, mutation)
	}
}

/** A mutation's SQL in `schema`. An insert lists its rows in the order the mutation states. */
export const sqlOf = (schema: string, mutation: Mutation): string => {
	const owner = qualified(schema, "owner")
	const fam = qualified(schema, "fam")
	switch (mutation.kind) {
		case "create":
			return `INSERT INTO ${owner} (id, n) VALUES (${mutation.owner}, ${mutation.count})`
		case "drop":
			return `DELETE FROM ${owner} WHERE id = ${mutation.owner}`
		case "count":
			return `UPDATE ${owner} SET n = ${mutation.count} WHERE id = ${mutation.owner}`
		case "insert":
			return `INSERT INTO ${fam} (member, g, at, copy) VALUES ${Arr.join(
				Arr.map(mutation.rows, (r) => tuple([r.member, r.group, r.at, r.copy])),
				", "
			)}`
		case "delete":
			return `DELETE FROM ${fam} WHERE member IN ${tuple(mutation.members)}`
		case "move":
			return `UPDATE ${fam} SET at = ${mutation.at} WHERE member = ${mutation.member}`
		case "regroup":
			return `UPDATE ${fam} SET g = ${mutation.group} WHERE member = ${mutation.member}`
		case "recopy":
			return `UPDATE ${fam} SET copy = ${mutation.copy} WHERE member = ${mutation.member}`
	}
}

/** The slots some row holds, as `group:at`. */
const heldSlots = (rows: ReadonlyArray<FamilyRow>): ReadonlySet<string> =>
	new Set(Arr.map(rows, (r) => `${r.group}:${r.at}`))

/**
 * Every constraint of the lowering the stored state breaks, whenever PostgreSQL checks it: the families theorem's
 * violations of the constraints the direction installs, the closure's read by the lowering's restriction.
 */
const violated = (lowering: Lowering, stored: Stored): ReadonlyArray<Violation> => {
	const present = new Set(constraintsOf[lowering.direction])
	const found = Arr.filter(
		violations(stored),
		(v) =>
			present.has(v.constraint) &&
			(v.constraint !== "closure" || lowering.restriction === "restricted")
	)
	if (lowering.restriction === "restricted" || !present.has("closure")) {
		return found
	}
	const held = heldSlots(stored.rows)
	return [
		...found,
		...Arr.flatMap(stored.rows, (row): ReadonlyArray<Violation> =>
			row.at > 0 && !held.has(`${row.group}:${row.at - 1}`)
				? [{ constraint: "closure", member: row.member }]
				: []
		)
	]
}

/** What the model says PostgreSQL does with a transaction: it commits to a stored state, or is refused at a moment. */
export type Predicted =
	| { readonly kind: "committed"; readonly after: Stored }
	| {
			readonly kind: "refused"
			readonly moment: Moment
			readonly violations: Arr.NonEmptyReadonlyArray<Violation>
	  }

/**
 * The model of one transaction of `mutations` over the committed state `before`: after each statement every
 * constraint checked at a statement must hold, which is PostgreSQL's check of the rows the statement touched since the
 * state before broke none of them; at commit every constraint must hold.
 */
export const predicted = (
	lowering: Lowering,
	before: Stored,
	mutations: ReadonlyArray<Mutation>
): Predicted => {
	let state = before
	for (const [index, mutation] of mutations.entries()) {
		state = appliedTo(state, mutation)
		const broken = Arr.filter(
			violated(lowering, state),
			(v) => timingOf(lowering, v.constraint) === "statement"
		)
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			return { kind: "refused", moment: { kind: "statement", index }, violations: broken }
		}
	}
	const deferred = violated(lowering, state)
	return Arr.isReadonlyArrayNonEmpty(deferred)
		? { kind: "refused", moment: { kind: "commit" }, violations: deferred }
		: { kind: "committed", after: state }
}

/** No owner and no row. */
export const emptyStored: Stored = { owners: new Map(), rows: [] }

/** A stored state's owners and rows in one canonical order, owners by key and rows by member, for exact comparison. */
export const canonical = (
	stored: Stored
): {
	readonly owners: ReadonlyArray<readonly [number, number]>
	readonly rows: ReadonlyArray<FamilyRow>
} => ({
	owners: Arr.sort(
		Array.from(stored.owners),
		Order.mapInput(Order.Number, ([o]: readonly [number, number]) => o)
	),
	rows: Arr.sort(
		stored.rows,
		Order.mapInput(Order.Number, (r: FamilyRow) => r.member)
	)
})

/** The read of a lowering's stored state, owners then rows, every value an int4. */
export const readSql = (schema: string): string =>
	`SELECT 0, id::int4, n::int4, 0, 0 FROM ${qualified(schema, "owner")} UNION ALL SELECT 1, member, g, at::int4, copy::int4 FROM ${qualified(schema, "fam")}`

/** The stored state the read returns. */
export const storedOfRows = (rows: ReadonlyArray<ReadonlyArray<unknown>>): Stored => {
	const owners = new Map<number, number>()
	const famRows: Array<FamilyRow> = []
	for (const [table, a, b, c, d] of rows) {
		if (Number(table) === 0) {
			owners.set(Number(a), Number(b))
		} else {
			famRows.push({ member: Number(a), group: Number(b), at: Number(c), copy: Number(d) })
		}
	}
	return { owners, rows: famRows }
}

/** The removal of every row and owner a case left, in one statement, so the next case starts from no state. */
export const clearSql = (schema: string): string =>
	`TRUNCATE ${qualified(schema, "fam")}, ${qualified(schema, "owner")}`

/**
 * The statements that write a stored state from no state, as one transaction: each owner created with its count, in
 * order of key, then one insert of every row, successor first, so a row never arrives after the row it references.
 */
export const writeOf = (stored: Stored): ReadonlyArray<Mutation> => {
	const descending = Arr.sort(
		stored.rows,
		Order.mapInput(Order.flip(Order.Number), (r: FamilyRow) => r.at)
	)
	return [
		...Arr.map(canonical(stored).owners, ([owner, count]): Mutation => ({
			kind: "create",
			owner,
			count
		})),
		...(Arr.isReadonlyArrayNonEmpty(descending)
			? [{ kind: "insert", rows: descending } satisfies Mutation]
			: [])
	]
}
