/**
 * Every check the compiler proves a write's rows cannot break emits nothing (analysis/theory/query.ts coverOf): a probe
 * of the rows a write adds to a relation R is pruned at an occurrence a sibling of its arm covers, at any depth, through
 * one of the schema's containments, stated or composed, S[F] ⊆ R[G], each stored match covered by one sibling, assigned
 * in the arm's order so that no chain of covers reaches back to it (`assignedCovers`):
 *
 * - **every field read** (Cover `read`): every field the occurrence reads of R a field of G at the variable S binds at
 *   its pair, through a definition of several rules only where its every arm reads R so and under no negation. Every
 *   committed state holds the containment, so a fact the arm gains through an added row of R beside a row of S that
 *   stood held before, an R row that stood agreeing with the added one at every field read; and where S's row is one
 *   the transaction added, S's probe reads it. The ledger's "Human within maximum" over HumanOperatorValue ⊆ Attempt
 *   is so pruned of its probe of Attempt's added rows, a statement of 330 KB every learner's answer planned at COMMIT.
 * - **a fresh key** (Cover `fresh`): R closed, and the fields of a key of R among G, each at S's variable, at every
 *   occurrence of R the match reads, through definitions and the groups of a fold, the occurrence reading any other
 *   field. A row of S that stood met a row of R at the key before the transaction, and no served write removes a row of
 *   a closed relation, so a row R gains is one of a new key, whose children the same write creates if any: a fact
 *   through it beside a row of S that stood is none. qti-pie's "Suspended in time" over a new sitting, a new candidate
 *   session and new item sessions (metis's start, `gw3sd`, `wkqjk`, `2zyad`, edullm's plan contract 4) is so pruned of
 *   each probe of their added rows. A mutable R is covered at no key: a row it gains at a key S pins may replace the
 *   one that stood there.
 *
 * On PostgreSQL 19, over Cover (rule-cover.fixtures.ts): a learner's mutable rows (Direct, Capped, Chained, Cycled,
 * Defined, Negated) and closed ones (Mixed, Crossed), and a sitting's closed rows (Paused, Lapsed, Booked), each rule a
 * check over a derived relation.
 *
 * - **coveredProbes**: a schedule of direct SQL transactions at SERIALIZABLE, each judged at its end against every law's
 *   whole check (each rule's violation query over every fact, lowered by the oracle baseline, which reads no probe, and
 *   each containment's rows of its source its target lacks), the oracle of every elision: the judge and the deferred
 *   foreign keys refuse exactly the states a law breaks, naming one it breaks, and commit the others. And the judge's
 *   statements read the added rows of exactly the relations no cover spares for each rule, each spared relation
 *   recorded with its covers, no capture writes the inserts of a closed relation every probe of which is covered, and
 *   none the removed rows of a closed relation (rule-cover.fixtures.ts `coverage`). Each situation is required, a constructed case
 *   aiming at each.
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
 * The judge whose probes a sibling's cover prunes refuses exactly the transactions whose state a law's whole check finds
 * broken, and holds no block, statement or capture of a probe the compiler proved.
 *
 * Its budget is the runner's, as its suite's was.
 */
export const aCheckTheCompilerProvesEmitsNothingAndTheJudgeBreaksNoVerdict = property.explore(
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
			name: "every law's whole check, each rule's violation query lowered by the oracle baseline and each containment's unmatched rows, read on the state: the judge refuses exactly the states one finds broken, naming a law it finds broken; and the probes read the added rows no cover spares, with no capture of a closed relation every probe of which is covered and none of a closed relation's removed rows"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\tif (proofs.kind === "none") {',
				replacement: '\t\tif (proofs.kind === "none" || proofs.kind === "facts") {',
				why: "No cover at all, every check the compiler proved judged anyway: Direct's, Defined's and Chained's probes read R's added rows and Paused's read Session's, Visit's, Item's and Test's, every insert of Test and Item captured, though a sibling's rows already guarantee them."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\tside === "added" && memo.cover(arm, m) !== undefined\n\t\t? []\n',
				replacement:
					'\tside === "added" && memo.cover(arm, m) !== undefined\n\t\t? matchTouches(m, relation, side, depth, memo, loc)\n',
				why: "A covered occurrence is probed anyway inside a side another occurrence keeps: Mixed_within's probe of Kin's added rows holds its rule beside Kid's row too, the statement of a check Kid's rows already guarantee."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\t\tat((o) => yieldsAt(o.yields, "positive") && o.under === undefined),',
				replacement: '\t\t\tat((o) => yieldsAt(o.yields, "positive")),',
				why: "Every covered occurrence is still captured on the side of what a write adds, though no probe reads it: each insert of Test and Item writes a delta and arms the judge for no block."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\tif (cover === undefined || reaches(s, m)) {",
				replacement: "\t\t\tif (cover === undefined) {",
				why: "A cover whose chain reaches back to the match it covers: U and V, each contained in the other, prune each other's probe, and a transaction adding U's and V's rows at a key where X's value stands over the bound is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\teveryRead({ matches: [], negated: a.negated })",
				replacement: "\teveryRead({ matches: [], negated: [] })",
				why: "A definition that reads R under a negation still covers R: Negated's probe of R's added rows is pruned, and a row of R that unblocks Unblocked beside S's row over the bound is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tfor (let at = 0; at < containments.length; at++) {",
				replacement: "\tfor (let at = containments.length; at < containments.length; at++) {",
				why: "The containments are the stated ones alone, never composed: T ⊆ S ⊆ R gives no T ⊆ R, and Chained keeps its probe of R's added rows, which T's rows pin, as Paused keeps Session's, which Pause pins through Visit."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\tconst pinned = (field: string, v: string): boolean => pin(field) === v",
				replacement:
					"\t\tconst pinned = (field: string, v: string): boolean => pin(field) !== undefined",
				why: "A field the containment pairs counts as pinned at any variable: Crossed's probe of Kin's added rows is pruned though Kid binds its group at Kin's key, not its own key, and a row of Kin at a group a row of Kid stood in, its cap over the bound, is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\tconst asked = pinning.kind === "read" ? Object.keys(m.bindings) : pinning.key',
				replacement: '\t\t\tconst asked = pinning.kind === "read" ? Object.keys(m.bindings) : []',
				why: "A key's cover asks no field of the occurrence: Crossed's Kin, read at Kid's group, and Lapsed's fold, which keeps no candidate session, are covered, so a row of Kin at a stood Kid's group over the bound, and a visit begun after the deadline beside another's pause, are accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\t\t\t? m.groups.body.every((b) =>\n\t\t\t\t\t\tthrough(b, (h) => (m.groups.keys.includes(h) ? m.bindings[h] : undefined))\n\t\t\t\t\t)\n",
				replacement: "\t\t\t\t? true\n",
				why: "A fold's groups count as pinned whatever its body reads: Lapsed's fold of the sitting's visits, grouped at the sitting alone, is covered by Pause, and a visit begun after the deadline beside another's pause is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\tbetween: (from, to) => bySource.get(from)?.get(to) ?? [],",
				replacement: "\t\t\tbetween: (from, to) => bySource.get(to)?.get(from) ?? [],",
				why: "A containment read the wrong way round, its target pinning its source: Paused's Pause is covered by Visit, and a pause added to a visit that stood, begun after the deadline, is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\tif (keyed !== undefined || !laws.closed(relation)) {",
				replacement: "\t\tif (keyed !== undefined) {",
				why: "A mutable relation is covered at a key a sibling pins: Capped's probe of R's added rows is pruned by S's pin of R's key, and R's row replaced at the key under a cap below S's score is accepted."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\tproofs.kind === "facts" && proofs.facts.closed(relation)\n',
				replacement: '\t\tproofs.kind === "facts"\n',
				why: "Every relation's removed rows go unread, as a closed relation's do: Negated's probes read no dependence W withdraws, which unblocks its facts."
			}
		]
	}
)
