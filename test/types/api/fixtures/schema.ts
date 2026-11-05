import {
	check,
	closed,
	closedId,
	contained,
	contract,
	counted,
	derived,
	drawn,
	fin,
	login,
	natural,
	on,
	pg,
	query,
	relation,
	role,
	schema,
	str,
	uuid,
	v
} from "#index.ts"

/**
 * The schemas the public API fixtures share: a Work schema with a containment, a pool's claims counted against its seats
 * (a counted family and a row check, fin §6's form of a capacity) and a recursive Edge relation,
 * a Reports extension with a derived relation, and their worlds: full roles that read, write and refresh, each in a
 * login. Typechecked only.
 */
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Account = relation("Account", { id: uuid, name: str.regex("^[a-z]+$") }, ["id"])
export const Task = relation(
	"Task",
	{ id: uuid, account: uuid, kind: closedId(Kind), cost: Cents },
	["id"]
)
export const Pool = relation("Pool", { id: uuid, seats: natural, claims: drawn(natural) }, ["id"])
export const Claim = relation("Claim", { id: uuid, pool: uuid, task: uuid }, ["id"])
export const Edge = relation("Edge", { from: uuid, to: uuid }, ["from", "to"])

/** A pool's claims, counted over its drawn count, which no more than its seats bound. */
export const poolClaims = counted(on(Claim, "pool"), fin(Pool, "claims"))
export const claimsWithinSeats = check("ClaimsWithinSeats", Pool, (p) => p.le(p.claims, p.seats))

export const Work = schema("Work", { Kind, Account, Task, Pool, Claim, Edge }, [
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Claim, "pool"), on(Pool, "id")),
	poolClaims,
	claimsWithinSeats
])

export const WorkReader = role(Work, "reader", Work.relations)
export const WorkWriter = role(Work, "writer", Work.relations, { write: ["Task", "Claim", "Edge"] })
export const WorkLogin = login(Work, "server", [WorkReader, WorkWriter])

/** One fact per account with tasks: AccountCost is keyed by account, its group term. */
export const accountCost = query(Work).rule((r) => {
	const { id, account, cost } = v(Task, "task")
	return r.match(Task, { id, account, cost }).find({ account, total: r.sum(cost) })
})
export const AccountCost = derived("AccountCost", accountCost)

export const Reports = schema.extend(Work, { AccountCost }, [])

export const Reporter = role(Reports, "reporter", Reports.relations)
export const Refresher = role(Reports, "refresher", Reports.relations, { refresh: ["AccountCost"] })
export const ReportsLogin = login(Reports, "server", [Reporter, Refresher])
