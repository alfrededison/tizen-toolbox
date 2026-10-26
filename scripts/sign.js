#!/usr/bin/env node
'use strict';

// Signs (or re-signs) any .wgt/.tpk with the certificates in certs/ (see
// npm run cert), so a TV listed in the distributor certificate accepts it.
//
//   npm run sign -- in.wgt [out.wgt]

const fs = require('fs');
const path = require('path');
const { signZipBuffer, whyCannotSign, describeSigning } = require('./lib/sign');

async function main() {
    const [input, output] = process.argv.slice(2);
    if (!input) {
        console.error('Usage: npm run sign -- <in.wgt> [out.wgt]');
        process.exit(2);
    }
    const reason = whyCannotSign();
    if (reason) {
        console.error('Cannot sign: ' + reason);
        process.exit(1);
    }
    const out = output || input.replace(/(\.\w+)$/, '-signed$1');
    const signed = await signZipBuffer(fs.readFileSync(input));
    fs.writeFileSync(out, signed);
    console.log(`Signed with ${describeSigning()} -> ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
