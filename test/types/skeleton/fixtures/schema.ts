import type { Brand } from "effect"
import { accumulated, closedId, drawn, natural, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import {
	alternatives,
	check,
	closed,
	contained,
	counted,
	fin,
	fold,
	key,
	Monoid,
	mirrors,
	mutable,
	on,
	relation,
	role,
	schema,
	select
} from "#compiler/public/schema.ts"
import type { Addition } from "#compiler/types/changeset/changeset.ts"
import type { Fact, SerialFieldsOf } from "#compiler/types/schema/relation.ts"
import type { KeysOf } from "#compiler/types/schema/schema.ts"
import type { Counted, Fin, KeyValues, Side } from "#compiler/types/schema/statements.ts"
import type { WriteListOf } from "#compiler/types/schema/world.ts"
import {
	Account,
	type byName,
	Cents,
	Kind,
	Label,
	type Reader,
	Reports,
	StudentWeekly,
	Task,
	TaskNote,
	type Ticket,
	Tier,
	TierBudget,
	Work,
	type Writer
} from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/**
 * Relations, statements and the schema projections over declare-only values. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires.
 *
 * Facts are host values; a roster's fact is { id }, and a closed relation's a fact of its fields.
 */
export type TaskFact = Expect<
	Equals<
		Fact<typeof Task>,
		{ readonly id: Uuid; readonly account: Uuid; readonly kind: "Automatic" | "Manual" }
	>
>

export type TierBudgetFact = Expect<
	Equals<
		Fact<typeof TierBudget>,
		{ readonly tier: "Free" | "Pro"; readonly budget: bigint & Brand.Brand<"Cents"> }
	>
>
export type KindFact = Expect<Equals<Fact<typeof Kind>, { readonly id: "Automatic" | "Manual" }>>

/** The primary key is required and nonempty, and names declared fields. */
// @ts-expect-error -- TS2345: a primary key names at least one field
export const NoKey = relation("NoKey", { id: uuid }, [])
// @ts-expect-error -- TS2322: the primary key names declared fields
export const BadKey = relation("BadKey", { id: uuid }, ["nope"])
/** A closed relation's rows are whole facts of its fields. */
export const PartialTier = closed.relation(
	"PartialTier",
	{ tier: closedId(Tier), budget: Cents },
	["tier"],
	[
		// @ts-expect-error -- TS2741: a row holds every field
		{ tier: "Free" }
	]
)

/** KeysOf reads the primary key and every key() over a whole relation that the schema captures. */
export type TaskKeys = Expect<Equals<KeysOf<typeof Work, typeof Task>, readonly ["id"]>>
export type AccountKeys = Expect<
	Equals<KeysOf<typeof Work, typeof Account>, readonly ["id"] | readonly ["name"]>
>
export type KindKeys = Expect<Equals<KeysOf<typeof Work, typeof Kind>, readonly ["id"]>>
export type KeyedLookup = Expect<Equals<KeyValues<typeof byName>, { readonly name: string }>>
export type PrimaryLookup = Expect<Equals<KeyValues<typeof Task>, { readonly id: Uuid }>>

/** Roles and write lists. */
export type WriterList = Expect<Equals<WriteListOf<typeof Writer>, "Task" | "TaskNote" | "Ticket">>
export type ReaderList = Expect<Equals<WriteListOf<typeof Reader>, never>>
// @ts-expect-error -- TS2345: a write list names relations of the role
export const strayWrite = role(Work, "stray", Work.relations, { write: ["Nobody"] })

/** Serial fields may be omitted from an addition, all or none. */
export type TicketSerials = Expect<Equals<SerialFieldsOf<typeof Ticket>, "id">>
export type TicketAddition = Expect<
	Equals<Addition<typeof Ticket>, Fact<typeof Ticket> | Omit<Fact<typeof Ticket>, "id">>
>

/**
 * Side compatibility: the mirrors/contained reader compares field host types position by position, contract and
 * roster identity included.
 */
export const Budget = relation("Budget", { account: uuid, cents: Cents, raw: pg.bigint }, [
	"account"
])
export const accountBudget = contained(on(Budget, "account"), on(Account, "id"))
export const kindRoster = contained(on(Task, "kind"), on(Kind, "id"))
export const noteMirror = mirrors(on(TaskNote, "task"), on(Task, "id"))
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const centsRaw = contained(on(Budget, "cents"), on(Budget, "raw"))
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const labelId = contained(on(Account, "name"), on(Account, "id"))
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const kindTier = contained(on(Task, "kind"), on(Tier, "id"))
// @ts-expect-error -- TS2345: a side's terms are fields of its source
export const badSide = on(Task, "nope")
export const automatic = on(
	select(Task, (t) => t.eq(t.kind, "Automatic")),
	"id"
)
// @ts-expect-error -- TS2345: a selection's predicate compares a closed id with a handle of its roster
export const badSelect = select(Task, (t) => t.eq(t.kind, "Other"))

/** Row checks see each field as a Scalar beside the Compute helpers. */
export const Election = relation("Election", { id: uuid, limit: pg.integer, maximum: pg.integer }, [
	"id"
])

export const limitWithinMaximum = check("LimitWithinMaximum", Election, (e) =>
	e.le(e.limit, e.maximum)
)
export const positiveLimit = check("PositiveLimit", Election, (e) => e.limit.ge(1))

/** Alternatives: the discriminator is a closedId of the roster, and each arm's key matches the parent key. */
export const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
export const ManualTask = relation("ManualTask", { task: uuid, assignee: uuid }, ["task"])
export const taskArms = alternatives(Task, "kind", Kind, {
	Automatic: AutomaticTask,
	Manual: ManualTask
})
export const Numbered = relation("Numbered", { n: pg.bigint, kind: closedId(Kind) }, ["n"])
// @ts-expect-error -- TS2322 refusal: the arm's key does not match the parent key
export const badArms = alternatives(Numbered, "kind", Kind, { Automatic: AutomaticTask })
// @ts-expect-error -- TS2345: the discriminator is a closedId of the roster
export const badDiscriminator = alternatives(Task, "account", Kind, { Automatic: AutomaticTask })
export const WorkArms = schema("WorkArms", { Kind, Task, AutomaticTask, ManualTask }, [
	taskArms,
	key(on(AutomaticTask, "budget", "task"))
])

/** The alternatives statement keeps its inputs, so the schema's other statements and keys stay readable. */
export type ArmKeys = Expect<
	Equals<
		KeysOf<typeof WorkArms, typeof AutomaticTask>,
		readonly ["task"] | readonly ["budget", "task"]
	>
>

/** No statement names a derived relation: LawOnDerived at the type level. */
// @ts-expect-error -- TS2345: a key's side is never over a derived relation
export const derivedKey = key(on(StudentWeekly, "student"))
// @ts-expect-error -- TS2739: mutable does not take a derived relation
export const derivedMutable = mutable(StudentWeekly)
// @ts-expect-error -- TS2345: a law side is never a derived relation
export const derivedSide = on(StudentWeekly, "student")
// @ts-expect-error -- TS2739: mutable takes ordinary relations; closed relations are immutable by nature
export const closedMutable = mutable(Kind)
// @ts-expect-error -- TS2739: check does not take a derived relation
export const derivedCheck = check("WeeklyPositive", StudentWeekly, (w) => w.and())
// @ts-expect-error -- TS2345: alternatives does not take a derived parent
export const derivedArms = alternatives(StudentWeekly, "week", Kind, {})
// @ts-expect-error -- TS2345: a write list never names a derived relation
export const derivedWrite = role(Reports, "bad", Reports.relations, { write: ["StudentWeekly"] })
export const labelled = relation("Labelled", { label: Label }, ["label"])

/**
 * Capacity's replacement (fin §6): a pool's claims are a counted family over its drawn count n, so a count of at least
 * one is a row check on n, and a weight within the budget is a sum fold of the claims' units into the pool's total,
 * checked against its budget.
 */
export const Pool = relation(
	"Pool",
	{ id: uuid, budget: pg.bigint, n: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
export const Claim = relation("Claim", { id: uuid, pool: uuid, units: pg.bigint }, ["id"])
export const claims = counted(on(Claim, "pool"), fin(Pool, "n"))
export const claimUnits = fold(claims, Monoid.sum, on(Claim, "pool", "units"), on(Pool, "id", "total"))
export const poolBudget = check("ClaimsWithinBudget", Pool, (p) => p.le(p.total, p.budget))
export const poolCount = check("AtLeastOneClaim", Pool, (p) => p.n.ge(1n))
export const WorkPools = schema("WorkPools", { Pool, Claim }, [
	claims,
	claimUnits,
	poolBudget,
	poolCount
])
export type PoolsClaims = Expect<
	Equals<
		(typeof WorkPools)["statements"][0],
		Counted<Side<typeof Claim, readonly ["pool"]>, Fin<typeof Pool, "n">>
	>
>
