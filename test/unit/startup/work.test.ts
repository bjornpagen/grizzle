import net from "node:net"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, FileSystem, Formatter, Layer, Record as Rec } from "effect"
import { DbLayer } from "#adapter/public/layer.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import { resolveConfig } from "#cli/config.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
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
import { role } from "#compiler/schema/world.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation, Relation } from "#compiler/types/schema/relation.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { defineConfig } from "#index.ts"
import {
	cliClock,
	cliOver,
	configName,
	offlineConnection,
	offlineOwner,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { type CallSite, callCounts } from "#test/support/kernel/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { clusterPool } from "#test/support/pg.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * Startup work, counted and never timed, so no verdict depends on the machine: the calls a schema's build and every
 * command and layer over it make to the schema's encoding and to its compilation, read off V8's call counts
 * (test/support/kernel/calls.ts).
 *
 * - A schema value's content is encoded once, when schema(...) builds it (schema/levels.ts levelContent, the level's
 *   one digest); roles, workloads and the login over it, and every level check they and every command and layer make,
 *   encode it again never, nor read it again from a description (contentOfDesc).
 * - Each statement's canonical text is read once, where the statement is built (schema/statements.ts), and carried in
 *   the level's content: schema(...) reads none, and `grizzle generate`, `grizzle check` and DbLayer.make own the
 *   schema once, reading the texts its content carries (schema/own.ts ownBuilt), none again; generate and check hash
 *   each level's fingerprint (core/fingerprint.ts schemaLevel), the snapshot's encoding of it, and the layer hashes
 *   none, owning the schema under the fingerprints the snapshot records (schema/own.ts ownServed); no level check or
 *   program they compile reads a description's text (descText). They compile its basis once and compile the login's
 *   programs once, through the one path they share (adapter/pool/registry.ts loginRoles): generate and check compile
 *   the installation's basis (its law model and closed constants, physical/install/plan.ts installBasis), packing every
 *   closed relation's cells once (physical/ddl/constants.ts planClosed), plan the installation twice over it, for the
 *   artifacts the programs read and for the draft, and build the draft's DDL once; the layer compiles its plan's basis
 *   from the closed constants' names the snapshot records (planBasis), packs no cell, plans once and builds no DDL.
 * - `grizzle migrate` and `grizzle drift` compile nothing before they connect: they reach the connection
 *   (openMigrationSession) without owning the schema, compiling its basis or a login's programs.
 * - No closed cell is held to its field's base type again where the schema compiles: closed.relation() admitted each
 *   once (ir/desc.ts AdmittedClosedRelation), so the compile's calls of the base check (ir/expr.ts literalProblem) are
 *   as many at twice the closed rows as at the rows.
 * - Every count grows at most linearly in each dimension of the schema and its worlds: relations, closed rows, roles and
 *   workload programs, each compared at n and 2n, as the installation's sizes are (test/unit/laws/scaling.test.ts).
 *
 * The box is exhausted: every dimension at every n from 2 to 3.
 */

/** The bound on growth from n to 2n: linear, with ε for the parts that do not grow. */
const linear = 2.5

/**
 * The functions whose calls the guard counts: each the one entry of a whole-schema pass, called a handful of times, so
 * no optimizing compiler folds one call into another. The canonical encoder's own calls are no such entry: an encoding
 * of a schema's content is levelContent's, a content read again from a description is contentOfDesc's, a
 * description's identity text is descText's, which no builder over a built schema reads, and a literal held to its
 * type's base is literalProblem's, which no closed cell meets at compile.
 */
const sites = {
	descText: { file: "packages/engine/src/ir/desc.ts", name: "descText" },
	literalProblem: { file: "packages/engine/src/ir/expr.ts", name: "literalProblem" },
	levelContent: { file: "packages/engine/src/schema/levels.ts", name: "levelContent" },
	contentOfDesc: { file: "packages/engine/src/schema/levels.ts", name: "contentOfDesc" },
	own: { file: "packages/engine/src/schema/own.ts", name: "ownWith" },
	schemaLevel: { file: "packages/engine/src/core/fingerprint.ts", name: "schemaLevel" },
	compileLaws: { file: "packages/engine/src/laws/model/model.ts", name: "compileLaws" },
	installBasis: { file: "packages/engine/src/physical/install/plan.ts", name: "installBasis" },
	planBasis: { file: "packages/engine/src/physical/install/plan.ts", name: "planBasis" },
	planClosed: { file: "packages/engine/src/physical/ddl/constants.ts", name: "planClosed" },
	plan: { file: "packages/engine/src/physical/install/plan.ts", name: "planInstallation" },
	installation: {
		file: "packages/engine/src/physical/install/compile.ts",
		name: "installationOver"
	},
	loginRoles: { file: "packages/grizzle/src/adapter/served/login.ts", name: "loginRoles" },
	connect: {
		file: "packages/grizzle/src/adapter/migrate/session.ts",
		name: "openMigrationSession"
	}
} satisfies Readonly<Record<string, CallSite>>

type Site = keyof typeof sites
type Counts = Readonly<Record<Site, number>>

type Dimension = "relations" | "closed rows" | "roles" | "programs"

const dimensions: Arr.NonEmptyReadonlyArray<Dimension> = [
	"relations",
	"closed rows",
	"roles",
	"programs"
]

interface Point {
	readonly dimension: Dimension
	readonly n: number
}

const pointGen: Gen<Point> = (s) => ({
	dimension: s.draw(element(dimensions)),
	n: s.draw(int(2, 3))
})

/** The size of a generated installation: its relations, its closed relation's rows, its roles and its programs. */
interface Size {
	readonly relations: number
	readonly rows: number
	readonly roles: number
	readonly programs: number
}

/** The installation at `n` of a dimension, every other dimension at its least. */
const sizeOf = (dimension: Dimension, n: number): Size => {
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
	const A = closed("GuardA", ["a0", ...upTo(size.rows - 1, (i) => `a${i + 1}`)])
	const B = closed("GuardB", ["b0"])
	const Weight = closed.relation(
		"Weight",
		{ a: closedId(A), b: closedId(B), w: pg.integer },
		["a", "b"],
		upTo(size.rows, (i) => ({ a: `a${i}`, b: "b0" as const, w: i }))
	)
	const fields: Record<string, FieldBase> = { id: Ident, parent: Ident, code: Ident }
	const primary: readonly [string, ...Array<string>] = ["id"]
	const ordinary: ReadonlyArray<Generated> = upTo(size.relations, (i) =>
		relation(`G${i}`, fields, primary)
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
		upTo(size.roles, (i) =>
			role(base, `guard${i}`, made.entries, { write: made.written, refresh: [] })
		),
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
interface Steps {
	readonly schema: Counts
	readonly builders: Counts
	readonly generate: Counts
	readonly check: Counts
	readonly migrate: Counts
	readonly drift: Counts
	readonly layer: Counts
}

/** Each step at a size, counted, in a workspace of its own: the builders, generate, check, migrate, drift, the layer. */
const stepsAt = (size: Size) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const made = schemaOf(size)
			const [base, schemaCounts] = yield* callCounts(
				Effect.sync((): AnySchema => schema("Guard", made.declared, made.statements)),
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
				connection: () => unreachable
			})
			const ws = yield* workspace("startup")
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
			const text = yield* fs.readFileString(`${directory}/${snapshotFileName}`)
			const [, layer] = yield* callCounts(
				Effect.scoped(
					Layer.build(
						DbLayer.make({
							...offlineConnection,
							pool: clusterPool,
							login: server,
							snapshot: snapshotJson(text)
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

/** The counts a step must make exactly, whatever the size: each site it names, at its count. */
const exactly: { readonly [S in keyof Steps]: Partial<Counts> } = {
	schema: { levelContent: 1, contentOfDesc: 0, own: 0 },
	builders: { descText: 0, levelContent: 0, contentOfDesc: 0, own: 0, compileLaws: 0 },
	generate: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 1,
		schemaLevel: 1,
		compileLaws: 1,
		installBasis: 1,
		planBasis: 0,
		planClosed: 1,
		plan: 2,
		installation: 1,
		loginRoles: 1
	},
	check: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 1,
		schemaLevel: 1,
		compileLaws: 1,
		installBasis: 1,
		planBasis: 0,
		planClosed: 1,
		plan: 2,
		installation: 1,
		loginRoles: 1
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
		loginRoles: 0,
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
		loginRoles: 0,
		descText: 0,
		connect: 1
	},
	layer: {
		levelContent: 0,
		contentOfDesc: 0,
		own: 1,
		schemaLevel: 0,
		compileLaws: 1,
		installBasis: 0,
		planBasis: 1,
		planClosed: 0,
		plan: 1,
		installation: 0,
		loginRoles: 1
	}
}

const stepNames: ReadonlyArray<keyof Steps> = [
	"schema",
	"builders",
	"generate",
	"check",
	"migrate",
	"drift",
	"layer"
]

const siteNames: ReadonlyArray<Site> = Rec.keys(sites)

layer(NodeServices.layer, { excludeTestServices: true })("startup work", (it) => {
	it.effect(
		"reads a schema's content once, compiles it once per command and layer, nothing for migrate or drift, and grows linearly",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/startup/work",
						generator: pointGen,
						literal: Formatter.format,
						limit: dimensions.length * 2,
						coverage: requiredInSpace<Dimension>(dimensions),
						caseHang
					},
					(point, c) =>
						Effect.gen(function* () {
							c.note(point.dimension)
							const small = yield* stepsAt(sizeOf(point.dimension, point.n))
							const large = yield* stepsAt(sizeOf(point.dimension, 2 * point.n))
							const at = `${point.dimension} at ${point.n} against ${2 * point.n}`
							for (const step of stepNames) {
								for (const site of siteNames) {
									const want = exactly[step][site]
									if (want !== undefined) {
										assert.equal(small[step][site], want, `${at}: ${step} calls ${site}`)
										assert.equal(large[step][site], want, `${at}: ${step} calls ${site}`)
									}
									assert.ok(
										large[step][site] <= linear * Math.max(small[step][site], 1),
										`${at}: ${step}'s calls of ${site} grow from ${small[step][site]} to ${large[step][site]}`
									)
								}
							}
							if (point.dimension === "closed rows") {
								for (const step of ["generate", "check", "layer"] as const) {
									assert.equal(
										large[step].literalProblem,
										small[step].literalProblem,
										`${at}: ${step} holds no closed cell to its base type again`
									)
								}
							}
							for (const steps of [small, large]) {
								for (const step of ["generate", "check", "layer"] as const) {
									assert.equal(
										steps[step].descText,
										steps.schema.descText,
										`${at}: ${step} reads no statement's text its statements carry from their build, as schema(...) reads none, and no description's text beside`
									)
								}
							}
						})
				)
			)
	)
})
