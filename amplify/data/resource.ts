import { defineData, a } from '@aws-amplify/backend';
import { chatFunction } from '../functions/chat/resource';
import { attachmentsFunction } from '../functions/attachments/resource';

export const data = defineData({
  schema: a.schema({

    chat: a
      .query()
      .arguments({
        prompt: a.string().required(),
        modelKey: a.string(), // optional
        history: a.string(), // JSON string of prior turns
        attachments: a.string(), // JSON string array of { metaKey, kind }
      })
      .returns(
        a.customType({
          text: a.string().required(),
          stopReason: a.string(),
        })
      )

      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(chatFunction)),

          attachments: a
      .query()
      .arguments({
        action: a.string().required(), // "presign" | "ingest"
        filename: a.string(),
        contentType: a.string(),
        sizeBytes: a.integer(),
        s3Key: a.string(),
      })
      .returns(
        a.customType({
          attachmentId: a.string(),
          s3Key: a.string(),
          uploadUrl: a.string(),
          kind: a.string(),
          metaKey: a.string(),
          chunkCount: a.integer(),
        })
      )
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(attachmentsFunction)),

      ChatThread: a
        .model({
          title: a.string().required(),
          modelKey: a.string(), // optional for legacy compatibility
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
