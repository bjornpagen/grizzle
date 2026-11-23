/** What the property of group-witness.test.ts reads: its schemas, its space, and each case's certification. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, login, relation, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { file } from "#test/unit/cli/served-certified.fixtures.ts"

/** A row of a unit, `package` its unit: its id, and the value x it states. Immutable, so its rules are judged whole. */
const T = relation("T", { package: pg.integer, id: pg.integer, x: pg.integer }, ["package", "id"])

/** The aggregates a whole rule's query may fold its unit's rows by, each over x but the count. */
const folds = ["count", "sum", "min", "max"] as const
type Fold = (typeof folds)[number]

/**
 * How the drawn check reads T: `group`, a fold of each unit's rows, which reads every row of the unit; or `row`, each
 * row of the unit apart, one row of a match.
 */
type Read = { readonly kind: "group"; readonly fold: Fold } | { readonly kind: "row" }

/** Which side of its bound the check holds the value it reads to. */
const sides = ["atMost", "atLeast"] as const
type Side = (typeof sides)[number]

/** A case: how the check reads T, the side of its bound it holds, and the bound. */
export interface Drawn {
	readonly read: Read
	readonly side: Side
	readonly bound: number
}

export const drawnGen: Gen<Drawn> = (s) => {
	const read: Read = s.draw(element([true, false]))
		? { kind: "group", fold: s.draw(element(folds)) }
		: { kind: "row" }
	return { read, side: s.draw(element(sides)), bound: s.draw(int(0, 9)) }
}

export type GroupWitnessFeature = "a count" | "a sum" | "a min" | "a max" | "one row of a match"

/** The feature a case's read reaches. */
const featureOf = (read: Read): GroupWitnessFeature => {
	switch (read.kind) {
		case "row":
			return "one row of a match"
		case "group":
			switch (read.fold) {
				case "count":
					return "a count"
				case "sum":
					return "a sum"
				case "min":
					return "a min"
				case "max":
					return "a max"
			}
	}
}

const Base = schema("GroupWitness", [T], [])

/**
 * The schema a case installs: Base and the check `Bounded` over the relation the case reads, every rule whole: each
 * unit's fold of its rows, each row read once by its key, or each row of each unit as it stands.
 */
const schemaOf = (drawn: Drawn) => {
	const { read, side, bound } = drawn
	const exact = BigInt(bound)
	if (read.kind === "row") {
		const Rows = derived(
			"Rows",
			query(Base).rule((r) => {
				const { package: unit, id, x } = v(T, "t")
				return r.match(T, { package: unit, id, x }).find({ package: unit, id, value: x })
			})
		)
		return schema.extend(
			[Base],
			"GroupWitness_1",
			[Rows],
			[
				check("Bounded", Rows, (b) =>
					side === "atMost" ? b.le(b.value, bound) : b.ge(b.value, bound)
				)
			]
		)
	}
	switch (read.fold) {
		case "count": {
			const Folded = derived(
				"Folded",
				query(Base).rule((r) => {
					const { package: unit, id } = v(T, "t")
					return r.match(T, { package: unit, id }).find({ package: unit, value: r.count() })
				})
			)
			return schema.extend(
				[Base],
				"GroupWitness_1",
				[Folded],
				[
					check("Bounded", Folded, (b) =>
						side === "atMost" ? b.le(b.value, exact) : b.ge(b.value, exact)
					)
				]
			)
		}
		case "sum": {
			const Folded = derived(
				"Folded",
				query(Base).rule((r) => {
					const { package: unit, id, x } = v(T, "t")
					return r.match(T, { package: unit, id, x }).find({ package: unit, value: r.sum(x) })
				})
			)
			return schema.extend(
				[Base],
				"GroupWitness_1",
				[Folded],
				[
					check("Bounded", Folded, (b) =>
						side === "atMost" ? b.le(b.value, exact) : b.ge(b.value, exact)
					)
				]
			)
		}
		case "min": {
			const Folded = derived(
				"Folded",
				query(Base).rule((r) => {
					const { package: unit, id, x } = v(T, "t")
					return r.match(T, { package: unit, id, x }).find({ package: unit, value: r.min(x) })
				})
			)
			return schema.extend(
				[Base],
				"GroupWitness_1",
				[Folded],
				[
					check("Bounded", Folded, (b) =>
						side === "atMost" ? b.le(b.value, bound) : b.ge(b.value, bound)
					)
				]
			)
		}
		case "max": {
			const Folded = derived(
				"Folded",
				query(Base).rule((r) => {
					const { package: unit, id, x } = v(T, "t")
					return r.match(T, { package: unit, id, x }).find({ package: unit, value: r.max(x) })
				})
			)
			return schema.extend(
				[Base],
				"GroupWitness_1",
				[Folded],
				[
					check("Bounded", Folded, (b) =>
						side === "atMost" ? b.le(b.value, bound) : b.ge(b.value, bound)
					)
				]
			)
		}
	}
}

/**
 * One case: the drawn schema configured with one login, its writer inserting T alone, and certified as generate
 * certifies it (draftSchema). A check over a group of T's rows reads every row of the group, so the writer's one row is
 * never the one occurrence its write makes true, and it runs SERIALIZABLE for the law; a check over T's rows apart reads
 * its one row, and it runs READ COMMITTED.
 */
export const runCertified = (drawn: Drawn, c: Case<GroupWitnessFeature>) =>
	Effect.gen(function* () {
		c.note(featureOf(drawn.read))
		const S = schemaOf(drawn)
		const writer = role(S, "writer", wholeEntriesOf(S), { insert: ["T"] })
		const app = login(S, "app", [writer], {
			workload: [workload(writer, { addT: ChangeSet.empty(writer).insert(T, []) })]
		})
		const config = yield* resolveConfig(
			defineConfig({
				schemas: [S],
				logins: [app],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			}),
			file
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const compiled = yield* Effect.fromResult(compileSchema(configured))
		const draft = yield* draftSchema(
			compiled,
			emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
			[],
			noDeclarations,
			silentPhases
		)
		assert.ok(draft.served.kind === "logins", "a schema with a login plans its logins")
		const writers = Arr.findFirst(draft.served.certification, (r) => r.role === "writer")
		assert.ok(Option.isSome(writers), "the writer's certificate")
		const certificate = writers.value.certificate
		switch (drawn.read.kind) {
			case "row":
				assert.ok(
					certificate.level === "readCommitted",
					`${Formatter.format(drawn)}: a writer whose row a whole check reads as one row of a match runs READ COMMITTED, certified ${Formatter.format(certificate)}`
				)
				return
			case "group":
				assert.ok(
					certificate.level === "serializable" &&
						certificate.why.kind === "own" &&
						Arr.some(
							certificate.why.reasons,
							(r) => r.condition === "laws" && r.at.kind === "relation" && r.at.relation === "T"
						),
					`${Formatter.format(drawn)}: a writer of rows a whole check reads as a group runs SERIALIZABLE for the law, certified ${Formatter.format(certificate)}`
				)
				return
		}
	})
