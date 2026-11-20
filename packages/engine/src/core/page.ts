/**
 * The pinned build's block size, BLCKSZ: the page a heap tuple must fit, and every index entry a share of.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one page of a table or of a B-tree or GiST index of the pinned build, which scripts/pg/source.sh configures
 *   by default
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/meson_options.txt#L5-L8
 * @quote option('blocksize', type: 'combo', choices: ['1', '2', '4', '8', '16', '32'], value: '8', description:
 *   'Relation block size, in kilobytes')
 * @verified 2026-11-20
 */
export const blockSize = 8192

/**
 * A page's header, PageHeaderData: the bytes every page of a table or an index begins with.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the header of every page
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/storage.sgml#L763
 * @quote 24 bytes long. Contains general information about the page
 * @verified 2026-11-20
 */
export const pageHeaderBytes = 24

/**
 * One line pointer, ItemIdData: the bytes every item a page holds, a heap tuple or an index entry, takes beside it.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the line pointer of every item on a page
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/storage.sgml#L769-L770
 * @quote Array of item identifiers pointing to the actual items. Each entry is an (offset,length) pair. 4 bytes per
 *   item.
 * @verified 2026-11-20
 */
export const itemIdBytes = 4

/**
 * A heap tuple's fixed header, SizeofHeapTupleHeader: the bytes every row begins with, before its null bitmap and its
 * columns, which the header's t_hoff rounds up to the greatest alignment.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the fixed header of every heap tuple, before its null bitmap: one row of a stored relation's table
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/storage.sgml#L955-L956
 * @quote There is a fixed-size header (occupying 23 bytes on most machines)
 * @verified 2026-11-20
 */
export const heapTupleHeaderBytes = 23
