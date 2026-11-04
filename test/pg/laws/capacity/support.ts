import { Array as Arr, Effect, Option, Record as Rec, type Scope } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { lawUnits, namedDetail, type ResidualLaw } from "#compiler/ir/law.ts"
import {
	emitResidualLaws,
	type ResidualLawObjects,
	residualLawStatements
} from "#compiler/laws/residual/skeleton.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { printStatement, quoteIdent } from "#compiler/sql/print.ts"
import { installationSql } from "#test/support/compile.ts"
import { strictDetail } from "#test/support/detail.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { oracleOwnedLogin } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import type { SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession, SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { oracleWorld } from "#test/support/worlds.ts"

export interface CapacityInstall {
	readonly schema: string
	/** The quoted schema, for SQL text. */
	readonly q: string
	readonly installation: Installation
	readonly objects: ReadonlyArray<ResidualLawObjects>
	/** The schema's one full role (oracleLogin), holding every relation whole and writing every one. */
	readonly writer: SubstrateWorld
	/** The quoted, schema-qualified table of a relation. */
	readonly table: (relation: string) => string
	readonly law: (id: LawId) => ResidualLaw
	/**
	 * The constraint name of the plain foreign key from a relation: the containment of its sources into its target that
	 * every capacity schema here declares (schemas.ts).
	 */
	readonly foreignKey: (relation: string) => ConstraintName
	/** The `SET CONSTRAINTS ... IMMEDIATE` of a law's trigger on a relation, schema-qualified. */
	readonly immediate: (law: LawId, relation: string) => string
}

/**
 * Installing capacity-bearing schemas for the capacity law tests.
 *
 * The native objects come from the fresh-install compiler (packages/engine/src/physical/install): the tables, keys and
 * foreign keys, the at-most-one partial UNIQUE that specializes an upper bound of one, the law's
 * supporting index on the source projection, and the full role's world with its derived grants. That compiler leaves
 * residual laws to the residual law extension, so the law functions, their PUBLIC revocations and their triggers come
 * from the residual emitter (packages/engine/src/laws/residual, with the capacity family), run as the owner exactly as a
 * migration's Prepare and Validate files would.
 */
export const installCapacity = (
	desc: SchemaDesc,
	label: string
): Effect.Effect<
	{
		schema: string
		q: string
		installation: Installation
		objects: readonly ResidualLawObjects[]
		writer: SubstrateWorld
		table: (relation: string) => string
		law: (id: LawId) => ResidualLaw
		foreignKey: (relation: string) => ConstraintName
		immediate: (law: LawId, relation: string) => string
	},
	SqlError | TransactionRolledBack,
	Scope.Scope | Substrate
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schema = yield* substrate.schema({ create: false, label })
		const owned = owning(desc)
		const compiled = compileInstallation(owned, {
			...installOptions(owned, substrate.owner.role),
			installation: identity.schema(parsedSchemaName(schema)),
			logins: [oracleOwnedLogin(desc)]
		})
		if (!compiled.ok) {
			return yield* Effect.die(new Error(`compile: ${compiled.error.message}`))
		}
		const installation = compiled.value
		yield* transaction(substrate.admin, installationSql(installation))
		const writer = yield* oracleWorld(installation)
		/** The full role holds every relation whole: every violation's DETAIL carries its keys to it. */
		const emitted = emitResidualLaws(installation.laws, {
			schema,
			names: installation.names,
			holders: () => [writer.role]
		})
		if (!emitted.ok) {
			return yield* Effect.die(new Error(`emit: ${emitted.error.message}`))
		}
		/** Every law function's statements pass the statement and text audits before they run. */
		const statements = Arr.flatMap(emitted.value, residualLawStatements)
		checkedStatements(statements, "residual law statement")
		yield* transaction(substrate.admin, Arr.map(statements, printStatement))
		const q = quoteIdent(schema)
		return {
			schema,
			q,
			installation,
			objects: emitted.value,
			writer,
			table: (relation: string) =>
				`${q}.${quoteIdent(
					Option.getOrThrowWith(
						Arr.findFirst(
							Rec.values(installation.laws.theory.relations),
							(r) => r.name === relation
						),
						() => new Error(`no relation ${relation}`)
					).ident
				)}`,
			law: (id: LawId) => {
				const law = Arr.findFirst(installation.laws.residuals, (r) => r.lawId === id)
				if (Option.isNone(law)) {
					throw new Error(
						`no residual law ${id}; there are ${Arr.join(
							Arr.map(installation.laws.residuals, (r) => r.lawId),
							", "
						)}`
					)
				}
				return law.value
			},
			foreignKey: (relation: string) => {
				const fk = Arr.findFirst(
					installation.laws.natives,
					(n) => n.object.kind === "ForeignKey" && n.object.relation.name === relation
				)
				if (Option.isNone(fk) || fk.value.namespace !== "constraint") {
					throw new Error(`no named foreign key from ${relation}`)
				}
				return identifierOf(fk.value.named)
			},
			immediate: (law: LawId, relation: string) => {
				const units = Arr.flatMap(
					Arr.filter(installation.laws.residuals, (r) => r.lawId === law),
					lawUnits
				)
				const triggers = Arr.flatMap(units, (u) =>
					u.participant.relation.name === relation
						? [`${q}.${quoteIdent(identifierOf(u.unit.trigger))}`]
						: []
				)
				if (!Arr.isReadonlyArrayNonEmpty(triggers)) {
					throw new Error(`no trigger of law ${law} on ${relation}`)
				}
				return `SET CONSTRAINTS ${Arr.join(triggers, ", ")} IMMEDIATE`
			}
		} satisfies CapacityInstall
	})

/** A writer session in the schema's full role, holding only its derived grants. */
export const writerOf = (
	install: CapacityInstall,
	label: string
): Effect.Effect<RawSession, SqlError, Scope.Scope | Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		return yield* substrate.session({ ...worldSession(install.writer), label })
	})

/** The key texts of a law function's DETAIL (DetailCodec), or a failure naming what was wrong. */
export const witness = (law: ResidualLaw, detail: Option.Option<string>): ReadonlyArray<string> => {
	if (Option.isNone(detail)) {
		throw new Error(`law ${law.lawId} raised without a DETAIL`)
	}
	return strictDetail(namedDetail(law.detail), detail.value)
}
