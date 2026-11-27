/** What the properties of codes.test.ts read: the hole patterns, their probes and templates, and each case's judgment. */
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { type MigrateError } from "#adapter/migrate/errors.ts"
import { type FolderTexts } from "#adapter/migrate/input.ts"
import { identity } from "#compiler/core/identity.ts"
import { type ConstraintName } from "#compiler/core/ids.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { type ParamText } from "#compiler/core/wire.ts"
import { type Declarations } from "#compiler/deploy/diff/plan.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import { type DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { type Codebook } from "#compiler/ir/codes.ts"
import { type ScalarType } from "#compiler/ir/scalar.ts"
import { login } from "#compiler/program/workload/login.ts"
import { bits, pg } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	type AnyRole,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import { hexOfText, setText, setWidth } from "#test/support/closed/bit-text.ts"
import {
	codeAt,
	liveOf,
	type ModelSlot,
	type RosterState,
	sizeOf
} from "#test/support/closed/generate.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { generatedDraft, type Installed, type Version } from "#test/support/install-migrate.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { fromSnapshot, noDeclarations } from "#test/support/migrate/kit.ts"
import { type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import {
	claimsOfNoFact,
	ownerSession,
	Substrate,
	worldSession
} from "#test/support/substrate/substrate.ts"
import { paramText } from "#test/support/wire.ts"

/** A migration of the installed `m` from `previous` to `version`, drafted as `grizzle generate` drafts it and reviewed. */
export interface Drafted {
	readonly plan: RealInstallPlan
	readonly snapshot: DeploySnapshot
	readonly folder: FolderTexts
	readonly codes: Codebook
}

/**
 * The next migration of `m`, from the snapshot `previous` to `version`, as the `ordinal`-th folder of its history,
 * declaring `declared`, drafted as `grizzle generate` drafts it (install-migrate.ts generatedDraft), at its step's
 * instant after the installation's own folder, and reviewed with every loss written in, '0' for each placeholder; its
 * codes the codebook of the snapshot it reaches.
 */
export const draftNext = (
	m: Installed,
	previous: DeploySnapshot,
	version: Version,
	ordinal: number,
	declared: Declarations
) =>
	Effect.map(
		Effect.orDie(
			generatedDraft(
				{ schema: version.schema, logins: version.logins, declarations: declared },
				{
					installation: identity.schema(parsedSchemaName(m.declared)),
					previous: fromSnapshot(previous),
					step: ordinal - 1
				},
				{ kind: "values", value: () => "'0'" }
			)
		),
		(drafted): Drafted => ({
			plan: drafted.plan,
			snapshot: drafted.snapshot,
			folder: drafted.folder,
			codes: codebookOf(drafted.snapshot)
		})
	)

/** Applies `m`'s folders and then `next` as `m`'s owner login, the runner's MigrateError its failure. */
export const applyNext = (m: Installed, next: ReadonlyArray<Drafted>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		const last = Arr.last(next)
		return yield* apply(
			migrator,
			{
				snapshot: Option.isSome(last) ? last.value.snapshot : m.snapshot,
				folders: [...m.folders, ...Arr.map(next, (d) => d.folder)]
			},
			noFurther
		)
	})

/** The first version of `states` installed alone, through its first migration, under a unique name. */
export const installFirst = <B>(
	label: string,
	build: (name: string) => B & { readonly version: Version }
) =>
	Effect.gen(function* () {
		const built: Array<B & { readonly version: Version }> = []
		const m = yield* migrated({
			label,
			schemaName: { kind: "unique" },
			first: (name) => {
				const b = build(name)
				built.push(b)
				return b.version
			},
			later: [],
			apply: { kind: "noPlaceholders" },
			declared: () => noDeclarations,
			observe: noObservation
		})
		return { m, first: defined(built[0], "the first version") }
	})

/** A writer's session in `role`'s world of `m`. */
export const sessionOf = (m: Installed, world: AnyRole, label: string) =>
	Effect.flatMap(Substrate, (substrate) =>
		substrate.session({ ...worldSession(m.world(world), claimsOfNoFact), label })
	)

/** The server's report of a migration's failure, which a test of a refused migration requires. */
export const serverOf = (e: MigrateError) => {
	const server = e.server
	if (server.by !== "server") {
		return assert.fail(`the server reports the failure: ${e.message}`)
	}
	return server.error
}

/** A bits relation's version: roster G of `handles`, Sets of an id and a set over G, written by `writer`. */
export const setsOf = (name: string, state: RosterState) => {
	const roster = closedBuilder(state.closed, liveOf(state), "ordered", [])
	const Sets = relation("Sets", { id: pg.integer, members: bits(roster) }, ["id"])
	const declared: Record<string, AnyRelation | AnyClosed> = { [state.closed]: roster, Sets }
	const base = schema(name, Rec.values(declared), [])
	const writer = role(base, "writer", { Sets }, { insert: ["Sets"] })
	const reader = role(base, "reader", { Sets }, { write: [] })
	const version: Version = { schema: base, logins: [login(base, "desk", [writer, reader])] }
	return { version, writer, reader }
}

/** A set's type over the roster's live handles: the column's codec's type. */
export const setType = (state: RosterState): ScalarType =>
	scalarOf({ kind: "bits", roster: state.closed }, { [state.closed]: liveOf(state) })

/** Handles in one order, so two sets compare as sets. */
export const sortedHandles = (handles: Iterable<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.fromIterable(handles), Order.String)

/** A decoded set's handles in one order; a value of another carrier fails the test. */
export const membersOf = (value: unknown): ReadonlyArray<string> => {
	if (!(value instanceof Set)) {
		return assert.fail("a set column decodes to a Set")
	}
	return sortedHandles(Arr.map(Arr.fromIterable(value), String))
}

/** Every subset of the roster's live handles, in code order: every set a bits value can be. */
export const subsetsOf = (state: RosterState): ReadonlyArray<ReadonlyArray<string>> => {
	const none: ReadonlyArray<ReadonlyArray<string>> = [[]]
	return Arr.reduce(liveOf(state), none, (sets, handle) => [
		...sets,
		...Arr.map(sets, (s) => [...s, handle])
	])
}

/** The model's text of a set: position c is 1 exactly when the set holds code c's handle, every padding bit 0. */
export const modelText = (state: RosterState, members: ReadonlyArray<string>): string =>
	setText(
		sizeOf(state),
		Arr.map(members, (h) => defined(codeAt(state, h), `${h} is live`))
	)

/** The model's wire text of a set: X, then the hex digits of its positional text. */
export const wireText = (state: RosterState, members: ReadonlyArray<string>): ParamText =>
	paramText(`X${hexOfText(modelText(state, members))}`)

/** The type of a column as the catalog holds it: its own type's kind, and its base type formatted with its typmod. */
export const columnTypeOf = (session: RawSession, table: string, column: string) =>
	Effect.gen(function* () {
		const rows = yield* session.values(
			`SELECT t.typtype::text, pg_catalog.format_type(t.typbasetype, t.typtypmod), n.nspname::text, t.typname::text FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace WHERE a.attrelid = $1::text::regclass AND a.attname = $2::text`,
			[table, column]
		)
		const [kind, base, schemaName, name] = trusted<readonly [string, string, string, string]>(
			defined(rows[0], `${table}.${column} exists`)
		)
		return { kind, base, domain: { schema: schemaName, name } }
	})

/** The one CHECK of a domain, by the catalog. */
export const domainCheckOf = (
	session: RawSession,
	domain: { readonly schema: string; readonly name: string }
) =>
	Effect.gen(function* () {
		const rows = yield* session.values(
			`SELECT c.conname::text FROM pg_catalog.pg_constraint AS c WHERE c.contypid = $1::text::regtype AND c.contype = 'c'`,
			[printObjectName(domain)]
		)
		assert.equal(rows.length, 1, `${domain.name} carries one CHECK`)
		return trusted<ConstraintName>(String(defined(rows[0])[0]))
	})

/** The handles one byte of a set's bit string holds: a growth of an installation of so many passes the byte. */
const byteHandles = setWidth(1)

/** The most migrations a bits history takes after its installation (bitsHistoryGen, pastByteHistoryGen). */
const historyMigrations = 2

/** The names a bits history's handles take, in the order a growth adds them, never one again: one for each handle the
 * largest installation holds, a byte's, and one for each migration after it, each of which may be a growth. */
const bitsNames: ReadonlyArray<string> = Array.from(
	{ length: byteHandles + historyMigrations },
	(_, i) => `Flag${i}`
)

/** A migration of a bits history: one handle added after the last code, or one live handle removed. */
type BitsStep = { readonly kind: "grow" } | { readonly kind: "remove"; readonly handle: string }

/** A roster's history: its installation, then its migrations. */
interface BitsHistory {
	readonly installed: RosterState
	readonly steps: ReadonlyArray<BitsStep>
}

/** The state a step leads to: a growth appends the next name live, a removal leaves its code a hole. */
export const stepped = (state: RosterState, step: BitsStep): RosterState => {
	switch (step.kind) {
		case "grow":
			return {
				...state,
				slots: [
					...state.slots,
					{ kind: "live", handle: defined(bitsNames[state.slots.length], "a name to grow by") }
				]
			}
		case "remove":
			return {
				...state,
				slots: nonEmpty(
					Arr.map(state.slots, (slot): ModelSlot =>
						slot.kind === "live" && slot.handle === step.handle
							? { kind: "hole", was: slot.handle }
							: slot
					),
					"a roster's codes"
				)
			}
	}
}

/** The roster of a bits history's installation: its first `size` names, each live. */
const installedOf = (size: number): RosterState => ({
	closed: parsedName("Flags"),
	slots: nonEmpty(
		Arr.map(Arr.take(bitsNames, size), (handle): ModelSlot => ({ kind: "live", handle })),
		"an installation's handles"
	),
	spellings: { plain: 3 }
})

/** A migration of `state`: a removal of one live handle, drawn only beside another live handle, or a growth. */
const bitsStepGen =
	(state: RosterState): Gen<BitsStep> =>
	(source) => {
		const live = liveOf(state)
		return live.length > 1 && source.draw(element(["grow", "remove"] as const)) === "remove"
			? { kind: "remove", handle: source.draw(element(live)) }
			: { kind: "grow" }
	}

/** A history of `installed` through the steps `taken`, then `more` migrations drawn after them. */
const bitsHistoryFrom =
	(installed: RosterState, taken: ReadonlyArray<BitsStep>, more: Gen<number>): Gen<BitsHistory> =>
	(source) => {
		const steps = [...taken]
		let state = Arr.reduce(taken, installed, stepped)
		const count = source.draw(more)
		for (let at = 0; at < count; at += 1) {
			const step = source.draw(bitsStepGen(state))
			steps.push(step)
			state = stepped(state, step)
		}
		return { installed, steps }
	}

/** A history whose every state keeps a live handle: one to a byte's handles installed, then one migration or more. */
const bitsHistoryGen: Gen<BitsHistory> = (source) =>
	source.draw(
		bitsHistoryFrom(installedOf(source.draw(int(1, byteHandles))), [], int(1, historyMigrations))
	)

/** A history that grows past a byte: a byte's handles installed, a growth, then the migrations left after it. */
const pastByteHistoryGen: Gen<BitsHistory> = bitsHistoryFrom(
	installedOf(byteHandles),
	[{ kind: "grow" }],
	int(0, historyMigrations - 1)
)

export type BitsFeature =
	| "a growth past a byte"
	| "a growth within a byte"
	| "a removal refused until the data step"
	| "two migrations"

/**
 * A history as the generator draws it: while a growth past a byte is pending (gen.ts steered), one that grows past it,
 * and otherwise a drawn one; a rotating case is drawn unaimed.
 */
export const bitsHistories = steered<BitsHistory, BitsFeature>((steering) =>
	Option.exists(steering, (pending) => pending.has("a growth past a byte"))
		? pastByteHistoryGen
		: bitsHistoryGen
)

/** A raw session of the migration identity, which owns the installation's schema, for SQL a case runs as the owner. */
export const ownerSessionOf = Effect.flatMap(Substrate, (substrate) =>
	substrate.session({ ...ownerSession(), label: "closed codes owner" })
)
