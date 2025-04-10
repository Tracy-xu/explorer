#!/usr/bin/env node
import minimist from 'minimist';
import StaticServer from  './static-server.js'

const args = minimist(process.argv.slice(2), {
  alias: {
    p: 'port',
    r: 'root'
  },
  default: {
    port: 3000,
    root: process.cwd()
  }
});

const server = new StaticServer({port: args.port, root: args.root});
server.start();
