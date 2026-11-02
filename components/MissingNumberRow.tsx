import { InventoryNoteCell, type InventoryNoteView } from '@/components/InventoryNoteCell'
import { MissingPill, TH } from '@/components/numbering-cells'

/** One MISSING number: amber, no check, its own tick and remark (spec §H). Rendered on the server and inside an opened run. */
export function MissingNumberRow({ checkBookId, number, note }: { checkBookId: string; number: string; note: InventoryNoteView | null }) {
  return (
    <tr className="border-b border-amber-200 bg-amber-50">
      <td className={`${TH} font-semibold tabular-nums text-amber-800`}>{number}</td>
      <td className={`${TH} text-amber-800/60`}>—</td>
      <td className={`${TH} text-amber-800/60`}>NO CHECK IN THIS SYSTEM</td>
      <td className={`${TH} text-right text-amber-800/60`}>—</td>
      <td className={TH}><MissingPill /></td>
      <td className={`${TH} py-2`}>
        <InventoryNoteCell checkBookId={checkBookId} checkNumber={number} note={note} label={number} />
      </td>
    </tr>
  )
}
