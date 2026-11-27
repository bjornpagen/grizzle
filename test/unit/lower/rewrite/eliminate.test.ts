/**
 * R03 (lower/optimize/eliminate): a relation is eliminated only with a complete proof. Exhausted over how the catalog
 * states the containment Posting.account -> Account.id (absent, an immediate or a deferred foreign key), the evidence
 * context, whether Account has a key, and what its occurrence does beyond the key match: the Account match goes exactly
 * when an admitted containment and a key of its target prove it neither filters nor multiplies; its certificate names
 * the context its evidence holds in, the key constraint and the containment's law it rests on, as a set; and the
 * rewritten query delivers what the original does, by the reference evaluator, on every database of the candidate facts
 * the context may see under the installation (two postings of one account, a posting of no account, two accounts of
 * one id). A plain containment into Account at its key is native whatever its schema (laws/model/plan.ts
 * containmentDischarge), and a selected one gives no existence evidence, so no whole one proves a key match: a
 * containment the judge holds whole gives its law's evidence alike (test/unit/laws/model/discharge).
 *
 * Oracle: the gate's statement as a checker (a specification), and the reference evaluator's delivery (a second
 * implementation).
 *
 * Features: eliminated in each evidence context and on each kind of evidence; held back for each missing premise.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { OpId } from "#compiler/ir/expr.ts"
import {
	accountKey,
	type Containment,
	containmentsOf,
	eliminated,
	type EliminateFeature,
	type Evidence,
	fk,
	installed,
	keyMatch,
	type Match,
	seenDatabases,
	unkeyed
} from "#test/unit/lower/rewrite/eliminate.fixtures.ts"
import { nodesOf } from "#test/unit/lower/rewrite/support.ts"

/** The complete proof an Account match goes exactly when an admitted containment and a key of its target prove it neither filters nor multiplies. */
export const theCompleteProofAnAccountMatchGoesExactlyWhenAnAdmittedContainmentAndAKeyOfItsTargetProveItNeitherFiltersNorMultiplies =
	property.exhaust(
		finite((source) => ({
			containment: source.draw(element<Containment>(["none", "immediate", "deferred"])),
			evidence: source.draw(element<Evidence>(["snapshot", "transaction"])),
			match: source.draw(element<Match>(["key match", "fixes a column", "delivers payload"])),
			keyed: source.draw(boolean)
		})),
		{
			needs: {},
			situations: [
				"eliminated in snapshot",
				"eliminated in transaction",
				"eliminated on immediate evidence",
				"eliminated on committedSnapshot evidence",
				"held back: no admitted containment",
				"held back: no key of the target",
				"held back: the match does more than match a key"
			] satisfies ReadonlyArray<Reached<EliminateFeature>>,
			check:
				(_, c: Case<EliminateFeature>) =>
				({ containment, evidence, match, keyed }) =>
					Effect.sync(() => {
						const catalog = {
							...(keyed ? installed : unkeyed),
							containments: containmentsOf[containment]
						}
						const ran = eliminated(
							keyMatch(match),
							catalog,
							evidence,
							seenDatabases(containment, evidence, keyed)
						)
						const containmentAdmitted =
							containment === "immediate" || (containment === "deferred" && evidence === "snapshot")
						const found = Arr.findFirst(ran.certificates, (x) => x.rule === "R03.elimination")
						if (!containmentAdmitted) {
							c.note("held back: no admitted containment")
						} else if (!keyed) {
							c.note("held back: no key of the target")
						} else if (match !== "key match") {
							c.note("held back: the match does more than match a key")
						}
						if (!(containmentAdmitted && keyed && match === "key match")) {
							assert.deepEqual(found, Option.none())
							return
						}
						const cert = Option.getOrThrowWith(
							found,
							() => new Error("the elimination's certificate")
						)
						const expectedContext = containment === "deferred" ? "committedSnapshot" : "immediate"
						c.note(`eliminated in ${evidence}`)
						c.note(`eliminated on ${expectedContext} evidence`)
						assert.equal(cert.context, expectedContext)
						assert.deepEqual(cert.equality, [OpId("uuid_eq")])
						unorderedEqual(
							Arr.flatMap(cert.premises, (p) =>
								p.kind === "constraint"
									? [String(p.constraint)]
									: p.kind === "law"
										? [String(p.law)]
										: []
							),
							[String(accountKey), ...Arr.map(fk.laws, String)]
						)
						assert.deepEqual(
							Arr.map(nodesOf(ran.query.dag, "MatchRegion"), (r) => r.occurrences.length),
							[1]
						)
					}),
			oracle: {
				kind: "specification",
				name: "R03's complete proof, an admitted containment and a key of its target; the reference's delivery on every database the context may see"
			},
			box: "every containment statement, evidence context, key and match of the ledger's Posting and Account",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/eliminate/index.ts",
					original: "\t\tcx.ctx.evidenceContext\n\t)\n",
					replacement: '\t\t"snapshot"\n\t)\n',
					why: "R03 reads a containment's evidence as a snapshot read would, so a deferred foreign key proves existence inside a transaction; the eliminate-proof search fails."
				}
			]
		}
	)
