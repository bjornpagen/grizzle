/** What the properties of attnums.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { draftMigration, type MigrationDraft } from "#compiler/deploy/render/generate.ts"
import {
	emptySnapshot,
	noWorkload,
	rosterFates,
	spellingsOf,
	withAttnums
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { draftCodebook, noRenames } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"

/** The commands: a field added under the next fresh name, the first field dropped, the first renamed to a fresh name. */
type Command = "add" | "drop" | "rename"

interface Box {
	readonly commands: ReadonlyArray<Command>
	readonly limit: number
}

export type Feature = Command | "within the bound" | "past the bound"

export const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"add",
	"drop",
	"rename",
	"within the bound",
	"past the bound"
]

/** The model: the table's fields in order, the fresh names taken so far, and its attribute numbers used. */
interface Model {
	readonly fields: ReadonlyArray<string>
	readonly minted: number
	readonly attnums: number
}

/** The table is created with its key and one field: two attribute numbers. */
const initial: Model = { fields: ["f0"], minted: 1, attnums: 2 }

const step = (m: Model, c: Command): Model => {
	switch (c) {
		case "add":
			return { fields: [...m.fields, `f${m.minted}`], minted: m.minted + 1, attnums: m.attnums + 1 }
		case "drop":
			return { ...m, fields: Arr.drop(m.fields, 1) }
		case "rename":
			return {
				fields: Arr.map(m.fields, (x, i) => (i === 0 ? `f${m.minted}` : x)),
				minted: m.minted + 1,
				attnums: m.attnums
			}
	}
}

/** Whether a command applies: a drop or a rename needs a field. */
const applies = (m: Model, c: Command): boolean => c === "add" || m.fields.length > 0

export const boxGen: Gen<Box> = (source) => {
	const commands = source.draw(
		array(element(["add", "drop", "rename"] as const), { min: 1, max: 6 })
	)
	return { commands, limit: source.draw(int(2, 6)) }
}

const descOf = (m: Model): SchemaDesc => ({
	name: "Attnums",
	relations: [
		relation(
			"T",
			{ id: f.uuid, ...Rec.fromEntries(Arr.map(m.fields, (x) => [x, f.integer] as const)) },
			["id"]
		)
	],
	statements: [],
	bases: []
})

/** A step's declarations: the dropped field's drop, or the renamed field's rename. */
const declaredOf = (m: Model, c: Command): Declarations => {
	const first = m.fields[0]
	if (first === undefined || c === "add") {
		return { renames: [], drops: [] }
	}
	const relation = parsedName("T")
	return c === "drop"
		? { renames: [], drops: [{ kind: "field", relation, field: parsedName(first) }] }
		: {
				renames: [
					{
						from: { kind: "field", relation, field: parsedName(first) },
						to: { kind: "field", relation, field: parsedName(`f${m.minted}`) }
					}
				],
				drops: []
			}
}

/** A migration drafted from its previous snapshot to its target. */
const draft = (previous: DeploySnapshot, m: Model, declared: Declarations): MigrationDraft => {
	const owned = owning(descOf(m))
	const rosters = rostersOf(owned)
	const codes = draftCodebook(
		rosterFates(
			previous,
			declared,
			Arr.map(rosters, (r) => r.closed)
		),
		noRenames,
		rosters,
		spellingsOf(previous)
	)
	if (!codes.ok) {
		return assert.fail("a schema with no roster drafts its codes")
	}
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], codes.value)
		)
	)
	return succeeded(
		draftMigration({ previous, installation, workload: noWorkload, declared, abandoned: [] })
	)
}

/** A program's state after a prefix of its applied commands: the model, and the draft that reached it. */
interface Drafted {
	readonly model: Model
	readonly drafted: MigrationDraft
}

/** Every command, in the order a prefix tries them. */
const commands: ReadonlyArray<Command> = ["add", "drop", "rename"]

/**
 * A prefix of applied commands by its key: the commands in order, each after a space, the table's creation the empty
 * key.
 */
const createdKey = ""

/** The key of `prefix` followed by `c`. */
const extendedKey = (prefix: string, c: Command): string =>
	prefix === createdKey ? c : `${prefix} ${c}`

/** The most commands a program of the box holds (boxGen), so the longest prefix of applied commands. */
const longestProgram = 6

/**
 * Every migration the box drafts, by the key of the prefix of applied commands that reaches it (extendedKey): the table's creation,
 * then each command that applies after each prefix, through every program of up to six commands. Programs and limits
 * share their prefixes, so the box's 5,460 cases draft the same prefixes again and again; built once, when a worker
 * readies the box (the need's open, outside every case's deadline), each prefix is drafted once and a case walks its
 * program's prefixes through it. A draft that fails fails the need's open, and so the property.
 */
export const draftsByPrefix: Need<ReadonlyMap<string, Drafted>> = {
	key: "test/unit/deploy/attnums.fixtures.ts draftsByPrefix",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const created: Drafted = {
			model: initial,
			drafted: draft(emptySnapshot({ schemaName: "Attnums", schema: "attnums" }), initial, {
				renames: [],
				drops: []
			})
		}
		const below = (
			prefix: string,
			length: number,
			at: Drafted
		): ReadonlyArray<readonly [string, Drafted]> =>
			length === longestProgram
				? []
				: Arr.flatMap(
						Arr.filter(commands, (c) => applies(at.model, c)),
						(c: Command): ReadonlyArray<readonly [string, Drafted]> => {
							const next = step(at.model, c)
							const reached: Drafted = {
								model: next,
								drafted: draft(at.drafted.snapshot, next, declaredOf(at.model, c))
							}
							const key = extendedKey(prefix, c)
							return [[key, reached] as const, ...below(key, length + 1, reached)]
						}
					)
		const drafts: ReadonlyMap<string, Drafted> = new Map([
			[createdKey, created] as const,
			...below(createdKey, 0, created)
		])
		return Effect.succeed(drafts)
	})
}

const attnumsOf = (s: DeploySnapshot): number => {
	const t = s.theory.relations["T"]
	return t?.kind === "relation" ? t.attnums : assert.fail("the snapshot records T")
}

export const judge = (
	drafts: ReadonlyMap<string, Drafted>,
	box: Box,
	note: (f: Feature) => void
): void => {
	const draftOf = (prefix: string): Drafted =>
		drafts.get(prefix) ?? assert.fail(`the box drafts the prefix "${prefix}"`)
	let model = initial
	let applied = createdKey
	let snapshot = draftOf(applied).drafted.snapshot
	assert.equal(attnumsOf(snapshot), initial.attnums, "a new table uses one number per column")
	for (const c of box.commands) {
		if (!applies(model, c)) {
			continue
		}
		note(c)
		const next = step(model, c)
		applied = extendedKey(applied, c)
		const drafted = draftOf(applied).drafted
		const at = `${Formatter.format(box)} at ${c}`
		assert.equal(
			attnumsOf(drafted.snapshot),
			next.attnums,
			`${at}: the snapshot records the model's count`
		)
		assert.ok(
			attnumsOf(drafted.snapshot) >= attnumsOf(snapshot),
			`${at}: attribute numbers only grow`
		)
		const { fingerprint: _, ...content } = drafted.snapshot
		const bounded = withAttnums(content, snapshot, drafted.plan, box.limit)
		const past = next.attnums > box.limit
		note(past ? "past the bound" : "within the bound")
		assert.equal(
			bounded.ok,
			!past,
			`${at}: refused under the bound ${box.limit} exactly when ${next.attnums} attribute numbers pass it`
		)
		if (!bounded.ok) {
			assert.equal(
				bounded.error.reason._tag,
				"UnsupportedOperation",
				`${at}: refused as unsupported`
			)
		}
		model = next
		snapshot = drafted.snapshot
	}
}
