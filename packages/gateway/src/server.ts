import { config } from './config.js';
import { buildGatewayApp } from './app.js';

async function start(): Promise<void> {
  const app = buildGatewayApp();
  let closing = false;

  async function shutdown(signal: NodeJS.Signals | 'unhandledRejection' | 'uncaughtException'): Promise<void> {
    if (closing) return;
    closing = true;
    app.log.info({ event: 'gateway.shutdown_signal', signal }, 'Gateway shutdown requested');
    const timeout = setTimeout(() => {
      app.log.error({ event: 'gateway.shutdown_timeout', signal }, 'Gateway shutdown timed out');
      process.exit(1);
    }, config.gracefulShutdownTimeoutMs);
    timeout.unref();
    try {
      await app.close();
      clearTimeout(timeout);
      process.exit(0);
    } catch (err) {
      clearTimeout(timeout);
      app.log.error({ event: 'gateway.shutdown_error', err }, 'Gateway shutdown failed');
      process.exit(1);
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('unhandledRejection', (reason) => {
    app.log.fatal({ event: 'gateway.unhandled_rejection', err: reason }, 'Unhandled rejection');
    void shutdown('unhandledRejection');
  });
  process.once('uncaughtException', (err) => {
    app.log.fatal({ event: 'gateway.uncaught_exception', err }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });

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
