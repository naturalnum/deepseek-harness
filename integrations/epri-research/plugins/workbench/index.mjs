import { basename } from 'node:path';
import { call } from '../../src/server/client.mjs';
import { registerWorkbenchRoute } from './web-route.mjs';
import {cloudResearch} from '../cloud/client-for.mjs';
export const name = 'deepscientist-workbench';
export const inject = ['tools', 'sessionProjections'];
export function conversationId(exec) {
  const id = exec?.agent?.session?.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('Research tools require an active Harness conversation');
  return id;
}
export function apply(ctx) {
  if(!ctx.get('peAccount',false)&&!ctx.get('peAuth',false))ctx.inject(['webServer','connection'], owner => owner.effect(() => registerWorkbenchRoute(owner)));
  // Capture deliveries only for the executing conversation's research preset.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== 'present' || result.isError || decision.kind !== 'accept') return decision;
    if (!exec.agent || ctx.sessionProjections.stateOf(exec.agent.session, 'agentPreset') !== 'research-suite') return decision;
    const messages = [];
    for (const [index, file] of (result.value?.files || []).entries()) {
      try {
        const sessionId = conversationId(exec);
        const agentCtx = exec.agent.ctx;
        const fs = agentCtx.get('fs');
        const cwd = await agentCtx.get('workingDirectory').ensure(exec.agent, exec.signal);
        const target = await fs.resolve(file.path, {cwd, signal:exec.signal});
        const bytes = await fs.readBytes(target, exec.signal, 2 * 1024 * 1024);
        const input={name:basename(file.path),contentBase64:Buffer.from(bytes).toString('base64'),requestId:'present:' + exec.callId + ':' + index};
        const cloud=cloudResearch(agentCtx);
        await (cloud?cloud.agentCall('attachment_put',input,exec):call('attachment_put',input,exec.signal,sessionId));
        messages.push('科研工作台已保存文件快照：' + basename(file.path));
      } catch (e) {
        messages.push('科研工作台未能收录 ' + basename(file.path) + '：' + e.message + '。原文件仍已交付；工作台单文件上限为 2 MiB，可用较小文件重试。');
      }
    }
    return {...decision, content:[...(decision.content || result.content), {type:'text',text:messages.join('\n')}]};
  });
}
