/**
 * Every relation grizzle stores states its facts to isolation certification (program/isolation/input.ts relationFacts):
 * a stored canonical relation of an import (analysis/derived/canonical.ts), `__canonical_<digest>`, which no declaration
 * names, beside every relation the owned schema states. A write whose upkeep keeps such a relation writes its table, and
 * a read whose form stands in it reads its table by reference (ir/derived.ts servedDag), so the member's facts name it
 * (program/isolation/member-facts.ts extractNames, which resolves a stored derived relation's table to its name). Before,
 * the installation stated facts only of the relations its owned schema declared, so each such role failed `facts` by
 * the canonical relation: edullm's pantry generate at qti-pie 3ab19845 (lane LEDGER-VALUECELL's repin onto bab85796)
 * reported "facts 2", __canonical_6f6bf243b1e97b31 and __canonical_948062b0814e796f, "the installation states no fact
 * of it".
 *
 * The box: the schema of test/pg/derived/canonical-grants.fixtures.ts, whose join of a place with its note is an
 * anonymous stored canonical relation the live relation Linked imports, and one role whose change member inserts a
 * place or a note, each read by the join, or a link it reads back through Linked, compiled for READ COMMITTED as
 * generate compiles it, then certified.
 *
 * Oracle: the specification: the login installs the canonical relation stored, and no reason the certificate gives is
 * `facts` or names an object the certifier reads no fact of (`?...`).
 *
 * Features: each write.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { isCanonicalName } from "#compiler/analysis/derived/canonical.ts"
import { reasonsOf } from "#compiler/core/certificate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { certification } from "#compiler/program/isolation/certification.ts"
import { readCommittedChanges } from "#compiler/program/workload/change.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	canonicalLoginOf,
	type Write,
	writeGen
} from "#test/unit/program/isolation/canonical-facts.fixtures.ts"

/** A role whose writes keep or read a stored canonical relation of an import is certified over that relation's facts. */
export const aRoleWhoseWritesKeepOrReadAStoredCanonicalRelationIsCertifiedOverItsFacts =
	property.exhaust(finite(writeGen), {
		box: "one role over a stored anonymous canonical join, its change member an insert of a place or of a note the join reads, or of a link read back through the live relation that imports the join",
		needs: {},
		situations: ["a place", "a note", "a link read back through Linked"] satisfies ReadonlyArray<
			Reached<Write>
		>,
		check: (_, c: Case<Write>) => (write: Write) =>
			Effect.sync(() => {
				c.note(write)
				const login = canonicalLoginOf(write)
				assert.ok(
					Arr.some(login.artifacts.derived.order, (d) => isCanonicalName(d.name)),
					"the join is a stored anonymous canonical relation"
				)
				const roles = succeeded(readCommittedChanges(login, silentPhases), "the login's compile")
				const certified = succeeded(
					certification(login.artifacts, new Map([["app", roles]])),
					"certification"
				)
				for (const { role, certificate } of certified.certificates) {
					const reasons = certificate.level === "serializable" ? reasonsOf(certificate.why) : []
					assert.deepEqual(
						Arr.filter(
							reasons,
							(r) =>
								r.condition === "facts" ||
								(r.at.kind !== "role" && Str.startsWith("?")(r.at.relation))
						),
						[],
						`role ${role} (${write}): no reason names a relation the certifier reads no fact of`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "every relation a write keeps or reads, a stored canonical relation of an import among them, stated to certification"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/input.ts",
				original: "\t\t\tisCanonicalName(d.name) ? [factsOf(d.name, derivedInserts)] : []\n",
				replacement: "\t\t\t[]\n",
				why: "The installation states the facts of its declared relations alone, as before: every write fails `facts` by the stored join, `__canonical_<digest>`, the rule over Linked's witness reading it by its name, as qti-pie's pantry generate reported two; the property fails."
			},
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original: "\t\tfor (const { name } of anonymousTables(world.checked)) {\n",
				replacement: "\t\tfor (const { name } of anonymousTables(world.checked).slice(0, 0)) {\n",
				why: "The extractor names no canonical relation's whole view: the link's read-back of Linked, which reads the join through the view the role is granted, fails `facts` by the view's unresolved name; the property fails."
			}
		]
	})
