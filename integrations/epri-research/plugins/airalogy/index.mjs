import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { contracts, validateArgs } from "../../src/server/contracts.mjs";
import { call } from "../../src/server/client.mjs";
import { conversationId } from "../workbench/index.mjs";
import {conversationReviewOps,reviewInConversation} from './conversation-review.mjs';
export const name = "airalogy-data-tools";
export const inject = ["tools"];
export function apply(ctx) {
  for (const [op, c] of Object.entries(contracts)) {
    const schema = zodToJsonSchema(z.object(c.shape).strict(), {
      $refStrategy: "none",
    });
    delete schema.$schema;
    ctx.tools.register({
      name: "research_" + op,
      description: c.description + (conversationReviewOps.has(op) ? ' This tool requests the exact human decision in the current Harness conversation before execution. Never use a separate ask tool as an approval token. Refusal, skip and cancellation do not execute.' : ''),
      parameters: schema,
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute: async (args, exec) => {
        const input=validateArgs(op,args),session=conversationId(exec);
        return conversationReviewOps.has(op)?reviewInConversation(ctx,op,input,exec,session):call(op,input,exec.signal,session);
      },
    });
  }
}
