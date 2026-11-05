/**
 * A closed literal's lowering (lower/conservative/expr/index.ts lowerLiteral): a handle is its code under the
 * installation's codebook, never its position among the roster's live handles, and a set of handles is bit(n)'s text,
 * n every code the roster has minted, position c set exactly for the handle of code c.
 *
 * - The oracle: an independent replay of the roster's history (test/support/closed/generate.ts), a naive list of slots
 *   replayed command by command that shares no code with ir/cells.ts rosterCodes or ir/codes.ts draftCodebook: a live
 *   handle's code is its slot, and the set's text is the slots read one bit each.
 * - D1 as a checker: for every two live handles, their lowered codes compare as their declared positions do, so a code
 *   comparison agrees with the roster's declared order, holes or none.
 * - Holes weighted up: the generator removes three times as often as it grows, because a lowering that writes the
 *   declared position agrees with the codes on every roster without a hole. Each literal notes its (hole count,
 *   literal) pair, aligned when its code is its position and shifted when a hole before it moved its code, and the
 *   search must reach a shifted literal under one hole and under several.
 *
 * The box: one roster installed with one to four handles, then up to six migrations (growth, removal, re-addition), in
 * plain and awkward spellings; every live handle as a literal, every ordered pair of them, and one drawn set.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { type Reached, required } from "@grizzle/testing/features"
import { subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { baseTypeRef, type PhysicalNames } from "#compiler/ir/physical.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import { scalarTypeOf } from "#compiler/scalar/registry.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	codeAt,
	codebookFor,
	historyGen,
	liveOf,
	literalFeature,
	type RosterFeature,
	type RosterHistory,
	type RosterState,
	sizeOf
} from "#test/support/closed/generate.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"

/** The roster every history is of. */
const closed: DeclaredName = succeeded(parseDeclaredName("Kind"))

/** The type of a closed id's or a set's field over the history's roster, as the descriptor registry types it. */
const typeOver = (state: RosterState, desc: FieldDesc): ScalarType =>
	succeeded(
		scalarTypeOf(
			desc,
			{
				kind: "builder",
				roster: (name) => (name === state.closed ? liveOf(state) : undefined),
				text: textLookup
			},
			SourceLoc("a closed literal's field", [])
		)
	)

/** The names a lowering of the roster's literals reads: the installation's codes, which are the model's. */
const namesOf = (state: RosterState): PhysicalNames =>
	productionNames("codes", { kind: "declared" }, localVectorSchema, codebookFor([state]))

/** The code a lowered handle literal states: an integer literal typed smallint, the type of a closed id's code. */
const loweredCode = (e: Expr, handle: string): number => {
	if (e.kind !== "literal" || e.value.kind !== "int") {
		return assert.fail(`${handle} lowers to an integer literal, not ${printExpr(e)}`)
	}
	assert.deepEqual(e.type, types.smallint, `${handle}'s code is typed smallint`)
	return Number(e.value.value)
}

/** Notes a situation a case reached: one feature, or an ordered pair. */
const reach = (c: Case<RosterFeature>, reached: Reached<RosterFeature>): void => {
	if (typeof reached === "string") {
		c.note(reached)
	} else {
		c.pair(reached[0], reached[1])
	}
}

/** The model's bit(n) text of a set: one character per code minted, 1 exactly at the codes of its handles. */
const modelBits = (state: RosterState, handles: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.makeBy(sizeOf(state), (code) =>
			Arr.some(handles, (h) => codeAt(state, h) === code) ? "1" : "0"
		),
		""
	)

/**
 * Every live handle lowers to the model's code for it, every two compare as their declared positions do (D1), and a
 * drawn set lowers to the model's bit text at the roster's size.
 */
const lowersByCodes = (history: RosterHistory, c: Case<RosterFeature>) =>
	Effect.sync(() => {
		const state = history.state
		const names = namesOf(state)
		const code = typeOver(state, { kind: "closedId", roster: closed })
		const live = liveOf(state)
		const lowered = Arr.map(live, (handle) => {
			const got = loweredCode(lowerLiteral(names, { kind: "handle", handle }, code), handle)
			assert.equal(
				got,
				defined(codeAt(state, handle)),
				`${handle}'s code is its slot in the roster's history`
			)
			reach(c, literalFeature(state, handle))
			return got
		})
		for (const [i, a] of lowered.entries()) {
			for (const [j, b] of lowered.entries()) {
				assert.equal(
					Math.sign(a - b),
					Math.sign(i - j),
					`${defined(live[i])} and ${defined(live[j])} compare by code as by declared position`
				)
			}
		}
		const set = c.draw(subset(live, { min: 0, max: live.length }))
		const bits = typeOver(state, { kind: "bits", roster: closed })
		const literal = lowerLiteral(names, { kind: "handles", handles: set }, bits)
		assert.deepEqual(
			literal,
			{
				kind: "literal",
				value: { kind: "text", value: modelBits(state, set) },
				type: baseTypeRef(names, bits)
			},
			`the set {${Arr.join(set, ", ")}} is bit(${sizeOf(state)})'s text over its codes, typed as a set's base`
		)
	})

describe("closed literals", () => {
	it.effect(
		"a handle lowers to its code in the roster's history, never its declared position, and codes keep declared order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/codes",
						draw: drawn(
							historyGen(closed, {
								handles: { min: 1, max: 4 },
								migrations: { min: 0, max: 6 }
							})
						),
						literal: Formatter.format,
						coverage: required<RosterFeature>(
							[
								["holes 0", "literal aligned"],
								["holes 1", "literal aligned"],
								["holes 1", "literal shifted"],
								["holes 2+", "literal shifted"]
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "a naive replay of the roster's history (test/support/closed/generate.ts)"
						}
					},
					lowersByCodes
				)
			)
	)
})
