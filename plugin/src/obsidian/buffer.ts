/**
 * Handing bytes to an Obsidian API that wants an `ArrayBuffer`, without copying a file to
 * do it.
 *
 * Both boundaries into Obsidian — `vault.adapter.writeBinary` and `requestUrl`'s body —
 * take an `ArrayBuffer`, and a `Uint8Array` is not one. Both used to copy unconditionally,
 * which is a whole extra copy of an attachment at exactly the moment there are already two
 * in memory: a pull holds the ciphertext and the plaintext, and the copy on the way to disk
 * made it three. docs/02 says mobile memory limits are real, and that third copy is the one
 * that decides whether a large file arrives at all (docs/10).
 *
 * When a view covers exactly its whole buffer, that buffer already IS the bytes and there is
 * nothing to copy. A decrypted blob is such a view — the AEAD returns a fresh, exact
 * allocation — and so is a sealed one. A **view into a larger buffer still has to be
 * copied**, and that case is not hypothetical: a resumable upload's parts are `subarray`s of
 * one sealed blob, so handing over `.buffer` there would send the entire file as every part.
 *
 * The buffer is lent, not given. The caller keeps its `Uint8Array` and may go on reading it
 * — a pull hashes the plaintext on the line after it writes it — which is sound because
 * these APIs read the buffer and neither retains nor mutates it.
 */
export const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer => {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    // A `SharedArrayBuffer` is an `ArrayBufferLike` and not an `ArrayBuffer`; the check
    // narrows the type and refuses to pass one somewhere that did not ask for it.
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }

  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};
