import { defineFunction } from '@aws-amplify/backend';

export const attachmentsFunction = defineFunction({
  name: 'attachments',
  entry: './handler.ts',
  timeoutSeconds: 60,
});
