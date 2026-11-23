/**
 * A call of a function grizzle installs reads what grizzle knows the function reads (program/isolation/certification.ts
 * extractNames): a library function reads what its definition reads (physical/ddl/library.ts tablelessLibrary), so its
 * text digest, whose body `sha256(convert_to($1, 'UTF8'))` reads no table, reads none; and a declared function reads no
 * relation, since it runs as the installation's function owner, which holds no privilege on any (physical/ddl/functions.ts).
 * At f87b2aaab the certifier read a call of either as a function that may read any table, a relation it states no fact
 * of, so every role whose writes call one failed `facts` by it: edullm's pantry author (1 reason, the digest), the qti
 * publisher (15: the digest and 14 of ledger's declared functions) and metis's delivery writer (12: the digest, 10 of
 * ledger's and 1 of assignment's), each named `?function:"<schema>"."<name>"`.
 *
 * The box: R(b, p, d, h = Crypto.sha256(p)), keyed (b, h), (h, b), (h) or (b), and one role that inserts it from its
 * parameters, d a declared function's call or not, compiled for READ COMMITTED as generate compiles it, then certified.
 *
 * Oracle: the specification: no reason the certificate gives names an object the certifier reads no fact of, a
 * function's or a table's (`?...`), and none is `facts`.
 *
 * Features: each primary key, and a declared function's call.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { reasonsOf } from "#compiler/core/certificate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { certification } from "#compiler/program/isolation/certification.ts"
import { readCommittedChanges } from "#compiler/program/workload/change.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	digestLoginOf,
	type Drawn,
	drawnGen,
	type Primary
} from "#test/unit/program/isolation/library-reads.fixtures.ts"

/** What a case reaches: each primary key, and a declared function's call. */
type Feature = Primary | "a declared function's call"

/** A role whose writes call grizzle's text digest or a declared function is certified over facts of every object they name. */
export const aRoleWhoseWritesCallGrizzlesTextDigestOrADeclaredFunctionIsCertifiedOverFactsOfEveryObjectTheyName =
	property.exhaust(finite(drawnGen), {
		box: "R keyed by each of (b, h), (h, b), (h) and (b), inserted by one role that calls a declared function or not",
		needs: {},
		situations: [
			"(b, h)",
			"(h, b)",
			"(h)",
			"(b)",
			"a declared function's call"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawn: Drawn) =>
			Effect.sync(() => {
				const { primary, declared } = drawn
				c.note(primary)
				if (declared) {
					c.note("a declared function's call")
				}
				const login = digestLoginOf(drawn)
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
						`role ${role} (R keyed ${primary}${declared ? ", d declared" : ""}): no reason names an object the certifier reads no fact of`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a write's every object named by a relation, a function that reads none among them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/certification.ts",
				original: "\tfor (const fn of tablelessLibrary) {",
				replacement: "\tfor (const fn of tablelessLibrary.slice(0, 0)) {",
				why: "grizzle's library functions read as functions that may read any table, as at f87b2aaab: a write that digests a text fails `facts` by the digest's call; the property fails."
			},
			{
				file: "packages/engine/src/program/isolation/certification.ts",
				original: "\tfor (const fn of Object.keys(artifacts.owned.functions)) {",
				replacement: "\tfor (const fn of Object.keys(artifacts.owned.functions).slice(0, 0)) {",
				why: "Declared functions read as functions that may read any table, as at f87b2aaab: a write that calls one fails `facts` by its call; the property fails."
			}
		]
	})
