/**
 * The attachment agreement (test/support/agreement/attachments.ts): every drawn attachment's stated delivery admitted
 * exactly where the engine proves it from the keys the types read, a closed relation's declared keys and never its
 * facts (declaredDelivery), each refusal under its directive at its argument; where a closed relation's facts make a
 * key its declaration does not, and the engine's one child per parent rests on it, the types state an array and the
 * engine proves more, the types stricter and never looser; and each admitted attachment's records, of a snapshot read
 * and of a read-back, the engine's decoded heading under the delivery stated, a nested attachment's within its child's
 * records. Each attachment is a block of one program a batch checks disarmed. A read-back's delivery is one the engine
 * proves in the transaction context. The witnesses reach every delivery, refusal, proof and shape, a derived parent's
 * and a nested attachment's among them, and a child over no level of its parent's schema, which both refuse.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	attachAimed,
	attachCases,
	attachProgram,
	attachRequired,
	transactionFaults
} from "#test/support/agreement/attachments.ts"
import { agreement } from "#test/support/types/batch/agreement.ts"

/**
 * Over drawn attachments, the types admit a stated delivery exactly as the engine proves it, and infer the engine's
 * records under it. It runs the runner's default budget, not the pre-conversion suite's rotating count (200): at
 * TEST_SEED=777, run beside it, the default's whole process tree took 107.8 CPU-s against the old count's 109.4, both
 * reaching every situation and killing its kill
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/attachments.*.txt, 2026-11-16, load 470 to 670).
 */
export const attachments = agreement(attachAimed, {
	situations: attachRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: attachProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's proof of each drawn attachment's delivery"
	},
	kept: [
		{
			token: ReplayToken(
				"test/types/evidence/attachments.test.ts#attachments:-:4.1.0.0.0.0.1.0.0.1.0.1.0.0.0.0.0.0.0.2.0.1.0.1.1.1.1.2"
			),
			reason:
				"a self-join parent, peer's match binding `id: own.id`, and a child stated one that counts Task at `id: p.id` under `r.le(child.account, p.peerAccount)`: the engine proves it from peer's scan, whose fact holds both p.id and p.peerAccount, where the types gave p.id an origin in own's scope alone and found the child's parent variables of two scopes (a full test/types run at 463e57274; its tape restated without the arm coin a stated delivery drew, which 271ffecf2's deletion of arm(field, handle) took out)",
			since: "2026-11-19"
		},
		{
			token: ReplayToken(
				"test/types/evidence/attachments.test.ts#attachments:100.8:6.1.0.1.0.1.0.0.1.0.1.1.1.1.2.1"
			),
			reason:
				"a parent over AccountTally, Tallies' live derived relation of each account's task count, its child the Account its account keys, stated one: no law touches a derived relation, so Account's key proves at most one child per tally and the stated one is refused by the engine as by the types, where the engine read a live derived relation as an import of its definition and proved the child one from Task.account's containment into Account through it, a proof a stored AccountTally never gave (TEST_SEED=2219874524, trunk red since e1b52df00 made AccountTally live; its token restated at 271ffecf2, which deleted the arm intent, the arm coin a stated delivery drew and the arm requirements, so derived is intent 6 and one into a closed relation requirement 8)",
			since: "2026-11-24"
		}
	],
	kills: [
		{
			file: "packages/engine/src/types/query/terms.ts",
			original: "\t> extends true\n\t\t? Held<W[K], W, Os>\n\t\t: W[K]\n}",
			replacement: "\t> extends true\n\t\t? W[K]\n\t\t: Held<W[K], W, Os>\n}",
			why: "A self-joined head's variable records no scope but its own (terms.ts OneFactScopes, HeldAt), never the other scope whose fact binds it at its own field; the kept self-join's reflexive child is refused."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: "\t\t\t\t\t? HoldsOne<CommonScopes<ScopeBoxesRead<B, H, Filters>>> extends true",
			replacement:
				'\t\t\t\t\t? HoldsOne<IsOneLiteral<ScopeBoxesRead<B, H, Filters>["scopes"]> extends true ? CommonScopes<ScopeBoxesRead<B, H, Filters>> : never> extends true',
			why: "The reflexive proof asks that every parent variable the child reads be of one scope (ReflexiveOf), not that one scope hold an origin of each; the kept self-join's reflexive child is refused."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: '\treadonly one: ChildEv extends { readonly card: "one" }',
			replacement: '\treadonly one: ChildEv extends { readonly card: "atMostOne" | "one" }',
			why: "The one child is admitted where the evidence proves at most one per parent (types/evidence/evidence.ts Claims' one); the agreement's program fails."
		},
		{
			file: "packages/engine/src/query/build/state.ts",
			original: '\t\t\tdesc: { kind: "relation", name: derived.name },',
			replacement: '\t\t\tdesc: { kind: "query", query: derived.query, bind: {} },',
			why: "A rule reads a derived relation as an import of its definition (query/build/state.ts sourceInfo), so the engine proves the kept AccountTally parent's Account child one through Task.account's containment, where the types read AccountTally as a relation no law touches and refuse the stated one; the agreement's program fails."
		}
	]
})

/** A read-back's delivery of every admitted attachment is one the engine proves in the transaction context. */
export const readBackDelivery = property.explore(attachCases, {
	situations: [],
	needs: {},
	check: () => (c) =>
		Effect.sync(() => {
			assert.deepEqual(
				transactionFaults(c),
				[],
				"read-backs the transaction context does not prove"
			)
		}),
	oracle: {
		kind: "specification",
		name: "a read-back reads only what the engine proves in the transaction context"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/compute/evaluate.ts",
			original: "\tif (!member.value) {",
			replacement: "\tif (member.value) {",
			why: "Operator mutant bc066f6b77 at packages/engine/src/scalar/compute/evaluate.ts:1357 in refined: `!member.value` becomes `member.value`; the property fails (the census, lane TESTPOLICY2)."
		}
	]
})
