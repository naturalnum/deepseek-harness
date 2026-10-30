/** CSV and TSV parsing preserves every field as literal text. */
import Papa from 'papaparse'
import type { Sheet } from '@fortune-sheet/core'
import { ExcelPreviewError } from './error.ts'
import { formatCell, initialSelection, type ExcelLimits, type ExcelPreview } from './model.ts'

/**
 * Parse delimited UTF-8 or BOM-marked UTF-16 without type inference.
 * @param bytes - Borrowed complete file bytes.
 * @param format - Comma or tab-separated input.
 * @param limits - Maximum worksheet area.
 * @returns A single sheet with literal field values.
 */
export function convertDelimited(bytes: Uint8Array<ArrayBuffer>, format: 'csv' | 'tsv', limits: ExcelLimits): ExcelPreview {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch (error) { throw new ExcelPreviewError('encoding', { cause: error }) }
  const celldata: NonNullable<Sheet['celldata']> = []
  let row = 0
  let column = 1
  let previousCursor: number | undefined
  let failure: ExcelPreviewError | undefined
  Papa.parse<string[]>(text, {
    delimiter: format === 'csv' ? ',' : '\t', header: false, dynamicTyping: false, skipEmptyLines: false,
    step(result, parser) {
      // Papa emits a duplicate empty step after the final record separator.
      // Compare its actual parser cursor and chosen linebreak, rather than
      // stripping a character that may belong to a mixed-line-ending field.
      const syntheticTail = result.errors.length === 0 && previousCursor === result.meta.cursor
        && result.meta.cursor === text.length && text.endsWith(result.meta.linebreak)
        && result.data.length === 1 && result.data[0] === ''
      previousCursor = result.meta.cursor
      if (syntheticTail) return
      row += 1
      column = Math.max(column, result.data.length)
      if (result.errors.length > 0 || row * column > limits.maxCells) {
        failure = new ExcelPreviewError(result.errors.length > 0 ? 'invalid' : 'tooLarge')
        parser.abort()
        return
      }
      result.data.forEach((value, c) => { celldata.push({ r: row - 1, c, v: formatCell({ v: value }, '@') }) })
    },
  })
  if (failure !== undefined) throw failure
  return {
    sheets: [{ id: '1', name: format.toUpperCase(), order: 0, status: 1, hide: 0,
      row: Math.max(1, row), column, celldata, config: {}, luckysheet_select_save: initialSelection({}) }],
    missingResults: 0,
    unsupportedFeatures: [],
  }
}
