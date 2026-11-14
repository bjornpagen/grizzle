import { nominal } from "#compiler/core/brand.ts"

declare const sqlstateBrand: unique symbol
/** A SQLSTATE: five characters, each a digit or an ASCII capital (unchecked; Sqlstate.parse is the parse). */
export type Sqlstate = string & { readonly [sqlstateBrand]: true }
const brand = nominal<string, Sqlstate>()

/**
 * The characters of a SQLSTATE: "All messages emitted by the PostgreSQL server are assigned five-character error codes
 * that follow the SQL standard's conventions for “SQLSTATE” codes" (https://www.postgresql.org/docs/19/errcodes-appendix.html).
 *
 * @formatConstant a SQLSTATE: five characters
 */
const sqlstateLength = 5

/**
 * The characters of a SQLSTATE's class: "According to the standard, the first two characters of an error code denote a
 * class of errors" (https://www.postgresql.org/docs/19/errcodes-appendix.html).
 *
 * @formatConstant a SQLSTATE's class: its first two characters
 */
const sqlstateClassLength = 2

/** A SQLSTATE's text as a regular expression's body: the characters `parse` admits, `sqlstateLength` of them. */
export const sqlstateBody = `[0-9A-Z]{${sqlstateLength}}`

/** The code a server reported, as a SQLSTATE, or undefined for any other text. */
const parse = (code: string): Sqlstate | undefined => {
	if (code.length !== sqlstateLength) {
		return undefined
	}
	for (let i = 0; i < code.length; i++) {
		const unit = code.charCodeAt(i)
		if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5a))) {
			return undefined
		}
	}
	return brand(code)
}

/**
 * The SQLSTATE operations, beside the Sqlstate type of the same name: `parse`, the one way to a Sqlstate from a code's
 * text, which the wire reads pg's report through and an application's test builds a ServerError's code with.
 */
export const Sqlstate = Object.freeze({ parse })

/**
 * SQLSTATEs: the one table of every condition grizzle branches on, and the parse of a reported code.
 *
 * A SQLSTATE travels as the Sqlstate brand, parsed once where the wire reads PostgreSQL's ErrorResponse
 * (adapter/wire/failure.ts). Every comparison reads a condition from `sqlstates` by its name, so a misspelt state is a
 * compile error, never a branch silently missed.
 *
 * The conditions grizzle branches on, by PostgreSQL's condition name (errcodes.txt), and grizzle's own codes, which its
 * generated SQL raises.
 */
export const sqlstates = {
	/** Class 28, invalid authorization: a startup the server refused for its role or password. */
	invalidAuthorizationSpecification: brand("28000"),
	/** A startup the server refused for its password: the password a role was given does not authenticate it. */
	invalidPassword: brand("28P01"),
	/** A startup the server refused because every connection slot it or the role allows is taken. */
	tooManyConnections: brand("53300"),
	/** The server ended a session or refused a startup because its administrator shut it down. */
	adminShutdown: brand("57P01"),
	/** The server ended a session or refused a startup because another of its processes crashed. */
	crashShutdown: brand("57P02"),
	/** A startup the server refused because it is starting up, recovering or shutting down. */
	cannotConnectNow: brand("57P03"),
	/**
	 * A server statement the session named and the backend no longer has, or whose cached plan changed its result
	 * type.
	 */
	invalidSqlStatementName: brand("26000"),
	featureNotSupported: brand("0A000"),
	/** Integrity: a write statement's refusal, and a migration's closed-only law, raise the class code itself. */
	integrityConstraintViolation: brand("23000"),
	uniqueViolation: brand("23505"),
	exclusionViolation: brand("23P01"),
	checkViolation: brand("23514"),
	foreignKeyViolation: brand("23503"),
	/** A NULL in a NOT NULL column: grizzle writes none, so only a generated column's NULL expression raises it. */
	notNullViolation: brand("23502"),
	/** A subquery used as an expression returned more than one row. */
	cardinalityViolation: brand("21000"),
	/** The isolation guard's refusal of a write in a transaction below SERIALIZABLE (physical/ddl/isolation.ts). */
	invalidTransactionState: brand("25000"),
	/**
	 * A statement a world role's privileges or row security do not allow: a TRUNCATE, an UPDATE of an immutable
	 * relation, or a row its policy refuses.
	 */
	insufficientPrivilege: brand("42501"),
	serializationFailure: brand("40001"),
	/** PostgreSQL's internal_error: a write statement's defect, a row its INSERT's arbitration met at no object it
	 * classifies (write/refusal.ts ArmRefusal `defect`), which no classifier reads as a refusal. */
	internalError: brand("XX000"),
	deadlockDetected: brand("40P01"),
	undefinedTable: brand("42P01"),
	invalidSchemaName: brand("3F000"),
	objectNotInPrerequisiteState: brand("55000"),
	/** A lock NOWAIT could not take: the fence's LOCK of the ledger while a migration holds or awaits it. */
	lockNotAvailable: brand("55P03"),
	/** Runtime resources, never a truncated result. */
	outOfMemory: brand("53200"),
	statementTooComplex: brand("54001"),
	/**
	 * grizzle's own: a concurrent change a write statement met, a delivered type its read-back refused, and a written
	 * fact a world relation cannot hold (outside-world), which a writable entry's precheck raises.
	 */
	grizzleConcurrentChange: brand("40Z01"),
	grizzleDeliveredType: brand("21Z01"),
	grizzleOutsideWorld: brand("42Z01"),
	/**
	 * grizzle's own, of class 55 (object not in prerequisite state), which the snapshot guard raises (snapshotGuardDdl):
	 * the ledger holds an unfinished folder, a migration running or stopped part-way; or its latest
	 * complete target is not the Db's snapshot. Neither is of class 40: the same call on the same Db meets it again.
	 */
	grizzleMigrating: brand("55Z02"),
	grizzleMigrated: brand("55Z01")
} as const

/** The class of a SQLSTATE: its first two characters. */
export const sqlstateClass = (state: Sqlstate): string => state.slice(0, sqlstateClassLength)
