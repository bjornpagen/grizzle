/**
 * The site-free typing of a scalar description (scalar/compute/typing.ts typeOf), against the lowering of the same
 * description at every site, over generated descriptions of the whole Compute catalogue over a heading of every
 * carrier, guarded by every guard a Compute.when holds.
 *
 * - Agreement: where the lowering of a description in a query or a check succeeds, its typing, the compile's text
 *   analysis read, succeeds, its root has the lowering's nominal and actual types, bounds and facts, and its tape
 *   records a node for each expression the lowering emits, in its order, of its kind, type, overload and arguments; a
 *   refusal its tape records at a site the lowering makes there; and where the typing refuses, every site refuses. A
 *   builder's typing, its text unanalyzed, succeeds exactly where the builder's own lowering does, at its nominal type
 *   and bounds.
 * - Scope key: two recorded nodes compute one value one way (sameNode), the key a guarded node finds its Compute.when
 *   by and a byte guard its text's occurrences, exactly where their emissions state one computation: one kind, one
 *   source, one overload, one literal and the same arguments.
 *
 * Oracle: the lowering's own typing, which compiles every description today (lower.ts lowerTerm, lowerPredicate), and
 * for the scope key a second implementation, each emitted expression's computation written out as a key.
 *
 * Features: each site agreeing, a refusal at one site alone, a typing refusal, every guard of a Compute.when, a byte
 * guard, and the operations whose type their text's language states.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { sameNode } from "#compiler/scalar/compute/typing.ts"
import { assert } from "#test/support/assert.ts"
import { baseParams, lowerWith, typeWith } from "#test/unit/compute/support.ts"
import {
	agreement,
	computationKey,
	descriptions,
	type Feature,
	recorded,
	vars
} from "#test/unit/compute/typing.fixtures.ts"

const agreementSituations: ReadonlyArray<Reached<Feature>> = [
	"agrees at query",
	"agrees at check",
	"agrees at build",
	"refused at query alone",
	"refused at check alone",
	"a typing refusal",
	"agrees under when nonzero",
	"agrees under when nonnegative",
	"agrees under when positive",
	"agrees under when finite",
	"agrees under when within",
	"agrees under when matches",
	"agrees under a byte guard",
	"agrees reading a byte guard's text as its branch beside a bare literal",
	"agrees over compute concat",
	"agrees over compute translate",
	"agrees over compute lowerAscii",
	"agrees over compute collapse",
	"agrees over compute sha256",
	"agrees over compute matches",
	"agrees over compute div",
	"agrees over compute sign",
	"agrees over cast"
]

/**
 * Where a description's lowering succeeds in a query or a check, its typing agrees with it there, node for node, and a
 * builder's typing agrees with the builder's lowering; a refusal the tape records at a site is made there, and a
 * typing's refusal everywhere.
 *
 * Budget: 1500 runs and 6000 steered cases, at well under a millisecond each, enough for the steered phase to reach
 * each guard and each operation whose type its text's language states agreeing.
 */
export const aTermsTypingAgreesWithItsLoweringAtEverySiteNodeForNodeAndRefusesWhereEverySiteRefuses =
	property.explore(descriptions, {
		needs: {},
		budget: { runs: 1500, steered: 6000 },
		situations: agreementSituations,
		check: (_, c: Case<Feature>) => (desc) =>
			Effect.sync(() => {
				agreement(desc, c, {
					lower: (site) => lowerWith(site, desc, vars, false, baseParams),
					type: (analysis) => typeWith(analysis, desc, vars, false, baseParams)
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "the lowering's own typing at each site (lower.ts lowerTerm), which emits and judges as it types"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\treturn [{ kind: "parameter", guard, holds: { kind: "language", subject: subject.node, type } }]',
				replacement: "\t\treturn []",
				why: "A match guard establishes nothing of its parameter, which keeps its subject's type in the branch where the lowering gives it the pattern's language; the agreement property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\t\t\t\tthis.textWithin([wildcardPattern], aBytes + bBytes, analysis.lookup, at),",
				replacement: "\t\t\t\t\tthis.textWithin([wildcardPattern], aBytes, analysis.lookup, at),",
				why: "A concatenation is typed within its first operand's bytes alone, where the lowering types it within the sum of both; the agreement property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\tconst at = isComputedNumeric(type) ? numericOf(point) : type\n",
				replacement: "\t\tconst at = type\n",
				why: "A numeric literal is recorded at the computed numeric it adopts, never at the numeric its own value bounds, as the lowering emits it; the agreement property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\t\t\tscope.kind === "parameter" ? held.includes(scope) : sameNode(scope.holds.subject, entry)',
				replacement: '\t\t\t\tscope.kind === "parameter" ? held.includes(scope) : false',
				why: "No node is an occurrence of the text a byte guard counts, so in its branch the text keeps its own type where the lowering bounds it within the guard's bytes at every occurrence; the agreement property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\t\tsameNode(scope.holds.subject, arg.node)\n",
				replacement: "\t\t\tfalse\n",
				why: "A guarded node holds no Compute.when, so a guard's parameter keeps its subject's own bounds where the lowering narrows them to the guard's interval; the agreement property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\tthis.refusedAt("check", at, floatArithmeticText(fn, va))',
				replacement: '\t\t\tthis.refusedAt("query", at, floatArithmeticText(fn, va))',
				why: "Float arithmetic's refusal is recorded at a query, which lowers it, not at a check, which refuses it; the agreement property fails."
			}
		]
	})

/**
 * Two recorded nodes compute one value one way exactly where their emissions state one computation: one kind, one
 * source, one overload, one literal and the same arguments.
 *
 * Budget: 600 runs and 1000 steered cases, over the agreement property's space.
 */
export const twoRecordedNodesComputeOneValueOneWayExactlyWhereTheirEmissionsStateOneComputation =
	property.explore(descriptions, {
		needs: {},
		budget: { runs: 600, steered: 1000 },
		situations: [
			"a computation recorded twice",
			"two computations of one kind over one argument list"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (desc) =>
			Effect.sync(() => {
				const lowered = lowerWith("query", desc, vars, false, baseParams)
				const typed = typeWith("analyzed", desc, vars, false, baseParams)
				if (!lowered.ok || !typed.ok) {
					return
				}
				const nodes = recorded(typed.value)
				const emitted = lowered.value.emitted
				assert.equal(nodes.length, emitted.length, "a recorded node for every emitted expression")
				const keys = Arr.map(emitted, computationKey)
				Arr.forEach(nodes, (a, i) => {
					Arr.forEach(nodes, (b, j) => {
						const same = keys[i] === keys[j]
						if (i < j && same) {
							c.note("a computation recorded twice")
						}
						const x = emitted[i]
						const y = emitted[j]
						if (
							x !== undefined &&
							y !== undefined &&
							!same &&
							x.kind === y.kind &&
							x.args.length > 0 &&
							Arr.join(Arr.map(x.args, computationKey), ",") ===
								Arr.join(Arr.map(y.args, computationKey), ",")
						) {
							c.note("two computations of one kind over one argument list")
						}
						assert.equal(
							sameNode(a, b),
							same,
							`nodes ${i} and ${j} compute one value one way exactly where their emissions do`
						)
					})
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "each emitted expression's computation written out as a key: its kind, what names it, and its arguments' keys"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\treturn y.kind === "op" && x.op === y.op',
				replacement: '\t\t\treturn y.kind === "op"',
				why: "Two operations over one argument list are one computation whatever their overloads; the scope key property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\t\treturn y.kind === "literal" && canonicalTextOf(x.value) === canonicalTextOf(y.value)',
				replacement: '\t\t\treturn y.kind === "literal"',
				why: "Two literals are one computation whatever their values; the scope key property fails."
			}
		]
	})
