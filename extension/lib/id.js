/**
 * Director's Cut — room identifiers.
 *
 * A room ID *is* the capability: anyone holding it can pair with you, so it is
 * generated from crypto.getRandomValues() with 100 bits of entropy and is never
 * derived from anything guessable (no timestamps, no counters, no user input).
 * Crockford base32 keeps it readable/dictatable without ambiguous characters.
 */
(() => {
  const NS = (globalThis.DirectorsCut ||= {});

  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U
  const CHARS = 20;                                    // 20 * 5 = 100 bits
  const GROUP = 4;

  /** @returns {string} e.g. "7K4Q-XW2M-9PT3-BVRC-H8ZN" */
  function createRoomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(CHARS));
    // 256 / 32 === 8, so `byte & 31` is an unbiased mapping onto the alphabet.
    let out = '';
    for (let i = 0; i < CHARS; i++) {
      if (i && i % GROUP === 0) out += '-';
      out += ALPHABET[bytes[i] & 31];
    }
    return out;
  }

  /** Accepts sloppy human input ("l"->"1", lowercase, spaces) or null. */
  function normalizeRoomId(input) {
    if (typeof input !== 'string') return null;
    const cleaned = input
      .toUpperCase()
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0')
      .replace(/[^0-9A-Z]/g, '');
    if (cleaned.length !== CHARS) return null;
    for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
    let out = '';
    for (let i = 0; i < cleaned.length; i++) {
      if (i && i % GROUP === 0) out += '-';
      out += cleaned[i];
    }
    return out;
  }

  /** Short opaque id for a peer / content-script instance / stroke. */
  function shortId(len = 10) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  }

  NS.createRoomId = createRoomId;
  NS.normalizeRoomId = normalizeRoomId;
  NS.shortId = shortId;
  NS.ROOM_ID_CHARS = CHARS;
})();
