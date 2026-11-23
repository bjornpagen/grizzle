/**
 * A probe of a relation's added rows is pruned where a sibling of its arm covers it through one of the schema's
 * containments (analysis/theory/query.ts `covered`): a stored match S of the arm, S[F] ⊆ R[G] stated or composed, every
 * field the arm reads of R a field of G at the variable S binds at its pair, S itself covered by no match of the arm,
 * and through a definition of several rules only where its every arm reads R so and under no negation. Every committed
 * state holds the containment, so a fact the arm gains through an added row of R beside a row of S that stood held
 * before, an R row that stood agreeing with the added one at every field read; and where S's row is one the
 * transaction added, S's probe reads it. The ledger's "Human within maximum" over HumanOperatorValue ⊆ Attempt is so
 * pruned of its probe of Attempt's added rows, a statement of 330 KB every learner's answer planned at COMMIT.
 *
 * On PostgreSQL 19, over Cover (rule-cover.fixtures.ts): six checks over derived relations, R covered at its key by S
 * (Direct), by S through a definition of two rules (Defined) and by T through T ⊆ S ⊆ R, a composition (Chained); R's
 * cap, which no containment pins (Capped); R read under two negations inside a definition of two rules (Negated); U and
 * V, each read at its key alone, each contained in the other (Cycled).
 *
 * - **coveredProbes**: a schedule of direct SQL transactions at SERIALIZABLE, each judged at its end against every law's
 *   whole check (each rule's violation query over every fact, lowered by the oracle baseline, which reads no probe, and
 *   each containment's rows of its source its target lacks): the judge and the deferred foreign keys refuse exactly the
 *   states a law breaks, naming one it breaks, and commit the others; the verdict the judge gave with every probe kept.
 *   And the judge's statements read the added rows of exactly the relations coverage keeps for each rule
 *   (rule-cover.fixtures.ts `coverage`). Each situation is required, a constructed case aiming at each.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	coverage,
	coverFeatures,
	coverSpace,
	coverTemplate,
	runSchedule
} from "#test/pg/laws/rule-cover.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge whose probes coverage prunes refuses exactly the transactions whose state a law's whole check finds broken.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbeACoveringContainmentPrunesBreaksNoVerdictOfItsRule = property.explore(
	coverSpace,
	{
		needs: { cover: Substrate.fresh(coverTemplate) },
		situations: coverFeatures,
		check:
			({ cover }, c) =>
			(schedule) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* cover
					coverage(value)
					const session = yield* substrate.session({ ...ownerSession(), label: "cover" })
					yield* runSchedule(value, substrate.admin, session, schedule, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "every law's whole check, each rule's violation query lowered by the oracle baseline and each containment's unmatched rows, read on the state: the judge refuses exactly the states one finds broken, naming a law it finds broken; and the probes read the added rows coverage keeps"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\t\t(t) => t !== s && t.kind === "stored" && covers(t, s, s.relation, containments)',
				replacement:
					'\t\t\t\t(t) => t === s && t !== s && t.kind === "stored" && covers(t, s, s.relation, containments)',
				why: "A sibling covered in turn still covers: U and V, each contained in the other, prune each other's probe, and a transaction adding U's and V's rows at a key where X's value stands over the bound is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\t\t.some((o) => o.relation === relation) &&",
				replacement: "\t\t\t\t\t\t.some((o) => o.relation === relation && false) &&",
				why: "A definition that reads R under a negation still covers R: Negated's probe of R's added rows is pruned, and a row of R that unblocks Unblocked beside S's row over the bound is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tfor (let at = 0; at < containments.length; at++) {",
				replacement: "\tfor (let at = containments.length; at < containments.length; at++) {",
				why: "The containments are the stated ones alone, never composed: T ⊆ S ⊆ R gives no T ⊆ R, and Chained keeps its probe of R's added rows, which T's rows pin."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\t\tv !== undefined && c.pairs.some((p) => p.to === field && varOf(s.bindings[p.from]) === v)",
				replacement: "\t\t\tv !== undefined && c.pairs.length > 0",
				why: "Any field read of R at any variable counts as pinned: Capped's probe of R's added rows is pruned though S pins no cap, and R's row replaced at its key under a cap below S's score is accepted."
			}
		]
	}
)
