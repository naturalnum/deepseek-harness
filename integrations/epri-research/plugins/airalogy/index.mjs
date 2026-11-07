import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { contracts, validateArgs } from "../../src/server/contracts.mjs";
import { call } from "../../src/server/client.mjs";
import { conversationId } from "../workbench/index.mjs";
import {conversationReviewOps,reviewInConversation} from './conversation-review.mjs';
import {cloudResearch} from '../cloud/client-for.mjs';
export const name = "airalogy-data-tools";
export const inject = ["tools"];
export function apply(ctx) {
  const provider=ctx.get('cloudResearch',false);
  for (const [op, c] of Object.entries(contracts)) {
    const schema = zodToJsonSchema(z.object(c.shape).strict(), {
      $refStrategy: "none",
    });
    delete schema.$schema;
    ctx.tools.register({
      name: "research_" + op,
      description: c.description + (provider && op==='engine_run'?' In Cloud mode this native tool waits for the actual terminal execution result before returning.':'') + (conversationReviewOps.has(op) ? ' This tool requests the exact human decision in the current Harness conversation before execution. Never use a separate ask tool as an approval token. Refusal, skip and cancellation do not execute.' : ''),
      parameters: schema,
      ...(provider?{timeoutMs:provider.toolTimeoutMs}:{}),
      output: {
        schema: { oneOf:[{type:"object",additionalProperties:true},{type:"array",items:{type:"object",additionalProperties:true}}] },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute: async (args, exec) => {
        const input=validateArgs(op,args),session=conversationId(exec);
        if(conversationReviewOps.has(op))return reviewInConversation(ctx,op,input,exec,session);
        const cloud=cloudResearch(exec.agent.ctx);
        return cloud?cloud.agentCall(op,input,exec):call(op,input,exec.signal,session);
      },
    });
  }
}
