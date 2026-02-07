'use client';

import { Amplify } from 'aws-amplify';
import outputs from '../../amplify_outputs.json';
import { generateClient } from 'aws-amplify/api';
import type { Schema } from '../../amplify/data/resource';

let configured = false;
if (!configured) {
  Amplify.configure(outputs);
  configured = true;
}

export const client = generateClient<Schema>();
