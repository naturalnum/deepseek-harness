/** Native attachment provider with the Cloud deployment's closed image declaration. */
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'

export default class ClosedImageStore extends LocalAttachmentStore {
  declare readonly imageLimits: LocalAttachmentStore['imageLimits']

  constructor(...args: ConstructorParameters<typeof LocalAttachmentStore>) {
    super(...args)
    this.imageLimits = Object.freeze({ ...this.imageLimits, mediaTypes: Object.freeze([]) })
  }
}
