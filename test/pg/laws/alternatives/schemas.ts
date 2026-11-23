import {
	alternatives,
	closed,
	f,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { openedDescs } from "#test/support/open.ts"

const Stage = closed.ordered("Stage", ["draft", "approved", "paid", "voided"])
const Run = relation(
	"Run",
	{ tenant: f.integer, id: f.integer, stage: f.closedId("Stage"), note: f.wildcard },
	["tenant", "id"]
)

const Payment = relation("Payment", { tenant: f.integer, run: f.integer, amount: f.integer }, [
	"tenant",
	"run"
])

const Voiding = relation("Voiding", { tenant: f.integer, run: f.integer, reason: f.wildcard }, [
	"tenant",
	"run"
])

const runStage = alternatives(Run, "stage", Stage, { paid: Payment, voided: Voiding })

/**
 * Ledger: a partial arm map over a composite parent key, `alternatives(Run, "stage", Stage, { paid: Payment, voided:
 * Voiding })` with `draft` and `approved` unarmed, one statement whose expansion is every arm's forward containment and
 * every armed handle's reverse one, each a native foreign key (fin.md §7). `mutable` opens every relation, each inside
 * the unit of its tenant (test/support/open.ts openedDescs), which adds its UPDATE events.
 */
export const ledger = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Ledger",
	relations: [Stage, Run, Payment, Voiding],
	statements: [runStage, ...(options.mutable ? openedDescs([Run, Payment, Voiding]) : [])],
	bases: []
})
