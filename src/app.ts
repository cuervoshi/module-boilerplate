declare global {
  var WebSocket: typeof import('ws');
}

import NDK from '@nostr-dev-kit/ndk';
import WebSocket from 'ws';
global.WebSocket = WebSocket;

import relayList from '@constants/relays.json';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import * as middlewares from '@lib/middlewares';
import { setUpRoutes, setUpSubscriptions } from '@lib/utils';
import path from 'path';
import { ExtendedRequest } from '@type/request';

// Instantiate prisma client
console.info('Instantiate prisma');
const prisma = new PrismaClient({
  log: [{ level: 'query', emit: 'event' }],
});

// Instantiate expresss
console.info('Instantiate express');
const app = express();

// Instantiate ndk
console.info('Instantiate NDK');
const ndk = new NDK({
  explicitRelayUrls: relayList,
});

// --------- //

// Header Middleware
app.use(morgan('dev'));
app.use(helmet());
app.use(express.json());
app.use(cors());

// Generate routes
console.info('Setting up routes...');
const routes = setUpRoutes(express.Router(), path.join(__dirname, 'rest'));

// Setup context
routes.use((req, res, next) => {
  console.log('Time:', Date.now());
  (req as ExtendedRequest).context = {
    prisma,
  };
  next();
});

// Setup express routes
app.use('/', routes);
app.use(middlewares.notFound);
app.use(middlewares.errorHandler);

// Setup Nostr subscriptions
console.info('Subscribing...');
setUpSubscriptions(ndk, path.join(__dirname, 'nostr'));

// Connect to Nostr
console.info('Connecting to Nostr...');
ndk.connect();

ndk.addListener('connected', () => {
  console.info('Connected to Relay');
});

ndk.addListener('error', () => {
  console.info('Error connecting to Relay');
});

export default app;
