/**
 * What a check answers, a refusal for its reason at the place the input determines, or the checked result:
 *
 * - **A literal at a typed slot:** a literal of another host kind or outside its base's range is no literal of the
 *   base (MalformedDescription), one outside the slot's contract or language is ContractLiteral, and one within is
 *   admitted; a literal an import's bind map binds is refused at that bind entry.
 * - **A query's contracts:** one descriptor per name across the query and its schema; a name declared with two is
 *   refused as DuplicateIdentity naming one of the clashing names (test/unit/check/contracts.ts).
 * - **A fault planted in a generated query:** each fault is refused for its reason at the place it determines, and a
 *   delta planted at a stored relation's match is admitted as a ChangeSet's read-back (test/unit/check/faults.ts).
 *
 * Oracles: each slot's type restated over the literal (its host kind, its base's range, its contract and its language,
 * judged here by a regular expression where the checker runs its own automaton); one name, one descriptor, restated
 * over the declarations; and the reason and place each planted fault determines.
 *
 * Features: each slot, each verdict, each contract clash, and each fault, live, stale or wild.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { corrupted, corruptedFeature } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { queryInput } from "#compiler/program/input.ts"
import { placeOf, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { WorkDesc } from "#test/support/fixtures/ir/work.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	conflicting,
	contractCaseGen,
	type ContractFeature,
	contractFeatures,
	contractQuery,
	contractSchema
} from "#test/unit/check/contracts.ts"
import { faults, liveOf, type Planted } from "#test/unit/check/faults.ts"
import {
	answers,
	expectedOf,
	type FaultFeature,
	literalAt,
	type LiteralFeature,
	readAt,
	slotGen
} from "#test/unit/check/reasons.fixtures.ts"
import { Lab } from "#test/unit/check/schemas.ts"

/** A literal at a typed slot is no literal of another host kind or range, refused outside its contract or language, and admitted within. Its budget is its suite's before it was a property (test/unit/check/reasons.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const aLiteralAtATypedSlotIsNoLiteralOfAnotherHostKindOrRangeRefusedOutsideItsContractOrLanguageAndAdmittedWithin =
	property.explore(slotGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"Cents bound",
			"Qty bound",
			"Qty compared",
			"Qty an import binds",
			"lower-case label compared",
			"lower-case label bound",
			"admitted",
			"ContractLiteral",
			"MalformedDescription"
		] satisfies ReadonlyArray<Reached<LiteralFeature>>,
		check:
			(_, c: Case<LiteralFeature>) =>
			({ slot, value }) =>
				Effect.sync(() => {
					const { query: q, located } = literalAt(slot, value)
					const expected = expectedOf(slot, value, located)
					answers(
						checkAuthored(
							checking(slot === "Cents bound" ? WorkDesc : Lab),
							q,
							checkOptions("query")
						),
						expected,
						`${slot} ${Formatter.format(value)}`
					)
					c.note(slot)
					c.note(
						expected.kind === "admitted"
							? "admitted"
							: expected.reason === "ContractLiteral"
								? "ContractLiteral"
								: "MalformedDescription"
					)
				}),
		oracle: {
			kind: "specification",
			name: "each slot's host kind, base range, contract and language, restated over the literal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: "\treturn !holds.ok ? Result.err(holds.error) : Result.ok(holds.value === true)",
				replacement: "\treturn !holds.ok ? Result.err(holds.error) : Result.ok(true)",
				why: "A literal outside its contract is admitted, the contract's predicate evaluated and its verdict ignored (scalar/compute/evaluate.ts); the typed slot property fails."
			}
		]
	})

/** A query's contracts are one descriptor per name across the query and its schema, a name declared with two refused with that name. Its budget is its suite's before it was a property (test/unit/check/reasons.test.ts at 4ca3036a): 100 runs and 200 steered cases. */
export const aQuerysContractsAreOneDescriptorPerNameAcrossTheQueryAndItsSchemaANameDeclaredWithTwoRefusedWithThatName =
	property.explore(contractCaseGen, {
		needs: {},
		budget: { runs: 100, steered: 200 },
		situations: [
			"one name declared with two descriptors",
			"the schema's contract declared otherwise",
			"the schema's own descriptor declared again",
			"one descriptor declared twice",
			"admitted"
		] satisfies ReadonlyArray<Reached<ContractFeature>>,
		check: (_, k: Case<ContractFeature>) => (c) =>
			Effect.sync(() => {
				k.noteAll(contractFeatures(c))
				const result = checkAuthored(
					checking(contractSchema(c)),
					contractQuery(c),
					checkOptions("contracts")
				)
				const clash = conflicting(c)
				if (clash.length === 0) {
					succeeded(result, "one descriptor per name")
					return
				}
				const reason = refused(result, "DuplicateIdentity").reason
				const duplicate = reason._tag === "DuplicateIdentity" ? reason.duplicate : undefined
				const named = duplicate?.kind === "domain" ? duplicate.name : undefined
				assert.ok(
					named !== undefined && Arr.some(clash, (name) => name === named),
					`a contract of the names ${Arr.join(clash, ", ")}, not ${Formatter.format(duplicate)}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one name, one descriptor, restated over the drawn declarations (test/unit/check/contracts.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original: 'if (typeof piece !== "string") {\n\t\t\treturn piece\n\t\t}',
				replacement: "{}",
				why: 'Operator mutant b363c73c35 at packages/text/src/regex/ir.ts:403 in settle: `if (typeof piece !== "string") {    return piece   }` becomes `{}`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})

/** A fault planted in a generated query is refused with its reason at the location it determines, and the query without it is admitted. Its budget is its suite's before it was a property (test/unit/check/reasons.test.ts at 4ca3036a): 200 runs and 400 steered cases. */
export const aFaultPlantedInAGeneratedQueryIsRefusedWithItsReasonAtTheLocationItDeterminesAndTheQueryWithoutItIsAdmitted =
	property.explore(caseSketchGen, {
		needs: {},
		budget: { runs: 200, steered: 400 },
		situations: [
			"live",
			"wild an attachment binding no parent column",
			"stale an undeclared variable in a binding",
			"stale an undeclared variable in a bind map",
			"stale a delta outside a read-back",
			"wild a delta of the roster",
			"admitted as a read-back"
		] satisfies ReadonlyArray<Reached<FaultFeature>>,
		check: (_, k: Case<FaultFeature>) => (sketch) =>
			Effect.sync(() => {
				const c = k.draw(resolveCase(sketch))
				const built = buildSchema(c.schema)
				for (const read of c.reads) {
					if (read.kind !== "query") {
						continue
					}
					const desc = succeeded(
						queryInput(buildRoot(built, built.schema, read.query)),
						"the builder admits a generated read"
					).desc
					succeeded(readAt(built.schema, desc, "query"), "the live read is admitted")
					const drawnFault = k.draw(corrupted(liveOf(c, desc), faults))
					k.note(corruptedFeature(drawnFault))
					if (drawnFault.kind === "live") {
						continue
					}
					const planted: Planted = drawnFault.refusal
					const label = `${drawnFault.rule} at ${drawnFault.at}`
					const e = refused(
						readAt(built.schema, planted.desc, planted.boundary),
						planted.reason,
						label
					)
					assert.deepEqual(placeOf(refusalLoc(e)), placeOf(planted.at), `${label}: located`)
					if (planted.admittedAs !== "none") {
						succeeded(
							readAt(built.schema, planted.desc, planted.admittedAs),
							`${label}, read as a ${planted.admittedAs}`
						)
						k.note("admitted as a read-back")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the reason and location each planted fault determines (test/unit/check/faults.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/description.ts",
				original: '\t\t\t\texpr(e, childLoc(childLoc(m.loc, "bindings"), column))',
				replacement: '\t\t\t\texpr(e, childLoc(m.loc, "bindings"))',
				why: "A binding's refusal is placed at its match's bindings, not at its entry (check/description.ts); the generated query's faults property fails."
			}
		]
	})
