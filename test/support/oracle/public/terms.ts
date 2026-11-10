import { malformedDescription } from "#compiler/core/errors.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	exprEmitter,
	type LowerEnv,
	lowerTerm,
	noClosedRelations,
	noParams
} from "#compiler/scalar/compute/lower.ts"
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
 * A padding's Description (program.ts Padding): Compute.when(Compute.within(v, low, high), (v) =>
 * Compute.numeric(Compute.cast(v, pg.numeric(1000, scale))), Compute.numeric(v)), whose branch reads the guarded
 * subject, which is the variable.
 */
const paddingDesc = (p: Padding, name: (v: Var) => string): ExprDesc => {
	const type = p.arg.field.type
	const arg: ExprDesc = { kind: "var", var: name(p.arg) }
	const [low, high] = paddingBounds(type)
	return {
		kind: "when",
		guard: {
			kind: "within",
			low: typedLiteralDesc(low, type),
			high: typedLiteralDesc(high, type)
		},
		subject: arg,
		proved: {
			kind: "compute",
			fn: "numeric",
			args: [{ kind: "cast", to: { kind: "numeric", precision: 1000, scale: p.scale }, arg }]
		},
		otherwise: { kind: "compute", fn: "numeric", args: [arg] }
	}
}

/** The Description of what an aggregate or a reading reads: its variable, or its padding. */
const argDesc = (a: ArgTerm, name: (v: Var) => string): ExprDesc =>
	a.kind === "var" ? { kind: "var", var: name(a.var) } : paddingDesc(a.padding, name)

/** A Compute term's Description over a node whose heading names each variable's declaration. */
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
				proved: { kind: "compute", fn: "sqrt", args: [radicand] },
				otherwise: literalDesc(unguarded, numeric)
			}
		}
		case "power": {
			const base = argDesc(t.base, name)
			const [low, high] = powerBounds
			return {
				kind: "when",
				guard: {
					kind: "within",
					low: typedLiteralDesc(low, numeric),
					high: typedLiteralDesc(high, numeric)
				},
				subject: base,
				proved: { kind: "compute", fn: "power", args: [base, literalDesc(t.exponent, numeric)] },
				otherwise: literalDesc(unguarded, numeric)
			}
		}
	}
}

/**
 * The type the checker gives the term `desc` builds over its variables' fields: the nominal type of its Compute
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
		loc: SourceLoc("a generated Compute term", []),
		closed: noClosedRelations("a generated term reads no closed relation"),
		emit: exprEmitter("g"),
		leaf: (leaf, loc) => {
			const type = leaf.kind === "var" ? fields.get(leaf.var) : undefined
			return leaf.kind !== "var" || type === undefined
				? Engine.err(malformedDescription(loc, "a variable of the term"))
				: Engine.ok({
						kind: "column",
						column: { node, name: leaf.var },
						args: [],
						type,
						nonNull: "storage"
					})
		},
		params: noParams,
		fieldType: (d, loc) => scalarTypeOf(d, bareEnv, loc),
		patterns: new CompilePatterns(),
		patternLanguage: textLookup,
		extension: noExtension
	}
	const lowered = lowerTerm(expr, env)
	if (!lowered.ok) {
		throw new Error(`a generated Compute term the checker refuses: ${lowered.error.message}`)
	}
	return lowered.value.nominal
}

/** The type the checker gives a computed head key. */
export const computedType = (t: ComputedTerm): ScalarType =>
	loweredType((name) => termDesc(t, name))

/** The type of what an aggregate or a reading reads: its variable's, or its padding's. */
export const argType = (a: ArgTerm): ScalarType =>
	a.kind === "var" ? a.var.field.type : loweredType((name) => paddingDesc(a.padding, name))
