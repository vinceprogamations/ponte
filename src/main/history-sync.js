'use strict';
// Budget encoded bytes rather than message count: reactions and Unicode can be large.
function* historyBatches(messages) {
  let batch = [];
  let bytes = 30;
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (batch.length && (bytes + size > 512 * 1024 || batch.length >= 100)) {
      yield batch; batch = []; bytes = 30;
    }
    batch.push(message); bytes += size;
  }
  if (batch.length) yield batch;
}
function requestMissingHistory(peerId, rawMessages, priv, chat, media) {
  for (const raw of rawMessages) {
    const m = chat.get(raw?.id);
    if (m && chat.isPrivateChannel(m.channel) === priv && m.file && !media.has(m.file.id)) media.request(peerId, m.file.id);
  }
}
module.exports = { historyBatches, requestMissingHistory };
