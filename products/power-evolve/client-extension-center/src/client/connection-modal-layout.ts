/** Shared original dialog viewport constraint. */
export const CONNECTION_MODAL_CLASS_NAME = 'pext-connection-modal'
/** Original independently scrolling field region. */
export const CONNECTION_MODAL_CONTENT_CLASS_NAME = 'pext-connection-modal-content'

/** Add the original modal layout to a width class.
 * @param widthClassName - page-specific width. @returns original modal class names.
 */
export function connectionModalClassName(widthClassName: string): string {
  return `${widthClassName} ${CONNECTION_MODAL_CLASS_NAME}`
}
