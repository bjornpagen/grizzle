/** What the property of wal-level.test.ts reads: its texts, its specification and its features. */

import { element, type Gen } from "@bjornpagen/testing/gen"

/**
 * The texts a survey's read of current_setting('wal_level') is judged over: PostgreSQL 19's three levels, the two
 * hidden aliases of replica, which current_setting never answers (it prints a level's own name), and texts no server
 * answers, a level in capitals, one with a trailing blank and the empty text.
 */
const texts = [
	"minimal",
	"replica",
	"logical",
	"archive",
	"hot_standby",
	"LOGICAL",
	"replica ",
	""
] as const

export const walTextGen: Gen<(typeof texts)[number]> = element(texts)

/** What PostgreSQL 19 makes of a live source on a server whose wal_level reads `text`, as its documentation states it. */
export type Specified = "refused" | "decoded" | "no level"

/**
 * The specification: logical decoding runs at logical, and at replica once the first logical slot is made, which
 * turns it on by itself (logicaldecoding.sgml at REL_19_0, "When wal_level is set to replica, logical decoding is
 * automatically activated upon creation of the first logical replication slot"); at minimal it never runs
 * (config.sgml: "logical adds information necessary to support logical decoding" to replica's, which adds to
 * minimal's). Any other text is no level PostgreSQL 19 reads wal_level as.
 */
export const specified = (text: string): Specified =>
	text === "minimal" ? "refused" : text === "replica" || text === "logical" ? "decoded" : "no level"

/** Why a case's verdict is what it is, as the search must reach each. */
export type WalFeature =
	| "a live source refused at minimal"
	| "a live source decoded at replica"
	| "a live source decoded at logical"
	| "a text no server reads as a level"

export const features = [
	"a live source refused at minimal",
	"a live source decoded at replica",
	"a live source decoded at logical",
	"a text no server reads as a level"
] as const
