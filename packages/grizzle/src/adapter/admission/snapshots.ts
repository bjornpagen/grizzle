import { Option, Result } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Engine from "#compiler/core/result.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { decodeDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import { type Owned, own } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"

/** Every registered snapshot, by itself. */
const registered = new WeakMap<object, DeploySnapshot>()

/**
 * The snapshots the test installer registers.
 *
 * The snapshot the application knows is the one it commits beside its code, `migrations/<schema>/snapshot.json`, which
 * every DbLayer.make takes. The test installer registers each installation's snapshot instead, with the schema value
 * it is the snapshot of (registerSnapshot), which no public API exposes: a layer given a registered snapshot takes it
 * as registered, with the levels it serves, rather than reading it again. The text form is
 * read as the generator wrote it and refused when its fingerprint is not its content's (snapshot/build.ts
 * readSnapshot), so a hand-edited snapshot is never trusted. The registry is WeakMaps keyed by the snapshot, never on
 * globalThis.
 *
 * The snapshot a DbLayer.make was given, when the test installer registered it.
 */
export const registeredSnapshot = (given: object): Option.Option<DeploySnapshot> =>
	Option.fromUndefinedOr(registered.get(given))

/**
 * The fingerprints of the levels of the schema a registered snapshot was registered with, recorded when it is
 * registered. A schema.extend level is deployed with the levels below it in one installation, and a Db opened over a
 * lower level is admitted against the deployed snapshot registered with the deployed schema value; the snapshot file
 * records no level below its own, so a snapshot given to DbLayer.make serves only its own schema, and applications open
 * the top level. The declared name's only physical consequence is the PostgreSQL schema the installation lives in,
 * which admission compares on its own (deploy/admission/target.ts snapshotMismatch); a schema rebuilt under the name of
 * the schema it is installed in, as the tests install every fixture under a unique schema, is served by that
 * installation's snapshot. A registered schema that is not the snapshot's own up to its declared name serves no level.
 */
const levels = new WeakMap<DeploySnapshot, ReadonlySet<string>>()

const declaredAs = (desc: SchemaDesc, name: string): SchemaDesc => ({
	...desc,
	name,
	...(desc.extends === undefined ? {} : { extends: declaredAs(desc.extends, name) })
})

/** A schema's fingerprint, none for a description ownership refuses. */
const fingerprintOf = (desc: SchemaDesc): Option.Option<string> => {
	const owned = own(desc)
	return owned.ok ? Option.some(owned.value.fingerprint) : Option.none()
}

/** The fingerprints of the levels of `schema` that `snapshot` serves (see `levels` above). */
const servedLevels = (snapshot: DeploySnapshot, schema: unknown): ReadonlySet<string> => {
	const built = schemaDescOf(schema)
	const decoded = built === undefined ? decodeDesc("schema", schema) : Engine.ok(built)
	const served = new Set<string>()
	if (
		!decoded.ok ||
		!Option.contains(
			fingerprintOf(declaredAs(decoded.value, snapshot.schemaName)),
			snapshot.theory.schema
		)
	) {
		return served
	}
	for (let d: SchemaDesc | undefined = decoded.value; d !== undefined; d = d.extends) {
		const fingerprint = fingerprintOf(d)
		if (Option.isSome(fingerprint)) {
			served.add(fingerprint.value)
		}
	}
	return served
}

/**
 * Whether `snapshot` is of the opened schema `owned`, up to its declared name, or of a schema whose lower level it is,
 * as the snapshot's registration recorded (see `levels` above).
 */
export const servesSchema = (snapshot: DeploySnapshot, owned: Owned): boolean =>
	snapshot.theory.schema === owned.fingerprint ||
	levels.get(snapshot)?.has(owned.fingerprint) === true ||
	Option.contains(
		fingerprintOf(declaredAs(owned.desc, snapshot.schemaName)),
		snapshot.theory.schema
	)

/**
 * Registers the committed snapshot of `schema`, a schema value or SchemaDesc: a DeploySnapshot, or the snapshot.json
 * text the generator wrote. The registered snapshot is what a DbLayer.make of its login is given.
 */
export const registerSnapshot = (
	schema: object,
	snapshot: DeploySnapshot | string
): Result.Result<DeploySnapshot, CompileError> =>
	Result.map(
		typeof snapshot === "string" ? readSnapshot(snapshot) : Result.succeed(snapshot),
		(s) => {
			registered.set(s, s)
			levels.set(s, servedLevels(s, schema))
			return s
		}
	)
