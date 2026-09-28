/** Product profile snapshot adapter: compare complete native records after volatile identity/clock normalization. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
const directory = new URL('../../../../snapshots/power-evolve/conversation/', import.meta.url)
const canonical = new URL('session.v4.jsonl', directory)
const record = process.env.PE_RECORD_SNAPSHOT === '1'
export async function recordedConversation() {
  const manifest = yaml.load(await readFile(new URL('snapshot.yml', directory), 'utf8'))
  assert.deepEqual(manifest, { version: 1, scenario: 'conversation', profile: 'power-evolve-host', composition: 'shared-host-platform-pg', recording: 'authored', header: { class: 'power-evolve-text', pin: true } })
  try {
    const rows = (await readFile(canonical,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    assert.equal(rows[0].version,4)
    return {
      input: rows.find(row=>row.type==='user/message').data.content[0].text,
      output: rows.find(row=>row.type==='assistant/message').data.message.content[0].text,
      rows,
    }
  } catch(error) {
    if (record && error.code==='ENOENT') return { input:'alpha',output:'reply:alpha',rows:null }
    throw error
  }
}
export async function compareRecordedSession(page, expected) {
  const ids = new Map([[page.header.id,'{{session:1}}']])
  const rpcIds = new Map()
  const identity = value => { if (!ids.has(value)) ids.set(value,`{{message:${ids.size}}}`); return ids.get(value) }
  const rpcIdentity = value => { if (!rpcIds.has(value)) rpcIds.set(value, `{{request:${rpcIds.size + 1}}}`); return rpcIds.get(value) }
  const normalizeIds = value => {
    if (Array.isArray(value)) return value.map(normalizeIds)
    if (!value || typeof value!=='object') return value
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
      key==='id' && typeof item==='string' ? identity(item)
        : key==='rpcId' && typeof item==='string' ? rpcIdentity(item) : normalizeIds(item)]))
  }
  const rows = [normalizeIds({...page.header,createdAt:0}),...page.events.map(event=> {
    const {seq,time,...rest}=event
    const row=normalizeIds(rest)
    if(row.type==='assistant/message' || row.type==='assistant/attempt') {
      for(const part of row.data.stream) {
        if ('time' in part) part.time=0
        if ('time0' in part) part.time0=0
        if ('dt' in part) part.dt=part.dt.map(()=>0)
      }
    }
    if(row.type==='system/message') for(const block of row.data.message.content) if(block.type==='text') block.text='{{system}}'
    return row
  })]
  const system = page.events.filter(event=>event.type==='system/message').flatMap(event=>event.data.message.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n')+'\n'
  if(record) {
    await writeFile(canonical,rows.map(row=>JSON.stringify(row)).join('\n')+'\n')
    await writeFile(new URL('system-prompt.expected.md',directory),system)
  } else {
    assert.deepEqual(rows,expected.rows,`Recorded native Session differs: ${fileURLToPath(canonical)}`)
    assert.equal(system,await readFile(new URL('system-prompt.expected.md',directory),'utf8'))
  }
}
