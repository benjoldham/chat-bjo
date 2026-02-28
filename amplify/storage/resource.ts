import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'chatbotUploads',
  access: (allow) => ({
    'tmp/{entity_id}/*': [allow.entity('identity').to(['read', 'write', 'delete'])],
    'extracted/{entity_id}/*': [allow.entity('identity').to(['read', 'write', 'delete'])],
  }),
});
