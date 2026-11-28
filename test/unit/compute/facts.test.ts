/**
 * A contract's facts are exactly the ones its `proves` declares, over drawn contracts: a base (an integer, a bigint or
 * a numeric typmod), a predicate that is a conjunction of comparisons of its value with small literals, and a
 * declaration among the facts.
 *
 * The oracle for what a predicate implies is a host table of each comparison's facts over every value it admits
 * (atomFacts), independent of the bound domain: a conjunction implies what any of its comparisons does, and an integer
 * is finite by its type. A declaration compiles exactly when the predicate implies every fact it names, and is refused
 * at its `proves` otherwise. A partial operation over a term of a contract that compiles, a column or a parameter, is
 * admitted exactly when the contract declares the fact it needs or its base has it, and refused naming that fact
 * otherwise: by the declaration to add (GuardTest proves) where the predicate implies the fact and the operation reads
 * the contract's own term, an exact widening of it included, else by the scalar guard of the fact. A conditional of
 * the contract's terms is an operation's result, as its TypeScript type states: it has its SQL type's facts alone (an
 * integer is finite), whatever its branches declare, and no declaration remedies its refusal.
 *
 * Features: each base, each operand form, a declared fact a conditional drops, each fact admitted by its declaration,
 * refused naming its declaration, and refused naming its guard, finite by its type, and a declaration compiled and one
 * refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { computeCore, scalarTerm } from "#compiler/scalar/compute/builders.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { referencePatterns } from "#test/support/oracle/reference/evaluate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	param,
	spelledExpr,
	testDeclaringContract,
	v
} from "#test/support/unit/compute/support.ts"
import {
	caseGen,
	type Feature,
	guardKinds,
	impliedFacts,
	operation,
	predicateOf,
	situations
} from "#test/unit/compute/facts.fixtures.ts"

/** A contract's facts are exactly the facts its proves declares, each of which its predicate implies. Its budget is its suite's before it was a property (test/unit/compute/facts.test.ts at 4ca3036a): 400 runs and 600 steered cases. */
export const aContractsFactsAreExactlyTheFactsItsProvesDeclaresEachOfWhichItsPredicateImplies =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 400, steered: 600 },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, c: Case<Feature>) =>
			({ base, atoms, declared, needs, form }) =>
				Effect.sync(() => {
					c.note(`over ${base.name}`)
					const name = `Facts_${base.name}`
					const implied = impliedFacts(base, atoms)
					const predicate = predicateOf(atoms, base)
					const table = contractPredicateTable(
						spelledExpr(
							predicate(scalarTerm({ kind: "value" }, base.field.scalar, base.field)).expr
						),
						base.field.scalar,
						name,
						declared,
						{
							loc: SourceLoc(`contract ${name}`, []),
							fieldType: (desc, at) => scalarTypeOf(desc, bareEnv, at),
							patterns: referencePatterns()
						}
					)
					const sound = Arr.every(declared, (f) => implied.includes(f))
					if (!sound) {
						c.note("a declaration its predicate does not imply, refused")
						if (table.ok) {
							return assert.fail(
								`contract ${name} declares ${Arr.join(declared, ", ")}, its predicate implies only ${Arr.join(implied, ", ")}`
							)
						}
						const refusal = table.error.reason
						if (refusal._tag !== "MalformedDescription") {
							return assert.fail(`a MalformedDescription at proves, not ${refusal._tag}`)
						}
						assert.deepEqual(refusal.at.path, ["proves"])
						return
					}
					assert.ok(
						table.ok,
						`contract ${name}'s declaration of facts its predicate implies compiles`
					)
					c.note("a declaration its predicate implies, compiled")
					c.note(`over a ${form}`)
					const contract = testDeclaringContract(name, base.field, predicate, declared)
					const column = v("x", contract)
					const x =
						form === "column"
							? column
							: form === "parameter"
								? param("x", contract)
								: computeCore.cond(computeCore.eq(column, column), column, column)
					const vars: Readonly<Record<string, LeafBinding>> = {
						x: { kind: "column", type: contract.scalar }
					}
					const op = operation(needs, base, x)
					const lowered = lowerWith("query", spelledExpr(op.term.expr), vars, false, baseParams)
					const byType = base.finite && needs === "finite"
					const declares = declared.includes(needs)
					if (byType || (declares && form !== "conditional")) {
						c.note(byType ? "finite by its type" : `${needs} admitted by its declaration`)
						assert.ok(lowered.ok, `${needs} over contract ${name}, which has it, is admitted`)
						return
					}
					if (lowered.ok) {
						return assert.fail(
							`${needs} over a ${form} of contract ${name}, which declares ${Arr.join(declared, ", ")}, is refused`
						)
					}
					if (declares) {
						c.note("a declared fact a conditional drops")
					}
					const reason = lowered.error.reason
					if (reason._tag !== "PartialOperation") {
						return assert.fail(`a PartialOperation for ${needs}, not ${reason._tag}`)
					}
					assert.equal(reason.precondition, needs)
					if (form !== "conditional" && op.direct && implied.includes(needs)) {
						c.note(`${needs} refused, its declaration named`)
						assert.deepEqual(reason.guard.remedy, { kind: "proves", contract: name })
						return
					}
					c.note(`${needs} refused, its guard named`)
					assert.equal(reason.guard.remedy.kind, guardKinds[needs])
				}),
		oracle: {
			kind: "specification",
			name: "a host table of each comparison's facts over every value it admits (atomFacts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/total.ts",
				original: "\t\tconst unproved = unprovedFact(base, owned, facts)",
				replacement: "\t\tconst unproved = unprovedFact(base, owned, [])",
				why: "A contract's declaration compiles whatever its predicate implies, its declared facts never proved; the facts property fails."
			}
		]
	})
