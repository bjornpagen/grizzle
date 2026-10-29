import {
	capacity,
	closed,
	closedId,
	contained,
	contract,
	derived,
	login,
	on,
	pg,
	query,
	ref,
	relation,
	role,
	schema,
	str,
	uuid,
	v,
	within
} from "#index.ts"

/**
 * The schemas the public API fixtures share: a Work schema with a containment, a capacity and a recursive Edge relation,
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
export const Pool = relation("Pool", { id: uuid, seats: pg.bigint }, ["id"])
export const Claim = relation("Claim", { id: uuid, pool: uuid, task: uuid }, ["id"])
export const Edge = relation("Edge", { from: uuid, to: uuid }, ["from", "to"])

export const Work = schema("Work", { Kind, Account, Task, Pool, Claim, Edge }, [
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Claim, "pool"), on(Pool, "id")),
	capacity(on(Pool, "id"), { from: on(Claim, "pool"), within: within(0n, ref("seats")) })
])

export const WorkReader = role(Work, "reader", Work.relations)
export const WorkWriter = role(Work, "writer", Work.relations, { write: ["Task", "Claim", "Edge"] })
export const WorkLogin = login(Work, "server", [WorkReader, WorkWriter])

/** One fact per account with tasks: AccountCost is keyed by account, its group term. */
export const accountCost = query(Work).rule((r) => {
	const { id, account, cost } = v(Task)
	return r.match(Task, { id, account, cost }).find({ account, total: r.sum(cost) })
})
export const AccountCost = derived("AccountCost", accountCost)

export const Reports = schema.extend(Work, { AccountCost }, [])

export const Reporter = role(Reports, "reporter", Reports.relations)
export const Refresher = role(Reports, "refresher", Reports.relations, { refresh: ["AccountCost"] })
export const ReportsLogin = login(Reports, "server", [Reporter, Refresher])
