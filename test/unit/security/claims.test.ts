/**
 * The host claims decoder (packages/grizzle/src/adapter/db/claims.ts tokenFacts, then claimsOf) decodes a verified payload exactly as
 * docs/access.md "Permissions" and "Security model" say, over the shapes a `verify` can return that JSON cannot: a claim or a
 * field on the payload's prototype chain rather than its own, a getter, a getter whose read throws, a non-object claim.
 * The worlds model's host decoder (test/support/worlds/model/session/claims.ts payloadFacts) is the specification,
 * written apart from the implementation; a payload whose reading does not throw must decode through grizzle to exactly
 * the facts the model reads, and refuse exactly when the model does, and one whose reading by the model throws, at a
 * claim field or at the claim object itself, must be refused as a ClaimRefused, never escaping as a defect.
 *
 * The attacker never holds a token's signature (the login is the boundary), so the hostile input here is the object
 * `verify` returns, not a signed claim: the suite's value over the worlds errors suite, which drives only JSON-text
 * tokens end to end, is the non-JSON object shapes and the own-versus-inherited placement the end-to-end suite never
 * draws. A context reads its fields from the payload's own top level or own claim object, so an inherited claim or
 * field is no fact; grizzle must read the same own properties the model reads, and no inherited one.
 *
 * The role is the documents base's `member`, whose relations read Session (a text subject at the top level) and Tenant
 * (a uuid organization and an int8 seat count in the claim object `t`). A refined claim (the subject's pattern) is
 * PostgreSQL's to judge after admission, so the host decoder admits it; the model marks it and the suite compares the
 * decoded facts, which are the same whether or not PostgreSQL will later refuse the pattern.
 *
 * The oracle is a second implementation, the model's host decoder. Features: every placement, value kind and verdict
 * the draw's modes reach (see `situations`).
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, Record as Rec, Result } from "effect"
import { type Claims, claimsOf, noFacts, tokenFacts } from "#adapter/db/claims.ts"
import { ClaimRefused, type ExpiryRefused } from "#adapter/errors/failures.ts"
import { docsBase } from "#test/support/worlds/model/bases/docs.ts"
import { claimsText, payloadFacts } from "#test/support/worlds/model/session/claims.ts"
import {
	drawGen,
	effective,
	type Feature,
	memberContexts,
	memberSpec,
	modeGen,
	payloadOf,
	situations
} from "#test/unit/security/claims.fixtures.ts"

/**
 * The host claims decoder decodes a verify's object to exactly the own-property facts the model reads, and refuses
 * exactly when it does.
 *
 * Budget: its suite's count before the conversion (unit/security/claims: 2000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theHostClaimsDecoderDecodesAVerifysObjectToExactlyTheOwnPropertyFactsTheModelReadsAndRefusesExactlyWhenItDoes =
	property.explore((source) => ({ mode: source.draw(modeGen), raw: source.draw(drawGen) }), {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, c: Case<Feature>) =>
			({ mode, raw }) =>
				Effect.sync(() => {
					const draw = effective(mode, raw)
					c.note(`tenant:${draw.tenantPlacement}`)
					for (const s of [...draw.session, ...draw.tenant]) {
						c.note(`field:${s.placement}`)
						c.note(`value:${s.kind}`)
					}
					const payload = payloadOf(draw)
					const grizzle: Result.Result<Claims, ClaimRefused | ExpiryRefused> = Result.map(
						tokenFacts(memberContexts, payload),
						({ facts, expiry }) => claimsOf(facts, noFacts, expiry)
					)
					const read = Option.liftThrowable(() => payloadFacts(docsBase, memberSpec, payload))()
					if (Option.isNone(read)) {
						c.note("verdict:read-throws")
						assert.ok(
							Result.isFailure(grizzle) && grizzle.failure instanceof ClaimRefused,
							"a payload whose read the model meets throwing is refused as a ClaimRefused"
						)
						return
					}
					const model = read.value
					if (model.kind === "refused") {
						c.note("verdict:refused")
						assert.ok(
							Result.isFailure(grizzle),
							"the model refuses the payload, so grizzle refuses it"
						)
						return
					}
					c.note(
						Rec.keys(model.facts).length > 1 ? "verdict:both-contexts" : "verdict:session-only"
					)
					assert.ok(
						Result.isSuccess(grizzle),
						"the model decodes the payload, so grizzle decodes it"
					)
					assert.equal(
						grizzle.success.text,
						claimsText(docsBase.contexts, {}, model.facts),
						"grizzle's claims setting is the model's facts in the setting's order"
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model's host decoder of a verified payload (model/session/claims.ts payloadFacts)"
		},
		budget: { runs: 2000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/db/claims.ts",
				original: "\tfor (const key of Rec.keys(value)) {",
				replacement: "\tfor (const key in value) {",
				why: "The decoder reads inherited enumerable members as the payload's own (adapter/db/claims.ts ownMembers walks for...in); the property fails."
			}
		]
	})
