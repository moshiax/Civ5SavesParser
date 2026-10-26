(() => {
  const id = (hex) => Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16)),
    text = (value) => new TextEncoder().encode(value),
    join = (...parts) => {
      const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
      }
      return result;
    },
    sizeVint = (size) => {
      for (let length = 1; length <= 8; length++) {
        if (BigInt(size) < (1n << BigInt(7 * length)) - 1n) {
          const value = BigInt(size) | (1n << BigInt(7 * length));
          const bytes = new Uint8Array(length);
          for (let i = length - 1; i >= 0; i--) {
            bytes[i] = Number(value >> BigInt(8 * (length - i - 1)) & 255n);
          }
          return bytes;
        }
      }
      throw new RangeError("WebM element exceeds the supported size.");
    },
    uint = (value) => {
      let length = 1;
      while (value >= 2 ** (length * 8) && length < 8) length++;
      const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
      for (let i = length - 1; i >= 0; i--) {
        bytes[i] = value % 256;
        value = Math.floor(value / 256);
      }
      return bytes;
    },
    element = (name, ...payload) => {
      const payloadSize = payload.reduce((size, part) => size + part.length, 0);
      return join(id(name), sizeVint(payloadSize), ...payload);
    },
    float64 = (value) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value, false);
      return bytes;
    };

  class ReplayWebMMuxer {
    constructor(width, height, fps = 4, codec = "vp8") {
      this.width = width;
      this.height = height;
      this.fps = fps;
      this.codec = codec === "vp9" ? "V_VP9" : "V_VP8";
      this.frames = [];
    }

    addFrame(timestamp, keyframe, data) {
      this.frames.push({ timestamp, keyframe, data });
    }

    finish() {
      if (!this.frames.length) throw new Error("The video has no encoded frames.");
      const duration = this.frames.length * 1000 / this.fps,
        ebml = element("1a45dfa3",
          element("4286", uint(1)), element("42f7", uint(1)),
          element("42f2", uint(4)), element("42f3", uint(8)),
          element("4282", text("webm")), element("4287", uint(4)), element("4285", uint(2))),
        info = element("1549a966",
          element("2ad7b1", uint(1_000_000)), element("4489", float64(duration)),
          element("4d80", text("Civ5 Replay Renderer")), element("5741", text("Civ5 Replay Renderer"))),
        video = element("e0", element("b0", uint(this.width)), element("ba", uint(this.height))),
        track = element("ae",
          element("d7", uint(1)), element("73c5", uint(1)), element("83", uint(1)),
          element("23e383", uint(Math.round(1_000_000_000 / this.fps))),
          element("86", text(this.codec)), video),
        tracks = element("1654ae6b", track),
        clusters = this.frames.map(({ timestamp, keyframe, data }) => {
          const timecode = Math.max(0, Math.round(timestamp / 1000)),
            timecodeElement = element("e7", uint(timecode)),
            blockSize = 4 + data.length,
            block = new Blob([id("a3"), sizeVint(blockSize), Uint8Array.of(0x81, 0, 0, keyframe ? 0x80 : 0), data]),
            clusterSize = timecodeElement.length + block.size;
          return new Blob([id("1f43b675"), sizeVint(clusterSize), timecodeElement, block]);
        }),
        clusterBytes = clusters.reduce((sum, cluster) => sum + cluster.size, 0);
      let seekHead = new Uint8Array(), cues;
      while (true) {
        let clusterPosition = seekHead.length + info.length + tracks.length;
        cues = element("1c53bb6b", ...this.frames.flatMap((frame, index) => {
          const position = clusterPosition;
          clusterPosition += clusters[index].size;
          return frame.keyframe
            ? [element("bb", element("b3", uint(Math.max(0, Math.round(frame.timestamp / 1000)))), element("b7", element("f7", uint(1)), element("f1", uint(position))))]
            : [];
        }));
        const cuePosition = seekHead.length + info.length + tracks.length + clusterBytes,
          nextSeekHead = element("114d9b74", element("4dbb", element("53ab", id("1c53bb6b")), element("53ac", uint(cuePosition))));
        if (nextSeekHead.length === seekHead.length) {
          seekHead = nextSeekHead;
          break;
        }
        seekHead = nextSeekHead;
      }
      const segmentSize = seekHead.length + info.length + tracks.length + clusterBytes + cues.length,
        segmentHeader = join(id("18538067"), sizeVint(segmentSize)),
        parts = [ebml, segmentHeader, seekHead, info, tracks, ...clusters, cues];
      return new Blob(parts, { type: "video/webm" });
    }
  }

  window.ReplayWebMMuxer = ReplayWebMMuxer;
})();
