import { defineData, a } from '@aws-amplify/backend';
import { chatFunction } from '../functions/chat/resource';

export const data = defineData({
  schema: a.schema({

    chat: a
      .query()
      .arguments({
        prompt: a.string().required(),
        modelKey: a.string(), // optional
        history: a.string(), // JSON string of prior turns
      })

      .returns(
        a.customType({
          text: a.string().required(),
        })
      )
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(chatFunction)),

    ChatThread: a
      .model({
        title: a.string().required(),
        createdAt: a.datetime().required(),
        deletedAt: a.datetime(), // nullable = soft delete (cross-device)
      })
      .authorization((allow) => [allow.owner()]),

    ChatMessage: a
      .model({
        threadId: a.id().required(),
        role: a.string().required(), // "user" | "assistant"
        content: a.string().required(),
        createdAt: a.datetime().required(),
      })
      .authorization((allow) => [allow.owner()]),
  }),
});
