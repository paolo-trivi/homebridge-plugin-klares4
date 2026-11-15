'use strict';

// A throwaway self-signed certificate (EC P-256, X.509 v1, CN=klares4-test),
// built at runtime with node:crypto so the repository holds no private key.
// It stands in for the Lares4 panel's own self-signed certificate.

const crypto = require('node:crypto');

const der = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    let len;
    if (body.length < 0x80) len = Buffer.from([body.length]);
    else {
        const bytes = [];
        for (let n = body.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
        len = Buffer.from([0x80 | bytes.length, ...bytes]);
    }
    return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const oid = (dotted) => {
    const [a, b, ...rest] = dotted.split('.').map(Number);
    const bytes = [40 * a + b];
    for (const n of rest) {
        const chunk = [n & 0x7f];
        for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
        bytes.push(...chunk);
    }
    return der(0x06, Buffer.from(bytes));
};
const utcTime = (date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

const ECDSA_WITH_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function createSelfSignedCertificate(commonName = 'klares4-test') {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const name = seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
    const now = Date.now();
    const tbs = seq(
        der(0x02, Buffer.from([0x01, ...crypto.randomBytes(8)])),
        ECDSA_WITH_SHA256,
        name,
        seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 24 * 3600_000))),
        name,
        publicKey.export({ type: 'spki', format: 'der' }),
    );
    const signature = crypto.sign('sha256', tbs, privateKey);
    const certificate = seq(tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), signature));
    const body = certificate.toString('base64').match(/.{1,64}/g).join('\n');
    return {
        cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
}

module.exports = { createSelfSignedCertificate };
