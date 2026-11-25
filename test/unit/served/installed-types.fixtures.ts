/** What the properties of installed-types.test.ts read: its spaces, models and helpers. */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen } from "@bjornpagen/testing/gen"
import { Result as Answered, Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { type ServedRefusal, snapshotCompiled } from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { servedSnapshot } from "#compiler/deploy/snapshot/served.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { paramDomainIdentity, paramDomainUses } from "#compiler/physical/ddl/domains.ts"
import { levelChain } from "#compiler/plan/common.ts"
import type { CreateDomain } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledInstallation, compiledSnapshot } from "#test/support/compiled-served.ts"
import { type CaseSketch, caseSketchGen } from "#test/support/oracle/public/generate.ts"
import { type LawLevel, lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	compiledLogin,
	drawnLogin,
	type DrawnSchema,
	type RoleShape,
	rolesOf
} from "#test/support/served-login.ts"
import { declaredBy } from "#test/support/served-reach.ts"

export type Feature =
	| "an uninstalled pattern domain refused"
	| "an uninstalled contract refused"
	| "a dropped program whose parameter types the installation installs, compiled"
	| "a pattern parameter installed, compiled"
	| "a contract parameter outside the base installed, compiled"
	| "a parameter's pattern domain over a field's structural domain"

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
 * What a case aimed at a pending feature keeps of every role: every program, for a parameter type installed and
 * compiled; all but the clocked reads, whose `now` is the one contract outside the base, for an uninstalled contract;
 * the clocked reads alone, for an uninstalled pattern domain, a pattern parameter being a read's.
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

/** What the dropped installation keeps of a case's roles: each role's own, drawn, or one `Kept` for every role. */
type Keeping = Readonly<{ kind: "drawn" }> | Readonly<{ kind: "every role"; kept: Kept }>

/** A case's sketch: its schema's, its law level, and what its installation keeps of its roles. */
type Sketch = readonly [CaseSketch, LawLevel, Keeping]

/** A case's sketch whose installation keeps of its roles what `keeping` says. */
export const sketchGen =
	(keeping: Keeping): Gen<Sketch> =>
	(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen), keeping]

/** The spaces a case aimed at a pending feature `aims` names is drawn from: every role keeping what `aims` says. */
export const aimsAt: ReadonlyArray<readonly [Feature, Gen<Sketch>]> = Arr.map(
	aims,
	([feature, kept]) => [feature, sketchGen({ kind: "every role", kept })] as const
)

/** What the dropped installation keeps of one role, as its case's sketch says. */
export const keptOf = (keeping: Keeping, draw: <A>(generator: Gen<A>) => A): Kept => {
	switch (keeping.kind) {
		case "drawn":
			return draw(keptGen)
		case "every role":
			return keeping.kept
	}
}

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
	const { contract } = type
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

/** A domain's body: its base, its collation and its CHECKs' predicates, its names aside. */
const bodyOf = (d: CreateDomain) => ({
	base: d.base,
	collation: d.collation,
	checks: Arr.map(d.constraints, (c) => c.predicate)
})

/** Whether a compile's refusal is UninstalledDomain. */
const uninstalled = (refusal: ServedRefusal): boolean =>
	isCompileError(refusal.error) && refusal.error.reason._tag === "UninstalledDomain"

/**
 * The property over one case: its login compiled under its own snapshot and under the dropped installation's, each
 * parameter type it casts to installed or the compile refused as UninstalledDomain, and no two installed domains
 * sharing a CHECK body (see the header).
 */
export const castsInstalled = (
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
		const base = succeeded(built.base.content.owned(), "the login's base")
		const owned = succeeded(ownLoginOver(built, base), "the login over its base")
		const needed = neededBy(
			Arr.flatMap(rolesOf(full.success), (r) => declaredBy(r.served, r.compiled)),
			new Set(Rec.keys(base.contracts))
		)
		const { installation } = yield* compiledInstallation(built, base, schema.laws.codes(base))
		const checked = Arr.filter(
			Arr.flatMap(installation.statements, (st) => (st.kind === "createDomain" ? [st] : [])),
			(d) => d.constraints.length > 0
		)
		for (const [i, d] of checked.entries()) {
			const twin = Arr.findFirst(Arr.drop(checked, i + 1), (e) =>
				canonicalEquals(bodyOf(d), bodyOf(e))
			)
			assert.ok(
				Option.isNone(twin),
				`no two installed domains share a CHECK body: ${d.name.name} and ${Option.match(twin, { onNone: () => "", onSome: (e) => e.name.name })}\n${printed()}`
			)
		}
		if (
			Arr.some(
				installation.statements,
				(st) =>
					st.kind === "createDomain" &&
					needed.domains.has(st.name.name) &&
					st.constraints.length === 0
			)
		) {
			note("a parameter's pattern domain over a field's structural domain")
		}
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
			snapshotCompiled({ login: built, owned }, snapshot.success, transactionClock)
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
