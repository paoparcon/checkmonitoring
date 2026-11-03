'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { filterHref } from '@/lib/filter-href'
import { markOwnNavigation, useExternalNavEpoch } from './filter-nav'

/** How long a text box waits after the last keystroke before the list follows it. */
const DEBOUNCE_MS = 400

/**
 * The filter bar's form, on every page that has one.
 *
 * A real `<form method="get">` that still works with no script: the browser
 * submits it natively, which is a full page load. With script, this intercepts
 * the submit and navigates SOFTLY (`router.replace`), so applying a filter swaps
 * the new page in instead of reloading the document — the white flash on every
 * APPLY, on every page, was the blinking (client report, 2026-10-12).
 *
 *   auto={false}   Enter or APPLY submits softly. The APPLY button stays.
 *   auto           The dashboard's behaviour: APPLY is hidden, dropdowns, dates
 *                  and ticks submit on change, text boxes 400 ms after the last
 *                  keystroke. `replace`, not `push`: forty keystrokes must not
 *                  become forty history entries.
 *
 * It is also what stops the bar from remounting under the reader. The `<form>`
 * is keyed on `useExternalNavEpoch`, which moves only when the URL changed from
 * somewhere other than this form (Back, a card, a link) — see `filter-nav.ts`.
 * `defaultValue` is re-applied then, and only then.
 *
 * The filter row's boxes sit in the table head, outside the form element, joined
 * to it by `form=`. Their events never bubble to the form, so the change and
 * input listeners are on the document and keep only this form's own controls.
 *
 * The URL is built by `filterHref`, which is pure and tested: it has to be the
 * URL the browser would have produced from the same form, or the enhanced and
 * the unenhanced paths would quietly mean different things.
 */
export function FilterForm({
  id, className, auto = false, applyButtonId, children,
}: {
  id?: string
  className?: string
  auto?: boolean
  /** The APPLY button's id; hidden while `auto` is on, so only a reader with no script sees it. */
  applyButtonId?: string
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const epoch = useExternalNavEpoch()
  const formRef = useRef<HTMLFormElement>(null)
  // Held in refs: a pending timer, and the URL as of the last render, are not
  // something the screen draws, and the listeners must always see the latest.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const here = useRef('')
  here.current = search ? `${pathname}?${search}` : pathname

  const go = () => {
    if (timer.current) clearTimeout(timer.current)
    const form = formRef.current
    if (!form) return
    const href = filterHref(new FormData(form).entries(), pathname)
    // Nothing changed (a debounce that landed on the same text): no navigation,
    // and nothing to mark, or the next real external change would be skipped.
    if (href === here.current) return
    markOwnNavigation(href.includes('?') ? href.slice(href.indexOf('?') + 1) : '')
    router.replace(href, { scroll: false })
  }
  const goRef = useRef(go)
  goRef.current = go

  useEffect(() => {
    if (!auto) return
    const apply = applyButtonId ? document.getElementById(applyButtonId) : null
    // `hidden`, not a class: out of the tab order too.
    if (apply) apply.hidden = true

    const owns = (t: EventTarget | null): t is HTMLInputElement | HTMLSelectElement =>
      (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) && t.form === formRef.current
    const isText = (t: HTMLInputElement | HTMLSelectElement) =>
      t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'search')

    const onChange = (e: Event) => {
      const t = e.target
      // A `change` on a text box fires on blur and would double-submit behind the debounce.
      if (owns(t) && !isText(t)) goRef.current()
    }
    const onInput = (e: Event) => {
      const t = e.target
      if (!owns(t) || !isText(t)) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => goRef.current(), DEBOUNCE_MS)
    }
    document.addEventListener('change', onChange)
    document.addEventListener('input', onInput)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('change', onChange)
      document.removeEventListener('input', onInput)
      if (apply) apply.hidden = false
    }
  }, [auto, applyButtonId, epoch])

  return (
    <form
      ref={formRef}
      id={id}
      key={epoch}
      className={className}
      method="get"
      onSubmit={(e) => {
        e.preventDefault()
        go()
      }}
    >
      {children}
    </form>
  )
}
