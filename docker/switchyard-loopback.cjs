// Forwards 127.0.0.1:4000 inside the Paperclip server container to the host's
// Switchyard router. An AI connection of type "Local endpoint" must use a
// loopback address, so this lets it use http://localhost:4000/v1.
// Started in the background by the server command in
// docker/docker-compose.network.yml.
const net = require("node:net");

const LISTEN_PORT = 4000;
const UPSTREAM_HOST = "host.docker.internal";
const UPSTREAM_PORT = 4000;

net
  .createServer((client) => {
    const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST);
    client.pipe(upstream).pipe(client);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  })
  .listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`switchyard-loopback: 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  });
