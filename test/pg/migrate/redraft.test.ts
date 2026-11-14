/**
 * A partial folder resumed under a regeneration, on PostgreSQL 19 (deploy/ledger/decide.ts decideFolder, adapter/migrate
 * apply.ts): the folder drafted again under its name after some of its files committed, the regeneration keeping, or
 * not, the folder's source, its file count and its completed files byte for byte.
 *
 * A case draws a folder of the shop chain (Shop v1 to v3 from the empty snapshot beside an abandoned schema), how many
 * of its files commit before a refused file stops it, a regeneration of it, whether the regeneration holds a file more,
 * and whether the regeneration's next file is refused once. Every regeneration is a real draft, reviewed as the chain's
 * folders are: of the folder's source to a schema that differs from the folder's target by a key, a check, a mutable
 * declaration or an alternative, whose first files grizzle may draft byte for byte alike and whose later files and
 * target differ; to another version, whose first file differs; of another source to the folder's own target; or the
 * folder's own draft again. Which files agree is read off the drafts, never assumed.
 *
 * Oracle: the documented contract, restated over the drafts' texts. A completed file the regeneration does not hold
 * byte for byte at its ordinal refuses the apply at `edited`, naming exactly those files; then another source, or
 * another file count, refuses it at `order`; each refusal runs nothing, the ledger and the catalog read back unchanged.
 * Otherwise the folder resumes at its first file without a row. A next file refused stops it there, and the ledger and
 * the catalog read back unchanged: the re-record of a regeneration rolls back with its file. The rerun completes: every
 * row of the folder records the regeneration's source, target and file count, its folder row the SHA-256 of the
 * regeneration's meta.json and each file row its file's; the ledger's latest target is the regeneration's; the
 * snapshot guard admits the regeneration's target and refuses the started draft's other one; and the schema's catalog
 * is a fresh install's of the chain with the regeneration in the folder's place, drafted under a schema of its own
 * (sameCatalog).
 *
 * Features: each verdict, the regeneration's re-record rolled back with its refused next file, a regeneration of a
 * target alike in files but not in fingerprint, and a resume whose next file runs outside a transaction. A case whose
 * turn aims at one (Case.steering) runs a folder, a regeneration and a point that reach it (aims).
 *
 * Plants (~/.cache/grizzle-release/LEDGERRESUME/plants): redraft-outside-transaction.patch (the re-record runs in a
 * transaction of its own before the next file), partial-digest-unchecked.patch (the partial folder's completed files are
 * not compared with the texts that ran).
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen, int, weighted, constant } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import type { AppliedEdit, MigrateError } from "#adapter/migrate/errors.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import type { AbandonedSchema, Declarations } from "#compiler/deploy/diff/plan.ts"
import type { LedgerState } from "#compiler/deploy/ledger/ledger.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { isNoTransaction, noTransactionMarker } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { snapshotGuardName } from "#compiler/physical/ddl/ledger.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	apply,
	kept,
	noFurther,
	openMigrator,
	refusal,
	reviewedSource,
	sameCatalog
} from "#test/pg/migrate/support.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { firstCodes, installedCodes } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { check, field, ge, key, literal, mutable, on } from "#test/support/fixtures/ir/desc.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	compile,
	draftCodes,
	draftedAt,
	fromEmptyBeside,
	fromSnapshot,
	generate,
	noDeclarations,
	ownedBy,
	type Previous
} from "#test/support/migrate/kit.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { shopV1, shopV2, shopV3, shopV3Declared, shopV4 } from "#test/unit/deploy/schemas.ts"

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
const v1Mutable: SchemaDesc = { ...shopV1, statements: [...shopV1.statements, mutable("Task")] }

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
/** Shop v3 with Task declared mutable. */
const v3Mutable: SchemaDesc = { ...shopV3, statements: [...shopV3.statements, mutable("Task")] }

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
			toward("v2 from v1 mutable", shopV2, noDeclarations, "v1 declared mutable")
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

const caseGen: Gen<RedraftCase> = (source) => ({
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

type Feature =
	| "a regeneration resumed"
	| "a regeneration alike in files resumed"
	| "the started draft resumed"
	| "a resume whose next file runs outside a transaction"
	| "a regeneration's next file refused, its re-record rolled back"
	| "a completed file the regeneration changes refused"
	| "a regeneration of another source refused"
	| "a regeneration of another file count refused"

/**
 * The case a turn aiming at a feature runs (Case.steering): a folder, a regeneration and a point the drafts reach it at,
 * as the drafts stand (Shop v1's and v2's first files are drafted alike under a key, a check or a mutable declaration
 * more or less, and every file of v2 alike without its mutable declaration; v2 drafted toward from v1 declared mutable
 * holds v2's files). The features noted are still the outcome's, so a note never claims what the case did not reach.
 */
const aims: ReadonlyArray<readonly [Feature, RedraftCase]> = [
	[
		"a regeneration resumed",
		{ folder: 0, regeneration: 1, completed: 0, added: false, failNext: false }
	],
	[
		"a regeneration alike in files resumed",
		{ folder: 1, regeneration: 4, completed: 2, added: false, failNext: false }
	],
	[
		"the started draft resumed",
		{ folder: 2, regeneration: 0, completed: 1, added: false, failNext: false }
	],
	[
		"a resume whose next file runs outside a transaction",
		{ folder: 1, regeneration: 0, completed: 1, added: false, failNext: false }
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
	]
]

/** The case a property runs: its drawn one, or the one its turn aims at (aims). */
const aimedCase = (drawnCase: RedraftCase, k: Case<Feature>): RedraftCase =>
	Option.match(
		Option.flatMap(k.steering, (pending) =>
			Arr.findFirst(aims, ([feature]) => pending.aimed(feature))
		),
		{ onNone: () => drawnCase, onSome: ([, aimed]) => aimed }
	)

/** A statement that fails when it runs (22012). */
const failingStatement = "SELECT 1 / 0;"

/** `text` refused at its first statement: the failing statement first, after a no-transaction file's marker line. */
const refusedFirst = (text: string): string =>
	isNoTransaction(text)
		? Arr.join([noTransactionMarker, failingStatement, ...Str.split(text, "\n").slice(1)], "\n")
		: `${failingStatement}\n${text}`

/** `folder` with its file at `index` refused at its first statement, when it holds one there. */
const refusedAt = (folder: FolderSource, index: number): FolderSource => ({
	...folder,
	files: Arr.map(folder.files, (f, i) => (i === index ? { ...f, text: refusedFirst(f.text) } : f))
})

/** `folder` with one file more after its own. */
const withAdded = (folder: FolderSource): FolderSource => ({
	...folder,
	files: [
		...folder.files,
		{
			name: `${Str.padStart(2, "0")(String(folder.files.length + 1))}-added.sql`,
			text: "SELECT 1;\n"
		}
	]
})

/** A draft of the shop under `allocated`, each step's codes drafted from the snapshot before it. */
const draftOf = (
	allocated: string,
	owner: string,
	desc: SchemaDesc,
	declared: Declarations,
	from: Previous,
	ordinal: number
): { readonly g: GenerateResult; readonly installation: Installation } => {
	const options = {
		schema: atName(allocated),
		owner: ownedBy(owner),
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
const draftsOf = (allocated: string, owner: string, index: number, r: Regeneration) => {
	const empty = fromEmptyBeside([abandoned])
	const before: Array<GenerateResult> = []
	let from: Previous = empty
	for (const i of indices(index)) {
		const step = defined(folders[i])
		const { g } = draftOf(allocated, owner, step.desc, step.declared, from, i + 1)
		before.push(g)
		from = fromSnapshot(g.snapshot)
	}
	const step = defined(folders[index])
	const original = draftOf(allocated, owner, step.desc, step.declared, from, index + 1).g
	const regenerationFrom =
		r.from === "its source"
			? from
			: fromSnapshot(draftOf(allocated, owner, v1Mutable, noDeclarations, empty, 1).g.snapshot)
	const regeneration = draftOf(allocated, owner, r.desc, r.declared, regenerationFrom, index + 1)
	return { before, original, regeneration }
}

/** What the contract says the apply with the regeneration in the folder's place does. */
type Verdict =
	| { readonly kind: "edited"; readonly edits: ReadonlyArray<AppliedEdit> }
	| { readonly kind: "source" }
	| { readonly kind: "count" }
	| { readonly kind: "resumes" }

/** The verdict, restated over the folder as it ran and the regeneration as the directory holds it (see the header). */
const verdictOf = (
	ran: FolderSource,
	regeneration: FolderSource,
	completed: number,
	sourceAlike: boolean
): Verdict => {
	const edits = Arr.flatMap(Arr.take(ran.files, completed), (f, i): ReadonlyArray<AppliedEdit> => {
		const held = regeneration.files[i]
		if (held === undefined || held.name !== f.name) {
			return [{ folder: ran.name, file: f.name, kind: "missing" }]
		}
		return held.text === f.text ? [] : [{ folder: ran.name, file: f.name, kind: "edited" }]
	})
	if (Arr.isReadonlyArrayNonEmpty(edits)) {
		return { kind: "edited", edits }
	}
	if (!sourceAlike) {
		return { kind: "source" }
	}
	return regeneration.files.length === ran.files.length ? { kind: "resumes" } : { kind: "count" }
}

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

const runCase = (drawnCase: RedraftCase, k: Case<Feature>) =>
	Effect.gen(function* () {
		const c = aimedCase(drawnCase, k)
		const substrate = yield* Substrate
		const owner = substrate.owner.role
		const index = c.folder
		const step = defined(folders[index])
		const r = defined(step.regenerations[c.regeneration % step.regenerations.length])
		const allocated = yield* substrate.schema({ create: false, label: "redraft" })
		const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
		const { before, original, regeneration } = draftsOf(allocated, owner, index, r)
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
				meta: sha256Hex(ran.metaText),
				target: original.snapshot.fingerprint
			}),
			"the folder started under its own draft, its first files recorded"
		)
		const reviewed = reviewedSource(regeneration.g, kept)
		const held = c.added ? withAdded(reviewed) : reviewed
		const directory = (folder: FolderSource) => ({
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
			case "count": {
				const e = yield* refusal(apply(m, directory(held), noFurther))
				yield* unchanged(e, "order")
				assert.ok(e.reason._tag === "FolderRefused", e.message)
				assert.equal(
					e.reason.refusal.kind,
					verdict.kind === "source" ? "moved" : "resized",
					e.message
				)
				k.note(
					verdict.kind === "source"
						? "a regeneration of another source refused"
						: "a regeneration of another file count refused"
				)
				return
			}
			case "resumes":
				break
		}
		const next = defined(held.files[completed], "the regeneration's next file")
		const redrafted = held.metaText !== ran.metaText
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
					meta: sha256Hex(held.metaText),
					completed: Arr.map(held.files, (f, i) => ({
						ordinal: i + 1,
						file: f.name,
						digest: sha256Hex(f.text)
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
		const fresh = draftsOf(freshAllocated, owner, index, r)
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
			if (Arr.every(held.files, (f, i) => ran.files[i]?.text === f.text)) {
				k.note("a regeneration alike in files resumed")
			}
		} else {
			k.note("the started draft resumed")
		}
		if (isNoTransaction(next.text)) {
			k.note("a resume whose next file runs outside a transaction")
		}
	}).pipe(Effect.scoped)

/** The rotating stream's cases. */
const runs = 12

/** The steered phase's budget, spent only until every feature is reached. */
const steeredCases = 6 * runs

layer(Substrate.layer)("a partial folder resumed under a regeneration", (it) => {
	it.effect(
		`${runs} cases of the rotating stream, steered until every feature is reached: the regeneration resumes exactly when it keeps the folder's source, file count and completed files, its re-record rides its next file, and the result is a fresh install's`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the resume's documented contract, restated over the drafts' texts, against the database read back and a fresh install"
						},
						suite: "migrate/redraft",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a regeneration resumed",
								"a regeneration alike in files resumed",
								"the started draft resumed",
								"a resume whose next file runs outside a transaction",
								"a regeneration's next file refused, its re-record rolled back",
								"a completed file the regeneration changes refused",
								"a regeneration of another source refused",
								"a regeneration of another file count refused"
							],
							{ cases: steeredCases, sense: notesOnly }
						),
						kept: [],
						runs,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					runCase
				)
			)
	)
})
