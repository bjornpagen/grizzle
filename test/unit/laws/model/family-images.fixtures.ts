/** What the properties of family-images.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { element, finite, type FiniteSpace } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { ColumnIdent } from "#compiler/core/ids.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { NativeOf } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import {
	contained,
	counted,
	f,
	fin,
	mutable,
	on,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { lawColumnsOf, onRelation } from "#test/unit/laws/model/natives.ts"

/** How a text of the box is bounded: by its pattern, or by nothing, which a key holds by its image. */
export type Bound = "bounded" | "unbounded"

/** A case of the box: the family's order, its group text's bound, the copy of an owner's text its owner axis carries,
 * if any, and whether the owner is mutable, so a put rewrites its fields and the cascade rewrites their copies. */
export interface ImageCase {
	readonly order: "ordered" | "counted"
	readonly group: Bound
	readonly copy: Bound | "no copy"
	readonly owner: "mutable" | "immutable"
}

export type ImageFeature =
	| ImageCase["order"]
	| `group ${Bound}`
	| `copy ${Bound}`
	| "no copy"
	| ImageCase["owner"]

/** The box, exhausted: every order, group bound, copy and owner mutability. */
export const imageCases: FiniteSpace<ImageCase> = finite((source) => ({
	order: source.draw(element<ImageCase["order"]>(["ordered", "counted"])),
	group: source.draw(element<Bound>(["bounded", "unbounded"])),
	copy: source.draw(element<ImageCase["copy"]>(["no copy", "bounded", "unbounded"])),
	owner: source.draw(element<ImageCase["owner"]>(["mutable", "immutable"]))
}))

const textOf = (bound: Bound): FieldDesc =>
	bound === "bounded" ? f.regex("^.{0,8}$", "su") : f.wildcard

/**
 * Doc, keyed by its text `path`, and its entries, an ordered family's by their drawn index `at` or a counted family's
 * keyed by `id`, grouped by their own `path`; with a copy, each entry's `title` is its doc's, carried on the owner axis.
 */
export const imageSchema = (c: ImageCase): SchemaDesc => {
	const path = textOf(c.group)
	const title = c.copy === "no copy" ? undefined : textOf(c.copy)
	const docFields = title === undefined ? { path, n: f.drawn } : { path, n: f.drawn, title }
	const copied = title === undefined ? {} : { title: f.accumulated(title, "") }
	const entry =
		c.order === "ordered"
			? relation("Entry", { path, at: f.drawn, ...copied }, ["path", "at"])
			: relation("Entry", { id: f.integer, path, ...copied }, ["id"])
	const family =
		c.order === "ordered"
			? ordered(on("Entry", ["path", "at"]), fin("Doc", "n"))
			: counted(on("Entry", ["path"]), fin("Doc", "n"))
	return {
		name: "Images",
		relations: [relation("Doc", docFields, ["path"]), entry],
		statements: [
			family,
			...(c.copy === "no copy"
				? []
				: [contained(on("Entry", ["path", "title"]), on("Doc", ["path", "title"]))]),
			...(c.owner === "mutable" ? [mutable("Doc")] : [])
		],
		bases: []
	}
}

/** Entry's drawn copies of a group field's image (ir/family.ts GroupImage), by the field each is the image of. */
export const imageCopies = (model: LawModel): ReadonlyMap<string, ColumnIdent> =>
	new Map(
		Arr.flatMap([...lawColumnsOf(model, "Entry").values()], (c) =>
			c.value.kind === "drawn" && c.value.draws.kind === "imageCopy"
				? [[c.value.draws.field, c.column] as const]
				: []
		)
	)

/** Entry's generated image of its field `field` (laws/model/plan.ts keyedAs), its own digest of the text. */
export const ownImage = (model: LawModel, field: string): ColumnIdent =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				[...lawColumnsOf(model, "Entry").values()],
				(c) =>
					c.value.kind === "image" &&
					c.value.term.kind === "column" &&
					c.value.term.column.name === field
			)
		)?.column,
		`Entry's own image of ${field}`
	)

/** The owner axis: Entry's foreign key into Doc, ON UPDATE CASCADE. */
export const ownerAxis = (model: LawModel): NativeOf<"ForeignKey"> =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(onRelation(model, "ForeignKey", "Entry"), (fk) => fk.target.name === "Doc")
		),
		"the owner axis"
	)

/** Whether a CHECK of Entry holds `a` and `b` equal: an equality whose two operands read the two columns. */
export const checksEqual = (model: LawModel, a: ColumnIdent, b: ColumnIdent): boolean =>
	Arr.some(onRelation(model, "TableCheck", "Entry"), (check) =>
		Arr.some(exprClosure([check.predicate]), (e: ScalarExpr) => {
			if (e.kind !== "op") {
				return false
			}
			const read = Arr.map(e.args, (x) => (x.kind === "column" ? x.column.name : undefined))
			return read.length === 2 && read.includes(a) && read.includes(b)
		})
	)
