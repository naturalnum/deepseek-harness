/** Test-only ABI8 startup surface; no account, anchor, copy, kernel or mutation capability is supplied. */
const unused = () => { throw new Error('No native file operation belongs to this configuration regression') }
module.exports = { abiVersion: 8, probeKernel() {}, openAnchor: unused, openRead: unused, openMetadata: unused,
  closeRead: unused, closeAnchor: unused, canonicalPath: unused, prepareLeaf: unused, removeEmptyLeaf: unused,
  prepareExt4Leaf: unused, removeExt4Leaf: unused, writeText: unused, openPathMetadata: unused,
  verifyContentAnchor: unused, listDirectory: unused }
