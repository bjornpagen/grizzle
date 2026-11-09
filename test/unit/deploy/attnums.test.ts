import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { draftMigration, type MigrationDraft } from "#compiler/deploy/render/generate.ts"
import {
	emptySnapshot,
	noWorkload,
	rosterFates,
	withAttnums
} from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { draftCodebook, noRenames } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { f, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

/**
 * A table's attribute numbers across migrations, drafted with no database: every program of at most six commands (add
 * a field, drop one, rename one) on one table, each against a column bound drawn small, from 2 to 6 (testing doctrine
 * rule 10: PostgreSQL's is 1600, a constant no test reaches by adding columns), exhausted.
 *
 * The oracle is a model of pg_attribute's attribute numbers: a table created with n columns has used n, each added
 * column takes the next, and a dropped or renamed one gives its number back to nothing. Each step's snapshot records
 * the model's count, which only grows, and the draft's attribute numbers are refused under the drawn bound exactly
 * when the model's count passes it, an addition past the bound counting the dropped columns.
 */

/** The commands: a field added under the next fresh name, the first field dropped, the first renamed to a fresh name. */
type Command = "add" | "drop" | "rename"

interface Box {
	readonly commands: ReadonlyArray<Command>
	readonly limit: number
}

type Feature = Command | "within the bound" | "past the bound"

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
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

const boxGen: Gen<Box> = (source) => {
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
	extends: undefined
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

/** Each distinct draft is made once: by its previous snapshot and its target. */
const drafts = new Map<string, MigrationDraft>()

const draft = (previous: DeploySnapshot, m: Model, declared: Declarations): MigrationDraft => {
	const key = canonicalTextOf([previous.fingerprint, m.fields, declared])
	const known = drafts.get(key)
	if (known !== undefined) {
		return known
	}
	const owned = owning(descOf(m))
	const rosters = rostersOf(owned)
	const codes = draftCodebook(
		rosterFates(
			previous,
			declared,
			Arr.map(rosters, (r) => r.closed)
		),
		noRenames,
		rosters
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
	const drafted = succeeded(
		draftMigration({ previous, installation, workload: noWorkload, declared, abandoned: [] })
	)
	drafts.set(key, drafted)
	return drafted
}

const attnumsOf = (s: DeploySnapshot): number => {
	const t = s.theory.relations["T"]
	return t?.kind === "relation" ? t.attnums : assert.fail("the snapshot records T")
}

const judge = (box: Box, note: (f: Feature) => void): void => {
	let model = initial
	let snapshot = draft(emptySnapshot({ schemaName: "Attnums", schema: "attnums" }), initial, {
		renames: [],
		drops: []
	}).snapshot
	assert.equal(attnumsOf(snapshot), initial.attnums, "a new table uses one number per column")
	for (const c of box.commands) {
		if (!applies(model, c)) {
			continue
		}
		note(c)
		const next = step(model, c)
		const drafted = draft(snapshot, next, declaredOf(model, c))
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

describe("a table's attribute numbers", () => {
	it.effect(
		"grow by one per added column and never shrink, every program of at most six adds, drops and renames, an addition past a small bound refused",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/attnums",
						generator: boxGen,
						literal: Formatter.format,
						limit: 6_000,
						box: "every program of one to six commands (add a field, drop the first, rename the first), each under a column bound from 2 to 6",
						oracle: {
							kind: "second-implementation",
							name: "a model of pg_attribute's attribute numbers"
						},
						coverage: requiredInSpace<Feature>(FEATURES),
						caseHang
					},
					(box, c) => Effect.sync(() => judge(box, (feature) => c.note(feature)))
				)
			)
	)
})
