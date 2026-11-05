import type { Brand } from "effect"
import { Compute } from "#compiler/public/compute.ts"
import {
	accumulated,
	type ClosedIdField,
	closedId,
	contract,
	drawn,
	natural,
	pg,
	type Uuid,
	uuid
} from "#compiler/public/fields.ts"
import {
	type Alternatives,
	alternatives,
	type Containment,
	type ContainmentsOf,
	check,
	closed,
	contained,
	derived,
	type ExpansionOf,
	type Fact,
	fin,
	fold,
	type KeysOf,
	key,
	type LawsOf,
	type LevelsOf,
	type Mirrors,
	Monoid,
	mirrors,
	mutable,
	on,
	ordered,
	type Relation,
	relation,
	role,
	type Schema,
	type Selection,
	type Side,
	type StatementsOf,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { Field } from "#compiler/types/fields/field.ts"
import type { RelationFieldsOf } from "#compiler/types/schema/relation.ts"
import type { BaseSchemaOf } from "#compiler/types/schema/schema.ts"
import { query, v } from "#index.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/schema/support.ts"

/**
 * The public schema types (relations, closed relations, schemas and statements), over the runtime
 * constructors of packages/engine/src/schema as the public barrel binds them. Typechecked only; every `@ts-expect-error --
 * TSnnnn` names the diagnostic the harness requires.
 *
 * Fields and relations.
 */
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const Rate = contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))
export const Kind = closed("Kind", ["Automatic", "Manual"])
/** A roster holds at least one handle: a roster of none has no code to read. */
// @ts-expect-error -- TS2345: a closed relation's handles are a non-empty tuple
export const Empty = closed("Empty", [])
export const Account = relation("Account", { id: uuid, name: str.regex("^[a-z]{1,40}$") }, ["id"])
export const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
export const Ticket = relation(
	"Ticket",
	{ id: pg.bigserial, account: uuid, amount: Cents, rate: Rate },
	["id"]
)

export const AccountLabel = relation(
	"AccountLabel",
	{ account: uuid, label: str.regex("^[a-z]{1,8}$") },
	["label", "account"]
)

/** The relation keeps its name, descriptors and primary key in the order written. */
export type TaskType = Expect<
	Equals<
		typeof Task,
		Relation<
			"Task",
			{
				readonly id: Field<Uuid, "uuid">
				readonly account: Field<Uuid, "uuid">
				readonly kind: ClosedIdField<typeof Kind>
			},
			readonly ["id"]
		>
	>
>

export type PureSetKey = Expect<
	Equals<(typeof AccountLabel)["primaryKey"], readonly ["label", "account"]>
>

/** Brands: a contract field's host value is the base branded with the contract's name. */
export type TicketAmount = Expect<
	Equals<Fact<typeof Ticket>["amount"], bigint & Brand.Brand<"Cents">>
>

export type TicketFact = Expect<
	Not<IsAssignable<{ readonly amount: bigint }, Pick<Fact<typeof Ticket>, "amount">>>
>

/** A roster's fact is its handle; a closed relation's, keyed by closed ids, a fact of its fields. */
export const Tier = closed("Tier", ["Free", "Pro"])
export const TierBudget = closed.relation(
	"TierBudget",
	{ tier: closedId(Tier), budget: Cents },
	["tier"],
	[
		{ tier: "Free", budget: Cents(100n) },
		{ tier: "Pro", budget: Cents(1000n) }
	]
)

export type TierFact = Expect<Equals<Fact<typeof Tier>, { readonly id: "Free" | "Pro" }>>
export type TierBudgetFact = Expect<
	Equals<
		Fact<typeof TierBudget>,
		{ readonly tier: "Free" | "Pro"; readonly budget: bigint & Brand.Brand<"Cents"> }
	>
>

export const BareTier = closed.relation(
	"BareTier",
	{ tier: closedId(Tier), budget: Cents },
	["tier"],
	[
		// @ts-expect-error -- TS2322: a row's contract field takes the contract's branded value, built by Cents(...)
		{ tier: "Free", budget: 100n }
	]
)

/** A handle is a member of its roster. */
export const pausedHandle = () =>
	// @ts-expect-error -- TS2345: a handle is a member of the roster
	Kind.handle("Paused")

/** The primary key is required, nonempty, over the relation's fields, each once; a side names its terms once each. */
// @ts-expect-error -- TS2345: a primary key names at least one field
export const NoKey = relation("NoKey", { id: uuid }, [])
// @ts-expect-error -- TS2322: the primary key names declared fields
export const BadKey = relation("BadKey", { id: uuid }, ["nope"])
// @ts-expect-error -- TS2345 refusal: a key lists each field once
export const TwiceKey = relation("TwiceKey", { id: uuid, b: uuid }, ["id", "id"])
// @ts-expect-error -- TS2345 refusal: a side lists each term once
export const twiceName = key(on(Account, "name", "name"))
// @ts-expect-error -- TS2345 refusal: a side lists each term once
export const twiceSide = on(Task, "id", "id")
// @ts-expect-error -- TS2555: a side names at least one term
export const emptySide = on(Task)

/** LiteralOf rejects a JavaScript number for numeric: in a row check's comparison, and in a selection's predicate. */
export const rateBound = check("RateBound", Ticket, (t) => t.rate.le(1n))
export const rateText = check("RateText", Ticket, (t) => t.rate.le("0.5"))
// @ts-expect-error -- TS2345: a JavaScript number is never a numeric literal
export const rateNumber = check("RateNumber", Ticket, (t) => t.rate.le(1))
// @ts-expect-error -- TS2345: a selection's predicate compares a numeric field with no JavaScript number
export const rateSelect = select(Ticket, (t) => t.rate.le(1))
/** A literal against a contract field adopts the contract: a bare bigint. */
export const centsBound = check("CentsBound", Ticket, (t) =>
	t.and(t.amount.ge(0n), t.ge(t.amount, 1n))
)

/** Statements and the schema's captured tuple. */
export const byName = key(on(Account, "name"))
export const taskAccount = contained(on(Task, "account"), on(Account, "id"))
export const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
export const ManualTask = relation("ManualTask", { task: uuid, assignee: uuid }, ["task"])
export const taskArms = alternatives(Task, "kind", Kind, {
	Automatic: AutomaticTask,
	Manual: ManualTask
})

/**
 * alternatives is one statement that keeps its four inputs. Its expansion is a containment each way per arm, each
 * keeping its arm's relation and key fields, and no head: the discriminator's roster domain types it.
 */
export type TaskArms = Expect<
	Equals<
		typeof taskArms,
		Alternatives<
			typeof Task,
			"kind",
			typeof Kind,
			{ readonly Automatic: typeof AutomaticTask; readonly Manual: typeof ManualTask }
		>
	>
>

type ArmSelection = Side<Selection<typeof Task>, readonly ["id"]>
type AutomaticKey = Side<typeof AutomaticTask, readonly ["task"]>
type ManualKey = Side<typeof ManualTask, readonly ["task"]>
type AutomaticArm =
	| Containment<AutomaticKey, ArmSelection>
	| Containment<ArmSelection, AutomaticKey>
type ManualArmLaw = Containment<ManualKey, ArmSelection> | Containment<ArmSelection, ManualKey>

export type TaskArmsExpansion = Expect<
	Equals<ExpansionOf<typeof taskArms>, AutomaticArm | ManualArmLaw>
>
/** Arms written out of roster order are the same law, and a handle without an arm adds nothing. */
export const manualArm = alternatives(Task, "kind", Kind, { Manual: ManualTask })
export const reversedArms = alternatives(Task, "kind", Kind, {
	Manual: ManualTask,
	Automatic: AutomaticTask
})
export type ManualArm = Expect<Equals<ExpansionOf<typeof manualArm>, ManualArmLaw>>
export type ReversedArms = Expect<Equals<typeof reversedArms, typeof taskArms>>
// @ts-expect-error -- TS2345 refusal: alternatives takes at least one arm
export const noArms = alternatives(Task, "kind", Kind, {})
/**
 * The arm map is keyed by handles of the roster alone, and no arm is the parent itself; one relation may be the arm of
 * several handles.
 */
export const sharedArm = alternatives(Task, "kind", Kind, {
	Automatic: ManualTask,
	Manual: ManualTask
})
// @ts-expect-error -- TS2322 refusal: an arm is keyed by a handle of its roster
export const strayArm = alternatives(Task, "kind", Kind, { Manual: ManualTask, Stray: ManualTask })
// @ts-expect-error -- TS2322 refusal: an arm is a relation other than its parent
export const selfArm = alternatives(Task, "kind", Kind, { Manual: Task })
export const Work = schema(
	"Work",
	{ Kind, Tier, Account, Task, Ticket, AutomaticTask, ManualTask },
	[byName, taskAccount, taskArms, mutable(Account)]
)

export type WorkKeys = Expect<
	Equals<KeysOf<typeof Work, typeof Account>, readonly ["id"] | readonly ["name"]>
>
export type WorkStatements = Expect<Equals<StatementsOf<typeof Work>[0], typeof byName>>
/**
 * The schema's laws read the alternatives statement as its expansion: both directions of every arm are the schema's
 * containments, and no mirrors stands for them.
 */
export type WorkArms = Expect<Equals<StatementsOf<typeof Work>[2], typeof taskArms>>
type ArmContainments = AutomaticArm | ManualArmLaw
type ArmMirrors = Mirrors<ArmSelection, AutomaticKey> | Mirrors<ArmSelection, ManualKey>
export type WorkContainments = Expect<
	Equals<ContainmentsOf<typeof Work>, typeof taskAccount | ArmContainments>
>
export type WorkLaws = Expect<IsAssignable<ArmContainments, LawsOf<typeof Work>>>
export type WorkSugar = Expect<Not<IsAssignable<ArmMirrors, LawsOf<typeof Work>>>>
export type WorkRoot = Expect<Equals<LevelsOf<typeof Work>, typeof Work>>
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const centsRaw = contained(on(Ticket, "amount"), on(Ticket, "id"))
// @ts-expect-error -- TS2739: mutable takes ordinary relations; a closed relation is immutable by nature
export const kindMutable = mutable(Kind)
// @ts-expect-error -- TS2345: a write list names ordinary relations and query entries only
export const kindWrite = role(Work, "bad", Work.relations, { write: ["Kind"] })

/**
 * A weighted bound (fin §6): a pool's claims are an ordered family over its drawn count, their units summed into its
 * total, which a row check holds within its budget; a count bound is a row check on the count.
 */
export const Pool = relation(
	"Pool",
	{ id: uuid, budget: pg.bigint, n: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
export const Claim = relation(
	"Claim",
	{
		pool: uuid,
		at: drawn(natural),
		units: pg.bigint,
		before: accumulated(pg.bigint, 0n),
		after: accumulated(pg.bigint, 0n)
	},
	["pool", "at"]
)
export const claims = ordered(on(Claim, "pool", "at"), fin(Pool, "n"))
export const claimUnits = fold(
	claims,
	Monoid.sum,
	on(Claim, "pool", "units", "before", "after"),
	on(Pool, "id", "total")
)
export const poolBudget = check("UnitsWithinBudget", Pool, (p) => p.le(p.total, p.budget))
export const exactlyTwo = check("ExactlyTwoClaims", Pool, (p) => p.n.eq(2n))
export const Pools = schema("Pools", { Pool, Claim }, [claims, claimUnits, poolBudget, exactlyTwo])

/** Derived relations and levels. */
export const Edu = schema("Edu", { Account, Task, Kind }, [])
export const taskCounts = query(Edu).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).find({ account, tasks: r.count() })
})
export const TaskCounts = derived("TaskCounts", taskCounts)
export const Reports = schema.extend(Edu, { TaskCounts }, [])
export type ReportsLevels = Expect<Equals<LevelsOf<typeof Reports>, typeof Reports | typeof Edu>>
export type ReportsBase = Expect<
	Equals<
		BaseSchemaOf<typeof Reports>,
		Schema<
			"Edu",
			{ readonly Account: typeof Account; readonly Task: typeof Task; readonly Kind: typeof Kind },
			readonly []
		>
	>
>

/** A definition reads no parameter. */
export const byAccount = query(Edu).rule((r) => {
	const { id, account } = v(Task, "task")
	return r
		.match(Task, { id, account })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id })
})
// @ts-expect-error -- TS2345: a derived definition is parameterless
export const ByAccount = derived("ByAccount", byAccount)

/** A definition over an extension does not read its own level: it is no query over a level below it. */
export const overReports = query(Reports).rule((r) => {
	const { account, tasks } = v(TaskCounts, "taskCounts")
	return r.match(TaskCounts, { account, tasks }).find({ account })
})
export const OverReports = derived("OverReports", overReports)
export const Level2 = schema.extend(Reports, { OverReports }, [])
// @ts-expect-error -- TS2322: a derived relation over Reports is not declared at Reports' own level
export const SameLevel = schema.extend(Edu, { OverReports }, [])
// @ts-expect-error -- TS2322: a root schema declares no derived relation; schema.extend does
export const RootDerived = schema("Root", { TaskCounts }, [])

/** A law over a derived relation does not typecheck: LawOnDerived at the type level. */
// @ts-expect-error -- TS2345: a key's side is never over a derived relation
export const derivedKey = key(on(TaskCounts, "account"))
// @ts-expect-error -- TS2739: mutable takes ordinary relations only
export const derivedMutable = mutable(TaskCounts)
// @ts-expect-error -- TS2739: check takes ordinary relations only
export const derivedCheck = check("Positive", TaskCounts, (w) => w.and())
// @ts-expect-error -- TS2345: a law side is never a derived relation
export const derivedSide = on(TaskCounts, "account")
// @ts-expect-error -- TS2345: a selection is never over a derived relation
export const derivedSelect = select(TaskCounts, (c) => c.and())
// @ts-expect-error -- TS2345: alternatives takes no derived parent
export const derivedArms = alternatives(TaskCounts, "account", Kind, {})
// @ts-expect-error -- TS2322 refusal: the arm's key does not match the parent key
export const derivedArm = alternatives(Task, "kind", Kind, { Automatic: TaskCounts })
// @ts-expect-error -- TS2345: a write list never names a derived relation
export const derivedWrite = role(Reports, "bad", Reports.relations, { write: ["TaskCounts"] })
// @ts-expect-error -- TS2345: a refresh list names derived relations only
export const baseRefresh = role(Reports, "bad", Reports.relations, { refresh: ["Task"] })

/** A computed head term keeps the type the derived relation's fields come from. */
export const centsTotals = query(Edu).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id }).find({ id, one: Compute.literal(pg.integer, 1) })
})
export const CentsTotals = derived("CentsTotals", centsTotals)
export type DerivedFields = Expect<Equals<keyof RelationFieldsOf<typeof CentsTotals>, "id" | "one">>
export const mirrorsAccount = mirrors(on(Task, "account"), on(Account, "id"))

/**
 * Every relation a statement names is declared by some level of the schema (the run time refuses it at Db.open with
 * "names B, which no level of the schema declares"), and every whole entry of a role is a relation of its base.
 */
export const S1 = schema("S1", { Account }, [])
// @ts-expect-error -- TS2322 refusal: a whole entry is a relation of the base under its own name
export const undeclaredEntry = role(S1, "r", { Account, Task })
// @ts-expect-error -- TS2345 refusal: a statement names a relation no level of the schema declares
export const undeclaredSide = schema("S2", { Task }, [
	contained(on(Task, "account"), on(Account, "id"))
])
// @ts-expect-error -- TS2345 refusal: a statement names a relation no level of the schema declares
export const undeclaredMutable = schema("S3", { Account }, [mutable(Task)])
// @ts-expect-error -- TS2345 refusal: a statement names a relation no level of the schema declares
export const undeclaredExtension = schema.extend(Edu, {}, [mutable(Ticket)])
export const declaredExtension = schema.extend(Edu, { Ticket }, [mutable(Ticket), mutable(Account)])

/**
 * A level's record is its index by name: each relation sits under its own name, in schema(...) and in
 * schema.extend(...), as a role's whole entries do (the run time refuses it with "a relation under its own name").
 */
// @ts-expect-error -- TS2322 refusal: a schema holds each relation under its own name
export const aliasedRelation = schema("S4", { Accounts: Account }, [])
// @ts-expect-error -- TS2322 refusal: a schema holds each relation under its own name
export const aliasedClosed = schema("S5", { Kinds: Kind }, [])
// @ts-expect-error -- TS2322 refusal: a schema holds each relation under its own name
export const aliasedDerived = schema.extend(Edu, { Counts: TaskCounts }, [])
// @ts-expect-error -- TS2322 refusal: a schema holds each relation under its own name
export const swappedNames = schema("S6", { Account: Task, Task: Account }, [])
export const ownNames = schema("S7", { Account, Kind, Task }, [])

/**
 * A row check, a selection and a contract predicate read no parameter: Predicate is covariant in its parameter map,
 * so the callback's own predicate type is what is refused.
 */
declare const needsAccount: Predicate<{ readonly account: string }>
// @ts-expect-error -- TS2322 refusal: a schema predicate reads no parameter
export const parameterizedCheck = check("NeedsAccount", Task, () => needsAccount)
// @ts-expect-error -- TS2322 refusal: a schema predicate reads no parameter
export const parameterizedSelect = select(Task, () => needsAccount)
// @ts-expect-error -- TS2345 refusal: a schema predicate reads no parameter
export const parameterizedContract = contract("NeedsAccount", pg.bigint, () => needsAccount)
export const parameterlessCheck = check("Positive", Task, (row) => row.id.eq(row.id))
