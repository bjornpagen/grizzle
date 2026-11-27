import {
	closed,
	eq,
	f,
	field,
	literal,
	mirrors,
	on,
	onWhere,
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

/** Each arm mirrored with the runs its stage selects: a payment's run is paid, and a paid run has its payment. */
const runStage = Object.freeze([
	...mirrors(
		on("Payment", ["tenant", "run"]),
		onWhere("Run", ["tenant", "id"], eq(field("stage"), literal("paid")))
	),
	...mirrors(
		on("Voiding", ["tenant", "run"]),
		onWhere("Run", ["tenant", "id"], eq(field("stage"), literal("voided")))
	)
])

/**
 * Ledger: a tagged header over a composite key, Run's stage, with one mirrors per arm, paid's Payment and voided's
 * Voiding, `draft` and `approved` holding no arm: each arm's containment in the runs its stage selects and the runs
 * the stage selects in the arm, each a native foreign key (fin.md §7). `mutable` opens every relation, each inside
 * the unit of its tenant (test/support/open.ts openedDescs), which adds its UPDATE events.
 */
export const ledger = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Ledger",
	relations: [Stage, Run, Payment, Voiding],
	statements: [...runStage, ...(options.mutable ? openedDescs([Run, Payment, Voiding]) : [])],
	bases: []
})
