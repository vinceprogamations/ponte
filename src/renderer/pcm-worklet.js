'use strict';
/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Toca o PCM que chega do ponte-audio.exe (16 bits, 48 kHz, estéreo) para que
// ele vire uma trilha de áudio enviável pelo WebRTC.
// Mantém pouco atraso: se acumular mais de 120 ms, descarta o excesso.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(sampleRate * 2); // 1 s, intercalado L/R
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.maxBuffered = Math.round(sampleRate * 2 * 0.12);
    this.port.onmessage = (e) => this.push(new Int16Array(e.data));
  }

  push(samples) {
    const ring = this.ring;
    for (let i = 0; i < samples.length; i++) {
      ring[this.write] = samples[i] / 32768;
      this.write = (this.write + 1) % ring.length;
    }
    this.count = Math.min(this.count + samples.length, ring.length);
    if (this.count > this.maxBuffered) {
      const drop = (this.count - (this.maxBuffered >> 1)) & ~1; // sempre em pares L/R
      this.read = (this.read + drop) % ring.length;
      this.count -= drop;
    }
  }

  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    const ring = this.ring;
    for (let i = 0; i < left.length; i++) {
      if (this.count >= 2) {
        left[i] = ring[this.read];
        right[i] = ring[(this.read + 1) % ring.length];
        this.read = (this.read + 2) % ring.length;
        this.count -= 2;
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
