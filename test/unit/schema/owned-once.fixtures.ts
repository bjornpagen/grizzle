import { defined } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { parseBuiltSchema } from "#compiler/program/input.ts"
import { recordsBuilder } from "#compiler/program/records.ts"
import { compiledSchema } from "#compiler/program/schema.ts"
import { contract, natural, pg } from "#compiler/public/fields.ts"
import { relation, role, schema } from "#compiler/public/schema.ts"
import { queryOver, v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { type Level, levelOf } from "#compiler/schema/level.ts"
import type { Owned } from "#compiler/schema/own.ts"
import { wholeEntriesOf } from "#compiler/schema/world.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"

/**
 * The programs the owned-once property draws (owned-once.test.ts), each built fresh, the shape of metis's schema import
 * whose records owned its levels 136 times over 5 descriptions: a schema, a schema.extend over it or none, a role over
 * the top level or none, and a count of records(...) over each level, each a query over one relation of the level whose
 * contract column the records read through the level's Owned. And what the readers of each value's Owned give.
 */

/** A program's shape: its levels, whether a role stands over the top one, and the records over each level. */
export type Shape = Readonly<{
	extended: boolean
	role: boolean
	records: 1 | 3 | 12
}>

export const shapes = finite((source): Shape => ({
	extended: source.draw(element([false, true] as const)),
	role: source.draw(element([false, true] as const)),
	records: source.draw(element([1, 3, 12] as const))
}))

/** The names of the records a level holds, one each: at most twelve a level. */
const KEPT = [
	"KeptA",
	"KeptB",
	"KeptC",
	"KeptD",
	"KeptE",
	"KeptF",
	"KeptG",
	"KeptH",
	"KeptI",
	"KeptJ",
	"KeptK",
	"KeptL"
] as const

/**
 * A program of the shape, built fresh, so every Owned the readers give is this build's, and `count` records(...) over
 * each of its levels, each a query of Unit's key and its contract column, under the owner `at`: its schema values, root
 * first, and the role over the top one, if any.
 */
const builtOf = (shape: Shape) => {
	const Score = contract("Score", pg.integer)
	const Unit = relation("Unit", { id: pg.integer, score: Score }, ["id"])
	const Base = schema("OwnedBase", [Unit], [])
	const Extra = relation("Extra", { id: pg.integer, score: Score }, ["id"])
	const Top = schema.extend([Base], "OwnedTop", [Extra], [])
	const schemas: Arr.NonEmptyReadonlyArray<AnySchema> = shape.extended ? [Base, Top] : [Base]
	const viewer = shape.role
		? shape.extended
			? role(Top, "viewer", wholeEntriesOf(Top))
			: role(Base, "viewer", wholeEntriesOf(Base))
		: undefined
	const levels: ReadonlyArray<unknown> = [...schemas, ...(viewer === undefined ? [] : [viewer])]
	for (const level of levels) {
		for (const name of Arr.take(KEPT, shape.records)) {
			const q = queryOver(level).rule((r: RuleValue) => {
				const unit = v(Unit, "unit")
				return r.match(Unit, unit).find({ id: unit.id, score: unit.score })
			})
			recordsBuilder(name, q, { at: natural }, ["at"], [])
		}
	}
	return { schemas, role: viewer }
}

/** The Owned a schema's or a role's level carries, built with the value: a role's its base's. */
const ownedOfLevel = (level: Level, what: string): Owned | undefined => {
	switch (level.kind) {
		case "schema":
			return succeeded(level.content.owned(), `${what}'s Owned`)
		case "role":
			return succeeded(level.owned(), `${what}'s OwnedRole`).base
		case "fragment":
			return undefined
	}
}

const carried = (value: unknown, what: string): Owned =>
	defined(
		ownedOfLevel(defined(levelOf(value), `${what}, a built level`), what),
		`${what}, a schema or a role`
	)

/**
 * What the readers of a program's Owned give: the distinct Owned objects every reader reads (each schema value's level,
 * read twice, its compile's law model, the role's base) beside the schema values, and whether each role's base is its
 * top level's Owned and each compile's the schema's own, by reference. One Owned per schema value means no reader owned
 * a built schema again: an owning makes a new one.
 */
export const readsOf = (shape: Shape) => {
	const built = builtOf(shape)
	const read: Array<Owned> = []
	const compiledAsBuilt = Arr.every(built.schemas, (s, at) => {
		const what = `schema ${String(at)}`
		const first = carried(s, what)
		read.push(first, carried(s, what))
		const model = succeeded(
			compiledSchema(succeeded(parseBuiltSchema(s, SourceLoc(what, [])), what)),
			`${what}'s compile`
		).model
		read.push(model.owned)
		return model.owned === first
	})
	const top = Arr.lastNonEmpty(built.schemas)
	const roleOverTop =
		built.role === undefined || carried(built.role, "the role") === carried(top, "the top level")
	if (built.role !== undefined) {
		read.push(carried(built.role, "the role"))
	}
	return {
		schemas: built.schemas.length,
		distinct: new Set(read).size,
		compiledAsBuilt,
		roleOverTop
	}
}
