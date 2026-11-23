/** What the properties of work.test.ts read: its spaces, models and helpers. */

import net from "node:net"
import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Layer, Record as Rec } from "effect"
import { served } from "#adapter/public/layer.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import { resolveConfig } from "#cli/config.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	type Statement
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { servedPath } from "#compiler/served/forms.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation, Relation } from "#compiler/types/schema/relation.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { defineConfig } from "#index.ts"
import {
	cliClock,
	cliOver,
	configName,
	offlineConnection,
	offlineOwner
} from "#test/pg/cli/support.ts"
import { callCounts, type CountedFunction } from "#test/support/kernel/calls.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { clusterPool } from "#test/support/pg.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The functions whose calls the guard counts: each the one entry of a whole-schema pass, called a handful of times, so
 * no optimizing compiler folds one call into another. The canonical encoder's own calls are no such entry: a schema's
 * content is levelContent's, a content read again from a description is contentOfDesc's, a
 * description's identity text is descText's, which no builder over a built schema reads, and a literal held to its
 * type's base is literalProblem's, which no closed cell meets at compile.
 */
const sites = Object.freeze({
	descText: { file: "packages/engine/src/ir/desc.ts", name: "descText" },
	literalProblem: { file: "packages/engine/src/ir/expr.ts", name: "literalProblem" },
	levelContent: { file: "packages/engine/src/schema/levels.ts", name: "levelContent" },
	contentOfDesc: { file: "packages/engine/src/schema/levels.ts", name: "contentOfDesc" },
	own: { file: "packages/engine/src/schema/own.ts", name: "ownWith" },
	schemaFingerprint: { file: "packages/engine/src/core/fingerprint.ts", name: "schemaFingerprint" },
	compileLaws: { file: "packages/engine/src/laws/model/model.ts", name: "compileLaws" },
	installBasis: { file: "packages/engine/src/physical/install/plan.ts", name: "installBasis" },
	planBasis: { file: "packages/engine/src/physical/install/plan.ts", name: "planBasis" },
	planClosed: { file: "packages/engine/src/physical/ddl/constants.ts", name: "planClosed" },
	plan: { file: "packages/engine/src/physical/install/plan.ts", name: "planInstallation" },
	installation: {
		file: "packages/engine/src/physical/install/compile.ts",
		name: "installationOver"
	},
	plannedLoginRoles: {
		file: "packages/grizzle/src/adapter/served/login.ts",
		name: "plannedLoginRoles"
	},
	connect: {
		file: "packages/grizzle/src/adapter/migrate/session.ts",
		name: "openMigrationSession"
	}
} satisfies Readonly<Record<string, CountedFunction>>)

type Site = keyof typeof sites

type Counts = Readonly<Record<Site, number>>

export type Dimension = "relations" | "closed rows" | "roles" | "programs"

export const dimensions: Arr.NonEmptyReadonlyArray<Dimension> = [
	"relations",
	"closed rows",
	"roles",
	"programs"
]

/** A point of the box: a dimension, measured at 2·half, 4·half and 6·half. */
interface Point {
	readonly dimension: Dimension
	readonly half: number
}

export const pointGen: Gen<Point> = (s) => ({
	dimension: s.draw(element(dimensions)),
	half: 1
})

/** The size of a generated installation: its relations, its closed relation's rows, its roles and its programs. */
interface Size {
	readonly relations: number
	readonly rows: number
	readonly roles: number
	readonly programs: number
}

/** The installation at `n` of a dimension, every other dimension at its least. */
export const sizeOf = (dimension: Dimension, n: number): Size => {
	const least: Size = { relations: 2, rows: 2, roles: 1, programs: 1 }
	switch (dimension) {
		case "relations":
			return { ...least, relations: n }
		case "closed rows":
			return { ...least, rows: n }
		case "roles":
			return { ...least, roles: n }
		case "programs":
			return { ...least, relations: n, programs: n }
	}
}

type Generated = Relation<string, Record<string, FieldBase>, readonly [string, ...Array<string>]>

/** The schema of a size: its relations keyed by one text pattern, each contained in the one before it, and a closed
 * relation of `rows` rows a relation's rows are held to. */
const schemaOf = (size: Size) => {
	const Ident = str.regex("^[a-z0-9_]{1,64}$")
	const A = closed.ordered("GuardA", ["a0", ...upTo(size.rows - 1, (i) => `a${i + 1}`)])
	const B = closed.ordered("GuardB", ["b0"])
	const Weight = closed.relation(
		"Weight",
		{ a: closedId(A), b: closedId(B), w: pg.integer },
		["a", "b"],
		upTo(size.rows, (i) => ({ a: `a${i}`, b: "b0" as const, w: i }))
	)
	const fields: Record<string, FieldBase> = { id: Ident, parent: Ident, code: Ident }
	const primary: readonly [string, ...Array<string>] = ["id"]
	const ordinary: ReadonlyArray<Generated> = upTo(size.relations, (i) =>
		relationBuilder(`G${i}`, fields, primary, [])
	)
	const Pick = relation("Pick", { id: Ident, a: closedId(A), b: closedId(B) }, ["id"])
	const declared: Record<string, AnyRelation | AnyClosed> = { GuardA: A, GuardB: B, Weight, Pick }
	for (const r of ordinary) {
		declared[r.name] = r
	}
	const statements: ReadonlyArray<Statement> = [
		contained(on(Pick, "a", "b"), on(Weight, "a", "b")),
		...Arr.flatMap(ordinary, (r, i): ReadonlyArray<Statement> => {
			const below = i === 0 ? undefined : ordinary[i - 1]
			return [
				key(on(r, "code")),
				...(below === undefined ? [] : [contained(on(r, "parent"), on(below, "id"))])
			]
		})
	]
	const entries: Record<string, EntryValue> = { GuardA: A, GuardB: B, Pick }
	for (const r of ordinary) {
		entries[r.name] = r
	}
	const written = [...Arr.map(ordinary, (r) => r.name), "Pick"]
	return { declared, statements, ordinary, entries, written }
}

/** The login of a size over its built schema: its full roles, and a workload over the first of keyed lookups. */
const loginOf = (size: Size, base: AnySchema, made: ReturnType<typeof schemaOf>) => {
	const [first, ...rest] = nonEmptyList(
		upTo(size.roles, (i) => role(base, `guard${i}`, made.entries, { write: made.written })),
		"the login's roles"
	)
	const programs = workload(
		first,
		Rec.fromEntries(
			Arr.map(Arr.take(made.ordinary, size.programs), (r) => [`by${r.name}`, r] as const)
		)
	)
	return login(base, "server", [first, ...rest], { workload: [programs] })
}

/** A socket whose connect fails at once, so a command that connects is refused before anything leaves the process. */
class Unreachable extends net.Socket {
	override connect(): this {
		queueMicrotask(() => this.destroy(new Error("unreachable")))
		return this
	}
}

/** The migration identity's connection over an unreachable socket: migrate and drift stop where they connect. */
const unreachable: MigrationConnectionConfig = {
	...offlineOwner,
	transport: { ...offlineOwner.transport, open: () => new Unreachable() }
}

const nextNow = cliClock()

/** What each step of an installation's life counted: the builders, each command, and the layer. */
export interface Steps {
	readonly schema: Counts
	readonly builders: Counts
	readonly generate: Counts
	readonly check: Counts
	readonly migrate: Counts
	readonly drift: Counts
	readonly layer: Counts
}

/**
 * Each step at a size, counted, in a workspace of its own inside the case's directory `dir`: the builders, generate,
 * check, migrate, drift, the layer.
 */
export const stepsAt = (dir: ScratchDir) => (size: Size) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const made = schemaOf(size)
			const [base, schemaCounts] = yield* callCounts(
				Effect.sync((): AnySchema => schema("Guard", Rec.values(made.declared), made.statements)),
				sites
			)
			const [server, builders] = yield* callCounts(
				Effect.sync(() => loginOf(size, base, made)),
				sites
			)
			const config = defineConfig({
				schemas: [base],
				logins: [server],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => unreachable
			})
			const ws = yield* fs.makeTempDirectoryScoped({ directory: dir, prefix: "startup-" })
			const command = (name: "check" | "migrate" | "drift") =>
				callCounts(cliOver(ws, config, [name, configName], nextNow()), sites)
			const [generated, generate] = yield* callCounts(
				cliOver(ws, config, ["generate", configName, "--name", "init"], nextNow()),
				sites
			)
			assert.equal(generated.code, 0, generated.stderr)
			const [checked, check] = yield* command("check")
			assert.equal(checked.code, 0, checked.stderr)
			const [, migrate] = yield* command("migrate")
			const [, drift] = yield* command("drift")
			const resolved = yield* resolveConfig(config, `${ws}/${configName}`)
			const directory = defined(resolved.schemas[0], "the configured schema").directory
			const text = yield* fs.readFileString(`${directory}/${servedPath("server")}`)
			const file = served<typeof server>(trustedJson<unknown>(text), "server")
			const [, layer] = yield* callCounts(
				Effect.scoped(
					Layer.build(
						servedSourcedLayer(offlineDecoders, {
							...offlineConnection,
							pool: clusterPool,
							login: file
						})
					)
				),
				sites
			)
			const steps: Steps = {
				schema: schemaCounts,
				builders,
				generate,
				check,
				migrate,
				drift,
				layer
			}
			return steps
		})
	)

/**
 * The plans generate and check make over the installation's basis, each once (cli/generate.ts plannedLogins,
 * draftInput), since each is planned from what the one before it compiled: the workload's check pass, which no
 * installation stands behind (ParamSource unserved) because the workload's parameter types are its output; the
 * artifacts every served file compiles over, planned from those types, which name the parameters' domains and join
 * their contracts' laws (98340dcf), and which an executor's compile requires (an installation stands behind it); and
 * the draft's installation, under its settings and extensions, among them the served workload compiled over the
 * second.
 */
const commandPlans = [
	"the workload's check pass",
	"the served artifacts",
	"the draft's installation"
] as const

/** The counts a step must make exactly, whatever the size: each site it names, at its count. */
export const exactly: { readonly [S in keyof Steps]: Partial<Counts> } = {
	schema: { levelContent: 1, contentOfDesc: 0, own: 0 },
	builders: { descText: 0, levelContent: 0, contentOfDesc: 0, own: 0, compileLaws: 0 },
	generate: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 1,
		schemaFingerprint: 1,
		compileLaws: 1,
		installBasis: 1,
		planBasis: 0,
		planClosed: 1,
		plan: commandPlans.length,
		installation: 1,
		plannedLoginRoles: 1
	},
	check: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 1,
		schemaFingerprint: 1,
		compileLaws: 1,
		installBasis: 1,
		planBasis: 0,
		planClosed: 1,
		plan: commandPlans.length,
		installation: 1,
		plannedLoginRoles: 1
	},
	migrate: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 0,
		compileLaws: 0,
		installBasis: 0,
		planBasis: 0,
		planClosed: 0,
		plan: 0,
		installation: 0,
		plannedLoginRoles: 0,
		descText: 0,
		connect: 1
	},
	drift: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 0,
		compileLaws: 0,
		installBasis: 0,
		planBasis: 0,
		planClosed: 0,
		plan: 0,
		installation: 0,
		plannedLoginRoles: 0,
		descText: 0,
		connect: 1
	},
	layer: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 0,
		schemaFingerprint: 0,
		compileLaws: 0,
		installBasis: 0,
		planBasis: 0,
		planClosed: 0,
		plan: 0,
		installation: 0,
		plannedLoginRoles: 0
	}
}

export const stepNames: ReadonlyArray<keyof Steps> = [
	"schema",
	"builders",
	"generate",
	"check",
	"migrate",
	"drift",
	"layer"
]

export const siteNames: ReadonlyArray<Site> = Rec.keys(sites)
