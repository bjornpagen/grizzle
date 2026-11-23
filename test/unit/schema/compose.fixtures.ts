/** What the properties of compose.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { boolean, element, type Gen, int, type Weighted, weighted } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { regex as arkregex } from "arkregex"
import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { natural } from "#compiler/public/fields.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import { unitBuilder } from "#compiler/schema/statements.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { Id } from "#test/support/ids.ts"
import {
	type Admitted,
	admittedSchemaNames,
	schemaNameGenOtherThan
} from "#test/support/kernel/dict.ts"
import { ownInput } from "#test/support/policy.ts"

/** A relation of the pool, by the index of its name and its variant, the pool's own value or a copy built again. */
export interface Drawn {
	readonly name: number
	readonly variant: 0 | 1
	readonly copy: boolean
}

/** A level of a drawn composition: the relations its list holds, and the relations it states mutable. */
export interface Level {
	readonly listed: ReadonlyArray<Drawn>
	readonly stated: ReadonlyArray<Drawn>
}

export const wordGen = matching(arkregex("^[A-Z][a-z]{1,7}$"))

/**
 * A composition's level names, root first, one to three: each a schema name the naming door admits, drawn from the
 * dictionary's admittedSchemaNames (core/identity.ts parseSchemaName decides them), so no level's installed schema takes
 * the pg_ PostgreSQL reserves; and each converting apart from every earlier one, since two levels converting to one
 * schema are IdentifierCollision (schema/own.ts ownedLevels).
 */
export const levelNamesGen: Gen<ReadonlyArray<string>> = (source) =>
	Arr.map(
		Arr.reduce(Array.from({ length: source.draw(int(1, 3)) }), Arr.empty<Admitted>(), (earlier) => {
			const taken = new Set(Arr.map(earlier, (name) => name.converted))
			const excluded = new Set(
				Arr.flatMap(admittedSchemaNames, (name) =>
					taken.has(name.converted) ? [name.declared] : []
				)
			)
			return [...earlier, source.draw(schemaNameGenOtherThan(excluded))]
		}),
		(name) => name.declared
	)

export const drawnGen =
	(names: number): Gen<Drawn> =>
	(source) => ({
		name: source.draw(int(0, names - 1)),
		variant: source.draw(
			weighted<0 | 1>([
				[3, () => 0],
				[1, () => 1]
			])
		),
		copy: source.draw(boolean)
	})

/** One of `relations` again, its name and variant, the pool's own value or a copy built again; no option where none. */
const againOf = (relations: ReadonlyArray<Drawn>): ReadonlyArray<Weighted<Drawn>> =>
	Arr.isReadonlyArrayNonEmpty(relations)
		? [[1, (source) => ({ ...source.draw(element(relations)), copy: source.draw(boolean) })]]
		: []

/**
 * The relation a level states mutable: a pool relation, whose name no level need declare, or one its own list holds,
 * one a lower level's list holds, or one a lower level states, each an option only where some level gives one.
 */
export const statedGen = (
	pool: Gen<Drawn>,
	listed: ReadonlyArray<Drawn>,
	below: ReadonlyArray<Level>
): Gen<Drawn> =>
	weighted<Drawn>([
		[1, pool],
		...againOf(listed),
		...againOf(Arr.flatMap(below, (level) => level.listed)),
		...againOf(Arr.flatMap(below, (level) => level.stated))
	])

/** The unit of a relation's id, which every relation of the pool, keyed by its id, sits in: the root states it. */
export const entity = unitBuilder("Entity", { id: Id }, [])

/** A relation of the name `name` in the variant `variant`: an id, and in the second variant a count beside it. */
export const relationOf = (name: string, variant: 0 | 1): AnyRelation =>
	variant === 0
		? relation(name, { id: Id }, ["id"], [])
		: relation(name, { id: Id, n: natural }, ["id"], [])

/**
 * A statement of a composition that builds, as the model holds it: the name of the relation it is over, the level
 * stating it, the level that first declares the relation, whether the stating level's own list holds the relation, and
 * the statement.
 */
export interface Written {
	readonly name: string
	readonly level: number
	readonly declared: number
	readonly relisted: boolean
	readonly statement: Statement
}

/** What the model predicts of a composition. */
export type Predicted =
	| {
			readonly kind: "admitted"
			readonly names: ReadonlyArray<string>
			readonly first: ReadonlyArray<unknown>
	  }
	| { readonly kind: "clash"; readonly later: unknown; readonly earlier: unknown }
	| { readonly kind: "undeclared"; readonly level: number }
	| { readonly kind: "reach"; readonly written: Written }

/** The reason a composition's build, or its ownership, refused; none where it succeeded. */
export const refusedReason = (
	result: Result.Result<unknown, CompileError>
): CompileError["reason"] | undefined => (result.ok ? undefined : result.error.reason)

/** A declaration the model holds: its variant, the value first declared under its name, and the level declaring it. */
export interface Held {
	readonly variant: 0 | 1
	readonly value: unknown
	readonly level: number
}

/** The situations the search must reach. */
export type Feature =
	| "admitted"
	| "a clash within a level"
	| "a clash across levels"
	| "a clash through a statement"
	| "a statement over an undeclared name"
	| "one value listed twice"
	| "a copy beside its original"
	| "a level declaring a lower relation again"
	| "a statement over a lower level's relation"
	| "a statement over a lower relation its own level lists again"
	| "a statement at an extension over its own level's relation"
	| "a lower level's statement stated again above"

/** A built composition owned, as a compilation's entry point owns it. */
export const ownedOf = (top: AnySchema | undefined) =>
	Result.flatMap(parseSchemaInput(top), ownInput)
