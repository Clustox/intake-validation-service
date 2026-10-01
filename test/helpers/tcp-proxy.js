'use strict';

// A TCP pass-through to MariaDB that a test can cut, to make the database
// genuinely unreachable from the service's point of view.

const net = require('node:net');

async function createProxy(targetHost, targetPort) {
  const sockets = new Set();
  let server;
  let port;

  const listen = () => new Promise((resolve, reject) => {
    server = net.createServer(client => {
      const upstream = net.connect(targetPort, targetHost);
      sockets.add(client); sockets.add(upstream);
      const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
      client.on('error', drop); upstream.on('error', drop);
      client.on('close', drop); upstream.on('close', drop);
      client.pipe(upstream); upstream.pipe(client);
    });
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });

  await listen();
  return {
    get port() { return port; },
    // Refuse new connections and sever every open one.
    async cut() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise(r => server.close(r));
    },
    async restore() { await listen(); },
  };
}

module.exports = { createProxy };
