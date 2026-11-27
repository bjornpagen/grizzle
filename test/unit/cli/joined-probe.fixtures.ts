/** What joined-probe.test.ts reads: its box, the draft of its login as generate makes it, and what it seeks. */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { GrizzleConfig } from "#adapter/types/config.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { type PrintedSeek, printedSeeks } from "#compiler/physical/access/seeks.ts"
import { variantsEntries } from "#compiler/program/workload/change.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import { login, relation, schema, unit, wholeEntriesOf } from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A case: how many coordinates follow the unit's field in the probed relation's key, whether the carrier of the call's
 * rows binds the first coordinate beside the unit's field, and whether a workload read asks a spanning index of the
 * probed relation over its coordinates, a suffix of its key.
 */
export interface Case {
	readonly coordinates: 1 | 2
	readonly carried: boolean
	readonly spanning: boolean
}

export const caseGen: Gen<Case> = (s) => ({
	coordinates: s.draw(int(1, 2)) === 1 ? 1 : 2,
	carried: s.draw(boolean),
	spanning: s.draw(boolean)
})

export type Feature =
	| "a key of one coordinate"
	| "a key of two coordinates"
	| "the carrier binds the unit alone"
	| "the carrier binds the unit and a coordinate"
	| "beside a spanning index"
	| "beside no spanning index"

/** The situations a case reaches. */
export const featuresOf = (c: Case): ReadonlyArray<Feature> => [
	c.coordinates === 1 ? "a key of one coordinate" : "a key of two coordinates",
	c.carried ? "the carrier binds the unit and a coordinate" : "the carrier binds the unit alone",
	c.spanning ? "beside a spanning index" : "beside no spanning index"
]

const file = `${repoRoot}app/grizzle.config.ts`

/** The coordinate fields of a case's relations, after the unit's `doc`. */
const coordinatesOf = (c: Case): Arr.NonEmptyReadonlyArray<string> =>
	c.coordinates === 1 ? ["f0"] : ["f0", "f1"]

/** The configuration of a box: its schema and its one login, drafted under `migrations`. */
const configOf = (
	schemaOf: GrizzleConfig["schemas"][number],
	app: GrizzleConfig["logins"][number]
): GrizzleConfig =>
	defineConfig({
		contracts: [],
		schemas: [schemaOf],
		logins: [app],
		migrations: "migrations",
		rolePrefixBytes: 0,
		connection: () => offlineOwner
	})

/** The configuration of the case's box over a key of one coordinate after the unit's field. */
const oneCoordinate = (c: Case): GrizzleConfig => {
	const X = relation("X", { doc: pg.integer, f0: pg.integer }, ["doc", "f0"])
	const S = relation("S", { doc: pg.integer, f0: pg.integer, w: pg.integer }, ["doc", "f0"])
	const Y = relation("Y", { doc: pg.integer, f0: pg.integer }, ["doc", "f0"])
	const Base = schema("joined_probe", [X, S, Y], [unit("Doc", { doc: pg.integer })])
	const writer = role(Base, "a0", wholeEntriesOf(Base), { insert: ["Y"] })
	const submit = ChangeSet.empty(writer).insert(
		Y,
		query(writer).rule((q) => {
			const { doc, f0 } = v(S, "s")
			const carrier = q.relation("docs", { doc: S.fields.doc, f0: S.fields.f0 })
			const lone = q.relation("docs", { doc: S.fields.doc })
			return (c.carried ? q.match(carrier, { doc, f0 }) : q.match(lone, { doc }))
				.match(S, { doc, f0 })
				.where(q.not(X, { doc, f0 }))
				.find({ doc, f0 })
		})
	)
	const spanning = query(writer).rule((q) => {
		const { doc } = v(X, "x")
		return q.match(X, { doc, f0: param("f0", pg.integer) }).find({ doc })
	})
	return configOf(
		Base,
		login(Base, "app", [writer], {
			workload: [workload(writer, c.spanning ? { submit, spanning } : { submit })]
		})
	)
}

/** The configuration of the case's box over a key of two coordinates after the unit's field. */
const twoCoordinates = (c: Case): GrizzleConfig => {
	const X = relation("X", { doc: pg.integer, f0: pg.integer, f1: pg.integer }, ["doc", "f0", "f1"])
	const S = relation("S", { doc: pg.integer, f0: pg.integer, f1: pg.integer, w: pg.integer }, [
		"doc",
		"f0",
		"f1"
	])
	const Y = relation("Y", { doc: pg.integer, f0: pg.integer, f1: pg.integer }, ["doc", "f0", "f1"])
	const Base = schema("joined_probe", [X, S, Y], [unit("Doc", { doc: pg.integer })])
	const writer = role(Base, "a0", wholeEntriesOf(Base), { insert: ["Y"] })
	const submit = ChangeSet.empty(writer).insert(
		Y,
		query(writer).rule((q) => {
			const { doc, f0, f1 } = v(S, "s")
			const carrier = q.relation("docs", { doc: S.fields.doc, f0: S.fields.f0 })
			const lone = q.relation("docs", { doc: S.fields.doc })
			return (c.carried ? q.match(carrier, { doc, f0 }) : q.match(lone, { doc }))
				.match(S, { doc, f0, f1 })
				.where(q.not(X, { doc, f0, f1 }))
				.find({ doc, f0, f1 })
		})
	)
	const spanning = query(writer).rule((q) => {
		const { doc } = v(X, "x")
		return q
			.match(X, { doc, f0: param("f0", pg.integer), f1: param("f1", pg.integer) })
			.find({ doc })
	})
	return configOf(
		Base,
		login(Base, "app", [writer], {
			workload: [workload(writer, c.spanning ? { submit, spanning } : { submit })]
		})
	)
}

/**
 * The write of the case's box as generate compiles it: a document's processed attempts X, keyed by the document and its
 * coordinates, a document's source rows S keyed alike, and the submissions Y; the one role inserts Y from the call's
 * carrier of documents (and the first coordinate, where it carries it) joined to S at them, each row no X holds at its
 * key, as metis's submit probes processed_attempt; and, where the case asks it, a read of X at its coordinates alone,
 * which asks the spanning index. Its seeks of X at its whole key, as its served write's program states them at the
 * installation generate drafts beside it, every variant's: what each column is bound against.
 */
export const probesOf = (c: Case) =>
	Effect.gen(function* () {
		const key: Arr.NonEmptyReadonlyArray<string> = ["doc", ...coordinatesOf(c)]
		const config = yield* resolveConfig(
			c.coordinates === 1 ? oneCoordinate(c) : twoCoordinates(c),
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
		const served = draft.served
		if (served.kind !== "logins") {
			return yield* Effect.die("a schema with a login plans its logins")
		}
		const planned = defined(served.logins.get("app"), "the login app's plan")
		const variants = defined(
			defined(planned.roles.get("a0"), "the role a0").members.get("submit"),
			"the member submit"
		)
		const columns = new Set(Arr.map(key, (f) => draft.installation.names.column("X", f)))
		const whole = (s: PrintedSeek): boolean =>
			s.relation === "X" &&
			s.bound.size === columns.size &&
			Arr.every([...columns], (k) => s.bound.has(k))
		return {
			columns,
			probes: Arr.filter(
				Arr.flatMap(variantsEntries(variants), (entry) =>
					printedSeeks(entry.compiled.seeks, served.seeks)
				),
				whole
			)
		}
	})
