/**
 * A served compile under a snapshot casts a parameter only to a type the snapshot's installation installs
 * (physical/install/plan.ts ParamSource `recorded`): a program whose parameter is cast to a pattern domain or to the
 * domain of a contract outside the base that the installation does not install is refused where it is compiled, as
 * UninstalledDomain, never by PostgreSQL where it runs (42704, type does not exist).
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level (laws.ts), and logins
 * drawn over them (test/support/served-login.ts liveLoginGen: reads of the case's queries, whose relation parameters
 * take stored headings; a read through the first role's query entry at the key a parameter binds, typed as the entry's
 * key field; perhaps a clocked read, its `now` typed by a contract outside the base), each login is compiled as
 * `grizzle generate` compiles it, and then again under the snapshot.json of an installation serving the same login with
 * some of its programs dropped, as drawn: a role's clocked read, its reads of the case's queries, its reads of its own
 * world.
 *
 * - Oracle: the types the login's programs cast their parameters to, read from its file compiled under its own snapshot
 *   (every parameter its roles' statements declare, test/support/served-reach.ts declaredBy: each pattern parameter's
 *   own pattern domain, at its place, and each contract outside the base down a parameter's type), against the
 *   parameter types the dropped installation's snapshot.json records (derived.params). The compile under that snapshot
 *   is refused as UninstalledDomain exactly when the login casts a parameter to one it lacks, and compiles otherwise.
 * - A login compiles under the snapshot generated with its own workload as far as its parameter types go: no compile of
 *   it there is refused as UninstalledDomain.
 *
 * Plants (~/.cache/grizzle-release/CONTRACTDOMAIN/plants): param-domain-total.patch names a parameter's pattern domain
 * under a recorded installation whatever it installs, so a missing pattern domain compiles; snapshot-params-dropped.patch
 * records no parameter type in snapshot.json, so a login does not compile under its own snapshot.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { type ServedRefusal, snapshotCompiled } from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { servedSnapshot } from "#compiler/deploy/snapshot/served.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { paramDomainIdentity, paramDomainUses } from "#compiler/physical/ddl/domains.ts"
import { levelChain } from "#compiler/plan/common.ts"
import { ownBuilt } from "#compiler/schema/own.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { compiledSnapshot } from "#test/support/compiled-served.ts"
import { caseHang } from "#test/support/limits.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	compiledLogin,
	drawnLogin,
	drawnSchema,
	type DrawnSchema,
	liveLoginGen,
	type RoleShape,
	rolesOf
} from "#test/support/served-login.ts"
import { declaredBy } from "#test/support/served-reach.ts"

type Feature =
	| "an uninstalled pattern domain refused"
	| "an uninstalled contract refused"
	| "a dropped program whose parameter types the installation installs, compiled"
	| "a pattern parameter installed, compiled"
	| "a contract parameter outside the base installed, compiled"

/** Which of a role's programs the dropped installation keeps (see the header). */
interface Kept {
	readonly clocked: boolean
	readonly reads: boolean
	readonly world: boolean
}

const keptGen: Gen<Kept> = (source) => ({
	clocked: source.draw(boolean),
	reads: source.draw(boolean),
	world: source.draw(boolean)
})

/**
 * What a case aimed at a pending feature keeps of every role (Case.steering): every program, for a parameter type
 * installed and compiled; all but the clocked reads, whose `now` is the one contract outside the base, for an
 * uninstalled contract; the clocked reads alone, for an uninstalled pattern domain, a pattern parameter being a read's.
 */
const aims: ReadonlyArray<readonly [Feature, Kept]> = [
	["a pattern parameter installed, compiled", { clocked: true, reads: true, world: true }],
	[
		"a contract parameter outside the base installed, compiled",
		{ clocked: true, reads: true, world: true }
	],
	["an uninstalled contract refused", { clocked: false, reads: true, world: true }],
	["an uninstalled pattern domain refused", { clocked: true, reads: false, world: false }]
]

/** A drawn role and which of its programs the dropped installation keeps. */
interface DrawnRole {
	readonly shape: RoleShape
	readonly kept: Kept
}

/** A role's shape with only the programs its installation keeps. */
const keptShape = ({ shape, kept }: DrawnRole): RoleShape => ({
	...shape,
	clocked: shape.clocked && kept.clocked,
	reads: kept.reads ? shape.reads : [],
	worldReads: kept.world ? shape.worldReads : []
})

/** Whether the dropped installation drops a program of the role. */
const drops = ({ shape, kept }: DrawnRole): boolean =>
	(shape.clocked && !kept.clocked) ||
	(!kept.reads && shape.reads.length > 0) ||
	(!kept.world && shape.worldReads.length > 0)

/** The contracts a value of `type` is checked under, outermost first. */
const contractsOf = (type: ScalarType): ReadonlyArray<string> => {
	const contract = contractOf(type)
	return contract === undefined ? [] : [contract.name, ...contractsOf(contract.base)]
}

/** The types of the columns a parameter binds: a relation's heading's, a scalar's or a clock reading's one. */
const paramTypes = (param: ParamDecl): ReadonlyArray<ScalarType> =>
	param.kind === "relation" ? Arr.map(param.heading, (c) => c.type) : [param.type]

/** The parameter types a set of declarations casts to, in installed terms: pattern domains and outside contracts. */
interface Needed {
	readonly domains: ReadonlySet<string>
	readonly contracts: ReadonlySet<string>
}

/** What the parameters `params` are cast to (Needed), the contracts outside the base `declared` names. */
const neededBy = (params: ReadonlyArray<ParamDecl>, declared: ReadonlySet<string>): Needed => ({
	domains: new Set(
		Arr.map(paramDomainUses(params), (use) =>
			identifierOf(paramDomainIdentity(use.place, use.regex))
		)
	),
	contracts: new Set(
		Arr.filter(Arr.flatMap(Arr.flatMap(params, paramTypes), contractsOf), (c) => !declared.has(c))
	)
})

/** Whether a compile's refusal is UninstalledDomain. */
const uninstalled = (refusal: ServedRefusal): boolean =>
	isCompileError(refusal.error) && refusal.error.reason._tag === "UninstalledDomain"

const property = (
	schema: DrawnSchema,
	level: LawLevel,
	roles: Arr.NonEmptyReadonlyArray<DrawnRole>,
	note: (feature: Feature) => void
) =>
	Effect.gen(function* () {
		const printed = () =>
			`${printCase(schema.case)}\n${Formatter.format(level)}\n${Formatter.format(roles)}`
		const login = drawnLogin(
			schema,
			mapNonEmpty(roles, (r) => r.shape)
		)
		const full = yield* Effect.result(compiledLogin(login, schema.laws.codes))
		if (Answered.isFailure(full)) {
			assert.ok(
				!uninstalled(full.failure),
				`a login compiles under its own snapshot as far as its parameter types go: ${Formatter.format(full.failure)}\n${printed()}`
			)
			return
		}
		const built = defined(builtLogin(login), "the drawn login")
		const base = succeeded(ownBuilt(built.base), "the login's base")
		const owned = succeeded(ownLoginOver(built, base), "the login over its base")
		const needed = neededBy(
			Arr.flatMap(rolesOf(full.success), (r) => declaredBy(r.served, r.compiled)),
			new Set(Rec.keys(base.contracts))
		)
		const dropped = defined(
			builtLogin(drawnLogin(schema, mapNonEmpty(roles, keptShape))),
			"the dropped login"
		)
		const snapshot = yield* Effect.result(compiledSnapshot(dropped, base, schema.laws.codes(base)))
		if (Answered.isFailure(snapshot)) {
			return
		}
		const installed = succeeded(
			servedSnapshot(snapshot.success, levelChain(built.base.desc).length - 1),
			"the dropped installation's snapshot"
		).derived.params
		const installedDomains = new Set(installed.domains)
		const installedContracts = new Set<string>(Arr.map(installed.contracts, (c) => c.name))
		const missingDomains = Arr.filter([...needed.domains], (d) => !installedDomains.has(d))
		const missingContracts = Arr.filter([...needed.contracts], (c) => !installedContracts.has(c))
		const compiled = yield* Effect.result(
			snapshotCompiled({ login: built, owned }, snapshot.success)
		)
		if (missingDomains.length > 0 || missingContracts.length > 0) {
			assert.ok(
				Answered.isFailure(compiled) && uninstalled(compiled.failure),
				`a login casting a parameter to ${Formatter.format([...missingDomains, ...missingContracts])}, which the installation does not install, is refused as UninstalledDomain\n${printed()}`
			)
			if (missingContracts.length === 0) {
				note("an uninstalled pattern domain refused")
			}
			if (missingDomains.length === 0) {
				note("an uninstalled contract refused")
			}
			return
		}
		assert.ok(
			Answered.isSuccess(compiled) || !uninstalled(compiled.failure),
			`a login casting its parameters only to installed types is not refused as UninstalledDomain\n${printed()}`
		)
		if (Answered.isFailure(compiled)) {
			return
		}
		if (Arr.some(roles, drops)) {
			note("a dropped program whose parameter types the installation installs, compiled")
		}
		if (needed.domains.size > 0) {
			note("a pattern parameter installed, compiled")
		}
		if (needed.contracts.size > 0) {
			note("a contract parameter outside the base installed, compiled")
		}
	})

describe("a served compile under a snapshot", () => {
	it.effect("casts a parameter only to a type the snapshot's installation installs", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the parameter types the login declares against those snapshot.json records (derived.params)"
					},
					suite: "unit/served/installed-types",
					draw: drawn((source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"an uninstalled pattern domain refused",
							"an uninstalled contract refused",
							"a dropped program whose parameter types the installation installs, compiled",
							"a pattern parameter installed, compiled",
							"a contract parameter outside the base installed, compiled"
						],
						{ cases: 60, sense: notesOnly }
					),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([sketch, level], notes) =>
					Effect.suspend(() => {
						const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
						const aimed = Option.flatMap(notes.steering, (pending) =>
							Arr.findFirst(aims, ([feature]) => pending.has(feature))
						)
						const roles = mapNonEmpty(notes.draw(liveLoginGen(schema)), (shape) => ({
							shape,
							kept: Option.isSome(aimed) ? aimed.value[1] : notes.draw(keptGen)
						}))
						return property(schema, level, roles, notes.note)
					})
			)
		)
	)
})
