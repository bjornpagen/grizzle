/**
 * Mutations of families as the statements a writer sends, the model of what PostgreSQL does with each transaction of
 * them, and programs of mutations as a state machine over the families they leave (`@grizzle/testing/commands`).
 *
 * The model is the theorem's lowering (theorem.ts) with the moment PostgreSQL checks each constraint: a transaction
 * applies its statements in order, is refused at the first statement after which a constraint checked there is broken,
 * or at commit when a deferred one is, and otherwise commits to the families the theorem reads from what it leaves.
 *
 * Every change sends its statements in one order: deletes, then the move of swap-with-last, then the owner's count,
 * then inserts. A family changes in the forms the writes take:
 *
 * - lawful, in that order, leaving the theorem true, so each must commit to exactly the families it states, each drawn
 *   as a `Change` and lowered by one function (`loweredGen`):
 *   - `create`, a new owner and its family;
 *   - `append`, rows after the last, with one count update however many rows it adds;
 *   - `remove`, one member: an ordered family deletes the suffix from it, lowers the count and inserts the rest of the
 *     suffix one slot down; a counted family deletes the member, moves its last row into the freed slot and lowers the
 *     count (swap-with-last);
 *   - `insert-at`, new members at a slot of an ordered family, by deleting the suffix from it, raising the count and
 *     inserting the new members then the old suffix;
 *   - `swap`, two members of an ordered family exchanging slots, by rewriting the suffix from the first;
 *   - `replace`, an owner's whole family replaced by a new array, as a put of the owner writes it: every row deleted,
 *     the count set, the new rows inserted;
 *   - `drop`, an owner deleted after its family;
 * - breaking, leaving the theorem false, so each must be refused:
 *   - `count-edit`, a count raised (a gap) or lowered (rows beyond it) with no row changed;
 *   - `beyond`, a row inserted at or past the count;
 *   - `gap`, a member deleted with no row renumbered, the count kept or lowered;
 *   - `twice`, a row inserted at a slot a row holds;
 *   - `orphan`, an owner deleted with its family left;
 * - `misorder`, a lawful mutation's statements in another order, which the model judges: a count lowered while a row
 *   remains at or above it is refused at the count update, because a check is never deferred and the count's cascade
 *   carries the new count into that row's copy; other orders the deferred foreign keys may let commit.
 *
 * Every insert lists its rows in a drawn order, so a row often arrives before its predecessor, and each row copies the
 * count its owner has once the mutation is done, which is what the host writes. Inserted members are new, numbered
 * after every member of the state, and moved members keep their numbers.
 */
import {
	accepting,
	type Command,
	type Machine,
	program,
	type Program as Steps,
	type Real,
	took
} from "@grizzle/testing/commands"
import { boolean, element, type Gen, int, shuffled, type Size } from "@grizzle/testing/gen"
import { fullSwarm, type Swarm, swarm, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Effect, Formatter, Result, Struct } from "effect"
import { indices, maxOf } from "#compiler/core/array.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { type FamilySpace, familiesGen } from "#test/support/families/generate.ts"
import {
	type Breach,
	type Constraint,
	type Families,
	type Family,
	type FamilyRow,
	rowsOf,
	type Shape,
	type Stored,
	storedOf,
	theorem,
	type Violation,
	violations
} from "#test/support/families/theorem.ts"

/**
 * One statement of a transaction:
 *
 * - `create` inserts an owner with its count;
 * - `drop` deletes an owner;
 * - `count` updates an owner's count, and the copy's cascade carries the new count into every row that copied the old;
 * - `insert` inserts family rows in one statement, in the order listed, each with the index and copy it states;
 * - `delete` deletes the rows of the members listed, by the family relation's own key;
 * - `move` updates one member's index.
 */
export type Statement =
	| { readonly kind: "create"; readonly owner: number; readonly count: number }
	| { readonly kind: "drop"; readonly owner: number }
	| { readonly kind: "count"; readonly owner: number; readonly count: number }
	| { readonly kind: "insert"; readonly rows: Arr.NonEmptyReadonlyArray<FamilyRow> }
	| { readonly kind: "delete"; readonly members: Arr.NonEmptyReadonlyArray<number> }
	| { readonly kind: "move"; readonly member: number; readonly at: number }

/**
 * Each statement's place in the order every change sends them: deletes, then the move of swap-with-last, then the
 * owner's count (its creation, its update, or its deletion once its family is gone), then inserts. A lawful mutation's
 * statements are in ascending place.
 */
export const placeOf: Readonly<Record<Statement["kind"], number>> = {
	delete: 0,
	move: 1,
	create: 2,
	count: 2,
	drop: 2,
	insert: 3
}

/**
 * The state a statement leaves, before any constraint is checked: a statement whose rows match nothing changes
 * nothing, as its SQL does. A drawn mutation only creates owners that do not exist.
 */
export const applied = (stored: Stored, statement: Statement): Stored => {
	switch (statement.kind) {
		case "create": {
			if (stored.owners.has(statement.owner)) {
				throw new Error(`owner ${statement.owner} exists: a drawn mutation creates new owners only`)
			}
			return {
				owners: new Map([...stored.owners, [statement.owner, statement.count]]),
				rows: stored.rows
			}
		}
		case "drop": {
			const owners = new Map(stored.owners)
			owners.delete(statement.owner)
			return { owners, rows: stored.rows }
		}
		case "count": {
			const old = stored.owners.get(statement.owner)
			if (old === undefined) {
				return stored
			}
			return {
				owners: new Map([...stored.owners, [statement.owner, statement.count]]),
				rows: Arr.map(stored.rows, (r) =>
					r.group === statement.owner && r.copy === old ? { ...r, copy: statement.count } : r
				)
			}
		}
		case "insert":
			return { owners: stored.owners, rows: [...stored.rows, ...statement.rows] }
		case "delete":
			return {
				owners: stored.owners,
				rows: Arr.filter(stored.rows, (r) => !statement.members.includes(r.member))
			}
		case "move":
			return {
				owners: stored.owners,
				rows: Arr.map(stored.rows, (r) =>
					r.member === statement.member ? { ...r, at: statement.at } : r
				)
			}
	}
}

/** When PostgreSQL checks a constraint: at the end of a statement that breaks it, or at commit. */
export type Timing = "statement" | "commit"

/**
 * When PostgreSQL checks each constraint but the closure, whatever the family's shape. Both keys are unique constraints
 * that are not deferrable, and a check never is, so all three hold at every statement. The copy's and the last slot's
 * foreign keys lie on the cycle between owner and family, so both are deferred; the copy's cascade still runs inside the
 * statement that updates the count, whatever its deferral.
 */
const checkedEverywhere: Readonly<Record<Exclude<Constraint, "closure">, Timing>> = {
	identity: "statement",
	key: "statement",
	bound: "statement",
	copy: "commit",
	last: "commit"
}

/**
 * A lawful change of families, as data, which `loweredGen` turns into statements:
 *
 * - `rewrite` replaces an owner's members from slot `at` on by `suffix`: it deletes the members from `at`, sets the
 *   count to `at` plus the suffix's length and inserts the suffix from `at`. It is how a family appends, an ordered one
 *   removes a member, inserts at a slot or swaps two, and how a put replaces a whole family (`at` 0);
 * - `swapLast` removes the member at `at` of a counted family: it deletes it, moves the last member into its slot and
 *   lowers the count;
 * - `create` adds an owner with its members, and `drop` deletes an owner after its family.
 */
type Change =
	| {
			readonly kind: "rewrite"
			readonly owner: number
			readonly at: number
			readonly suffix: ReadonlyArray<number>
	  }
	| { readonly kind: "swapLast"; readonly owner: number; readonly at: number }
	| { readonly kind: "create"; readonly owner: number; readonly members: ReadonlyArray<number> }
	| { readonly kind: "drop"; readonly owner: number }

/**
 * What a family's shape decides: when its closure is checked, how a member at a slot is removed, and whether the writer
 * may rearrange its order (insert-at and swap). An ordered family's closure holds at the end of the statement that
 * writes the family, which a single insert whose rows arrive successor first passes, and a member leaves by the rewrite
 * of the suffix after it. A counted family's closure is deferred, since swap-with-last leaves the slot after the one
 * it deletes without a predecessor until the last row moves in, and it has no order to rearrange.
 */
interface ShapeRules {
	readonly closure: Timing
	readonly remove: (owner: number, members: ReadonlyArray<number>, at: number) => Change
	readonly reorderable: boolean
}

const shapeRules: Readonly<Record<Shape, ShapeRules>> = {
	ordered: {
		closure: "statement",
		remove: (owner, members, at) => ({ kind: "rewrite", owner, at, suffix: members.slice(at + 1) }),
		reorderable: true
	},
	counted: {
		closure: "commit",
		remove: (owner, _members, at) => ({ kind: "swapLast", owner, at }),
		reorderable: false
	}
}

/** When PostgreSQL checks a constraint of a family of a shape. */
const checkedAt = (constraint: Constraint, shape: Shape): Timing =>
	constraint === "closure" ? shapeRules[shape].closure : checkedEverywhere[constraint]

/** Where a transaction is refused: at its statement of that index, or at commit. */
export type Moment =
	| { readonly kind: "statement"; readonly index: number }
	| { readonly kind: "commit" }

/**
 * What PostgreSQL does with a transaction: it commits, to the families it leaves, or is refused at a moment with every
 * violation checked there. PostgreSQL reports one of them, and which one depends on an order of rows and constraints
 * it does not promise.
 */
export type Outcome =
	| { readonly kind: "committed"; readonly after: Families }
	| {
			readonly kind: "refused"
			readonly moment: Moment
			readonly violations: Arr.NonEmptyReadonlyArray<Violation>
	  }

/**
 * What PostgreSQL does with one transaction of statements over committed families of a shape. The whole state is
 * checked after each statement, which is PostgreSQL's check of the rows that statement touched: the state before it
 * broke no constraint checked there.
 */
export const run = (
	shape: Shape,
	before: Families,
	statements: ReadonlyArray<Statement>
): Outcome => {
	let state = storedOf(before)
	for (const [index, statement] of statements.entries()) {
		state = applied(state, statement)
		const broken = Arr.filter(
			violations(state),
			(v) => checkedAt(v.constraint, shape) === "statement"
		)
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			return { kind: "refused", moment: { kind: "statement", index }, violations: broken }
		}
	}
	const deferred = violations(state)
	if (Arr.isReadonlyArrayNonEmpty(deferred)) {
		return { kind: "refused", moment: { kind: "commit" }, violations: deferred }
	}
	const read = theorem(state)
	if (Result.isFailure(read)) {
		throw new Error(
			`every constraint holds and the theorem does not: ${Formatter.format(read.failure)}`
		)
	}
	return { kind: "committed", after: read.success }
}

/** The families a transaction leaves: what it commits to, or what was there when it is refused. */
const settled = (
	shape: Shape,
	before: Families,
	statements: ReadonlyArray<Statement>
): Families => {
	const outcome = run(shape, before, statements)
	return outcome.kind === "committed" ? outcome.after : before
}

/** The lawful forms, the simplest first. */
export const LAWFUL_FORMS = [
	"create",
	"append",
	"remove",
	"insert-at",
	"swap",
	"replace",
	"drop"
] as const

export type LawfulForm = (typeof LAWFUL_FORMS)[number]

/** The breaking forms, the simplest first. */
export const BREAKING_FORMS = ["count-edit", "beyond", "gap", "twice", "orphan"] as const

export type BreakingForm = (typeof BREAKING_FORMS)[number]

/** Every form, the lawful first, then the breaking, then the misorder: a program's swarm turns each on or off. */
const FORMS = [...LAWFUL_FORMS, ...BREAKING_FORMS, "misorder"] as const

export type Form = (typeof FORMS)[number]

/** A lawful mutation: its statements, in the order every change sends them, and the families it must commit to. */
export interface Lawful {
	readonly statements: Arr.NonEmptyReadonlyArray<Statement>
	readonly after: Families
}

/** A breaking mutation: its statements, and the breach of the theorem the state they leave holds. */
export interface Breaking {
	readonly statements: Arr.NonEmptyReadonlyArray<Statement>
	readonly breaks: Breach["kind"]
}

/**
 * A lawful mutation's statements in another order: the form it was drawn as, its statements in their order, the order
 * sent, and the families the lawful order commits to.
 */
export interface Misordered {
	readonly form: LawfulForm
	readonly prescribed: Arr.NonEmptyReadonlyArray<Statement>
	readonly statements: Arr.NonEmptyReadonlyArray<Statement>
	readonly after: Families
}

/** What each form's command draws. */
export type Mutations = { readonly [F in LawfulForm]: Lawful } & {
	readonly [F in BreakingForm]: Breaking
} & { readonly misorder: Misordered }

/** How many members a mutation that adds them adds. */
const ADDED: Size = { min: 1, max: 3 }

/** A key above every owner's. */
const freshOwner = (families: Families): number =>
	maxOf(
		Arr.map(families, (f) => f.owner),
		-1
	) + 1

/** `count` members numbered after every member of the families. */
const freshMembers = (families: Families, count: number): ReadonlyArray<number> => {
	const first =
		maxOf(
			Arr.flatMap(families, (f) => f.members),
			-1
		) + 1
	return Arr.map(indices(count), (i) => first + i)
}

/** An owner's members, none for an owner the families lack. */
const membersOf = (families: Families, owner: number): ReadonlyArray<number> =>
	Arr.flatMap(families, (f) => (f.owner === owner ? f.members : []))

/** The families with one owner's members replaced. */
const replaced = (families: Families, owner: number, members: ReadonlyArray<number>): Families =>
	Arr.map(families, (f) => (f.owner === owner ? { owner, members } : f))

/** The delete of the members' rows, none for no member. */
const deletesOf = (members: ReadonlyArray<number>): ReadonlyArray<Statement> =>
	Arr.isReadonlyArrayNonEmpty(members) ? [{ kind: "delete", members }] : []

/** The count update from one count to another, none when they are equal. */
const countsOf = (owner: number, from: number, to: number): ReadonlyArray<Statement> =>
	from === to ? [] : [{ kind: "count", owner, count: to }]

/** The insert of the members at consecutive slots from `from`, its rows in a drawn order, none for no member. */
const insertsOf =
	(
		owner: number,
		members: ReadonlyArray<number>,
		from: number,
		copy: number
	): Gen<ReadonlyArray<Statement>> =>
	(source) => {
		const rows = rowsOf(owner, members, from, copy)
		const sent = source.draw(shuffled(rows, { min: rows.length, max: rows.length }))
		return Arr.isReadonlyArrayNonEmpty(sent) ? [{ kind: "insert", rows: sent }] : []
	}

/** A counted family's members after swap-with-last at `at`: the last member in its slot, the count one lower. */
const swappedLast = (members: ReadonlyArray<number>, at: number): ReadonlyArray<number> => {
	const n = members.length
	return at < n - 1
		? [...members.slice(0, at), Arr.getUnsafe(members, n - 1), ...members.slice(at + 1, n - 1)]
		: members.slice(0, n - 1)
}

/** The families a change leaves. */
const changed = (families: Families, change: Change): Families => {
	switch (change.kind) {
		case "create":
			return [...families, { owner: change.owner, members: change.members }]
		case "drop":
			return Arr.filter(families, (f) => f.owner !== change.owner)
		case "rewrite":
			return replaced(families, change.owner, [
				...membersOf(families, change.owner).slice(0, change.at),
				...change.suffix
			])
		case "swapLast":
			return replaced(
				families,
				change.owner,
				swappedLast(membersOf(families, change.owner), change.at)
			)
	}
}

/** A change's statements in the order every change sends them, each insert's rows in a drawn order. */
const loweredGen =
	(families: Families, change: Change): Gen<ReadonlyArray<Statement>> =>
	(source) => {
		switch (change.kind) {
			case "create":
				return [
					{ kind: "create", owner: change.owner, count: change.members.length },
					...source.draw(insertsOf(change.owner, change.members, 0, change.members.length))
				]
			case "drop":
				return [
					...deletesOf(membersOf(families, change.owner)),
					{ kind: "drop", owner: change.owner }
				]
			case "rewrite": {
				const members = membersOf(families, change.owner)
				const count = change.at + change.suffix.length
				return [
					...deletesOf(members.slice(change.at)),
					...countsOf(change.owner, members.length, count),
					...source.draw(insertsOf(change.owner, change.suffix, change.at, count))
				]
			}
			case "swapLast": {
				const members = membersOf(families, change.owner)
				const n = members.length
				return [
					...deletesOf([Arr.getUnsafe(members, change.at)]),
					...(change.at < n - 1
						? [{ kind: "move", member: Arr.getUnsafe(members, n - 1), at: change.at } as const]
						: []),
					...countsOf(change.owner, n, n - 1)
				]
			}
		}
	}

/** A lawful mutation of a form: its change lowered, and the families the change leaves. */
const lawfulOf =
	(families: Families, form: LawfulForm, change: Gen<Change>): Gen<Lawful> =>
	(source) => {
		const drawn = source.draw(change)
		return {
			statements: nonEmpty(source.draw(loweredGen(families, drawn)), `a ${form} sends a statement`),
			after: changed(families, drawn)
		}
	}

/**
 * Whether a family of a shape has a form: insert-at and swap rearrange an order, which only a reorderable shape has;
 * every other form changes either shape.
 */
const hasForm = (shape: Shape, form: Exclude<Form, "create" | "misorder">): boolean => {
	switch (form) {
		case "insert-at":
		case "swap":
			return shapeRules[shape].reorderable
		case "append":
		case "remove":
		case "replace":
		case "drop":
		case "count-edit":
		case "beyond":
		case "gap":
		case "twice":
		case "orphan":
			return true
	}
}

/** The owners a form can change: those with the members it needs. */
const ownersFor = (
	families: Families,
	form: Exclude<Form, "create" | "misorder">
): ReadonlyArray<Family> => {
	const least = (n: number) => Arr.filter(families, (f) => f.members.length >= n)
	switch (form) {
		case "append":
		case "replace":
		case "drop":
		case "count-edit":
		case "beyond":
			return families
		case "remove":
		case "insert-at":
		case "gap":
		case "twice":
		case "orphan":
			return least(1)
		case "swap":
			return least(2)
	}
}

/** A new owner with between `least` and three new members. */
const createGen =
	(families: Families, least: number): Gen<Change> =>
	(source) => ({
		kind: "create",
		owner: freshOwner(families),
		members: freshMembers(families, source.draw(int(least, ADDED.max)))
	})

/** The change a lawful form draws of one of `owners`. */
const changeGen =
	(
		shape: Shape,
		families: Families,
		form: Exclude<LawfulForm, "create">,
		owners: Arr.NonEmptyReadonlyArray<Family>
	): Gen<Change> =>
	(source) => {
		const { owner, members } = source.draw(element(owners))
		const n = members.length
		const rewrite = (at: number, suffix: ReadonlyArray<number>): Change => ({
			kind: "rewrite",
			owner,
			at,
			suffix
		})
		switch (form) {
			case "append":
				return rewrite(n, freshMembers(families, source.draw(int(ADDED.min, ADDED.max))))
			case "remove":
				return shapeRules[shape].remove(owner, members, source.draw(int(0, n - 1)))
			case "insert-at": {
				const at = source.draw(int(0, n - 1))
				const added = freshMembers(families, source.draw(int(ADDED.min, ADDED.max - 1)))
				return rewrite(at, [...added, ...members.slice(at)])
			}
			case "swap": {
				const first = source.draw(int(0, n - 2))
				const second = source.draw(int(first + 1, n - 1))
				const swapped = Arr.map(members, (m, i) =>
					i === first
						? Arr.getUnsafe(members, second)
						: i === second
							? Arr.getUnsafe(members, first)
							: m
				)
				return rewrite(first, swapped.slice(first))
			}
			case "replace": {
				const kept = source.draw(shuffled(members, { min: 0, max: n }))
				const added = freshMembers(families, source.draw(int(n === 0 ? 1 : 0, ADDED.max - 1)))
				const all = [...kept, ...added]
				return rewrite(0, source.draw(shuffled(all, { min: all.length, max: all.length })))
			}
			case "drop":
				return { kind: "drop", owner }
		}
	}

/** A breaking change of one of `owners`. */
const breakingGen =
	(
		families: Families,
		form: BreakingForm,
		owners: Arr.NonEmptyReadonlyArray<Family>
	): Gen<Breaking> =>
	(source) => {
		const { owner, members } = source.draw(element(owners))
		const n = members.length
		const one = (row: Omit<FamilyRow, "member">): Statement => ({
			kind: "insert",
			rows: [{ ...row, member: Arr.getUnsafe(freshMembers(families, 1), 0) }]
		})
		switch (form) {
			case "count-edit": {
				const lower: ReadonlyArray<number> = n >= 2 ? [n - 1, n - 2] : n >= 1 ? [n - 1] : []
				const counts: Arr.NonEmptyReadonlyArray<number> = [n + 1, n + 2, ...lower]
				const count = source.draw(element(counts))
				return {
					statements: [{ kind: "count", owner, count }],
					breaks: count > n ? "gap" : "beyond"
				}
			}
			case "beyond":
				return {
					statements: [one({ group: owner, at: n + source.draw(int(0, 1)), copy: n })],
					breaks: "beyond"
				}
			case "gap": {
				const at = source.draw(int(0, n - 1))
				const lowered = at < n - 1 && source.draw(boolean)
				return {
					statements: nonEmpty<Statement>([
						...deletesOf([Arr.getUnsafe(members, at)]),
						...(lowered ? countsOf(owner, n, n - 1) : [])
					]),
					breaks: "gap"
				}
			}
			case "twice":
				return {
					statements: [one({ group: owner, at: source.draw(int(0, n - 1)), copy: n })],
					breaks: "twice"
				}
			case "orphan":
				return { statements: [{ kind: "drop", owner }], breaks: "orphan" }
		}
	}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))

/** The permutation of 0 … n − 1 of this rank in lexicographic order: rank 0 is the identity. */
const permutation = (n: number, rank: number): ReadonlyArray<number> => {
	let rest: ReadonlyArray<number> = indices(n)
	let left = rank
	const order: Array<number> = []
	for (let place = n - 1; place >= 0; place--) {
		const at = Math.floor(left / factorial(place))
		left %= factorial(place)
		order.push(Arr.getUnsafe(rest, at))
		rest = Arr.remove(rest, at)
	}
	return order
}

/**
 * A lawful mutation of two statements or more, of a form the swarm turns on, in another order: any order but its own,
 * shrinking toward the one that exchanges its last two statements.
 */
const misorderGen =
	(shape: Shape, families: Families, forms: Swarm<Form>): Gen<Misordered> =>
	(source) => {
		const bases: Array<readonly [LawfulForm, Gen<Lawful>]> = [
			["create", lawfulOf(families, "create", createGen(families, 1))]
		]
		for (const form of ["append", "remove", "insert-at", "swap", "replace", "drop"] as const) {
			const owners = Arr.filter(
				ownersFor(families, form),
				(f) => form !== "drop" || f.members.length > 0
			)
			if (
				hasForm(shape, form) &&
				weightOf(forms, form) > 0 &&
				Arr.isReadonlyArrayNonEmpty(owners)
			) {
				bases.push([form, lawfulOf(families, form, changeGen(shape, families, form, owners))])
			}
		}
		const [form, base] = source.draw(element(nonEmpty(bases)))
		const lawful = source.draw(base)
		const prescribed = lawful.statements
		const orders = factorial(prescribed.length)
		if (orders < 2) {
			throw new Error(`a misorder needs two statements or more, and a ${form} drew one`)
		}
		const order = permutation(prescribed.length, source.draw(int(1, orders - 1)))
		return {
			form,
			prescribed,
			statements: nonEmpty(Arr.map(order, (i) => Arr.getUnsafe(prescribed, i))),
			after: lawful.after
		}
	}

/**
 * The state machine of a program over families of a shape, from `families`: a command per form, which applies where
 * the form has an owner to change and the swarm turns it on, and advances to the families the model says its
 * transaction leaves. `create` applies always, so a program never runs out of commands.
 */
export const machineOf = (
	shape: Shape,
	families: Families,
	forms: Swarm<Form>
): Machine<Families, Mutations, never> => {
	const next = (model: Families, mutation: { readonly statements: ReadonlyArray<Statement> }) =>
		settled(shape, model, mutation.statements)
	const owned = <P extends { readonly statements: ReadonlyArray<Statement> }>(
		form: Exclude<Form, "create" | "misorder">,
		parameters: (model: Families, owners: Arr.NonEmptyReadonlyArray<Family>) => Gen<P>
	): Command<Families, P, never> => ({
		weight: 1,
		applies: (model) =>
			hasForm(shape, form) && weightOf(forms, form) > 0 && ownersFor(model, form).length > 0,
		parameters: (model) => parameters(model, nonEmpty(ownersFor(model, form))),
		judge: accepting(next)
	})
	const lawful = (form: Exclude<LawfulForm, "create">) =>
		owned(form, (model, owners) => lawfulOf(model, form, changeGen(shape, model, form, owners)))
	const breaking = (form: BreakingForm) =>
		owned(form, (model, owners) => breakingGen(model, form, owners))
	return {
		initial: families,
		commands: {
			create: {
				weight: 1,
				applies: () => true,
				parameters: (model) => lawfulOf(model, "create", createGen(model, 0)),
				judge: accepting(next)
			},
			append: lawful("append"),
			remove: lawful("remove"),
			"insert-at": lawful("insert-at"),
			swap: lawful("swap"),
			replace: lawful("replace"),
			drop: lawful("drop"),
			"count-edit": breaking("count-edit"),
			beyond: breaking("beyond"),
			gap: breaking("gap"),
			twice: breaking("twice"),
			orphan: breaking("orphan"),
			misorder: {
				weight: 1,
				applies: () => weightOf(forms, "misorder") > 0,
				parameters: (model) => misorderGen(shape, model, forms),
				judge: accepting(next)
			}
		}
	}
}

/**
 * How a test judges each kind of mutation against the system it runs on: given the mutation and the families before
 * it and after it, as the model says.
 */
export interface Judges<E, R> {
	readonly lawful: (
		form: LawfulForm,
		mutation: Lawful,
		before: Families,
		after: Families
	) => Effect.Effect<void, E, R>
	readonly breaking: (
		form: BreakingForm,
		mutation: Breaking,
		before: Families,
		after: Families
	) => Effect.Effect<void, E, R>
	readonly misordered: (
		mutation: Misordered,
		before: Families,
		after: Families
	) => Effect.Effect<void, E, R>
}

/** Each command's real run, by the kind of mutation it draws. */
export const realOf = <E, R>(judges: Judges<E, R>): Real<Families, Mutations, never, E, R> => ({
	create: (m, before, after) => Effect.as(judges.lawful("create", m, before, after), took),
	append: (m, before, after) => Effect.as(judges.lawful("append", m, before, after), took),
	remove: (m, before, after) => Effect.as(judges.lawful("remove", m, before, after), took),
	"insert-at": (m, before, after) => Effect.as(judges.lawful("insert-at", m, before, after), took),
	swap: (m, before, after) => Effect.as(judges.lawful("swap", m, before, after), took),
	replace: (m, before, after) => Effect.as(judges.lawful("replace", m, before, after), took),
	drop: (m, before, after) => Effect.as(judges.lawful("drop", m, before, after), took),
	"count-edit": (m, before, after) =>
		Effect.as(judges.breaking("count-edit", m, before, after), took),
	beyond: (m, before, after) => Effect.as(judges.breaking("beyond", m, before, after), took),
	gap: (m, before, after) => Effect.as(judges.breaking("gap", m, before, after), took),
	twice: (m, before, after) => Effect.as(judges.breaking("twice", m, before, after), took),
	orphan: (m, before, after) => Effect.as(judges.breaking("orphan", m, before, after), took),
	misorder: (m, before, after) => Effect.as(judges.misordered(m, before, after), took)
})

/**
 * A program: its families' shape, the families it starts from, the forms its swarm turns on, and its steps. It is
 * plain data, so a kept case is its literal, and `machineOf(shape, families, forms)` replays its steps.
 */
export interface Program {
	readonly shape: Shape
	readonly families: Families
	readonly forms: Swarm<Form>
	readonly steps: Steps<Mutations>
}

/** What a drawn program may hold: the families it starts from, and how many steps it takes. */
export interface ProgramSpace {
	readonly families: FamilySpace
	readonly steps: Size
}

/** Programs over families of a shape: the families drawn, then a swarm over the forms, then the steps. */
export const programGen =
	(shape: Shape, space: ProgramSpace): Gen<Program> =>
	(source) => {
		const families = source.draw(familiesGen(space.families))
		const forms = source.draw(swarm(FORMS))
		return {
			shape,
			families,
			forms,
			steps: source.draw(
				program(
					machineOf(shape, families, forms),
					space.steps,
					fullSwarm(Struct.keys(machineOf(shape, families, forms).commands))
				)
			)
		}
	}
