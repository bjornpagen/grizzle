/** The documents world as a template, which test/pg/substrate/installs.test.ts seats on. */

import { ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { worldTemplate } from "#test/support/worlds/execute/template.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"

/**
 * The docs world installed once per member (worlds/execute/template.ts worldTemplate), each case realizing its layers
 * and sessions over a clone of it.
 */
export const docsWorld = worldTemplate({
	budget: templateNeedBudget,
	declaredIn: import.meta,
	name: "sessions",
	install: docsInstall,
	ambient: ordinarySession
})
