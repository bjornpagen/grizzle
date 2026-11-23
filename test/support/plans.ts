/**
 * A load's SQL helpers, for a suite that writes its rows at volume in SQL (test/pg/physical/serving.fixtures.ts): a
 * series spread over a few values, and a uuid named by a text.
 */

/**
 * A load's series `g` spread over `distinct` values by PostgreSQL's 64-bit hash seeded with `salt`: two spread columns of
 * different salts are independent, and one alone holds each of its values on about 1 / distinct of the rows. (A salt
 * added to one multiplicative hash only shifted every value by one offset, so two columns were one column renamed.)
 */
export const spread = (salt: number, distinct: number): string =>
	`((pg_catalog.hashint8extended(g::int8, ${salt}) % ${distinct} + ${distinct}) % ${distinct})`

/**
 * A load's uuid named by the SQL text `text`: the first 16 of the 32 bytes of its UTF-8 bytes' SHA-256, cast to a uuid
 * as PostgreSQL 19 casts 16 bytes. A load's ids spread over the uuid's order as drawn ones do, and one text names one
 * id in every table that reads it, so a row's foreign key is its parent's text again.
 */
export const sha256Uuid = (text: string): string =>
	`pg_catalog.substring(pg_catalog.sha256(pg_catalog.convert_to(${text}, 'UTF8')), 1, 16)::uuid`
