import {
	type Containment,
	type ContainmentsOf,
	closedId,
	contained,
	type Fact,
	type Key,
	type KeysOf,
	key,
	type Mirrors,
	mirrors,
	natural,
	on,
	type Pred,
	pg,
	pred,
	relation,
	type Selection,
	type Side,
	schema,
	select,
	str,
	uuid
} from "#index.ts"
import { Account, AccountCost, Kind, Task } from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/**
 * Sides are partial projections (fin.md §3.2): a side is on(R | select(R, φ), term…), where φ is a row check's
 * predicate over R and a term is a field of R or pred(n) of a natural field n of R. key, contained and mirrors take
 * sides. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * natural is a bigint that is never negative, and its host value is a bigint.
 */
const text = str.regex("^[a-z]+$")
export const Parent = relation(
	"Parent",
	{ id: uuid, children: natural, label: text, size: pg.bigint, kind: closedId(Kind) },
	["id"]
)
export const Child = relation("Child", { parent: uuid, at: natural, label: text }, ["parent", "at"])
export const ManualTask = relation("ManualTask", { task: uuid, operator: text }, ["task"])
export type ChildrenHost = Expect<Equals<Fact<typeof Parent>["children"], bigint>>

/** pred(n) is n − 1, defined where n > 0: a term of a side, never a field, and its type keeps the field it reads. */
export const lastChild = pred("children")
export type LastChild = Expect<Equals<typeof lastChild, Pred<"children">>>

/** A side keeps its terms in order, a pred term among them; a field and its pred are two terms. */
export const lastSlot = on(Parent, "id", pred("children"))
export type LastSlot = Expect<
	Equals<typeof lastSlot, Side<typeof Parent, readonly ["id", Pred<"children">]>>
>
export const countAndLast = on(Parent, "children", pred("children"))

/** pred reads a natural field of the side's relation, one level deep. */
// @ts-expect-error -- TS2345: pred reads a natural field, and label is text
export const predText = on(Parent, pred("label"))
// @ts-expect-error -- TS2345: pred reads a natural field, and a bigint field is not one
export const predBigint = on(Parent, pred("size"))
// @ts-expect-error -- TS2345: pred reads a natural field, and a closed id is not one
export const predKind = on(Parent, pred("kind"))
// @ts-expect-error -- TS2345: pred reads a field of the side's relation
export const predNope = on(Parent, pred("nope"))
// @ts-expect-error -- TS2345: a closed relation has no natural field for pred to read
export const predClosed = on(Kind, pred("id"))
// @ts-expect-error -- TS2345: pred is one level deep: its argument is a field name, never a pred term
export const predPred = on(Parent, pred(pred("children")))
// @ts-expect-error -- TS2345 refusal: a side lists each term once
export const predTwice = on(Parent, pred("children"), pred("children"))

/**
 * select(R, φ) is a selection: φ is a row check's predicate, the only spelling of one (fin.md §12, entry 2), over a
 * relation or a closed relation. Its type is the relation's selection; what φ says lives in the value.
 */
export const manual = select(Task, (t) => t.eq(t.kind, "Manual"))
export type ManualSelection = Expect<Equals<typeof manual, Selection<typeof Task>>>
export const costlyManual = select(Task, (t) => t.and(t.eq(t.kind, "Manual"), t.ge(t.cost, 100n)))
export const manualKind = select(Kind, (k) => k.eq(k.id, "Manual"))
export type ManualKind = Expect<Equals<typeof manualKind, Selection<typeof Kind>>>
// @ts-expect-error -- TS2345: φ compares a closed id with a handle of its roster
export const weekly = select(Task, (t) => t.eq(t.kind, "Weekly"))
// @ts-expect-error -- TS2345: a selection is never over a derived relation
export const derivedSelection = select(AccountCost, (c) => c.and())

/** A selected side's terms are its relation's: fields, and pred terms of its natural fields. */
export const manualIds = on(manual, "id")
export type ManualIds = Expect<
	Equals<typeof manualIds, Side<Selection<typeof Task>, readonly ["id"]>>
>
export const labelledLast = on(
	select(Parent, (p) => p.eq(p.label, "open")),
	"id",
	pred("children")
)
// @ts-expect-error -- TS2345: a selected side's terms are its relation's fields
export const manualNope = on(manual, "nope")

/**
 * key(side) is a key: UNIQUE over the side's terms. A key over a whole relation is one of its keys; a key over a
 * selected side bounds only the selected facts, at most one per value, and is no key of the relation.
 */
export const byName = key(on(Account, "name"))
export type ByName = Expect<Equals<typeof byName, Key<Side<typeof Account, readonly ["name"]>>>>
export const oneManualPerAccount = key(on(manual, "account"))
export type OneManualPerAccount = Expect<
	Equals<typeof oneManualPerAccount, Key<Side<Selection<typeof Task>, readonly ["account"]>>>
>
// @ts-expect-error -- TS2345 refusal: a side lists each term once
export const twiceName = key(on(Account, "name", "name"))
/** A closed relation is keyed by its handle alone: no key names a side of one. */
// @ts-expect-error -- TS2345: key takes a side of an ordinary relation, and Kind is closed
export const keyedKind = key(on(Kind, "id"))

/**
 * contained and mirrors pair their sides' terms position by position, and pred(n) joins as n's own type. The last
 * slot law: the child marked last is the parent's last slot. mirrors is the two containments, so it keeps both sides.
 */
export const lastMarked = contained(
	on(
		select(Child, (c) => c.eq(c.label, "last")),
		"parent",
		"at"
	),
	on(Parent, "id", pred("children"))
)
export const lastMirrored = mirrors(
	on(Parent, "id", pred("children")),
	on(
		select(Child, (c) => c.eq(c.label, "last")),
		"parent",
		"at"
	)
)
export const manualArm = mirrors(on(manual, "id"), on(ManualTask, "task"))
export type ManualArm = Expect<
	Equals<
		typeof manualArm,
		Mirrors<
			Side<Selection<typeof Task>, readonly ["id"]>,
			Side<typeof ManualTask, readonly ["task"]>
		>
	>
>
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const labelAsSlot = contained(on(Child, "label"), on(Parent, pred("children")))
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const slotArity = mirrors(on(Child, "parent", "at"), on(Parent, pred("children")))

/**
 * A schema reads the relation each side names, a selected side's relation among them; its keys are its relations'
 * keys, and its containments read each mirrors as the two it is sugar for.
 */
export const Sides = schema("Sides", { Kind, Account, Task, Parent, Child, ManualTask }, [
	byName,
	oneManualPerAccount,
	lastMarked,
	manualArm
])
export type AccountKeys = Expect<
	Equals<KeysOf<typeof Sides, typeof Account>, readonly ["id"] | readonly ["name"]>
>
export type TaskKeys = Expect<Equals<KeysOf<typeof Sides, typeof Task>, readonly ["id"]>>
type ManualTaskKey = Side<typeof ManualTask, readonly ["task"]>
export type SidesContainments = Expect<
	Equals<
		ContainmentsOf<typeof Sides>,
		| typeof lastMarked
		| Containment<typeof manualIds, ManualTaskKey>
		| Containment<ManualTaskKey, typeof manualIds>
	>
>
// @ts-expect-error -- TS2345 refusal: a statement names a relation no level of the schema declares
export const undeclaredSelection = schema("Partial", { Account }, [oneManualPerAccount])
// @ts-expect-error -- TS2345 refusal: a statement names a relation no level of the schema declares
export const undeclaredPred = schema("Slots", { Child }, [lastMarked])
