import { query, v } from "#compiler/public/query.ts"
import { derived, schema } from "#compiler/public/schema.ts"
import { Deliver } from "#test/support/agreement/schema.ts"

/**
 * The extension of Deliver (./schema.ts) the attachment agreement (./attachments.ts) draws a derived parent from:
 * AccountTally, each account's count of tasks, keyed by the account it groups by. No law touches a derived relation,
 * so no containment of Deliver reaches it: an attachment from it into Account is licensed by Account's key alone.
 */
const { Task } = Deliver.relations

export const AccountTally = derived.materialized(
	"AccountTally",
	query(Deliver).rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).find({ account, tasks: r.count() })
	})
)
export const Tallies = schema.extend(Deliver, { AccountTally }, [])
