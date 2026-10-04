import { t } from './locale.js'
const get = id => document.getElementById(id)
for (const [id, key] of Object.entries({ 'device-title': 'deviceTitle', 'device-intro': 'deviceIntro',
  'pair-title': 'devicePairTitle', 'pair-code-label': 'devicePairCode', 'device-name-label': 'deviceName',
  'pair-button': 'devicePair', 'folders-title': 'deviceFolders', 'folders-intro': 'deviceFolderIntro',
  'choose-folder': 'deviceChoose', 'authorize-folder': 'deviceAuthorize',
  'transfer-title': 'deviceTransferTitle', 'transfer-intro': 'deviceTransferIntro',
  'transfer-directory-label': 'deviceTransferDirectory', 'cloud-path-label': 'deviceCloudPath',
  'local-path-label': 'deviceLocalPath', 'import-file': 'deviceImport', 'export-file': 'deviceExport' })) get(id).textContent = t[key]
get('folder-path').placeholder = t.devicePath
get('device-name').value = t.deviceDefaultName
let nonce = ''
async function call(path, input) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pe-device-nonce': nonce },
    body: JSON.stringify(input) })
  const value = await response.json()
  if (!response.ok) throw new Error(`${t.error} (${value.error})`)
  return value
}
function render(status) {
  get('pair-section').hidden = status.paired
  get('folders-section').hidden = !status.paired
  get('transfer-section').hidden = !status.paired || !status.directories.length
  get('device-state').textContent = !status.paired ? t.deviceUnpaired : status.online ? t.deviceOnline : t.deviceOffline
  const list = get('folder-list'); list.replaceChildren()
  for (const item of status.directories) {
    const row = document.createElement('article'); row.className = 'device-folder'
    const title = document.createElement('strong'); title.textContent = item.label
    const path = document.createElement('code'); path.textContent = item.path
    row.append(title, path); list.append(row)
  }
  if (!status.directories.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t.deviceNoFolders; list.append(empty) }
  const selector = get('transfer-directory'), selected = selector.value
  selector.replaceChildren()
  for (const item of status.directories) {
    const option = document.createElement('option'); option.value = item.directoryId; option.textContent = item.label
    selector.append(option)
  }
  if (status.directories.some(item => item.directoryId === selected)) selector.value = selected
}
async function action(operation) {
  get('device-error').textContent = ''
  try { await operation(); render(await call('status', {})) }
  catch (error) { get('device-error').textContent = error.message }
}
get('pair-form').addEventListener('submit', event => {
  event.preventDefault()
  void action(() => call('pair', { code: get('pair-code').value.trim(), name: get('device-name').value.trim() }))
})
get('choose-folder').addEventListener('click', () => void action(async () => {
  if (window.powerEvolveDevicePicker !== undefined) {
    const path = await window.powerEvolveDevicePicker.choose()
    if (path !== null) await call('authorize', { path })
  } else await call('choose', {})
}))
get('folder-form').addEventListener('submit', event => {
  event.preventDefault()
  void action(() => call('authorize', { path: get('folder-path').value.trim() }))
})
for (const [button, operation] of [['import-file', 'import'], ['export-file', 'export']]) {
  get(button).addEventListener('click', () => void action(async () => {
    const directoryId = get('transfer-directory').value
    const cloudPath = get('cloud-path').value.trim(), localPath = get('local-path').value.trim()
    const requestId = crypto.randomUUID()
    get('transfer-result').textContent = ''
    const result = await call(operation, { directoryId, cloudPath, localPath, ...(operation === 'export' ? { requestId } : {}) })
    const destination = operation === 'import' ? result.localPath : result.path
    get('transfer-result').textContent = `${t.deviceTransferDone}: ${destination} (${result.size} bytes)`
  }))
}
const config = await (await fetch('/config')).json(); nonce = config.nonce; render(config.status)
setInterval(() => void call('status', {}).then(render).catch(() => {}), 2000)
