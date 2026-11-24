/** What the properties of fold-digests.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import {
	type AuthoredStatementDesc,
	f,
	field,
	fin,
	fold,
	on,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

/**
 * How a fold's side names one of its running texts: the accumulated text itself, its SHA-256 digest (a generated field
 * `Crypto.sha256(row.v)` over it), or another generation over it, `Text.lowerAscii(row.v)`, which is no digest.
 */
export type Naming = "text" | "digest" | "lowered"

/** The sequence a concat fold folds: an ordered family of lines under their document, or a tree's nodes. */
export type Sequence = "ordered" | "tree"

/** The type of a fold's texts: no byte bound, or a byte bound whose axis entry fits. */
export type Bound = "unbounded" | "bounded"

/** A concat fold whose sides name each of its before, after and end in one of three ways, over texts of one bound. */
export interface Shape {
	readonly sequence: Sequence
	readonly bound: Bound
	readonly before: Naming
	readonly after: Naming
	readonly end: Naming
}

const namings = ["text", "digest", "lowered"] as const satisfies ReadonlyArray<Naming>

/** Every shape: each sequence, bound and naming of each running text. */
export const shapeGen: Gen<Shape> = (source) => ({
	sequence: element(["ordered", "tree"] as const)(source),
	bound: element(["unbounded", "bounded"] as const)(source),
	before: element(namings)(source),
	after: element(namings)(source),
	end: element(namings)(source)
})

/**
 * The fold's texts: the wildcard, or a pattern of at most a hundred ASCII letters, whose byte bound fits an axis entry
 * beside any sequence's key. Each is a text of no contract, so a lowering of one is of its type.
 */
const textOf = (b: Bound): FieldDesc =>
	b === "unbounded" ? f.wildcard : f.regex("^[a-z]{0,100}$", "u")

/** Crypto.sha256's value: the lowercase hexadecimal spelling of a SHA-256 digest. */
const digestType: FieldDesc = { kind: "sha256" }

/** The field a fold's side names for the running text `v` under `n`. */
const namedField = (v: string, n: Naming): string => {
	switch (n) {
		case "text":
			return v
		case "digest":
			return `${v}Digest`
		case "lowered":
			return `${v}Lowered`
	}
}

/**
 * A running text `v` of type `t`, accumulated from the empty text, with its lowering and its digest generated beside it,
 * the lowering first: a relation's declared digests name one field per text, the first in declared order (ir/law.ts
 * textDigestsOf), so a lowering declared after the digest would be no candidate, and one declared before it is the
 * generation a recognizer that took any for a digest would take.
 */
const running = (v: string, t: FieldDesc) => ({
	[v]: f.accumulated(t, ""),
	[`${v}Lowered`]: f.generated(t, { kind: "compute", fn: "lowerAscii", args: [field(v)] }),
	[`${v}Digest`]: f.generated(digestType, { kind: "compute", fn: "sha256", args: [field(v)] })
})

/** The member relation of a shape, its key, its step side's group and its end side's key. */
interface Layout {
	readonly member: string
	readonly owner: string
	readonly count: string
	readonly group: ReadonlyArray<string>
	readonly key: ReadonlyArray<string>
}

export const layoutOf = (s: Shape): Layout =>
	s.sequence === "ordered"
		? { member: "Line", owner: "Doc", count: "n", group: ["doc"], key: ["id"] }
		: {
				member: "Node",
				owner: "Node",
				count: "children",
				group: ["doc", "parent"],
				key: ["doc", "start"]
			}

/**
 * A shape's schema: the concat fold of the members' `piece` into the owner's `text`, its step side naming `before` and
 * `after`, and its end side `text`, each as the shape names it. An ordered family of Doc's lines, or a tree of nodes.
 */
export const schemaOf = (s: Shape): SchemaDesc => {
	const t = textOf(s.bound)
	const l = layoutOf(s)
	const foldOf = fold(
		fin(l.owner, l.count),
		"concat",
		on(l.member, [
			...l.group,
			"piece",
			namedField("before", s.before),
			namedField("after", s.after)
		]),
		on(l.owner, [...l.key, namedField("text", s.end)])
	)
	if (s.sequence === "ordered") {
		return {
			name: "Digests",
			relations: [
				relation("Doc", { id: f.uuid, n: f.drawn, ...running("text", t) }, ["id"]),
				relation(
					"Line",
					{
						doc: f.uuid,
						at: f.drawn,
						piece: t,
						...running("before", t),
						...running("after", t)
					},
					["doc", "at"]
				)
			],
			statements: [ordered(on("Line", ["doc", "at"]), fin("Doc", "n")), foldOf],
			bases: []
		}
	}
	const tree: AuthoredStatementDesc = {
		kind: "tree",
		member: on("Node", ["parent", "at"]),
		slots: fin("Node", "children"),
		root: ["doc"]
	}
	return {
		name: "Digests",
		relations: [
			relation(
				"Node",
				{
					doc: f.uuid,
					parent: f.drawn,
					at: f.drawn,
					children: f.drawn,
					start: f.drawn,
					end: f.drawn,
					piece: t,
					...running("before", t),
					...running("after", t),
					...running("text", t)
				},
				["doc", "start"]
			)
		],
		statements: [tree, foldOf],
		bases: []
	}
}

/** What the schema of a shape is: admitted with its texts or their digests on its axes, or refused, and why. */
export type Verdict =
	| { readonly kind: "admitted"; readonly carried: "text" | "digest" }
	| { readonly kind: "lowered"; readonly field: string }
	| { readonly kind: "unalike" }
	| { readonly kind: "unbounded" }

/**
 * The specification's verdict on a shape (ir/family.ts FoldCarrier, check/fold.ts foldRule): a side naming another
 * generation than a digest names no accumulator, the first so named in step then end order refused; a plane named
 * unalike is refused, since its axes pair a digest only with a digest; a plane of texts carries them, refused where they
 * are unbounded; a plane of digests carries the digests whatever the texts' bound.
 */
export const verdictOf = (s: Shape): Verdict => {
	const sides = [
		["before", s.before],
		["after", s.after],
		["text", s.end]
	] as const
	const lowered = Arr.findFirst(sides, ([, n]) => n === "lowered")
	if (Option.isSome(lowered)) {
		return { kind: "lowered", field: namedField(lowered.value[0], "lowered") }
	}
	if (s.before !== s.after || s.after !== s.end) {
		return { kind: "unalike" }
	}
	if (s.before === "digest") {
		return { kind: "admitted", carried: "digest" }
	}
	return s.bound === "unbounded" ? { kind: "unbounded" } : { kind: "admitted", carried: "text" }
}

export type Feature =
	| `${Sequence} carried by its digests over ${Bound} texts`
	| `${Sequence} carried by its texts`
	| "another generation refused"
	| "a plane named unalike refused"
	| "unbounded texts refused"

/** The feature a shape's verdict reaches. */
export const featureOf = (s: Shape, v: Verdict): Feature => {
	switch (v.kind) {
		case "admitted":
			return v.carried === "digest"
				? `${s.sequence} carried by its digests over ${s.bound} texts`
				: `${s.sequence} carried by its texts`
		case "lowered":
			return "another generation refused"
		case "unalike":
			return "a plane named unalike refused"
		case "unbounded":
			return "unbounded texts refused"
	}
}
