/** What the property of parted.test.ts reads: its box, the program it compiles and how a call's statement is read. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import type { FlightForm, FlightWrite } from "#compiler/runtime/write/flight.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { lexemesOf } from "#compiler/sql/lexer.ts"
import { compileWrite, type CompiledWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"

/**
 * The box's relations: a header H, one fact a call; three sidecars S1, S2 and S3, each of a header's variables and their
 * values, each from its own relation parameter p1, p2, p3; and G, the variables either of S1's and S2's parameters names,
 * from a union of two rules, one over each.
 */
export const H = relation("H", { id: Id }, ["id"])
/** A sidecar's fields: a header's variable and its value, keyed by the header and the variable. */
const sidecarFields = Object.freeze({
	id: Id,
	variable: str.regex("^[a-z]{1,8}$"),
	value: pg.bigint
})
export const S1 = relation("S1", sidecarFields, ["id", "variable"])
export const S2 = relation("S2", sidecarFields, ["id", "variable"])
export const S3 = relation("S3", sidecarFields, ["id", "variable"])
export const G = relation("G", { id: Id, variable: str.regex("^[a-z]{1,8}$") }, ["id", "variable"])
const Parted = schema("parted", [H, S1, S2, S3, G], [])

/** The box's schema compiled, whose names each statement's text spells its tables by. */
const artifacts = succeeded(testArtifacts(Parted, testCompile), "the box's schema compiles")

/** The name a statement's text spells `relation`'s table by. */
export const tableOf = (relation: { readonly name: string }): string =>
	artifacts.names.relation(relation.name).name

/** The sidecars by the relation parameter each is inserted from. */
const sidecars = { p1: S1, p2: S2, p3: S3 } as const

type Param = keyof typeof sidecars

/** A case of the box: how many facts each parameter holds, none to two, and whether a read-back of S1's added facts
 * rides the statement. */
export interface Box {
	readonly facts: Readonly<Record<Param, 0 | 1 | 2>>
	readonly rider: boolean
}

const counts = [0, 1, 2] as const

export const boxGen: Gen<Box> = (source) => ({
	facts: {
		p1: source.draw(element(counts)),
		p2: source.draw(element(counts)),
		p3: source.draw(element(counts))
	},
	rider: source.draw(element([false, true] as const))
})

/** A sidecar's insert from its relation parameter, each fact the parameter states. */
const fromParam = (param: Param) => {
	const S = sidecars[param]
	return query(Parted).rule((r) => {
		const given = r.relation(param, {
			id: S.fields.id,
			variable: S.fields.variable,
			value: S.fields.value
		})
		const { id, variable, value } = v(given, "given")
		return r.match(given, { id, variable, value }).find({ id, variable, value })
	})
}

/** G's insert: each variable p1 or p2 states, by one rule over each. */
const named = query(Parted)
	.rule((r) => {
		const given = r.relation("p1", {
			id: S1.fields.id,
			variable: S1.fields.variable,
			value: S1.fields.value
		})
		const { id, variable, value } = v(given, "given")
		return r.match(given, { id, variable, value }).find({ id, variable })
	})
	.rule((r) => {
		const given = r.relation("p2", {
			id: S2.fields.id,
			variable: S2.fields.variable,
			value: S2.fields.value
		})
		const { id, variable, value } = v(given, "given")
		return r.match(given, { id, variable, value }).find({ id, variable })
	})

/** The box's write: H's one fact, each sidecar from its parameter, G, and, for a rider, a read-back of S1's added facts. */
export const changesOf = (rider: boolean) => {
	const writes = ChangeSet.empty(Parted)
		.insert(
			H,
			query(Parted).rule((r) => r.find({ id: r.param("id", H.fields.id) }))
		)
		.insert(S1, fromParam("p1"))
		.insert(S2, fromParam("p2"))
		.insert(S3, fromParam("p3"))
		.insert(G, named)
	return rider
		? writes.read("added", (d) =>
				query(Parted).rule((r) => {
					const { id, variable, value } = v(S1, "added")
					return r.match(d.added(S1), { id, variable, value }).find({ id, variable, value })
				})
			)
		: writes
}

/** The box's write compiled for reality over its schema. */
export const programOf = (changes: ReturnType<typeof changesOf>): CompiledWrite =>
	succeeded(
		compileWrite(checking(Parted), descOf(changes), realityWrite(artifacts)),
		"the box's write compiles"
	)

const header = "00000000-0000-7000-8000-000000000001"

/** A call's parameters: the header, and each parameter's facts, the variables a, b. */
const paramsOf = (box: Box): Readonly<Record<string, unknown>> => ({
	id: header,
	...Rec.fromEntries(
		Arr.map(["p1", "p2", "p3"] as const, (param) => [
			param,
			Arr.take(
				[
					{ id: header, variable: "a", value: 1n },
					{ id: header, variable: "b", value: 2n }
				],
				box.facts[param]
			)
		])
	)
})

/** What one call of the box sends: each statement's form, none of one it skips, with its values. */
export const sentOf = (
	program: CompiledWrite,
	flight: FlightWrite,
	changes: ReturnType<typeof changesOf>,
	box: Box
): Effect.Effect<
	ReadonlyArray<{ readonly form: FlightForm; readonly values: number } | undefined>
> =>
	Effect.gen(function* () {
		const members = yield* Effect.orDie(
			collectInputs(program.binding.groups, parsedOf(changes).inputs)
		)
		const bound = succeeded(
			bindWrite(flight, { members, params: paramsOf(box), transport: inForce(bindFrame) }),
			"the call binds"
		)
		if (bound.kind !== "bound") {
			throw new Error(`the call binds, not ${bound.kind}`)
		}
		return Arr.map(flight.statements, (s) =>
			bound.skip.has(s.index)
				? undefined
				: { form: bound.form(s), values: succeeded(bound.values(s), "its values encode").length }
		)
	})

/** The tables a text inserts into, by their names, in order, as PostgreSQL's scanner reads it: each `INSERT INTO`'s
 * target, its schema's quoted name, a dot and its own. */
export const insertedInto = (text: string): ReadonlyArray<string> => {
	const tokens = lexemesOf(text).lexemes
	return Arr.flatMap(tokens, (t, i) => {
		const into = tokens[i + 1]
		const table = tokens[i + 4]
		return t.kind === "word" &&
			t.upper === "INSERT" &&
			into?.kind === "word" &&
			into.upper === "INTO" &&
			table?.kind === "quotedIdent"
			? [table.text]
			: []
	})
}

/** The placeholder numbers a text holds, each once, ascending, as PostgreSQL's scanner reads it. */
export const placeholdersOf = (text: string): ReadonlyArray<number> =>
	Arr.sort(
		Arr.dedupe(Arr.flatMap(lexemesOf(text).lexemes, (l) => (l.kind === "param" ? [l.index] : []))),
		Order.Number
	)
