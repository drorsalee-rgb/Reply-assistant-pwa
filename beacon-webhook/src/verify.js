// Verifies Beacon's webhook signatures.
//
// Beacon signs each delivery with HMAC-SHA256 over "<timestamp>:<rawBody>",
// sending `x-beacon-hmac: sha256=<hex>` and `x-beacon-timestamp` (epoch
// seconds). The body must be the raw bytes — parsing and re-serialising the
// JSON changes whitespace and breaks the signature.

const crypto = require('crypto');

const MAX_DRIFT_SECONDS = 300;   // Beacon's recommended replay window

class VerificationError extends Error {}

function verifySignature(headers, rawBody, secret){
  const hmacHeader = headers['x-beacon-hmac'];
  const timestampHeader = headers['x-beacon-timestamp'];

  if(!hmacHeader || !timestampHeader){
    throw new VerificationError('missing x-beacon-hmac or x-beacon-timestamp');
  }

  const [algorithm, receivedHmac] = String(hmacHeader).split('=');
  if(algorithm !== 'sha256' || !receivedHmac){
    throw new VerificationError('unsupported HMAC algorithm');
  }
  if(!/^[0-9a-f]+$/i.test(receivedHmac) || receivedHmac.length % 2 !== 0){
    throw new VerificationError('malformed signature');
  }

  const timestamp = Number(timestampHeader);
  if(!Number.isFinite(timestamp)){
    throw new VerificationError('invalid timestamp');
  }
  const drift = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if(drift > MAX_DRIFT_SECONDS){
    throw new VerificationError(`timestamp outside the ${MAX_DRIFT_SECONDS}s window (drift ${drift}s)`);
  }

  const payload = `${timestamp}:${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(receivedHmac, 'hex');
  if(expectedBuffer.length !== receivedBuffer.length
     || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)){
    throw new VerificationError('signature mismatch');
  }
}

module.exports = { verifySignature, VerificationError, MAX_DRIFT_SECONDS };
