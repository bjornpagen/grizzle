/** What the property of composed-prints.test.ts reads: its space, its schemas and an installation's compile, counted. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import { owning } from "#test/support/policy.ts"

/**
 * A rule's law over D: a check over its facts, a containment of S into it by a number or by a text, or a key over a
 * projection of them.
 */
type Law = "check" | "contained" | "tagged" | "key"

/** A short lowercase word, a text of bounded bytes. */
const word = str.regex("^[a-z]{1,8}$")

/**
 * One case: its law; D's arms, each T's facts of one literal of `a`; and its judge: whole, T and S immutable, so the
 * rule is unit-local and one statement reads every arm of D over a delta of T, or probed, both mutable in their
 * document's unit and each arm joining W, mutable in a unit of its own, so the rule reads two units.
 */
interface Shape {
	readonly law: Law
	readonly arms: 1 | 2 | 3 | 4
	readonly judge: "whole" | "probed"
}

export const shapeGen: Gen<Shape> = (s) => ({
	law: s.draw(element<Law>(["check", "contained", "tagged", "key"])),
	arms: s.draw(element<Shape["arms"]>([1, 2, 3, 4])),
	judge: s.draw(element<Shape["judge"]>(["whole", "probed"]))
})

export type Reached = "a whole rule's statement" | "a probe's statement"

/**
 * T and S, each keyed by its document first; D, the union of `arms` rules over T, the k-th T's facts whose `a` is k, by
 * document and place with their `b`. The rule judges D: its `b` at least 0, S's references among its `b`s by document,
 * or its `b` once per document.
 */
const schemaOf = (shape: Shape) => {
	const T = relation("T", { doc: int4, at: int4, a: int4, b: int4, tag: word }, ["doc", "at"])
	const S = relation("S", { doc: int4, at: int4, ref: int4, label: word }, ["doc", "at"])
	const W = relation("W", { wdoc: int4 }, ["wdoc"])
	const probed = shape.judge === "probed"
	const Base = schema(
		"delta_reads",
		[T, S, W],
		probed
			? [
					unit("Document", { doc: int4 }),
					unit("Ws", { wdoc: int4 }),
					mutable(T),
					mutable(S),
					mutable(W)
				]
			: []
	)
	/** The k-th arm: T's facts whose `a` is k, at a document W holds where the judge probes. */
	const arm = (k: number) => (r: Rule<typeof Base>) => {
		const { doc, at, b, tag } = v(T, "t")
		const matched = r.match(T, { doc, at, a: k, b, tag })
		return probed
			? matched.match(W, { wdoc: doc }).find({ doc, at, b, tag })
			: matched.find({ doc, at, b, tag })
	}
	const first = query(Base).rule(arm(1))
	const second = first.rule(arm(2))
	const third = second.rule(arm(3))
	const fourth = third.rule(arm(4))
	const D = derived(
		"D",
		shape.arms === 1 ? first : shape.arms === 2 ? second : shape.arms === 3 ? third : fourth
	)
	const law = (() => {
		switch (shape.law) {
			case "check":
				return check("Positive", D, (d) => d.ge(d.b, 0))
			case "contained":
				return contained(on(S, "doc", "ref"), on(D, "doc", "b"))
			case "tagged":
				return contained(on(S, "doc", "label"), on(D, "doc", "tag"))
			case "key":
				return key(on(D, "doc", "b"))
		}
	})()
	return schema.extend([Base], "delta_reads_1", [D], [law])
}

/** The module whose calls the judged prints count: the printer's one door and the composed statements' text maker. */
const counted = "packages/engine/src/sql/emit.ts"

/**
 * The installation of `shape`'s schema compiled, counted: the statements it prints (sql/emit.ts emitText) and the
 * statements its lowerings compose into others, which nothing prints (sql/emit.ts unprintedText), every call of the
 * module counted (kernel/calls.ts everyCallCount).
 */
export const printsAt = (shape: Shape) =>
	Effect.gen(function* () {
		const owned = owning(schemaOf(shape))
		const [, counts] = yield* everyCallCount(
			Effect.sync(() => succeeded(compileInstallation(owned, installOptions(owned)))),
			(file) => file === counted
		)
		const callsOf = (name: string): number =>
			Arr.reduce(
				Arr.filter([...counts], ([key]) => Str.endsWith(` ${name}`)(key)),
				0,
				(n, [, k]) => n + k
			)
		return { prints: callsOf("emitText"), composed: callsOf("unprintedText") }
	})
