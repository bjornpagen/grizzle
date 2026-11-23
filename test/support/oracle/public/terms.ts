import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { malformedDescription } from "#compiler/core/errors.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type ExprDesc, type GuardDesc, guardedExpr } from "#compiler/ir/desc.ts"
import { type TypedLiteral, storedColumn } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { exprEmitter, type LowerEnv, lowerTerm } from "#compiler/scalar/compute/lower.ts"
import { noClosedRelations, noParams } from "#compiler/scalar/compute/typing.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { noExtension } from "#test/support/compute.ts"
import { numeric, typedLiteralDesc } from "#test/support/oracle/gen/domain.ts"
import {
	type ArgTerm,
	type ComputedTerm,
	type Padding,
	paddingBounds,
	powerBounds,
	unguarded,
	type Var
} from "#test/support/oracle/public/program.ts"

const literalDesc = (literal: TypedLiteral, type: ScalarType): ExprDesc => ({
	kind: "literal",
	value: typedLiteralDesc(literal, type)
})

/**
 * A padding's Description (program.ts Padding): Logic.when(Num.within(v, low, high), (v) =>
 * Num.numeric(Type.cast(v, pg.numeric(1000, scale))), Num.numeric(v)), whose branch reads the guarded
 * subject, which is the variable.
 */
const paddingDesc = (p: Padding, name: (v: Var) => string): ExprDesc => {
	const type = p.arg.field.type
	const arg: ExprDesc = { kind: "var", var: name(p.arg) }
	const [low, high] = paddingBounds(type)
	const guard: GuardDesc = {
		kind: "within",
		low: typedLiteralDesc(low, type),
		high: typedLiteralDesc(high, type)
	}
	return {
		kind: "when",
		guard,
		subject: arg,
		proved: {
			kind: "compute",
			fn: "numeric",
			args: [
				{
					kind: "cast",
					to: { kind: "numeric", precision: 1000, scale: p.scale },
					arg: guardedExpr(guard, arg)
				}
			]
		},
		otherwise: { kind: "compute", fn: "numeric", args: [arg] }
	}
}

/** The Description of what an aggregate or a reading reads: its variable, or its padding. */
const argDesc = (a: ArgTerm, name: (v: Var) => string): ExprDesc =>
	a.kind === "var" ? { kind: "var", var: name(a.var) } : paddingDesc(a.padding, name)

/** A scalar term's Description over a node whose heading names each variable's declaration. */
export const termDesc = (t: ComputedTerm, name: (v: Var) => string): ExprDesc => {
	switch (t.kind) {
		case "base":
			return { kind: "base", arg: { kind: "var", var: name(t.arg) } }
		case "cast numeric":
			return { kind: "compute", fn: "numeric", args: [{ kind: "var", var: name(t.arg) }] }
		case "cond": {
			const arg: ExprDesc = { kind: "var", var: name(t.arg) }
			return {
				kind: "cond",
				pred: {
					kind: "compare",
					op: t.op,
					left: arg,
					right: literalDesc(t.than, t.arg.field.type)
				},
				onTrue: arg,
				onFalse: literalDesc(t.otherwise, t.arg.field.type)
			}
		}
		case "padded":
			return paddingDesc(t.padding, name)
		case "div":
			return {
				kind: "compute",
				fn: "div",
				args: [argDesc(t.dividend, name), literalDesc(t.divisor, numeric)]
			}
		case "sqrt": {
			const radicand = argDesc(t.radicand, name)
			return {
				kind: "when",
				guard: { kind: "nonnegative" },
				subject: radicand,
				proved: {
					kind: "compute",
					fn: "sqrt",
					args: [guardedExpr({ kind: "nonnegative" }, radicand)]
				},
				otherwise: literalDesc(unguarded, numeric)
			}
		}
		case "power": {
			const base = argDesc(t.base, name)
			const [low, high] = powerBounds
			const guard: GuardDesc = {
				kind: "within",
				low: typedLiteralDesc(low, numeric),
				high: typedLiteralDesc(high, numeric)
			}
			return {
				kind: "when",
				guard,
				subject: base,
				proved: {
					kind: "compute",
					fn: "power",
					args: [guardedExpr(guard, base), literalDesc(t.exponent, numeric)]
				},
				otherwise: literalDesc(unguarded, numeric)
			}
		}
	}
}

/**
 * The type the checker gives the term `desc` builds over its variables' fields: the nominal type of its scalar
 * lowering, so a computed numeric is the bound the lowering proves of it. A program's heading types a computed column
 * by it, and an aggregate over a padding by the padding's, as the checker does, so the generator draws only the
 * aggregates the checker admits.
 */
const loweredType = (desc: (name: (v: Var) => string) => ExprDesc): ScalarType => {
	const fields = new Map<string, ScalarType>()
	const name = (v: Var): string => {
		const n = `v${v.id}`
		fields.set(n, v.field.type)
		return n
	}
	const expr = desc(name)
	const node = NodeId("a generated term's input")
	const env: LowerEnv = {
		mode: "query",
		held: [],
		functions: () => undefined,
		loc: SourceLoc("a generated scalar term", []),
		closed: noClosedRelations("a generated term reads no closed relation"),
		emit: exprEmitter("g"),
		leaf: (leaf, loc) => {
			const type = leaf.kind === "var" ? fields.get(leaf.var) : undefined
			return leaf.kind !== "var" || type === undefined
				? Engine.err(malformedDescription(loc, "a variable of the term"))
				: Engine.ok(storedColumn(node, leaf.var, type))
		},
		params: noParams,
		fieldType: (d, loc) => scalarTypeOf(d, bareEnv, loc),
		patterns: new CompilePatterns(),
		patternLanguage: textLookup,
		extension: noExtension
	}
	const lowered = lowerTerm(expr, env)
	if (!lowered.ok) {
		throw new Error(`a generated scalar term the checker refuses: ${lowered.error.message}`)
	}
	return lowered.value.nominal
}

/** The type the checker gives a computed head key. */
export const computedType = (t: ComputedTerm): ScalarType =>
	loweredType((name) => termDesc(t, name))

/** The type of what an aggregate or a reading reads: its variable's, or its padding's. */
export const argType = (a: ArgTerm): ScalarType =>
	a.kind === "var" ? a.var.field.type : loweredType((name) => paddingDesc(a.padding, name))
