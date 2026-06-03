import { config } from './config.js';
import { buildGatewayApp } from './app.js';

async function start(): Promise<void> {
  const app = buildGatewayApp();

  try {
    await app.listen({ port: config.gatewayPort, host: '0.0.0.0' });
    app.log.info(
      { event: 'gateway.listen', port: config.gatewayPort, host: '0.0.0.0' },
      `Gateway listening on http://0.0.0.0:${config.gatewayPort}`
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
