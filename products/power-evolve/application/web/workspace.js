/** User workspace and personal skills over authenticated product RPC. */
export function initWorkspace({ rpc, t }) {
  const get = id => document.getElementById(id)
  let directory = '', file = null, fileBytes = null, viewEpoch = 0, installRequest = null
  const labels = { 'files-link': t.files, 'skills-link': t.skills, 'actions-link': t.actions, 'executions-link': t.executions, 'toggle-panel': t.content,
    'files-tab': t.files, 'skills-tab': t.skills, 'actions-tab': t.actions, 'executions-tab': t.executions,
    'actions-refresh': t.actionRefresh, 'actions-approval': t.actionApproveAt,
    'executions-refresh': t.executionRefresh,
    'file-up': t.up, 'file-upload-label': t.upload,
    'file-save': t.save, 'file-download': t.download, 'skill-install-title': t.installSkill,
    'skill-install-button': t.install }
  for (const [id, value] of Object.entries(labels)) get(id).textContent = value
  get('skill-name').placeholder = t.skillName
  get('skill-description').placeholder = t.skillDescription
  get('skill-instructions').placeholder = t.skillInstructions
  void fetch('/config').then(response => response.json()).then(config => { get('actions-approval').href = config.approvalUrl }).catch(() => {})

  function showError(error) { get('panel-error').textContent = error.message }
  async function attempt(action) {
    get('panel-error').textContent = ''
    try { return await action() } catch (error) { showError(error); return null }
  }
  function encode(bytes) {
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(text)
  }
  function decode(data) { return Uint8Array.from(atob(data), char => char.charCodeAt(0)) }
  function itemButton(label, action) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'quiet'; button.textContent = label
    button.addEventListener('click', () => void attempt(action))
    return button
  }

  function openPanel(name) {
    get('right-panel').hidden = false
    get('panel-title').textContent = t[name]
    for (const section of ['files', 'skills', 'actions', 'executions']) {
      get(section + '-panel').hidden = name !== section
      get(section + '-tab').classList.toggle('selected', name === section)
    }
    void attempt(name === 'files' ? refreshFiles : name === 'skills' ? refreshSkills : name === 'actions' ? refreshActions : refreshExecutions)
  }
  get('toggle-panel').addEventListener('click', () => openPanel('files'))
  get('files-link').addEventListener('click', () => openPanel('files'))
  get('skills-link').addEventListener('click', () => openPanel('skills'))
  get('actions-link').addEventListener('click', () => openPanel('actions'))
  get('executions-link').addEventListener('click', () => openPanel('executions'))
  get('files-tab').addEventListener('click', () => openPanel('files'))
  get('skills-tab').addEventListener('click', () => openPanel('skills'))
  get('actions-tab').addEventListener('click', () => openPanel('actions'))
  get('executions-tab').addEventListener('click', () => openPanel('executions'))
  get('close-panel').addEventListener('click', () => { get('right-panel').hidden = true })

  async function refreshActions() {
    const result = await rpc('actionsList', {})
    const list = get('action-list'); list.replaceChildren()
    if (!result.items.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t.actionEmpty; list.append(empty) }
    const states = { pending: t.approvalPending, rejected: t.approvalRejected, approved: t.approvalApproved,
      dispatching: t.approvalDispatching, succeeded: t.approvalSucceeded, failed: t.approvalFailed, uncertain: t.approvalUncertain }
    for (const item of result.items) {
      const card = document.createElement('article'); card.className = 'approval-card'
      const heading = document.createElement('strong'); heading.textContent = `${t.approvalAction} · ${states[item.state] ?? item.state}`
      const body = document.createElement('p'); body.textContent = item.text
      const time = document.createElement('small'); time.textContent = new Date(item.createdAt).toLocaleString()
      card.append(heading, body, time); list.append(card)
    }
  }
  get('actions-refresh').addEventListener('click', () => void attempt(refreshActions))

  async function refreshExecutions() {
    const result = await rpc('executionsList', {})
    const list = get('execution-list'); list.replaceChildren()
    if (!result.items.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t.executionEmpty; list.append(empty) }
    const states = { queued: t.executionQueued, starting: t.executionStarting, running: t.executionRunning,
      cancelling: t.executionCancelling, succeeded: t.executionSucceeded, failed: t.executionFailed,
      cancelled: t.executionCancelled, uncertain: t.executionUncertain }
    for (const item of result.items) {
      const card = document.createElement('article'); card.className = 'approval-card'
      const heading = document.createElement('strong'); heading.textContent = states[item.state] ?? item.state
      const command = document.createElement('pre'); command.textContent = item.command
      const time = document.createElement('small'); time.textContent = new Date(item.createdAt).toLocaleString()
      card.append(heading, command, time)
      if (item.result) {
        const output = document.createElement('pre')
        output.textContent = [item.result.stdout, item.result.stderr].filter(Boolean).join('\n')
        card.append(output)
      }
      if (['queued', 'starting', 'running', 'cancelling', 'uncertain'].includes(item.state)) {
        card.append(itemButton(t.executionCancel, async () => {
          await rpc('executionCancel', { executionId: item.executionId }); await refreshExecutions()
        }))
      }
      list.append(card)
    }
  }
  get('executions-refresh').addEventListener('click', () => void attempt(refreshExecutions))

  async function refreshFiles() {
    const epoch = ++viewEpoch
    const result = await rpc('filesList', { directory })
    if (epoch !== viewEpoch) return
    get('file-location').textContent = directory ? `${t.root} / ${directory}` : t.root
    get('file-preview').hidden = true
    const list = get('file-list'); list.replaceChildren()
    if (!result.items.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t.emptyFiles; list.append(empty) }
    for (const entry of result.items) {
      const row = document.createElement('div'); row.className = 'file-row'
      row.append(itemButton(`${entry.kind === 'directory' ? '📁' : '📄'} ${entry.name}`, async () => {
        if (entry.kind === 'directory') { directory = entry.path; await refreshFiles() }
        else await openFile(entry.path)
      }))
      if (entry.kind === 'file') { const size = document.createElement('span'); size.className = 'muted'; size.textContent = `${entry.size} B`; row.append(size) }
      list.append(row)
    }
  }
  get('file-up').addEventListener('click', () => void attempt(async () => {
    directory = directory.split('/').slice(0, -1).join('/'); await refreshFiles()
  }))
  async function openFile(path) {
    file = await rpc('fileRead', { path })
    fileBytes = decode(file.data)
    get('file-name').textContent = path.split('/').at(-1)
    get('file-meta').textContent = `${file.size} B · ${file.mime}`
    try { get('file-editor').value = new TextDecoder('utf-8', { fatal: true }).decode(fileBytes); get('file-editor').disabled = false; get('file-save').disabled = false }
    catch (_binary) { get('file-editor').value = ''; get('file-editor').disabled = true; get('file-save').disabled = true }
    get('file-preview').hidden = false
  }
  get('file-input').addEventListener('change', () => void attempt(async () => {
    const selected = get('file-input').files[0]
    if (!selected) return
    if (selected.size > 2 * 1024 * 1024) throw new Error(t.fileTooLarge)
    const path = directory ? `${directory}/${selected.name}` : selected.name
    const data = encode(new Uint8Array(await selected.arrayBuffer()))
    await rpc('filePut', { requestId: crypto.randomUUID(), path, baseRevision: null, data })
    get('file-input').value = ''
    await refreshFiles(); await openFile(path)
  }))
  get('file-save').addEventListener('click', () => void attempt(async () => {
    if (!file) return
    const data = encode(new TextEncoder().encode(get('file-editor').value))
    await rpc('filePut', { requestId: crypto.randomUUID(), path: file.path, baseRevision: file.revision, data })
    await refreshFiles(); await openFile(file.path)
  }))
  get('file-download').addEventListener('click', () => {
    if (!file || !fileBytes) return
    const url = URL.createObjectURL(new Blob([fileBytes], { type: file.mime }))
    const link = document.createElement('a'); link.href = url; link.download = file.path.split('/').at(-1); link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  })

  async function refreshSkills() {
    const result = await rpc('skillsList', {})
    const list = get('skill-list'); list.replaceChildren()
    if (!result.items.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t.emptySkills; list.append(empty) }
    for (const item of result.items) {
      const row = document.createElement('div'); row.className = 'skill-row'
      row.append(itemButton(`${item.name} · ${item.description}`, async () => {
        const skill = await rpc('skillsRead', { skillId: item.skillId })
        get('skill-detail-name').textContent = skill.name
        get('skill-detail-description').textContent = skill.description
        get('skill-detail-instructions').textContent = skill.instructions
        get('skill-detail').hidden = false
      }))
      row.append(itemButton(item.enabled ? t.disable : t.enable, async () => {
        await rpc('skillsToggle', { skillId: item.skillId, enabled: !item.enabled }); await refreshSkills()
      }))
      list.append(row)
    }
  }
  get('skill-install').addEventListener('submit', event => {
    event.preventDefault()
    void attempt(async () => {
      const name = get('skill-name').value.trim(), description = get('skill-description').value.trim(), instructions = get('skill-instructions').value.trim()
      if (!installRequest || installRequest.name !== name || installRequest.description !== description || installRequest.instructions !== instructions) {
        installRequest = { requestId: crypto.randomUUID(), name, description, instructions }
      }
      await rpc('skillsInstall', installRequest)
      installRequest = null; get('skill-install').reset(); await refreshSkills()
    })
  })
}
