/**
 * Native messaging host entry point.
 *
 * Chrome launches this process and talks to it over stdin/stdout with
 * length-prefixed JSON. It owns the Broker, so MCP servers can attach later.
 *
 * Nothing may be written to stdout except frames — a stray console.log corrupts
 * the stream and Chrome kills the host.
 */

import { Broker, DuplicateHostError, StdioExtensionLink } from './broker.js';
import type { HostRequest } from '../protocol.js';

function log(message: string): void {
  process.stderr.write(`[browsermcp-host] ${message}\n`);
}

async function main(): Promise<void> {
  const broker = new Broker({ onLog: log });
  try {
    await broker.start();
  } catch (err) {
    if (err instanceof DuplicateHostError) {
      log('another host owns the browser; exiting');
      process.exit(0);
    }
    throw err;
  }
  log(`state file: ${broker.stateFilePath}`);

  const link = new StdioExtensionLink((frame) => process.stdout.write(frame));
  broker.attachExtension(link);

  process.stdin.on('data', (chunk: Buffer) => {
    try {
      link.ingest(chunk);
    } catch (err) {
      log(`bad frame: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Chrome closes the pipe when the extension disconnects; the broker keeps the
  // socket open briefly so an agent can reconnect without losing its port.
  process.stdin.on('end', () => {
    log('stdin closed (extension gone)');
    broker.detachExtension();
    setTimeout(() => {
      void broker.close().finally(() => process.exit(0));
    }, 500);
  });

  // Chrome probes the host with a ping on some platforms; answer it explicitly.
  process.stdin.once('readable', () => {
    log('extension connected');
  });

  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => log(`unhandled: ${String(reason)}`));
}

void main();

export type { HostRequest };
