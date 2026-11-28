/** What the properties of share.test.ts read: its spaces, models and helpers. */

import { element } from "@bjornpagen/testing/gen"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { Q, T, Task } from "#test/support/unit/lower/conservative/fixtures.ts"

type Param = "account" | "other"

/** The tasks of the account a parameter names, projected to their ids: a projection over one compared parameter. */
export const tasksOf = (q: Q, param: Param) => {
	const m = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { id: "id", account: "account" },
			constants: { account: q.param(param, T.uuid, "compare") }
		}
	])
	return q.project(m, [["id", "id"]], conservativeMeta)
}

export const params = element<Param>(["account", "other"])
