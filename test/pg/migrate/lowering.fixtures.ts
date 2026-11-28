/** What the properties of lowering.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import {
	type DraftedVersion,
	draftVersion,
	expectFreshCatalog,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	fromEmpty,
	fromSnapshot,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import {
	type Aim,
	apply,
	checkedAdmission,
	openMigrator
} from "#test/support/pg/migrate/support.ts"
import { attemptChecked } from "#test/support/substrate.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The kinds a version's selection of Doc fixes. */
const kinds = [0, 1] as const

type Kind = (typeof kinds)[number]

/** D's shape at a version (see the header). */
const shapes = ["selection", "union", "negated", "doc", "none"] as const

type Shape = (typeof shapes)[number]

interface Version {
	readonly shape: Shape
	readonly kind: Kind
}

/** The stored rows: Doc's (node, kind), Extra's nodes and Use's docs, each Use row's id its place. */
interface Rows {
	readonly docs: ReadonlyArray<readonly [number, Kind]>
	readonly extras: ReadonlyArray<number>
	readonly uses: ReadonlyArray<number>
}

/** How the later versions are applied: each alone, or the last two as one apply, Use renamed to Usage in the last. */
type Applied = "each alone" | "the last two together"

interface WalkCase {
	readonly versions: readonly [Version, Version, Version]
	readonly rows: Rows
	readonly applied: Applied
}

const versionGen: Gen<Version> = (s) => ({
	shape: s.draw(element(shapes)),
	kind: s.draw(element(kinds))
})

const nodes = 4

const rowsGen: Gen<Rows> = (s) => ({
	docs: Arr.dedupeWith(
		s.draw(
			array((d) => [d.draw(int(0, nodes - 1)), d.draw(element(kinds))] as const, {
				min: 0,
				max: nodes
			})
		),
		(a, b) => a[0] === b[0]
	),
	extras: Arr.dedupe(s.draw(array(int(0, nodes - 1), { min: 0, max: nodes }))),
	uses: s.draw(array(int(0, nodes), { min: 0, max: 4 }))
})

export const caseGen: Gen<WalkCase> = (s) => ({
	versions: [s.draw(versionGen), s.draw(versionGen), s.draw(versionGen)],
	rows: s.draw(rowsGen),
	applied: s.draw(boolean) ? "the last two together" : "each alone"
})

/** The docs a version's rule admits a Use row's doc among, none for no rule. */
const targetsOf = (rows: Rows, version: Version): Option.Option<ReadonlySet<number>> => {
	const selected = Arr.flatMap(rows.docs, ([node, kind]) => (kind === version.kind ? [node] : []))
	switch (version.shape) {
		case "selection":
			return Option.some(new Set(selected))
		case "union":
			return Option.some(new Set([...selected, ...rows.extras]))
		case "negated":
			return Option.some(new Set(Arr.filter(selected, (node) => !rows.extras.includes(node))))
		case "doc":
			return Option.some(new Set(Arr.map(rows.docs, ([node]) => node)))
		case "none":
			return Option.none()
	}
}

/** Whether Use rows naming `uses` keep a version's rule. */
const keeps = (rows: Rows, uses: ReadonlyArray<number>, version: Version): boolean =>
	Option.match(targetsOf(rows, version), {
		onNone: () => true,
		onSome: (targets) => Arr.every(uses, (doc) => targets.has(doc))
	})

/** The name Use goes by at step `step` of a case: Usage in the last when the last two apply together. */
const useName = (c: WalkCase, step: number): "Use" | "Usage" =>
	c.applied === "the last two together" && step === 2 ? "Usage" : "Use"

const Doc = relation("Doc", { node: int4, kind: int4 }, ["node"])

const Extra = relation("Extra", { node: int4 }, ["node"])

const Use = relation("Use", { id: int4, doc: int4 }, ["id"])

const Usage = relation("Usage", { id: int4, doc: int4 }, ["id"])

/** The version `version` under `name`, with Use contained in D or in nothing. */
const withUseDerived = (name: string, version: Version) => {
	const Base = schema(name, [Doc, Extra, Use], [])
	const selected = query(Base).rule((r) => {
		const { node } = v(Doc, "d")
		return r.match(Doc, { node, kind: version.kind }).find({ node })
	})
	const D = derived(
		"D",
		version.shape === "union"
			? selected.rule((r) => {
					const { node } = v(Extra, "e")
					return r.match(Extra, { node }).find({ node })
				})
			: version.shape === "negated"
				? query(Base).rule((r) => {
						const { node } = v(Doc, "d")
						return r
							.match(Doc, { node, kind: version.kind })
							.where(r.not(Extra, { node }))
							.find({ node })
					})
				: selected
	)
	return version.shape === "none"
		? schema.extend([Base], `${name}_1`, [D], [])
		: schema.extend([Base], `${name}_1`, [D], [contained(on(Use, "doc"), on(D, "node"))])
}

/** The version `version` under `name`, with Use contained in Doc, D a selection no law reads. */
const withUseStored = (name: string, version: Version) => {
	const Base = schema(name, [Doc, Extra, Use], [contained(on(Use, "doc"), on(Doc, "node"))])
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { node } = v(Doc, "d")
			return r.match(Doc, { node, kind: version.kind }).find({ node })
		})
	)
	return schema.extend([Base], `${name}_1`, [D], [])
}

/** The version `version` under `name`, with Usage contained in D or in nothing. */
const withUsageDerived = (name: string, version: Version) => {
	const Base = schema(name, [Doc, Extra, Usage], [])
	const selected = query(Base).rule((r) => {
		const { node } = v(Doc, "d")
		return r.match(Doc, { node, kind: version.kind }).find({ node })
	})
	const D = derived(
		"D",
		version.shape === "union"
			? selected.rule((r) => {
					const { node } = v(Extra, "e")
					return r.match(Extra, { node }).find({ node })
				})
			: version.shape === "negated"
				? query(Base).rule((r) => {
						const { node } = v(Doc, "d")
						return r
							.match(Doc, { node, kind: version.kind })
							.where(r.not(Extra, { node }))
							.find({ node })
					})
				: selected
	)
	return version.shape === "none"
		? schema.extend([Base], `${name}_1`, [D], [])
		: schema.extend([Base], `${name}_1`, [D], [contained(on(Usage, "doc"), on(D, "node"))])
}

/** The version `version` under `name`, with Usage contained in Doc, D a selection no law reads. */
const withUsageStored = (name: string, version: Version) => {
	const Base = schema(name, [Doc, Extra, Usage], [contained(on(Usage, "doc"), on(Doc, "node"))])
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { node } = v(Doc, "d")
			return r.match(Doc, { node, kind: version.kind }).find({ node })
		})
	)
	return schema.extend([Base], `${name}_1`, [D], [])
}

/** The version `version` under `name`, its source relation named `use`. */
const schemaOf = (name: string, use: "Use" | "Usage", version: Version) =>
	use === "Use"
		? version.shape === "doc"
			? withUseStored(name, version)
			: withUseDerived(name, version)
		: version.shape === "doc"
			? withUsageStored(name, version)
			: withUsageDerived(name, version)

/** What a step declares: the rename of Use to Usage at the step that takes it. */
const declaredAt = (c: WalkCase, step: number): Declarations =>
	step > 0 && useName(c, step) !== useName(c, step - 1)
		? {
				renames: [
					{
						from: { kind: "relation", relation: parsedName(useName(c, step - 1)) },
						to: { kind: "relation", relation: parsedName(useName(c, step)) }
					}
				],
				drops: []
			}
		: noDeclarations

/** The law over Use at a plan: the one rule or containment, none for a version with no law over it. */
const ruleLawOf = (plan: RealInstallPlan) =>
	Option.map(
		Arr.findFirst(
			plan.installation.laws.theory.laws,
			(law) => law.detail.kind === "rule" || law.detail.kind === "containment"
		),
		(law) => law.id
	)

/** Whether a plan holds its law over Use by foreign keys: it has one, and the law model triggers none for it. */
const lowered = (plan: RealInstallPlan): boolean =>
	Option.exists(ruleLawOf(plan), (id) =>
		Arr.every(plan.installation.laws.rules, (rule) => rule.law.id !== id)
	)

/**
 * How a migration's refusal names its law: by migrate's own reading of the refused constraint through its folder's laws
 * (`folder`), or by a violation check, which raises under the law's identity (`check`).
 */
type Naming = "folder" | "check"

/** The law a migration's refusal names, and how it names it (Naming). */
interface Named {
	readonly law: string
	readonly by: Naming
}

/** Every law a migration's refusal names (Named), none for a refusal that names none. */
const namedLaws = (failure: MigrateError): ReadonlyArray<Named> => {
	const reason = failure.reason
	const named = (laws: ReadonlyArray<string>, by: Naming): ReadonlyArray<Named> =>
		Arr.map(laws, (law) => ({ law, by }))
	if (reason._tag === "FileCommitRefused") {
		return named(reason.laws, "folder")
	}
	if (reason._tag !== "StatementFailed") {
		return []
	}
	return Arr.isReadonlyArrayNonEmpty(reason.laws)
		? named(reason.laws, "folder")
		: reason.failure._tag === "ServerError" && reason.failure.sqlstate === "23000"
			? named(Option.toArray(Option.fromUndefinedOr(reason.failure.constraint)), "check")
			: []
}

/** The folder a migration's refusal names, by its step's place, none for any other failure. */
const refusedFolder = (failure: MigrateError): Option.Option<string> => {
	const reason = failure.reason
	return reason._tag === "StatementFailed" || reason._tag === "FileCommitRefused"
		? Option.some(reason.folder)
		: Option.none()
}

export type Feature =
	| "triggers to foreign keys applied over stored rows"
	| "foreign keys to triggers applied over stored rows"
	| "a lowered rule's constant changed over stored rows"
	| "a lowered rule's constant changed over stored rows that break it, refused naming its law"
	| "triggers to foreign keys over stored rows that break them, refused naming the law"
	| "a lowered rule added over stored rows that break it, refused naming its law"
	| "a stored containment added over stored rows that break it, refused naming its law"
	| "a triggered rule added over stored rows that break it, refused naming its law"
	| "an intermediate folder refused, two pending"
	| "an intermediate folder's foreign key refused, two pending, named by its own laws"
	| "a refused write names the law by its foreign key"
	| "a refused write names the law by its trigger"

export const walk = (c: WalkCase, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: "lowering" })
		const installation = identity.schema(parsedSchemaName(name))
		const schemaIdent = identifierOf(installation)
		const tableOf = (relationName: string) =>
			`${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`
		const session = yield* substrate.session({ ...ownerSession(), label: "owner lowering" })
		const ownerLogin = yield* ambientOwner(ordinarySession, [schemaIdent])
		const migrator = yield* openMigrator(substrate, ownerLogin.credentials)
		const [first] = c.versions
		const stored: Rows = {
			...c.rows,
			uses: Arr.filter(c.rows.uses, (doc) => keeps(c.rows, [doc], first))
		}
		const drafted: Array<DraftedVersion> = []
		let previous: Previous = fromEmpty
		let applied: { readonly version: Version; readonly plan: RealInstallPlan } | undefined
		for (const [step, version] of c.versions.entries()) {
			const draft = yield* draftVersion(
				{
					schema: schemaOf(name, useName(c, step), version),
					declarations: declaredAt(c, step)
				},
				{ installation, previous, step },
				{ extensions: [], compile: compileInstallation, review: noPlaceholders }
			)
			const plan = draft.plan
			drafted.push(draft)
			previous = fromSnapshot(draft.snapshot)
			if (step === 1 && c.applied === "the last two together") {
				continue
			}
			const folders = Arr.map(drafted, (d) => d.folder)
			const outcome = yield* Effect.result(
				apply(
					migrator,
					{ snapshot: draft.snapshot, folders },
					checkedAdmission(plan.installation, substrate.admin)
				)
			)
			const pending = step === 2 && c.applied === "the last two together" ? [1, 2] : [step]
			const breaking = Arr.findFirst(
				pending,
				(at) => !keeps(stored, stored.uses, Arr.getUnsafe(c.versions, at))
			)
			if (outcome._tag === "Failure") {
				const failure = outcome.failure
				if (Option.isNone(breaking)) {
					return assert.fail(
						`step ${step + 1} failed where the stored rows keep every rule it reaches: ${failure.message}\n${Formatter.format(c)}`
					)
				}
				const at = breaking.value
				const atDraft = Arr.getUnsafe(drafted, at)
				const atPlan = atDraft.plan
				const law = ruleLawOf(atPlan)
				const named = namedLaws(failure)
				assert.ok(
					Option.exists(refusedFolder(failure), (folder) => folder === atDraft.folder.name),
					`the refusal names the folder of step ${at + 1}, the first whose rule the rows break: ${failure.message}`
				)
				assert.ok(
					Option.exists(law, (id) => Arr.some(named, (n) => n.law === id)),
					`the refusal names the law over Use of the folder it refuses: ${failure.message}`
				)
				if (at === step) {
					const before = at === 0 ? first : Arr.getUnsafe(c.versions, at - 1)
					const beforePlan = Arr.getUnsafe(drafted, Math.max(0, at - 1)).plan
					const flipped = Option.exists(ruleLawOf(beforePlan), (id) =>
						Option.exists(law, (other) => other === id)
					)
					if (flipped && lowered(atPlan) && !lowered(beforePlan)) {
						note(
							"triggers to foreign keys over stored rows that break them, refused naming the law"
						)
					}
					if (
						flipped &&
						lowered(atPlan) &&
						lowered(beforePlan) &&
						before.shape === "selection" &&
						before.kind !== Arr.getUnsafe(c.versions, at).kind
					) {
						note(
							"a lowered rule's constant changed over stored rows that break it, refused naming its law"
						)
					}
					if (before.shape === "none") {
						note(
							!lowered(atPlan)
								? "a triggered rule added over stored rows that break it, refused naming its law"
								: Arr.getUnsafe(c.versions, at).shape === "doc"
									? "a stored containment added over stored rows that break it, refused naming its law"
									: "a lowered rule added over stored rows that break it, refused naming its law"
						)
					}
				} else {
					note("an intermediate folder refused, two pending")
					if (Arr.some(named, (n) => n.by === "folder")) {
						note("an intermediate folder's foreign key refused, two pending, named by its own laws")
					}
				}
				return
			}
			if (Option.isSome(breaking)) {
				return assert.fail(
					`step ${step + 1} applied though the stored rows break the rule of step ${breaking.value + 1}\n${Formatter.format(c)}`
				)
			}
			if (step === 0) {
				const statements = [
					...Arr.map(
						stored.docs,
						([node, kind]) => `INSERT INTO ${tableOf("Doc")} (node, kind) VALUES (${node}, ${kind})`
					),
					...Arr.map(
						stored.extras,
						(node) => `INSERT INTO ${tableOf("Extra")} (node) VALUES (${node})`
					),
					...Arr.map(
						stored.uses,
						(doc, id) => `INSERT INTO ${tableOf("Use")} (id, doc) VALUES (${id + 1}, ${doc})`
					)
				]
				yield* transaction(substrate.admin, statements)
			} else if (applied !== undefined) {
				const now = lowered(plan)
				const was = lowered(applied.plan)
				const sameLaw = Option.exists(ruleLawOf(applied.plan), (id) =>
					Option.exists(ruleLawOf(plan), (other) => other === id)
				)
				if (sameLaw && was !== now) {
					note(
						now
							? "triggers to foreign keys applied over stored rows"
							: "foreign keys to triggers applied over stored rows"
					)
				}
				if (
					sameLaw &&
					now &&
					was &&
					applied.version.shape === "selection" &&
					version.shape === "selection" &&
					applied.version.kind !== version.kind &&
					stored.docs.length > 0
				) {
					note("a lowered rule's constant changed over stored rows")
				}
			}
			applied = { version, plan }
			yield* expectFreshCatalog(plan.installation, folders, draft.planned)
			const law = ruleLawOf(plan)
			if (Option.isSome(law)) {
				const use = useName(c, step)
				const refused = yield* attemptChecked(
					session,
					[`INSERT INTO ${tableOf(use)} (id, doc) VALUES (100, ${nodes + 9})`],
					Effect.void
				)
				if (refused.kind !== "refused" || refused.fields.code !== "23503") {
					return assert.fail(
						`step ${step + 1}: a Use row naming no doc is not refused with 23503\n${Formatter.format(c)}`
					)
				}
				const table = plan.installation.names.relation(use).name
				const reported = refused.fields.constraint
				assert.ok(
					reported !== undefined &&
						Arr.contains(
							lawsOfConstraint(
								draft.snapshot.constraintToLaw,
								{ kind: "table", name: table },
								reported
							) ?? [],
							law.value
						),
					`step ${step + 1}: the refusing constraint ${String(reported)} reads as the law ${law.value}`
				)
				note(
					lowered(plan)
						? "a refused write names the law by its foreign key"
						: "a refused write names the law by its trigger"
				)
			}
		}
	})

/** A case that adds the law of `shape` over a stored Use row its first version admits and the second's law breaks. */
const addedOver =
	(shape: Shape): Gen<WalkCase> =>
	(s) => ({
		versions: [
			{ shape: "none", kind: s.draw(element(kinds)) },
			{ shape, kind: s.draw(element(kinds)) },
			s.draw(versionGen)
		],
		rows: { docs: [], extras: [], uses: [s.draw(int(0, nodes))] },
		applied: "each alone"
	})

/** A case of three versions, the first two `first` and `second`, the second at the first's kind or the other, over `rows`. */
const pathOver =
	(
		first: Shape,
		second: Shape,
		constant: "same kind" | "other kind",
		rows: (kind: Kind) => Rows
	): Gen<WalkCase> =>
	(s) => {
		const kind = s.draw(element(kinds))
		const other: Kind = kind === 0 ? 1 : 0
		return {
			versions: [
				{ shape: first, kind },
				{ shape: second, kind: constant === "same kind" ? kind : other },
				s.draw(versionGen)
			],
			rows: rows(kind),
			applied: "each alone"
		}
	}

/** The cases each required situation is aimed at while it is pending: the generator draws the one a case's turn aims
 * at (aimed) in place of its plain draw. */
export const aims: ReadonlyArray<Aim<WalkCase, Feature>> = [
	[
		"a stored containment added over stored rows that break it, refused naming its law",
		addedOver("doc")
	],
	[
		"a triggered rule added over stored rows that break it, refused naming its law",
		(s) => s.draw(addedOver(s.draw(element(["union", "negated"] as const))))
	],
	[
		"a lowered rule added over stored rows that break it, refused naming its law",
		addedOver("selection")
	],
	[
		"triggers to foreign keys applied over stored rows",
		pathOver("union", "selection", "same kind", (kind) => ({
			docs: [
				[0, kind],
				[1, kind]
			],
			extras: [],
			uses: [0, 1]
		}))
	],
	[
		"foreign keys to triggers applied over stored rows",
		(s) =>
			s.draw(
				pathOver(
					"selection",
					s.draw(element(["union", "negated"] as const)),
					"same kind",
					(kind) => ({
						docs: [[0, kind]],
						extras: [],
						uses: [0]
					})
				)
			)
	],
	[
		"a lowered rule's constant changed over stored rows",
		pathOver("selection", "selection", "other kind", () => ({
			docs: [
				[0, 0],
				[1, 1]
			],
			extras: [],
			uses: []
		}))
	],
	[
		"a lowered rule's constant changed over stored rows that break it, refused naming its law",
		pathOver("selection", "selection", "other kind", (kind) => ({
			docs: [[0, kind]],
			extras: [],
			uses: [0]
		}))
	],
	[
		"an intermediate folder refused, two pending",
		(s) => ({
			...s.draw(addedOver(s.draw(element(["selection", "union", "doc"] as const)))),
			applied: "the last two together"
		})
	],
	[
		"an intermediate folder's foreign key refused, two pending, named by its own laws",
		(s) => ({
			...s.draw(addedOver(s.draw(element(["selection", "doc"] as const)))),
			applied: "the last two together"
		})
	],
	[
		"triggers to foreign keys over stored rows that break them, refused naming the law",
		pathOver("union", "selection", "same kind", () => ({ docs: [], extras: [0], uses: [0] }))
	]
]
