/** Node test-stream evidence; per-file summaries distinguish actual cases from an empty file wrapper. */

/** Persist native summaries and case outcomes beside TAP without changing runner results.
 * @param source Native Node test event stream.
 * @returns JSON lines containing per-file and overall summaries and actual outcomes.
 */
export default async function* cloudReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:summary') yield JSON.stringify(event) + '\n'
    else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const { name, file, line, column, nesting, skip, todo, details } = event.data
      yield JSON.stringify({ type: event.type, data: { name, file, line, column, nesting, skip, todo,
        details: { type: details.type, error: details.error?.message } } }) + '\n'
    }
  }
}
