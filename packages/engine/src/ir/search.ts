import { textSearchStringMaxBytes } from "#compiler/scalar/values/fault.ts"

/**
 * PostgreSQL's full text search, as grizzle reads it: the configurations a search document is parsed under, the weight
 * labels its parts carry, and the parsers a query's text is read by.
 *
 * A search document is a tsvector PostgreSQL computes from its row's texts, `to_tsvector(<configuration>, text)` per
 * part, each part labelled by setweight and the parts concatenated in their order (scalar/search.ts). What it holds is
 * PostgreSQL's alone: the configuration's parser and dictionaries, Snowball's stemmers and the stop word files the
 * server's build installs, read under the database's locale, which grizzle holds at the builtin C.UTF-8 (PostgreSQL 19
 * classifies a token's characters by pg_database_locale() and folds its case by the database's default collation). So
 * the host evaluates no document, no match and no rank: each is a term only PostgreSQL computes, and every position a
 * host judgement stands in refuses it.
 */

/**
 * The text search configurations PostgreSQL 19.0's initdb installs in pg_catalog: `simple`, its own, and one for each
 * language of its Snowball stemmers. A document names one, so the configuration is the document's type: a query is
 * parsed under the configuration of the document it meets, and no document can be read under another.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's initdb
 * @unit configurations
 * @scope pg_catalog's text search configurations in every database the server makes
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/snowball/snowball_create.pl#L14-L46
 * @quote our @languages = qw(
 * @verified 2026-11-20
 */
export const textSearchConfigurations = [
	"arabic",
	"armenian",
	"basque",
	"catalan",
	"danish",
	"dutch",
	"english",
	"esperanto",
	"estonian",
	"finnish",
	"french",
	"german",
	"greek",
	"hindi",
	"hungarian",
	"indonesian",
	"irish",
	"italian",
	"lithuanian",
	"nepali",
	"norwegian",
	"polish",
	"portuguese",
	"romanian",
	"russian",
	"serbian",
	"simple",
	"spanish",
	"swedish",
	"tamil",
	"turkish",
	"yiddish"
] as const

/** A text search configuration of pg_catalog's (textSearchConfigurations). */
export type TextSearchConfiguration = (typeof textSearchConfigurations)[number]

/** Whether `name` names a configuration of textSearchConfigurations. */
export const isTextSearchConfiguration = (name: unknown): name is TextSearchConfiguration =>
	typeof name === "string" && textSearchConfigurations.some((c) => c === name)

/**
 * The weight labels a part of a document carries, setweight's: a tsvector's every position is labelled A, B, C or D,
 * and ts_rank and ts_rank_cd weigh a match by its label (by default 1.0, 0.4, 0.2 and 0.1).
 */
export const textSearchWeights = ["A", "B", "C", "D"] as const

/** A weight label (textSearchWeights). */
export type TextSearchWeight = (typeof textSearchWeights)[number]

/** Whether `label` is a weight label of textSearchWeights. */
export const isTextSearchWeight = (label: unknown): label is TextSearchWeight =>
	typeof label === "string" && textSearchWeights.some((w) => w === label)

/**
 * How a query's text is read into a tsquery under a document's configuration: `websearch`, websearch_to_tsquery, the
 * syntax of a web search engine (quoted phrases, `or`, a leading `-` for not), which never raises on any text; `plain`,
 * plainto_tsquery, every word of the text required, punctuation ignored.
 */
export type TextQueryParser = "websearch" | "plain"

/**
 * The longest text, in UTF-8 bytes, a query's match or rank parses into a tsquery, so a read never fails on a value: a
 * match or a rank in a query reads a text its type or a byte guard bounds within it (scalar/compute/typing.ts
 * textSearch), and refuses any other when it compiles.
 *
 * @limitKind provisional
 * @owner grizzle's full text search (scalar/compute/typing.ts textSearch)
 * @unit bytes
 * @scope the text one match or rank of a query parses
 * @guards a read failing on its parameter's value: websearch_to_tsquery and plainto_tsquery refuse with 54000 a query
 *   whose operands, each lexeme with its terminating byte, take more than textSearchStringMaxBytes, and a long enough
 *   text of any language reaches it (600,000 bytes of "ab-cd " under english do)
 * @measure derive the most operand bytes a byte of text yields from the default parser's overlapping tokens (a
 *   hyphenated word and its parts, a URL and its host and path), the builtin C.UTF-8 locale's lowercase mapping and every
 *   Snowball stemmer's longest output against its input, and replace the 4 here with that derivation, or fuzz every
 *   configuration with texts drawn to maximize the ratio and keep the largest seen
 * @origin written with this bound by lane FTS on 2026-11-20 from a census of sixteen adversarial texts (hyphenated
 *   words of letters whose lowercase is longer, numbers, URLs, hosts, paths, versions, entities, Greek and Turkish
 *   letters) under every configuration of textSearchConfigurations, whose most operand bytes per byte of text was
 *   2.667, a hyphenated word of U+023A's under simple; 4 a byte allows half again as many
 * @recorded 2026-11-20
 */
export const textQueryMaxBytes = Math.floor(textSearchStringMaxBytes / 4)
