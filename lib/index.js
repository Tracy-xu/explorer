#!/usr/bin/env node
import minimist from 'minimist';
import { readFileSync } from 'fs';
import StaticServer from './static-server.js';
import { dedent } from './utils.js';
const args = minimist(process.argv.slice(2), {
    alias: {
        p: 'port',
        r: 'root',
        h: 'help',
        v: 'version'
    },
    default: {
        port: 3000,
        root: process.cwd()
    },
    boolean: ['help', 'version']
});
if (args.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(pkg.version);
    process.exit(0);
}
if (args.help) {
    console.log(dedent(`
    Usage: npx explorer [options]

    Options:
      -p, --port   server port (default: 3000)
      -r, --root   root directory to serve (default: current working directory)
      -h, --help   display help for command
  `));
    process.exit(0);
}
const server = new StaticServer({ port: args.port, root: args.root });
server.start();
