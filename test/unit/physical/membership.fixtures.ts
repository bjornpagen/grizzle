/** What the properties of membership.test.ts read: its box, the schema each case installs and its CHECK's work. */

import { defined } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import { constant, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { libraryIdentity } from "#compiler/physical/ddl/library.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, natural, pg, slot } from "#compiler/public/fields.ts"
import { check, closed, fin, relation, schema } from "#compiler/public/schema.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { codeSources, setSources } from "#test/unit/physical/membership.dictionary.ts"

export type CodeSource = (typeof codeSources)[number]
export type SetSource = (typeof setSources)[number]

/** One case: a membership of a code in a set, or the control, a subset test of two sets. */
export type Asked =
	| { readonly kind: "member"; readonly code: CodeSource; readonly set: SetSource }
	| { readonly kind: "subset" }

/** The box: every code against every set, but a handle in a set value, both constant, whose CHECK folds whole; and the
 * control. */
export const box: Gen<Asked> = oneOf<Asked>([
	constant({ kind: "subset" }),
	(s) => {
		const set = word(setSources)(s)
		const code = word(codeSources)(s)
		return { kind: "member", code: set === "value" && code === "handle" ? "own" : code, set }
	}
])

const Kind = closed.ordered("Kind", ["k0", "k1", "k2"])
const Flag = closed.ordered("Flag", ["a", "b", "c", "d", "e"])
const Position = closed.ordered("Position", ["p0", "p1", "p2"])
/** Which flags each kind admits: a product key. */
const Allowed = closed.relation(
	"Allowed",
	{ kind: closedId(Kind), flag: closedId(Flag) },
	["kind", "flag"],
	[
		{ kind: "k0", flag: "a" },
		{ kind: "k1", flag: "b" },
		{ kind: "k1", flag: "e" }
	]
)
/** Each kind's flag. */
const Pick = closed.relation(
	"Pick",
	{ kind: closedId(Kind), flag: closedId(Flag) },
	["kind"],
	[
		{ kind: "k0", flag: "b" },
		{ kind: "k2", flag: "d" }
	]
)
/** Each kind's count of positions, the owner of Slotted's slots. */
const Model = closed.relation(
	"Model",
	{ kind: closedId(Kind), positions: natural },
	["kind"],
	[
		{ kind: "k0", positions: 2n },
		{ kind: "k1", positions: 1n }
	]
)
/** Which positions of its kind's count each kind holds: a dependent key whose last field is a slot. */
const Slotted = closed.relation(
	"Slotted",
	{ kind: closedId(Kind), at: slot(closedId(Position), fin(Model, "positions")) },
	["kind", "at"],
	[
		{ kind: "k0", at: "p1" },
		{ kind: "k1", at: "p0" }
	]
)
const T = relation(
	"T",
	{
		k: pg.integer,
		kind: closedId(Kind),
		flag: closedId(Flag),
		at: closedId(Position),
		flags: bits(Flag)
	},
	["k"]
)
/** The one check a case's schema holds of T: the code it asks for, over Flag, or over Position where its set is
 * Slotted's row, in the set it asks of. */
const checkOf = (asked: Asked) =>
	check("asked", T, (r) => {
		if (asked.kind === "subset") {
			return r.eq(Bits.subset(Allowed.row(r.kind), r.flags), true)
		}
		if (asked.set === "slotted row") {
			const row = Slotted.row(r.kind)
			switch (asked.code) {
				case "own":
					return r.eq(Bits.subset(Bits.singleton(r.at), row), true)
				case "picked":
					return r.eq(
						Bits.subset(
							Bits.singleton(
								Logic.cond(r.eq(r.flag, Flag.handle("a")), r.at, Position.handle("p2"))
							),
							row
						),
						true
					)
				case "handle":
					return r.eq(Bits.subset(Bits.singleton(Position.handle("p1")), row), true)
			}
		}
		const singleton =
			asked.code === "own"
				? Bits.singleton(r.flag)
				: asked.code === "picked"
					? Bits.singleton(Pick.at("flag", r.kind))
					: Bits.singleton(Flag.handle("c"))
		switch (asked.set) {
			case "stored":
				return r.eq(Bits.subset(singleton, r.flags), true)
			case "row":
				return r.eq(Bits.subset(singleton, Allowed.row(r.kind)), true)
			case "value":
				return r.eq(Bits.subset(singleton, Bits.of(Flag, ["a", "c"])), true)
			case "union":
				return r.eq(Bits.subset(singleton, Bits.union(r.flags, Allowed.row(r.kind))), true)
		}
	})

/** What a predicate's evaluation does, counted by the SQL it is, a row function's body (physical/ddl/row-functions.ts)
 * read where it calls one: each builtin function it calls, by name, each complement, and the substrings of each constant
 * it reads. */
export interface Work {
	readonly calls: ReadonlyMap<string, number>
	readonly complements: number
	/** The binary searches (width_bucket) of each constant's cells, by their function's name. */
	readonly searches: ReadonlyMap<string, number>
	/** The calls of the library's closedRow, each a closed row read whole (physical/ddl/library.ts). */
	readonly rows: number
}

const workOf = (predicate: Expr, rowBodies: ReadonlyMap<string, Expr>): Work => {
	const calls = new Map<string, number>()
	const searches = new Map<string, number>()
	let complements = 0
	let rows = 0
	const walk = (e: Expr): void => {
		transformExpr(e, {
			...identityHooks,
			expr: (node) => {
				if (node.kind === "complement") {
					complements += 1
				}
				if (node.kind === "call" && node.fn.kind === "qualified") {
					const body = rowBodies.get(node.fn.name)
					if (body !== undefined) {
						walk(body)
					}
					if (node.fn.name === libraryIdentity("closedRow").identifier) {
						rows += 1
					}
				}
				if (node.kind === "call" && node.fn.kind === "builtin") {
					calls.set(node.fn.name, (calls.get(node.fn.name) ?? 0) + 1)
					const [, codes] = node.args
					if (
						node.fn.name === "width_bucket" &&
						codes?.kind === "call" &&
						codes.fn.kind === "qualified"
					) {
						searches.set(codes.fn.name, (searches.get(codes.fn.name) ?? 0) + 1)
					}
				}
				return node
			}
		})
	}
	walk(predicate)
	return { calls, complements, searches, rows }
}

/** A case's installation: its CHECK's work, and the name of the constant's function of the relation its set rows. */
export const installedWork = (
	asked: Asked
): { readonly work: Work; readonly codes: string | undefined } => {
	const S = schema(
		"Membership",
		[Kind, Flag, Position, Allowed, Pick, Model, Slotted, T],
		[checkOf(asked)]
	)
	const owned = succeeded(own(defined(schemaDescOf(S), "the case's description")))
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				[identity.schema(parsedSchemaName("membership"))],
				[],
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
	const predicates = Arr.flatMap(installation.manifest.objects, (o) =>
		o.kind === "table"
			? Arr.flatMap(o.ddl, (statement) =>
					statement.kind === "createTable"
						? Arr.flatMap(statement.secondary, (c) =>
								c.kind === "check" && c.name === "asked" ? [c.predicate] : []
							)
						: []
				)
			: []
	)
	const [predicate] = predicates
	const rowBodies = new Map(
		Arr.flatMap(installation.manifest.objects, (o) =>
			Arr.flatMap(o.ddl, (statement) =>
				statement.kind === "createConstant" && statement.language === "plpgsql"
					? [[statement.name.name, statement.body] as const]
					: []
			)
		)
	)
	const rowed =
		asked.kind === "subset" || asked.set === "row" || asked.set === "union"
			? "Allowed"
			: asked.set === "slotted row"
				? "Slotted"
				: undefined
	return {
		work: workOf(
			defined(predicates.length === 1 ? predicate : undefined, "the one CHECK asked"),
			rowBodies
		),
		codes: rowed === undefined ? undefined : installation.names.closed(rowed).constant.cells.name
	}
}
