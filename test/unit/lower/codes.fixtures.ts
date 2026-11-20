/** What the properties of codes.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { subset } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { baseTypeRef, type PhysicalNames } from "#compiler/ir/physical.ts"
import { Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import { scalarTypeOf } from "#compiler/scalar/registry.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { hexOfText, setText, wholeDigits } from "#test/support/closed/bit-text.ts"
import {
	codeAt,
	codebookOfStates,
	literalFeature,
	liveOf,
	type RosterFeature,
	type RosterHistory,
	type RosterState,
	sizeOf
} from "#test/support/closed/generate.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"

/** The roster every history is of. */
export const closed: DeclaredName = succeeded(parseDeclaredName("Kind"))

/** The type of a closed id's or a set's field over the history's roster, as the descriptor registry types it. */
const typeOver = (state: RosterState, desc: FieldDesc): ScalarType =>
	succeeded(
		scalarTypeOf(
			desc,
			{
				kind: "builder",
				roster: (name) =>
					name === state.closed ? Roster.of(name, "ordered", liveOf(state)) : undefined
			},
			SourceLoc("a closed literal's field", [])
		)
	)

/** The names a lowering of the roster's literals reads: the installation's codes, which are the model's. */
const namesOf = (state: RosterState): PhysicalNames =>
	productionNames("codes", { kind: "declared" }, localVectorSchema, codebookOfStates([state]))

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

/**
 * The model's hex digits of a set: its bit(n) text, n the codes minted rounded up to whole hex digits, 1 exactly at the
 * codes of its handles, as hex digits.
 */
const modelBits = (state: RosterState, handles: ReadonlyArray<string>): string =>
	hexOfText(
		setText(
			sizeOf(state),
			Arr.flatMap(handles, (h) => {
				const at = codeAt(state, h)
				return at === undefined ? [] : [at]
			})
		)
	)

/**
 * Every live handle lowers to the model's code for it, every two compare as their declared positions do (D1), and a
 * drawn set lowers to the model's hex literal at the roster's width.
 */
export const lowersByCodes = (history: RosterHistory, c: Case<RosterFeature>) =>
	Effect.sync(() => {
		const state = history.state
		const names = namesOf(state)
		const code = typeOver(state, { kind: "closedId", roster: closed, only: undefined })
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
				value: { kind: "bits", hex: modelBits(state, set) },
				type: baseTypeRef(names, bits)
			},
			`the set {${Arr.join(set, ", ")}} is bit(${wholeDigits(sizeOf(state))})'s hex literal over its codes, typed as a set's base`
		)
	})
