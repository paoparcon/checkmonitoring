/**
 * The table kit's column description (spec 2026-10-13). Plain data: a server
 * page builds these and hands them to a client table, so nothing here may be a
 * function.
 */

export type ColumnKind = 'text' | 'enum' | 'date' | 'amount'

export const RANGE_OPS = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between'] as const
export type RangeOp = (typeof RANGE_OPS)[number]

export type KitOption = { value: string; label: string }

export type KitColumn = {
  key: string
  label: string
  kind: ColumnKind
  /** enum: the dropdown's values. `value` is what the filter stores; `label` what it shows. */
  options?: readonly KitOption[]
  /**
   * enum: ticked boxes instead of a dropdown, any of them matching. The needle
   * is "=<v1>,<v2>", so a multi column's values must never contain a comma.
   */
  multi?: boolean
  /** date / amount: the operators the menu offers. Default: all of RANGE_OPS. */
  ops?: readonly RangeOp[]
  /** Cannot be moved to Available Columns. */
  locked?: boolean
  noSort?: boolean
  noFilter?: boolean
  /** Starts in Available Columns. */
  defaultHidden?: boolean
  align?: 'left' | 'right'
  /** Classes for this column's body cells (`KitTable`). */
  className?: string
}

export type KitSort = { key: string; dir: 'asc' | 'desc' } | null

/** Column key → needle. An empty or absent needle is no filter. */
export type KitFilters = Readonly<Record<string, string>>
