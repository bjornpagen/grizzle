import type { Brand, Stream } from "effect"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Origin, ParamType, Rostered, Term } from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type {
	EvidenceOfQuery,
	HeadOf,
	ParamsOf,
	QueryConstructor,
	VConstructor
} from "#compiler/types/query/query.ts"
import { query, v } from "#index.ts"
import { Account, Cents, Task, Work } from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOf<X> = keyof ParamsOf<X>

/**
 * Queries over declare-only values: parameter inference from uses, origin brands, heterogeneous unions, imports and
 * ordering. Every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * Variables carry their origin: relation, field and scope.
 */
declare const taskVars: ReturnType<typeof v<typeof Task, "task">>
export type TaskIdOrigin = Expect<
	Equals<typeof taskVars.id, Term<Uuid, unknown, Origin<"Task", "id", "task">, "uuid">>
>

/** The account parameter is a required uuid: its map entry is the descriptor it was declared at. */
export const tasksForAccount = query(Work).rule((r) => {
	const { id, account, kind } = v(Task, "task")
	return r
		.match(Task, { id, account, kind })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, kind })
})

export type TasksForAccountParams = Expect<
	Equals<ParamsOf<typeof tasksForAccount>, { readonly account: ParamType<Uuid, "uuid"> }>
>

export type TasksForAccountHead = Expect<
	Equals<
		HeadOf<typeof tasksForAccount>,
		{ readonly id: Uuid; readonly kind: "Automatic" | "Manual" }
	>
>

/** preferencesByState infers a required boolean parameter and a boolean answer field. */
export const Preference = relation("Preference", { account: uuid, enabled: pg.boolean }, [
	"account"
])
export const Settings = schema("Settings", { Preference }, [])
export const preferencesByState = query(Settings).rule((r) => {
	const { account, enabled } = v(Preference, "preference")
	return r
		.match(Preference, { account, enabled })
		.where(r.eq(enabled, r.param("enabled", pg.boolean)))
		.find({ account, enabled })
})

export type PreferenceParams = Expect<
	Equals<ParamsOf<typeof preferencesByState>, { readonly enabled: ParamType<boolean, "boolean"> }>
>

export type PreferenceHead = Expect<
	Equals<HeadOf<typeof preferencesByState>, { readonly account: Uuid; readonly enabled: boolean }>
>

/**
 * A parameter bound in a match takes the field's host type; a parameter compared with a contract field takes the
 * contract. Two uses of one name unify.
 */
export const Budget = relation("Budget", { account: uuid, cents: Cents }, ["account"])
export const Money = schema("Money", { Budget, Account }, [])
export const atLeast = query(Money).rule((r) => {
	const { account, cents } = v(Budget, "budget")
	return r
		.match(Budget, { account: r.param("account", Budget.fields.account), cents })
		.match(Account, { id: r.param("account", Account.fields.id) })
		.where(r.ge(cents, r.param("floor", Cents)), r.le(cents, 10_000n))
		.find({ account, cents })
})

export type AtLeastParams = Expect<
	Equals<
		ParamsOf<typeof atLeast>,
		{
			readonly account: ParamType<Uuid, "uuid">
			readonly floor: ParamType<bigint & Brand.Brand<"Cents">, "bigint">
		}
	>
>

/** A relation parameter is a set-valued source: an array or a Stream of facts. */
export const tasksById = query(Work).rule((r) => {
	const wanted = r.relation("ids", { id: uuid })
	const { id, kind } = v(Task, "task")
	return r.match(wanted, { id }).match(Task, { id, kind }).find({ id, kind })
})

export type TasksByIdParams = Expect<
	Equals<
		ParamsOf<typeof tasksById>,
		{
			readonly ids: ReadonlyArray<{ readonly id: Uuid }> | Stream.Stream<{ readonly id: Uuid }>
		}
	>
>

/** Comparisons are typed: no implicit coercion, no number for numeric, no contract against its base. */
export const Ledger = relation(
	"Ledger",
	{ id: uuid, amount: pg.numeric(12, 2), cents: Cents, n: pg.bigint },
	["id"]
)
export const Books = schema("Books", { Ledger }, [])
export const numericFilter = query(Books).rule((r) => {
	const { id, amount } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id, amount })
		.where(r.gt(amount, "10.50"), r.lt(amount, 100n))
		.find({ id })
})

export const badNumeric = query(Books).rule((r) => {
	const { id, amount } = v(Ledger, "ledger")
	// @ts-expect-error -- TS2345: a JavaScript number is never a numeric literal
	return r.match(Ledger, { id, amount }).where(r.gt(amount, 10)).find({ id })
})

export const badJoin = query(Books).rule((r) => {
	const { id, cents, n } = v(Ledger, "ledger")
	// @ts-expect-error -- TS2345: a contract term never meets its bare base
	return r.match(Ledger, { id, cents, n }).where(r.eq(cents, n)).find({ id })
})

export const badBinding = query(Books).rule((r) => {
	const { id, n } = v(Ledger, "ledger")
	// @ts-expect-error -- TS2322: a bigint variable does not bind a contract field
	return r.match(Ledger, { id, cents: n }).find({ id })
})

/** The same refusals with the bare base first: T is invariant, so Term<Cents> is no Term<bigint> either. */
export const badJoinReversed = query(Books).rule((r) => {
	const { id, cents, n } = v(Ledger, "ledger")
	// @ts-expect-error -- TS2345: a bare base never meets a contract term
	return r.match(Ledger, { id, cents, n }).where(r.eq(n, cents)).find({ id })
})

export const badBindingReversed = query(Books).rule((r) => {
	const { id, cents } = v(Ledger, "ledger")
	// @ts-expect-error -- TS2322: a contract variable does not bind a bigint field
	return r.match(Ledger, { id, n: cents }).find({ id })
})

/** A binding names fields of the source: the binding object is inferred, so the excess check is explicit. */
export const misspelledField = query(Books).rule((r) => {
	const { id } = v(Ledger, "ledger")
	// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
	return r.match(Ledger, { id, nope: id }).find({ id })
})

export const misspelledNegation = query(Books).rule((r) => {
	const { id } = v(Ledger, "ledger")
	// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
	const negated = r.not(Ledger, { id, bogus: 1n })
	return r.match(Ledger, { id }).where(negated).find({ id })
})

/** r.not is relational negation; its parameters join the rule's, at the bound fields' types. */
export const unpaid = query(Books).rule((r) => {
	const { id } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id })
		.where(r.not(Ledger, { id, n: r.param("n", Ledger.fields.n) }))
		.find({ id })
})
export type UnpaidParams = Expect<
	Equals<ParamsOf<typeof unpaid>, { readonly n: ParamType<bigint, "bigint"> }>
>
/** inSet takes literals of the term's type. */
export const inSetOk = query(Books).rule((r) => {
	const { id, n } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id, n })
		.where(r.inSet(n, [1n, 2n]))
		.find({ id })
})

export const inSetBad = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	// @ts-expect-error -- TS2322: a number is not a literal of a uuid field
	const listed = r.inSet(account, [1])
	return r.match(Task, { id, account }).where(listed).find({ id })
})

/** Parameters stand in every operand position opposite a term, typed by that term. */
export const computedParams = query(Books).rule((r) => {
	const { id, n } = v(Ledger, "ledger")
	return r.match(Ledger, { id, n }).find({
		id,
		g: Compute.gcd(n, r.param("g", pg.bigint)),
		l: Compute.least(n, r.param("cap", pg.bigint)),
		b: Compute.widthBucket(amount, low, high, r.param("buckets", pg.integer))
	})
})
/** width_bucket's operand and bounds are proved finite, as a guard's branch or a declaration states. */
type FiniteDecimal = Term<Decimal, unknown, unknown, "numeric", Decimal, { readonly finite: true }>
declare const amount: FiniteDecimal
declare const low: FiniteDecimal
declare const high: FiniteDecimal
export type ComputedParams = Expect<
	Equals<
		ParamsOf<typeof computedParams>,
		{
			readonly g: ParamType<bigint, "bigint">
			readonly cap: ParamType<bigint, "bigint">
			readonly buckets: ParamType<number, "integer">
		}
	>
>

/**
 * Aggregates follow PostgreSQL: SUM over a bigint contract is numeric, COUNT is bigint, MIN keeps the contract, SUM
 * over integer is bigint, AVG is numeric.
 */
export const Item = relation("Item", { id: uuid, qty: pg.integer, cents: Cents }, ["id"])
export const Shop = schema("Shop", { Item }, [])
export const totals = query(Shop).rule((r) => {
	const { id, qty, cents } = v(Item, "item")
	return r.match(Item, { id, qty, cents }).find({
		n: r.count(),
		qtySum: r.sum(qty),
		centsSum: r.sum(cents),
		centsMin: r.min(cents),
		qtyMean: r.mean(qty),
		passes: r.sum(Compute.cond(r.gt(qty, 0), Compute.literal(pg.integer, 1), 0))
	})
})

export type TotalsHead = Expect<
	Equals<
		HeadOf<typeof totals>,
		{
			readonly n: bigint
			readonly qtySum: bigint
			readonly centsSum: Decimal
			readonly centsMin: bigint & Brand.Brand<"Cents">
			readonly qtyMean: Decimal
			readonly passes: bigint
		}
	>
>

/** Unions of different headings: the element type is the discriminated union of the arm headings. */
export const Role = closed("Role", ["reported", "rejected", "omitted"])
export const Enrollment = relation("Enrollment", { assertion: uuid, role: closedId(Role) }, [
	"assertion"
])

export const RoleReported = relation(
	"RoleReported",
	{ assertion: uuid, value: str.regex("^.*$", "su") },
	["assertion"]
)

export const RoleRejected = relation("RoleRejected", { assertion: uuid, issue: uuid }, [
	"assertion"
])
export const Roster = schema("Roster", { Role, Enrollment, RoleReported, RoleRejected }, [])
export const roles = query(Roster)
	.rule((r) => {
		const { assertion } = v(Enrollment, "enrollment")
		const { value } = v(RoleReported, "roleReported")
		return r
			.match(Enrollment, { assertion, role: "reported" })
			.match(RoleReported, { assertion, value })
			.find({ assertion, role: Role.handle("reported"), value })
	})
	.rule((r) => {
		const { assertion } = v(Enrollment, "enrollment")
		const { issue } = v(RoleRejected, "roleRejected")
		return r
			.match(Enrollment, { assertion, role: "rejected" })
			.match(RoleRejected, { assertion, issue })
			.find({ assertion, role: Role.handle("rejected"), issue })
	})
	.rule((r) => {
		const { assertion } = v(Enrollment, "enrollment")
		return r
			.match(Enrollment, { assertion, role: "omitted" })
			.find({ assertion, role: Role.handle("omitted") })
	})

export type RolesHead = Expect<
	Equals<
		HeadOf<typeof roles>,
		| { readonly assertion: Uuid; readonly role: "reported"; readonly value: string }
		| { readonly assertion: Uuid; readonly role: "rejected"; readonly issue: Uuid }
		| { readonly assertion: Uuid; readonly role: "omitted" }
	>
>
/** A union's evidence is unknown: two arms can each return a row. */
export type RolesEvidence = Expect<Equals<EvidenceOfQuery<typeof roles>, Evidence.Unknown>>
/** Ordering over a union uses common fields. */
export const rolesOrdered = roles.orderBy(["role", "asc"], ["assertion", "desc"])
// @ts-expect-error -- TS2322: value is not common to every arm
export const rolesByValue = roles.orderBy(["value", "asc"])
/**
 * Matching a union with its discriminant bound narrows to one arm, so a parameter of that arm's field type may be bound
 * to an arm-only field.
 */
export const byIssue = query(Roster).rule((r) => {
	const { assertion } = v(roles, "roles")
	return r
		.match(roles, {
			assertion,
			role: "rejected",
			issue: r.param("issue", RoleRejected.fields.issue)
		})
		.find({ assertion })
})
export type ByIssueParams = Expect<
	Equals<ParamsOf<typeof byIssue>, { readonly issue: ParamType<Uuid, "uuid"> }>
>
export const byRole = query(Roster).rule((r) => {
	const { assertion } = v(roles, "roles")
	return r
		.match(roles, { assertion, role: r.param("role", Enrollment.fields.role) })
		.find({ assertion })
})

export type ByRoleParams = Expect<
	Equals<
		ParamsOf<typeof byRole>,
		{
			readonly role: ParamType<
				("reported" | "rejected" | "omitted") & Rostered<"Role">,
				"code",
				"reported" | "rejected" | "omitted"
			>
		}
	>
>

/** take(k) closes an ordered query into a set; a named k is an integer parameter. */
export const latest = tasksForAccount.orderBy(["kind", "asc"]).take("batch")
export type LatestParams = Expect<
	Equals<
		ParamsOf<typeof latest>,
		{ readonly account: ParamType<Uuid, "uuid">; readonly batch: ParamType<number, "integer"> }
	>
>

/** Imports: a parameterized query is matched through bind, which binds every parameter. */
export const perAccount = query(Work).rule((r) => {
	const { id: account } = v(Account, "account")
	const top = tasksForAccount.bind({ account })
	const { id, kind } = v(top, "top")
	return r.match(Account, { id: account }).match(top, { id, kind }).find({ account, id, kind })
})
export type PerAccountParams = Expect<Equals<ParamNamesOf<typeof perAccount>, never>>
export const perOuterParam = query(Work).rule((r) => {
	const top = tasksForAccount.bind({ account: r.param("who", uuid) })
	const { id } = v(top, "top")
	return r.match(top, { id }).find({ id })
})

export type PerOuterParams = Expect<
	Equals<ParamsOf<typeof perOuterParam>, { readonly who: ParamType<Uuid, "uuid"> }>
>

export const unbound = query(Work).rule((r) => {
	const { id } = v(tasksForAccount, "tasksForAccount")
	// @ts-expect-error -- TS2345 refusal: bind the query's parameters before matching it: Q.bind({ ... })
	return r.match(tasksForAccount, { id }).find({ id })
})
// @ts-expect-error -- TS2345: bind requires every parameter
export const partialBind = tasksForAccount.bind({})
const accountId = "0193d8f2-7c1e-7000-8000-0000000000a1"
// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
export const misspelledBind = tasksForAccount.bind({ account: accountId, acount: accountId })

/** A rule matches only relations of its schema: Settings does not hold Task. */
export const foreign = query(Settings).rule((r) => {
	const { id } = v(Task, "task")
	// @ts-expect-error -- TS2345 refusal: the relation is not in this query's schema
	return r.match(Task, { id }).find({ id })
})

/** The same holds for a query an arm attaches: it carries its schema. */
export const allPreferences = query(Settings).rule((r) => {
	const { account, enabled } = v(Preference, "preference")
	return r.match(Preference, { account, enabled }).find({ account, enabled })
})

export const foreignArmAttach = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return (
		r
			.match(Task, { id })
			.find({ id })
			// @ts-expect-error -- TS2322: an arm attaches a child over a level of its rule's schema
			.attach("preferences", () => allPreferences, "array")
	)
})

/** An interior stage is over its rule's schema, and its parameters join the rule's. */
export const interiorStage = query(Work).rule((r) => {
	const stage = r.interior((r2) => {
		const { id } = v(Task, "task")
		return r2.match(Task, { id, account: r2.param("account", Task.fields.account) }).find({ id })
	})
	const { id } = v(stage, "stage")
	return r.match(stage, { id }).find({ id })
})

export type InteriorParams = Expect<
	Equals<ParamsOf<typeof interiorStage>, { readonly account: ParamType<Uuid, "uuid"> }>
>

/** Recursive relations: an explicit row signature, typed self. */
export const Edge = relation("Edge", { from: uuid, to: uuid }, ["from", "to"])
export const Graph = schema("Graph", { Edge }, [])
export const reachable = query(Graph).recursive("Reach", {
	row: { from: uuid, to: uuid },
	base: [
		(r) => {
			const { from, to } = v(Edge, "edge")
			return r.match(Edge, { from: r.param("start", Edge.fields.from), to }).find({ from, to })
		}
	],
	rec: [
		(r, self) => {
			const step = v(Edge, "edge")
			const prior = v(self, "self")
			return r
				.match(self, { from: prior.from, to: prior.to })
				.match(Edge, { from: prior.to, to: step.to })
				.find({ from: prior.from, to: step.to })
		}
	]
})

export type ReachableHead = Expect<
	Equals<HeadOf<typeof reachable>, { readonly from: Uuid; readonly to: Uuid }>
>
export type ReachableParams = Expect<
	Equals<ParamsOf<typeof reachable>, { readonly start: ParamType<Uuid, "uuid"> }>
>

/** The shipped values have the public signatures themselves: no declare-only twin stands in for them. */
export type QueryIsTheConstructor = Expect<Equals<typeof query, QueryConstructor>>
export type VIsTheConstructor = Expect<Equals<typeof v, VConstructor>>
