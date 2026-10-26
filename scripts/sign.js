#!/usr/bin/env node
'use strict';

// Signs (or re-signs) any .wgt/.tpk with your author certificate and the
// Tizen public distributor certificate, so the TV Installer accepts it.
//
//   TIZEN_AUTHOR_KEY=certs/author.p12 TIZEN_AUTHOR_KEY_PW=... npm run sign -- in.wgt [out.wgt]

const fs = require('fs');
const path = require('path');
const { signZipBuffer, whyCannotSign } = require('./lib/sign');

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
    console.log(`Signed -> ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
