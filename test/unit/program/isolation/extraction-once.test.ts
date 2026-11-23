/**
 * Certification extracts each compiled write's isolation facts once (program/isolation/certification.ts WriteFacts):
 * the round that judges its role reads them (isolationInput), a lowering reads its role's SERIALIZABLE form's, and the
 * fence that locks what a login's write writes reads that write's again (exclusionOf), each from the one extraction,
 * where at hub 74dc1011f the fence extracted them afresh from the write's statements. On edullm's qti at 74dc1011f
 * GENMEM's split of the heap 48 s into certification (perf/perf-phys/qti-cert-holders-tip.md) held one statement's ~119
 * MB of facts twice. The work is counted (test/support/kernel/calls.ts): the calls of extractedFacts, each one
 * extraction of one compiled write.
 *
 * The box, drawn: G3's fenced shape over one published relation, one
 * login of a writer, whose gate insert runs or not, a publisher of one to all three of a replace (deleting and inserting
 * what the learner references, which generate fences), a removal and a publish gated on Gate's absence (SERIALIZABLE),
 * and a learner inserting what it sees, compiled for READ COMMITTED as generate compiles it (readCommittedChanges),
 * then certified.
 *
 * Oracle: a model of what certification reads: each READ COMMITTED write of a formed role, which the first round judges,
 * and each write of a role's SERIALIZABLE form, of a role it lowers or of one with no READ COMMITTED form, which it
 * judges from its lowering on; each extracted once.
 *
 * Features: a login fenced; a role lowered; a role with no READ COMMITTED form; a role certified READ COMMITTED.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { silentPhases } from "#compiler/core/phase.ts"
import { certification } from "#compiler/program/isolation/certification.ts"
import { readCommittedChanges } from "#compiler/program/workload/change.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { fencedLoginOf, drawnGen } from "#test/unit/program/isolation/extraction-once.fixtures.ts"
import { entriesOf } from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation =
	| "a login fenced"
	| "a role lowered"
	| "a role with no READ COMMITTED form"
	| "a role certified READ COMMITTED"

/** Certification extracts each compiled write's facts once, however many rounds, lowerings and fences read them. */
export const certificationExtractsEachCompiledWritesFactsOnceHoweverManyRoundsLoweringsAndFencesReadThem =
	property.explore(drawnGen, {
		needs: {},
		budget: { runs: 30, steered: 30 },
		situations: [
			"a login fenced",
			"a role lowered",
			"a role with no READ COMMITTED form",
			"a role certified READ COMMITTED"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.gen(function* () {
				const login = fencedLoginOf(drawn)
				const roles = succeeded(readCommittedChanges(login, silentPhases), "the login's compile")
				const [certified, counts] = yield* callCounts(
					Effect.sync(() =>
						succeeded(certification(login.artifacts, new Map([["app", roles]])), "certification")
					),
					{
						extractions: {
							file: "packages/engine/src/program/isolation/certification.ts",
							name: "extractedFacts"
						}
					}
				)
				const served = certified.served.get("app")
				assert.ok(served !== undefined, "the login is served")
				let expected = 0
				for (const [name, compiled] of roles) {
					const certificate = Arr.findFirst(certified.certificates, (r) => r.role === name)
					assert.ok(certificate._tag === "Some", `role ${name} certified`)
					const level = certificate.value.certificate.level
					const form = served.get(name)
					assert.ok(form !== undefined, `role ${name} served`)
					const writes = (changes: typeof compiled.changes | typeof form): number =>
						Arr.flatMap([...changes.members.values()], entriesOf).length
					if (compiled.kind === "formed") {
						expected += writes(compiled.changes)
					}
					if (level === "serializable") {
						expected += writes(form)
						c.note(
							compiled.kind === "formed" ? "a role lowered" : "a role with no READ COMMITTED form"
						)
					} else {
						c.note("a role certified READ COMMITTED")
					}
				}
				assert.equal(
					counts.extractions,
					expected,
					"one extraction for each READ COMMITTED write of a formed role and each write of a SERIALIZABLE form"
				)
				if (certified.fences.length > 0) {
					c.note("a login fenced")
				}
			}),
		oracle: {
			kind: "specification",
			name: "what certification reads: each formed role's READ COMMITTED writes and each SERIALIZABLE form's writes, each once"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/certification.ts",
				original:
					"\t\treturn this.#facts.getOrInsertComputed(write, () => extractedFacts(name, write, names))\n",
				replacement: "\t\treturn extractedFacts(name, write, names)\n",
				why: "Each read extracts afresh, as at 74dc1011f: a fenced login's writes are extracted again for the lock of what they write, and the property fails."
			}
		]
	})
