import type { LineKind } from './compute'

/**
 * What a statement line is called on screen, and which kinds a person may
 * classify a line as. No imports but a type, so the browser bundle (the
 * statement upload preview) can read it without pulling in server code.
 */
export const LINE_KIND_LABEL: Record<LineKind, string> = {
  CHECK: 'CLEARED CHECK',
  BOOK_ENTRY: 'BOOK ENTRY',
  BANK_CHARGE: 'BANK CHARGE',
  BANK_CREDIT: 'BANK CREDIT',
  UNIDENTIFIED_DEBIT: 'UNIDENTIFIED DEBIT',
  UNIDENTIFIED_CREDIT: 'UNIDENTIFIED CREDIT',
  BANK_ERROR: 'BANK ERROR',
}

/** CHECK and BOOK_ENTRY are matches, not classifications. */
export function classificationsFor(direction: 'DEBIT' | 'CREDIT'): LineKind[] {
  return direction === 'DEBIT'
    ? ['BANK_CHARGE', 'UNIDENTIFIED_DEBIT', 'BANK_ERROR']
    : ['BANK_CREDIT', 'UNIDENTIFIED_CREDIT', 'BANK_ERROR']
}
