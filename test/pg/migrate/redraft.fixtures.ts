/** What the properties of redraft.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { ChunkView } from "@bjornpagen/grizzle-text/chunks"
import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { boolean, constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { readLedger } from "#adapter/migrate/apply.ts"
import type { AppliedEdit, MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { sha256ChunksHex } from "#compiler/core/sha256.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { AbandonedSchema, Declarations } from "#compiler/deploy/diff/plan.ts"
import type { LedgerState } from "#compiler/deploy/ledger/ledger.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { isNoTransaction, noTransactionMarker } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { snapshotGuardName } from "#compiler/physical/ddl/ledger.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	apply,
	kept,
	noFurther,
	openMigrator,
	refusal,
	reviewedSource,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { firstCodes, installedCodes } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	check,
	f,
	field,
	ge,
	key,
	literal,
	on,
	relation,
	value
} from "#test/support/fixtures/ir/desc.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	compile,
	draftCodes,
	draftedAt,
	fromEmptyBeside,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	openTask,
	shopV1,
	shopV2,
	shopV3,
	shopV3Declared,
	shopV4
} from "#test/unit/deploy/schemas.ts"

/**
 * The schema the chain's first draft abandons, as the ledger suite's chain does (test/pg/migrate/ledger.test.ts): every
 * drop is declared, so starting the schema beside it is the one loss a draft leaves to the reviewer.
 */
const abandoned: AbandonedSchema = { schema: "store", directory: "migrations/store" }

/** Shop v1 with Account's name a candidate key. */
const v1Keyed: SchemaDesc = {
	...shopV1,
	statements: [...shopV1.statements, key(on("Account", ["name"]))]
}

/** Shop v1 with AutomaticTask's budget bounded above. */
const v1Bounded: SchemaDesc = {
	...shopV1,
	statements: [
		...shopV1.statements,
		check("BudgetBounded", "AutomaticTask", ge(literal(1000000n), field("budget")))
	]
}

/** Shop v1 with Task declared mutable. */
const v1Mutable: SchemaDesc = { ...shopV1, statements: [...shopV1.statements, ...openTask] }

/** Shop v2 with one of its statements, by index, left out. */
const v2Without = (statement: number): SchemaDesc => ({
	...shopV2,
	statements: Arr.filter(shopV2.statements, (_, i) => i !== statement)
})

/** Shop v2 with its weight check tightened. */
const v2Tightened: SchemaDesc = {
	...shopV2,
	statements: Arr.map(shopV2.statements, (s, i) =>
		i === 3 ? check("WeightNonNegative", "Task", ge(field("weight"), literal(1))) : s
	)
}

/**
 * Shop v2 with AutomaticTask's budget a contract of another name and the definition of v2's Cents, whose domain is named
 * by its definition alone (core/identity.ts contractDomain), as each check of it: every file alike, the target, which
 * records the contract a field is of by its name, not.
 */
const v2BudgetRenamed: SchemaDesc = {
	...shopV2,
	relations: Arr.map(shopV2.relations, (r) =>
		r.name === "AutomaticTask"
			? relation(
					"AutomaticTask",
					{ task: f.uuid, budget: f.contract("Money", f.bigint, ge(value, literal(1n))) },
					["task"]
				)
			: r
	)
}

/** Shop v3 with Task declared mutable. */
const v3Mutable: SchemaDesc = { ...shopV3, statements: [...shopV3.statements, ...openTask] }

/** What a regeneration drafts from: the folder's own source, or the snapshot of Shop v1 declared mutable. */
type From = "its source" | "v1 declared mutable"

/** A regeneration of a folder of the chain: the schema it drafts toward, what it declares, and what it drafts from. */
interface Regeneration {
	readonly name: string
	readonly desc: SchemaDesc
	readonly declared: Declarations
	readonly from: From
}

const toward = (
	name: string,
	desc: SchemaDesc,
	declared: Declarations,
	from: From
): Regeneration => ({ name, desc, declared, from })

/** Each folder's drafted version, what it declares, and its regenerations, the folder's own draft first. */
const folders: ReadonlyArray<{
	readonly desc: SchemaDesc
	readonly declared: Declarations
	readonly regenerations: Arr.NonEmptyReadonlyArray<Regeneration>
}> = [
	{
		desc: shopV1,
		declared: noDeclarations,
		regenerations: [
			toward("its own draft", shopV1, noDeclarations, "its source"),
			toward("v1 keyed", v1Keyed, noDeclarations, "its source"),
			toward("v1 bounded", v1Bounded, noDeclarations, "its source"),
			toward("v1 mutable", v1Mutable, noDeclarations, "its source"),
			toward("v2", shopV2, noDeclarations, "its source")
		]
	},
	{
		desc: shopV2,
		declared: noDeclarations,
		regenerations: [
			toward("its own draft", shopV2, noDeclarations, "its source"),
			toward("v2 tightened", v2Tightened, noDeclarations, "its source"),
			toward("v2 unkeyed", v2Without(2), noDeclarations, "its source"),
			toward("v2 unchecked", v2Without(3), noDeclarations, "its source"),
			toward("v2 immutable", v2Without(4), noDeclarations, "its source"),
			toward("v2 without alternatives", v2Without(1), noDeclarations, "its source"),
			toward("v3", shopV3, noDeclarations, "its source"),
			toward("v2 from v1 mutable", shopV2, noDeclarations, "v1 declared mutable"),
			toward("v2 budget renamed", v2BudgetRenamed, noDeclarations, "its source")
		]
	},
	{
		desc: shopV3,
		declared: shopV3Declared,
		regenerations: [
			toward("its own draft", shopV3, shopV3Declared, "its source"),
			toward("v3 mutable", v3Mutable, shopV3Declared, "its source"),
			toward("v4", shopV4, shopV3Declared, "its source")
		]
	}
]

interface RedraftCase {
	/** The chain's folder left partial, by index. */
	readonly folder: number
	/** Its regeneration, picked among the folder's. */
	readonly regeneration: number
	/** How many of its files commit before its next one is refused, picked from one to all but one. */
	readonly completed: number
	/** Whether the regeneration holds a file more, after its own. */
	readonly added: boolean
	/** Whether the regeneration's next file is refused once. */
	readonly failNext: boolean
}

export const caseGen: Gen<RedraftCase> = (source) => ({
	folder: source.draw(int(0, folders.length - 1)),
	regeneration: source.draw(int(0, 0xffff)),
	completed: source.draw(int(0, 0xffff)),
	added: source.draw(
		weighted<boolean>([
			[4, constant(false)],
			[1, constant(true)]
		])
	),
	failNext: source.draw(boolean)
})

export type Feature =
	| "a regeneration resumed"
	| "a regeneration alike in files resumed"
	| "the started draft resumed"
	| "a resume whose next file runs outside a transaction"
	| "a regeneration's next file refused, its re-record rolled back"
	| "a completed file the regeneration changes refused"
	| "a regeneration of another source refused"
	| "a regeneration of another file count refused"
	| "a regeneration resuming at a no-transaction file refused"

/**
 * The case the generator draws for a turn aiming at a feature (aimed): a folder, a regeneration and a point the drafts
 * reach it at, as the drafts stand (Shop v1's and v2's first files are drafted alike under a key, a check or a mutable
 * declaration more or less, and every file of v2 alike with AutomaticTask's budget a contract of another name, where
 * without Task's mutable declaration the alternatives' containments are judged whole and its files differ, and with
 * Account declared mutable too its immutability guard is dropped; v2 drafted toward from v1 declared mutable holds v2's
 * files; v2's seven files are Setup, Structure, Indexes in a transaction, the tables' declared statistics, Indexes
 * outside one, Validate, Publish and Validate again, so its fourth runs outside a transaction). The features noted are still the outcome's, so a note never claims what the case
 * did not reach.
 */
export const aims: ReadonlyArray<readonly [Feature, RedraftCase]> = [
	[
		"a regeneration resumed",
		{ folder: 0, regeneration: 1, completed: 0, added: false, failNext: false }
	],
	[
		"a regeneration alike in files resumed",
		{ folder: 1, regeneration: 8, completed: 3, added: false, failNext: false }
	],
	[
		"the started draft resumed",
		{ folder: 2, regeneration: 0, completed: 1, added: false, failNext: false }
	],
	[
		"a resume whose next file runs outside a transaction",
		{ folder: 1, regeneration: 0, completed: 2, added: false, failNext: false }
	],
	[
		"a regeneration's next file refused, its re-record rolled back",
		{ folder: 1, regeneration: 1, completed: 0, added: false, failNext: true }
	],
	[
		"a completed file the regeneration changes refused",
		{ folder: 0, regeneration: 4, completed: 0, added: false, failNext: false }
	],
	[
		"a regeneration of another source refused",
		{ folder: 1, regeneration: 7, completed: 0, added: false, failNext: false }
	],
	[
		"a regeneration of another file count refused",
		{ folder: 0, regeneration: 0, completed: 0, added: true, failNext: false }
	],
	[
		"a regeneration resuming at a no-transaction file refused",
		{ folder: 1, regeneration: 8, completed: 2, added: false, failNext: false }
	]
]

/** A statement that fails when it runs (22012). */
const failingStatement = "SELECT 1 / 0;"

/** `text` refused at its first statement: the failing statement first, after a no-transaction file's marker line. */
const refusedFirst = (text: string): string =>
	isNoTransaction(text)
		? Arr.join([noTransactionMarker, failingStatement, ...Str.split(text, "\n").slice(1)], "\n")
		: `${failingStatement}\n${text}`

/** `folder` with its file at `index` refused at its first statement, when it holds one there. */
const refusedAt = (folder: FolderTexts, index: number): FolderTexts => ({
	...folder,
	files: Arr.map(folder.files, (f, i) =>
		i === index ? { ...f, text: chunked(refusedFirst(joined(f.text))) } : f
	)
})

/** `folder` with one file more after its own. */
const withAdded = (folder: FolderTexts): FolderTexts => ({
	...folder,
	files: [
		...folder.files,
		{
			name: `${Str.padStart(2, "0")(String(folder.files.length + 1))}-added.sql`,
			text: chunked("SELECT 1;\n")
		}
	]
})

/** A draft of the shop under `allocated`, each step's codes drafted from the snapshot before it. */
const draftOf = (
	allocated: string,
	desc: SchemaDesc,
	declared: Declarations,
	from: Previous,
	ordinal: number
): { readonly g: GenerateResult; readonly installation: Installation } => {
	const options = {
		schema: atName(allocated),
		extensions: [],
		codes: firstCodes
	}
	const codes = succeeded(draftCodes(desc, from, declared))
	const installation = compile(desc, { ...options, codes: installedCodes(codes) })
	const g = succeeded(
		generate({
			installation,
			timestamp: draftedAt(ordinal),
			previous: from,
			workload: noWorkload,
			declared,
			name: `step_${ordinal}`
		})
	)
	return { g, installation }
}

/**
 * The chain under `allocated` up to the folder at `index`, and that folder's regeneration `r`: the drafts before the
 * folder, the folder's own draft, and the regeneration with its installation.
 */
const draftsOf = (allocated: string, index: number, r: Regeneration) => {
	const empty = fromEmptyBeside([abandoned])
	const before: Array<GenerateResult> = []
	let from: Previous = empty
	for (const i of indices(index)) {
		const step = defined(folders[i])
		const { g } = draftOf(allocated, step.desc, step.declared, from, i + 1)
		before.push(g)
		from = fromSnapshot(g.snapshot)
	}
	const step = defined(folders[index])
	const original = draftOf(allocated, step.desc, step.declared, from, index + 1).g
	const regenerationFrom =
		r.from === "its source"
			? from
			: fromSnapshot(draftOf(allocated, v1Mutable, noDeclarations, empty, 1).g.snapshot)
	const regeneration = draftOf(allocated, r.desc, r.declared, regenerationFrom, index + 1)
	return { before, original, regeneration }
}

/** What the contract says the apply with the regeneration in the folder's place does. */
type Verdict =
	| { readonly kind: "edited"; readonly edits: ReadonlyArray<AppliedEdit> }
	| { readonly kind: "source" }
	| { readonly kind: "count" }
	| { readonly kind: "unverifiable"; readonly file: string }
	| { readonly kind: "resumes" }

/** The verdict, restated over the folder as it ran and the regeneration as the directory holds it (see the header). */
const verdictOf = (
	ran: FolderTexts,
	regeneration: FolderTexts,
	completed: number,
	sourceAlike: boolean
): Verdict => {
	const edits = Arr.flatMap(Arr.take(ran.files, completed), (f, i): ReadonlyArray<AppliedEdit> => {
		const held = regeneration.files[i]
		if (held === undefined || held.name !== f.name) {
			return [{ folder: ran.name, file: f.name, kind: "missing" }]
		}
		return joined(held.text) === joined(f.text)
			? []
			: [{ folder: ran.name, file: f.name, kind: "edited" }]
	})
	if (Arr.isReadonlyArrayNonEmpty(edits)) {
		return { kind: "edited", edits }
	}
	if (!sourceAlike) {
		return { kind: "source" }
	}
	if (regeneration.files.length !== ran.files.length) {
		return { kind: "count" }
	}
	const next = regeneration.files[completed]
	return joined(regeneration.metaText) !== joined(ran.metaText) &&
		next !== undefined &&
		isNoTransaction(new ChunkView(next.text))
		? { kind: "unverifiable", file: next.name }
		: { kind: "resumes" }
}

/** Each refusal at `order` the contract names, by its verdict: the folder's refusal and the feature it reaches. */
const orderRefusals = {
	source: { refusal: "moved", feature: "a regeneration of another source refused" },
	count: { refusal: "resized", feature: "a regeneration of another file count refused" },
	unverifiable: {
		refusal: "redraftUnverifiable",
		feature: "a regeneration resuming at a no-transaction file refused"
	}
} as const satisfies Readonly<
	Record<string, { readonly refusal: string; readonly feature: Feature }>
>

/** The ledger and the schema's catalog, read back. */
const observe = (m: MigrationSession, schema: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const ledger = yield* readLedger(m, schema, succeeded(statementsFor(schema)))
		return { ledger, catalog: yield* readCatalog(substrate.admin, [schema]) }
	})

/** Whether the snapshot guard of `schema` admits `fingerprint`, or the SQLSTATE it refuses it with. */
const guardOf = (schema: string, fingerprint: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const answered = yield* Effect.result(
			substrate.admin.queryValues(
				`SELECT ${quoteIdent(schema)}.${quoteIdent(snapshotGuardName)}($1::text)::text`,
				[fingerprint]
			)
		)
		if (answered._tag === "Success") {
			return "admitted"
		}
		const reason = answered.failure.reason
		return reason._tag === "ServerError" ? reason.fields.code : reason.message
	})

export const runCase = (c: RedraftCase, k: Case<Feature>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const index = c.folder
		const step = defined(folders[index])
		const r = defined(step.regenerations[c.regeneration % step.regenerations.length])
		const allocated = yield* substrate.schema({ create: false, label: "redraft" })
		const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
		const { before, original, regeneration } = draftsOf(allocated, index, r)
		const reviewedBefore = Arr.map(before, (g) => reviewedSource(g, kept))
		const ran = reviewedSource(original, kept)
		const completed = (c.completed % (ran.files.length - 1)) + 1
		const m = yield* openMigrator(substrate, substrate.owner)
		if (Arr.isReadonlyArrayNonEmpty(before)) {
			yield* apply(
				m,
				{
					snapshot: defined(Arr.last(before).pipe(Option.getOrUndefined)).snapshot,
					folders: reviewedBefore
				},
				noFurther
			)
		}
		const stopped = yield* refusal(
			apply(
				m,
				{ snapshot: original.snapshot, folders: [...reviewedBefore, refusedAt(ran, completed)] },
				noFurther
			)
		)
		assert.equal(stopped.stage, "statement", stopped.message)
		const started = yield* observe(m, schema)
		assert.deepEqual(
			Option.fromUndefinedOr(started.ledger.partial).pipe(
				Option.map((p) => ({
					folder: p.folder,
					files: p.completed.length,
					meta: p.meta,
					target: p.target
				}))
			),
			Option.some({
				folder: ran.name,
				files: completed,
				meta: sha256ChunksHex(ran.metaText),
				target: original.snapshot.fingerprint
			}),
			"the folder started under its own draft, its first files recorded"
		)
		const reviewed = reviewedSource(regeneration.g, kept)
		const held = c.added ? withAdded(reviewed) : reviewed
		const directory = (folder: FolderTexts) => ({
			snapshot: regeneration.g.snapshot,
			folders: [...reviewedBefore, folder]
		})
		const verdict = verdictOf(
			ran,
			held,
			completed,
			regeneration.g.folder.meta.source === original.folder.meta.source
		)
		/** A refusal that runs nothing: the ledger and the catalog read back unchanged. */
		const unchanged = (e: MigrateError, stage: MigrateError["stage"]) =>
			Effect.gen(function* () {
				assert.equal(e.stage, stage, e.message)
				const after = yield* observe(m, schema)
				assert.deepEqual(after.ledger, started.ledger, "nothing ran: the ledger")
				assert.deepEqual(after.catalog, started.catalog, "nothing ran: the catalog")
			})
		switch (verdict.kind) {
			case "edited": {
				const e = yield* refusal(apply(m, directory(held), noFurther))
				yield* unchanged(e, "edited")
				assert.ok(e.reason._tag === "AppliedEdited", e.message)
				unorderedEqual(
					e.reason.edits,
					verdict.edits,
					"the completed files the regeneration changes"
				)
				k.note("a completed file the regeneration changes refused")
				return
			}
			case "source":
			case "count":
			case "unverifiable": {
				const e = yield* refusal(apply(m, directory(held), noFurther))
				yield* unchanged(e, "order")
				assert.ok(e.reason._tag === "FolderRefused", e.message)
				const expected = orderRefusals[verdict.kind]
				assert.equal(e.reason.refusal.kind, expected.refusal, e.message)
				if (verdict.kind === "unverifiable") {
					assert.ok(
						e.reason.refusal.kind === "redraftUnverifiable" &&
							e.reason.refusal.file === verdict.file,
						"the refusal names the no-transaction file the regeneration would resume at"
					)
				}
				k.note(expected.feature)
				return
			}
			case "resumes":
				break
		}
		const next = defined(held.files[completed], "the regeneration's next file")
		const redrafted = joined(held.metaText) !== joined(ran.metaText)
		if (c.failNext) {
			const e = yield* refusal(apply(m, directory(refusedAt(held, completed)), noFurther))
			yield* unchanged(e, "statement")
			assert.ok(e.place.kind === "statement" && e.place.file === next.name, e.message)
			if (redrafted) {
				k.note("a regeneration's next file refused, its re-record rolled back")
			}
		}
		const report = yield* apply(m, directory(held), noFurther)
		assert.deepEqual(
			report.applied,
			[
				{
					folder: held.name,
					files: Arr.map(held.files.slice(completed), (f) => f.name),
					resumed: true
				}
			],
			"the folder resumed at its first file without a row"
		)
		const after = yield* observe(m, schema)
		const target = regeneration.g.snapshot.fingerprint
		const expected: LedgerState = {
			latest: target,
			complete: [
				...started.ledger.complete,
				{
					folder: held.name,
					source: regeneration.g.folder.meta.source,
					target,
					files: held.files.length,
					meta: sha256ChunksHex(held.metaText),
					completed: Arr.map(held.files, (f, i) => ({
						ordinal: i + 1,
						file: f.name,
						digest: sha256ChunksHex(f.text)
					}))
				}
			],
			partial: undefined
		}
		assert.deepEqual(after.ledger, expected, "the ledger records the regeneration whole")
		const admitted = yield* guardOf(schema, target)
		assert.equal(admitted, "admitted", "the guard admits the regeneration's target")
		const startedTarget = original.snapshot.fingerprint
		if (startedTarget !== target) {
			const refused = yield* guardOf(schema, startedTarget)
			assert.equal(refused, "55Z01", "the guard refuses the started draft's target")
		}
		const freshAllocated = yield* substrate.schema({ create: false, label: "redraft_fresh" })
		const fresh = draftsOf(freshAllocated, index, r)
		const freshHeld = reviewedSource(fresh.regeneration.g, kept)
		yield* apply(
			m,
			{
				snapshot: fresh.regeneration.g.snapshot,
				folders: [...Arr.map(fresh.before, (g) => reviewedSource(g, kept)), freshHeld]
			},
			noFurther
		)
		yield* sameCatalog(
			regeneration.installation,
			fresh.regeneration.installation,
			"the resumed schema against a fresh install of the regeneration"
		)
		if (redrafted) {
			k.note("a regeneration resumed")
			if (
				Arr.every(held.files, (f, i) => {
					const was = ran.files[i]
					return was !== undefined && joined(was.text) === joined(f.text)
				})
			) {
				k.note("a regeneration alike in files resumed")
			}
		} else {
			k.note("the started draft resumed")
		}
		if (isNoTransaction(new ChunkView(next.text))) {
			k.note("a resume whose next file runs outside a transaction")
		}
	}).pipe(Effect.scoped)
