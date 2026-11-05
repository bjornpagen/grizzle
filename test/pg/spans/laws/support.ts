import { Effect, type Scope } from "effect"
import { identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { installationSql } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { installationGroup, type ResetGroup } from "#test/support/substrate/replace.ts"
import type { RawSession, SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { oracleWorld } from "#test/support/worlds.ts"

export interface SpanInstall {
	readonly schema: string
	/** The quoted schema, for SQL text. */
	readonly q: string
	readonly installation: Installation
	/** The oracle's full role, as a direct SQL writer takes it on. */
	readonly writer: SubstrateWorld
	/** The quoted, schema-qualified table of a relation. */
	readonly table: (relation: string) => string
	/** Every relation's table, which a reset truncates together (substrate/replace.ts). */
	readonly group: ResetGroup
	/** The installed name of the PERIOD foreign key that enforces a coverage law, read through the naming door. */
	readonly periodForeignKey: (law: LawId) => ConstraintName
}

/**
 * Installing span-law schemas for the span law tests through the real fresh-install compiler, every law native: a
 * coverage is a PERIOD foreign key, from a selected source's range law column, into a target keyed WITHOUT OVERLAPS
 * (fin.md §7). The script runs as the owner in one transaction, under a unique schema name, because roles are
 * cluster-wide, with the oracle's one login; the writer takes on its full role with only its derived grants, as a
 * grizzle connection or a psql writer does.
 */
export const installSpans = (
	desc: SchemaDesc,
	label: string
): Effect.Effect<SpanInstall, SqlError | TransactionRolledBack, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schema = yield* substrate.schema({ create: false, label })
		const owned = owning(desc)
		const compiled = compileInstallation(owned, {
			...installOptions(owned, substrate.owner.role),
			installation: identity.schema(parsedSchemaName(schema)),
			logins: [oracleOwnedLogin(owned.desc)]
		})
		if (!compiled.ok) {
			return yield* Effect.die(new Error(`compile: ${compiled.error.message}`))
		}
		const installation = compiled.value
		yield* transaction(substrate.admin, installationSql(installation))
		const writer = yield* oracleWorld(installation)
		const names = installationNamesOf(installation)
		const q = quoteIdent(schema)
		return {
			schema,
			q,
			installation,
			writer,
			table: (relation: string) => `${q}.${quoteIdent(names.tableIdent({ name: relation }))}`,
			group: installationGroup(names),
			periodForeignKey: (law: LawId) => names.constraintOf(law, "PeriodForeignKey")
		} satisfies SpanInstall
	})

/** A writer session taking on the schema's full role, holding only its derived grants. */
export const writerOf = (
	install: SpanInstall,
	label: string
): Effect.Effect<RawSession, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		return yield* substrate.session({ ...worldSession(install.writer), label })
	})
