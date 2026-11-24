import { RegexBuilder, set } from "@bjornpagen/grizzle-text/regex/ir"
import { runsOf } from "@bjornpagen/grizzle-text/regex/words"
import { isAsciiDigit } from "@bjornpagen/grizzle-text/text"
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

/** A SQLSTATE's texts as a regular language: the characters `parse` admits, `sqlstateLength` of them. */
export const sqlstateSpelling = new RegexBuilder().repeat(
	set(runsOf("0-9A-Z")),
	sqlstateLength,
	sqlstateLength
)

/** The code a server reported, as a SQLSTATE, or undefined for any other text. */
const parse = (code: string): Sqlstate | undefined => {
	if (code.length !== sqlstateLength) {
		return undefined
	}
	for (let i = 0; i < code.length; i++) {
		const unit = code.charCodeAt(i)
		if (!(isAsciiDigit(unit) || (unit >= 0x41 && unit <= 0x5a))) {
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
	/**
	 * A NULL a declared function returned where grizzle holds a value, a value, a row's field or a field's row, which a
	 * query's read of its call raises through the installation's refusal function (lower/conservative/call).
	 */
	nullValueNotAllowed: brand("22004"),
	/**
	 * A numeric value past numeric's own format, which PostgreSQL's arithmetic raises over an operand bounded by nothing
	 * but numeric's own limit, pg.numeric's (scalar/values/fault.ts resultDigits): every other numeric making is proved
	 * within it.
	 */
	numericValueOutOfRange: brand("22003"),
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
	/** Class 42's statements over an object the catalog lacks: any object's, a function's and a column's. */
	undefinedObject: brand("42704"),
	undefinedFunction: brand("42883"),
	undefinedColumn: brand("42703"),
	/** Class 42's statements over an object the catalog already holds: any object's, a table's, a function's, a
	 * schema's and a column's. */
	duplicateObject: brand("42710"),
	duplicateTable: brand("42P07"),
	duplicateFunction: brand("42723"),
	duplicateSchema: brand("42P06"),
	duplicateColumn: brand("42701"),
	/** A DROP RESTRICT of an object another depends on, a privilege on a table among them for a role's. */
	dependentObjectsStillExist: brand("2BP01"),
	invalidSchemaName: brand("3F000"),
	objectNotInPrerequisiteState: brand("55000"),
	/** An object a statement drops in use: a replication slot a leader streams from, which PostgreSQL drops never. */
	objectInUse: brand("55006"),
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
	grizzleMigrated: brand("55Z01"),
	/**
	 * grizzle's own, of class 55 (object not in prerequisite state), which a rule capture raises (physical/ddl/rules.ts
	 * addCapture): a write of a table the rule judge captures in a session that has not stood up the judge's tables the
	 * write needs (physical/ddl/rules.ts addStandUps), which a served write's session does before its first call of the
	 * write (runtime/write/flight.ts StandUp). Only a writer outside grizzle meets it.
	 */
	grizzleUnstood: brand("55Z03")
} as const

/**
 * The conditions of a statement over an object the catalog lacks or already holds, a table, a column, a function, a
 * schema or any other object (class 42's undefined_ and duplicate_ conditions), or whose DROP another object depends on
 * (class 2B's dependent_objects_still_exist): what a migration's statement meets where the installation departs from
 * the snapshot its folders were drafted against, an object dropped or created outside any migration, or a privilege
 * granted outside one to a role it drops, since a folder drops, alters and creates exactly the objects its snapshot
 * states and drops them RESTRICT.
 */
export const catalogDeparted: ReadonlySet<Sqlstate> = new Set([
	sqlstates.undefinedTable,
	sqlstates.undefinedObject,
	sqlstates.undefinedFunction,
	sqlstates.undefinedColumn,
	sqlstates.duplicateObject,
	sqlstates.duplicateTable,
	sqlstates.duplicateFunction,
	sqlstates.duplicateSchema,
	sqlstates.duplicateColumn,
	sqlstates.dependentObjectsStillExist
])

/** The class of a SQLSTATE: its first two characters. */
export const sqlstateClass = (state: Sqlstate): string => state.slice(0, sqlstateClassLength)
