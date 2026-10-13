/** Native cloud Workspace requests shared by Host and Platform. */
import { posix } from 'node:path'
import { z } from 'zod'
import { sessionId, workspaceId } from './contracts.ts'

/** The cloud account's browse root, independent of its physical storage. */
export const cloudHome = '/workspace'
/** One child directory name with no traversal or control characters. */
export const cloudDirectoryName = z.string().min(1).max(80).refine(name =>
  name === name.trim() && name.normalize('NFC') === name && !['.', '..'].includes(name)
  && !/[\u0000-\u001f\u007f/\\]/u.test(name), { message: 'Expected one directory name' })
/** One normalized cloud directory path with independently valid child names. */
export const cloudDirectory = z.string().min(1).max(512).refine(path =>
  (path === cloudHome || path.startsWith(`${cloudHome}/`)) && posix.normalize(path) === path
  && path.split('/').slice(2).every(segment => cloudDirectoryName.safeParse(segment).success),
{ message: 'Expected a canonical cloud directory path' })
/** Native directory listing retains its upstream named arguments. */
export const nativeDirectoryList = z.object({ path: z.union([z.literal('/'), cloudDirectory]).optional() }).strict()
/** Native directory creation accepts one existing parent and one child name. */
export const nativeDirectoryCreate = z.object({ path: cloudDirectory, name: cloudDirectoryName }).strict()
/** Native Workspace registration adopts one existing cloud directory. */
export const nativeWorkspaceCreate = z.object({ path: cloudDirectory }).strict()
/** Native Workspace title mutation preserves its registered directory. */
export const nativeWorkspaceRename = z.object({ workspaceId, title: z.string().trim().min(1).max(80) }).strict()
/** Native Workspace removal retains its owned files and Sessions. */
export const nativeWorkspaceDelete = z.object({ workspaceId }).strict()
/** Native Workspace ordering uses an optional current registry anchor. */
export const nativeWorkspaceOrder = nativeWorkspaceDelete.extend({ beforeWorkspaceId: workspaceId.optional() }).strict()
/** Native Session ordering preserves immutable Workspace membership. */
export const nativeSessionOrder = z.object({ workspaceId, sessionId, beforeSessionId: sessionId.optional() }).strict()
/** Native Session archival optionally requests cancellation of its active work. */
export const nativeSessionArchive = z.object({ sessionId, stopActivity: z.boolean().optional() }).strict()
/** Native unarchive and pin mutations address one owned Session. */
export const nativeSessionGrouping = z.object({ sessionId }).strict()
