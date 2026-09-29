/** Per-user skill metadata in PG; original instructions remain in a private POSIX library. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { PlatformError, type Identity } from '../contracts.ts'
import type { z } from 'zod'
import type { skillSelection } from '../contracts.ts'
import { transaction } from './database.ts'

interface SkillRow {
  id: string
  name: string
  description: string
  digest: string
  enabled: boolean
  revision: number
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }

/** Skill code is stored as data and never imported into the shared host process. */
export class SkillService {
  private readonly root: string
  constructor(private readonly pool: Pool, workspaceRoot: string) { this.root = join(resolve(workspaceRoot), 'extensions') }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill library root must be a real directory')
  }

  private async userRoot(userId: string): Promise<string> {
    const path = join(this.root, userId)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlatformError(503, 'skill_library_unavailable')
    return path
  }

  private async content(userId: string, skill: SkillRow): Promise<string> {
    const root = await this.userRoot(userId)
    const file = await open(join(root, `${skill.id}.md`), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16_384) throw new PlatformError(503, 'skill_unavailable')
      const body = await file.readFile({ encoding: 'utf8' })
      if (hash(body) !== skill.digest) throw new PlatformError(503, 'skill_unavailable')
      return body
    } finally { await file.close() }
  }

  async list(user: Identity): Promise<unknown> {
    const result = await this.pool.query<SkillRow>(
      'SELECT id,name,description,digest,enabled,revision FROM pe_user_skills WHERE user_id=$1 ORDER BY name,id', [user.userId],
    )
    return { items: result.rows.map(({ id, name, description, enabled, revision }) => ({ skillId: id, name, description, enabled, revision })) }
  }

  async read(user: Identity, id: string): Promise<unknown> {
    const result = await this.pool.query<SkillRow>(
      'SELECT id,name,description,digest,enabled,revision FROM pe_user_skills WHERE id=$1 AND user_id=$2', [id, user.userId],
    )
    const skill = result.rows[0]
    if (!skill) throw new PlatformError(404, 'skill_not_found')
    return { skillId: id, name: skill.name, description: skill.description, enabled: skill.enabled, revision: skill.revision,
      instructions: await this.content(user.userId, skill) }
  }

  async install(user: Identity, id: string, name: string, description: string, instructions: string): Promise<unknown> {
    const digest = hash(instructions)
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const prior = await client.query<SkillRow & { user_id: string }>(
        'SELECT id,user_id,name,description,digest,enabled,revision FROM pe_user_skills WHERE id=$1', [id])
      if (prior.rows[0]) {
        const skill = prior.rows[0]
        if (skill.user_id !== user.userId) throw new PlatformError(409, 'request_id_conflict')
        if (skill.name !== name || skill.description !== description || skill.digest !== digest) throw new PlatformError(409, 'request_id_conflict')
        return { skillId: id, name, description, enabled: skill.enabled, revision: skill.revision }
      }
      const conflict = await client.query('SELECT id FROM pe_user_skills WHERE user_id=$1 AND name=$2', [user.userId, name])
      if (conflict.rowCount) throw new PlatformError(409, 'skill_name_conflict')
      const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM pe_user_skills WHERE user_id=$1', [user.userId])
      if (Number(count.rows[0]!.n) >= 8) throw new PlatformError(413, 'skill_limit')
      const root = await this.userRoot(user.userId)
      const temporary = join(root, `.pe-${id}.tmp`)
      await rm(temporary, { force: true })
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(instructions); await file.sync() }
      finally { await file.close() }
      try {
        await rename(temporary, join(root, `${id}.md`))
        const directory = await open(root, constants.O_RDONLY)
        try { await directory.sync() } finally { await directory.close() }
      } finally { await rm(temporary, { force: true }) }
      await client.query(
        'INSERT INTO pe_user_skills(id,user_id,name,description,digest) VALUES($1,$2,$3,$4,$5)',
        [id, user.userId, name, description, digest],
      )
      return { skillId: id, name, description, enabled: true, revision: 1 }
    })
  }

  async toggle(user: Identity, id: string, enabled: boolean): Promise<unknown> {
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const result = await client.query<SkillRow>(
      `UPDATE pe_user_skills SET enabled=$3,revision=revision+CASE WHEN enabled=$3 THEN 0 ELSE 1 END,
       updated_at=CASE WHEN enabled=$3 THEN updated_at ELSE now() END
       WHERE id=$1 AND user_id=$2 RETURNING id,name,description,digest,enabled,revision`, [id, user.userId, enabled],
    )
      const skill = result.rows[0]
      if (!skill) throw new PlatformError(404, 'skill_not_found')
      return { skillId: id, name: skill.name, description: skill.description, enabled: skill.enabled, revision: skill.revision }
    })
  }

  /** Freeze installed instructions for one claimed Operation. */
  async snapshot(userId: string, selection: z.infer<typeof skillSelection>[]): Promise<unknown[]> {
    return Promise.all(selection.map(async selected => ({ name: selected.name, description: selected.description,
      instructions: await this.content(userId, { id: selected.skillId, name: selected.name, description: selected.description,
        digest: selected.digest, revision: selected.revision, enabled: true }), revision: selected.revision })))
  }
}
