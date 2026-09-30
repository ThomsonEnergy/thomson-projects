// Builds a plain-text RFC 2822 message and base64url-encodes it, the
// shape Gmail's users.messages.send endpoint wants ({ raw: <that> }).
// Plain text only (no HTML/multipart) - covers sending/replying with a
// per-person signature, which is all v1 needs.

function encodeHeaderWord(text) {
  // Only the display name portion of From ever needs this - subjects with
  // non-ASCII are rare for this app's use (client names/subjects are
  // almost always plain English) but this keeps a stray apostrophe-heavy
  // name from producing a malformed header.
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf-8').toString('base64')}?=`;
}

function buildMimeMessage({ fromName, fromAddress, to, cc, subject, bodyText, inReplyTo, references }) {
  const headers = [
    `From: ${encodeHeaderWord(fromName)} <${fromAddress}>`,
    `To: ${(Array.isArray(to) ? to : [to]).join(', ')}`,
  ];
  if (cc && cc.length) headers.push(`Cc: ${(Array.isArray(cc) ? cc : [cc]).join(', ')}`);
  headers.push(`Subject: ${encodeHeaderWord(subject || '')}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64'); // safe for any UTF-8 body (signatures/names with accents etc.), not just ASCII
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  // RFC 2045 wants base64 body lines wrapped at 76 chars - Gmail's own
  // parser is lenient, but other clients aren't guaranteed to be.
  const bodyBase64 = Buffer.from(bodyText || '', 'utf-8').toString('base64').replace(/.{76}/g, '$&\r\n');

  const message = `${headers.join('\r\n')}\r\n\r\n${bodyBase64}`;

  const raw = Buffer.from(message, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return raw;
}

module.exports = { buildMimeMessage };
