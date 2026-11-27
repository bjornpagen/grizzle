/** What world-barrier.test.ts reads: its box, its cases, and the draft of its login as generate makes it. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Cause, Effect, Exit, Formatter, Record as Rec } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { SeekTargets } from "#compiler/physical/access/seeks.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, schema } from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * The reads of the box's role, each through its query entry Mine, a security barrier view: at a value of `amount`, a
 * numeric whose equality is leaky, which the barrier holds above it; at a value of `n`, an integer whose equality is
 * leakproof, which it passes; and at both.
 */
const readKinds = ["byAmount", "byN", "byBoth"] as const

export type ReadKind = (typeof readKinds)[number]

/** The order of Shop's key: led by the leaky `amount`, or by `region`, the column Mine's definition binds. */
const keyOrders = ["amount first", "region first"] as const

export type KeyOrder = (typeof keyOrders)[number]

/** A case: Shop's key order and the reads the role serves, at least one. */
export interface Case {
	readonly key: KeyOrder
	readonly reads: Arr.NonEmptyReadonlyArray<ReadKind>
}

export const caseGen: Gen<Case> = (source) => {
	const first = source.draw(element(readKinds))
	return {
		key: source.draw(element(keyOrders)),
		reads: [
			first,
			...Arr.filter(source.draw(subset(readKinds, { min: 0, max: 2 })), (r) => r !== first)
		]
	}
}

/** The region Mine's definition reads Shop at: a literal, which selects its column as a parameter's value does. */
const region = 1

/** The box's schema at key order `key`: Shop(region, amount, n), keyed by (amount, region) or (region, amount). */
const baseOf = (key: KeyOrder) => {
	const Shop = relation(
		"Shop",
		{ region: pg.integer, amount: pg.numeric(5, 2), n: pg.integer },
		key === "amount first" ? ["amount", "region"] : ["region", "amount"]
	)
	return { Shop, Base: schema("world_barrier", [Shop], []) }
}

/** The read of kind `kind` through the role's Mine: its facts at the parameters the kind binds. */
const readOf = (reader: ReturnType<typeof roleOf>, kind: ReadKind) => {
	const mine = reader.relations.Mine
	switch (kind) {
		case "byAmount":
			return query(reader).rule((r) => {
				const { amount, n } = v(mine, "mine")
				return r
					.match(mine, { amount, n })
					.where(r.eq(amount, r.param("amount", pg.numeric(5, 2))))
					.find({ n })
			})
		case "byN":
			return query(reader).rule((r) => {
				const { amount, n } = v(mine, "mine")
				return r
					.match(mine, { amount, n })
					.where(r.eq(n, r.param("n", pg.integer)))
					.find({ amount })
			})
		case "byBoth":
			return query(reader).rule((r) => {
				const { amount, n } = v(mine, "mine")
				return r
					.match(mine, { amount, n })
					.where(
						r.eq(amount, r.param("amount", pg.numeric(5, 2))),
						r.eq(n, r.param("n", pg.integer))
					)
					.find({ amount, n })
			})
	}
}

/** The box's role: its query entry Mine, Shop's facts of the region, and no write. */
const roleOf = (box: ReturnType<typeof baseOf>) =>
	role(box.Base, "a0", {
		Mine: query(box.Base).rule((r) => {
			const { amount, n } = v(box.Shop, "shop")
			return r.match(box.Shop, { region, amount, n }).find({ amount, n })
		})
	})

const file = `${repoRoot}app/grizzle.config.ts`

/**
 * The draft of the case's login from nothing, as `grizzle generate` makes it: the installation's tables and views it
 * drafts (`targets`), and `served`, the served files' step of generate over them (eachServedFile), the defect it dies with,
 * none where the login's file is served.
 */
export const drafted = (c: Case) =>
	Effect.gen(function* () {
		const box = baseOf(c.key)
		const reader = roleOf(box)
		const app = login(box.Base, "app", [reader], {
			workload: [
				workload(
					reader,
					Rec.fromEntries(Arr.map(c.reads, (kind) => [kind, readOf(reader, kind)] as const))
				)
			]
		})
		const config = yield* resolveConfig(
			defineConfig({
				contracts: [],
				schemas: [box.Base],
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
		const served = draft.served
		if (served.kind !== "logins") {
			return yield* Effect.die("a schema with a login plans its logins")
		}
		const targets: SeekTargets = served.seeks
		const refusal = yield* Effect.map(
			Effect.exit(eachServedFile(compiled, draft, served, silentPhases, Effect.succeed)),
			(exit) => (Exit.isFailure(exit) ? Formatter.format(Cause.squash(exit.cause)) : undefined)
		)
		return { targets, refusal }
	})
