/* ---------------------------------------------------------------------
   رمزگشای JPEG پایه‌ای (baseline) — برای لوگوی توکن در کارت پیش‌نمایش
   ---------------------------------------------------------------------
   برگرفته از بخشِ رمزگشای بسته‌ی jpeg-js (نسخه‌ی ۰٫۴٫۴)، که خودش از
   pdf.js (notmasteryet) آمده. اینجا فقط baseline/sequential-huffman ۸بیتی
   مانده؛ رمزگذار، progressive، arithmetic، CMYK و کدِ مرورگر (XHR) حذف شده.
   خروجی همیشه RGB است (خاکستری تکرار می‌شود). سقفِ ابعاد پیش از هر تخصیص
   چک می‌شود تا یک فایلِ مخرب حافظه نخورد.

   مجوزها (عیناً از منبع):

   jpeg-js decoder — Copyright 2011 notmasteryet
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

   jpeg-js package — Copyright (c) 2014, Eugene Ware. All rights reserved.
   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions are
   met: 1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
   2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
   3. Neither the name of Eugene Ware nor the names of its contributors may
   be used to endorse or promote products derived from this software
   without specific prior written permission.
   THIS SOFTWARE IS PROVIDED BY EUGENE WARE ''AS IS'' AND ANY EXPRESS OR
   IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
   OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN
   NO EVENT SHALL EUGENE WARE BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
   SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
   TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   --------------------------------------------------------------------- */

const dctZigZag = new Int32Array([
     0,
     1,  8,
    16,  9,  2,
     3, 10, 17, 24,
    32, 25, 18, 11, 4,
     5, 12, 19, 26, 33, 40,
    48, 41, 34, 27, 20, 13,  6,
     7, 14, 21, 28, 35, 42, 49, 56,
    57, 50, 43, 36, 29, 22, 15,
    23, 30, 37, 44, 51, 58,
    59, 52, 45, 38, 31,
    39, 46, 53, 60,
    61, 54, 47,
    55, 62,
    63
]);

  const dctCos1  =  4017   // cos(pi/16)
  const dctSin1  =   799   // sin(pi/16)
  const dctCos3  =  3406   // cos(3*pi/16)
  const dctSin3  =  2276   // sin(3*pi/16)
  const dctCos6  =  1567   // cos(6*pi/16)
  const dctSin6  =  3784   // sin(6*pi/16)
  const dctSqrt2 =  5793   // sqrt(2)
  const dctSqrt1d2 = 2896  // sqrt(2) / 2

  function buildHuffmanTable(codeLengths, values) {
    var k = 0, code = [], i, j, length = 16;
    while (length > 0 && !codeLengths[length - 1])
      length--;
    code.push({children: [], index: 0});
    var p = code[0], q;
    for (i = 0; i < length; i++) {
      for (j = 0; j < codeLengths[i]; j++) {
        p = code.pop();
        p.children[p.index] = values[k];
        while (p.index > 0) {
          if (code.length === 0)
            throw new Error('Could not recreate Huffman Table');
          p = code.pop();
        }
        p.index++;
        code.push(p);
        while (code.length <= i) {
          code.push(q = {children: [], index: 0});
          p.children[p.index] = q.children;
          p = q;
        }
        k++;
      }
      if (i + 1 < length) {
        // p here points to last code
        code.push(q = {children: [], index: 0});
        p.children[p.index] = q.children;
        p = q;
      }
    }
    return code[0].children;
  }

function decodeScan(data, offset, frame, components, resetInterval) {
  let bitsData = 0, bitsCount = 0;
  const startOffset = offset;
  function readBit() {
    if (bitsCount > 0) {
      bitsCount--;
      return (bitsData >> bitsCount) & 1;
    }
    bitsData = data[offset++];
    if (bitsData === 0xFF) {
      const nextByte = data[offset++];
      if (nextByte) throw new Error("unexpected marker");
    }
    bitsCount = 7;
    return bitsData >>> 7;
  }
  function decodeHuffman(tree) {
    let node = tree, bit;
    while ((bit = readBit()) !== null) {
      node = node[bit];
      if (typeof node === "number") return node;
      if (typeof node !== "object") throw new Error("invalid huffman sequence");
    }
    return null;
  }
  function receive(length) {
    let n = 0;
    while (length > 0) {
      n = (n << 1) | readBit();
      length--;
    }
    return n;
  }
  function receiveAndExtend(length) {
    const n = receive(length);
    if (n >= 1 << (length - 1)) return n;
    return n + (-1 << length) + 1;
  }
  function decodeBaseline(component, zz) {
    const t = decodeHuffman(component.huffmanTableDC);
    const diff = t === 0 ? 0 : receiveAndExtend(t);
    zz[0] = (component.pred += diff);
    let k = 1;
    while (k < 64) {
      const rs = decodeHuffman(component.huffmanTableAC);
      const s = rs & 15, r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) throw new Error("bad AC index");
      zz[dctZigZag[k]] = receiveAndExtend(s);
      k++;
    }
  }
  const mcusPerLine = frame.mcusPerLine;
  function decodeMcu(component, mcu, row, col) {
    const mcuRow = (mcu / mcusPerLine) | 0;
    const mcuCol = mcu % mcusPerLine;
    const blockRow = mcuRow * component.v + row;
    const blockCol = mcuCol * component.h + col;
    if (component.blocks[blockRow] === undefined) return;
    decodeBaseline(component, component.blocks[blockRow][blockCol]);
  }
  function decodeBlock(component, mcu) {
    const blockRow = (mcu / component.blocksPerLine) | 0;
    const blockCol = mcu % component.blocksPerLine;
    if (component.blocks[blockRow] === undefined) return;
    decodeBaseline(component, component.blocks[blockRow][blockCol]);
  }
  const n = components.length;
  let mcu = 0;
  const mcuExpected = n === 1
    ? components[0].blocksPerLine * components[0].blocksPerColumn
    : mcusPerLine * frame.mcusPerColumn;
  if (!resetInterval) resetInterval = mcuExpected;
  while (mcu < mcuExpected) {
    for (let i = 0; i < n; i++) components[i].pred = 0;
    if (n === 1) {
      for (let q = 0; q < resetInterval; q++) {
        decodeBlock(components[0], mcu);
        mcu++;
      }
    } else {
      for (let q = 0; q < resetInterval; q++) {
        for (let i = 0; i < n; i++) {
          const c = components[i];
          for (let j = 0; j < c.v; j++)
            for (let k = 0; k < c.h; k++) decodeMcu(c, mcu, j, k);
        }
        mcu++;
        if (mcu === mcuExpected) break;
      }
    }
    if (mcu === mcuExpected) {
      do {
        if (data[offset] === 0xFF && data[offset + 1] !== 0x00) break;
        offset += 1;
      } while (offset < data.length - 2);
    }
    bitsCount = 0;
    const marker = (data[offset] << 8) | data[offset + 1];
    if (marker < 0xFF00) throw new Error("marker was not found");
    if (marker >= 0xFFD0 && marker <= 0xFFD7) offset += 2;
    else break;
  }
  return offset - startOffset;
}

function buildComponentData(frame, component) {
  let lines = [];
  let blocksPerLine = component.blocksPerLine;
  let blocksPerColumn = component.blocksPerColumn;
  let samplesPerLine = blocksPerLine << 3;
  // Only 1 used per invocation of this function and garbage collected after invocation, so no need to account for its memory footprint.
  let R = new Int32Array(64), r = new Uint8Array(64);

  // A port of poppler's IDCT method which in turn is taken from:
  //   Christoph Loeffler, Adriaan Ligtenberg, George S. Moschytz,
  //   "Practical Fast 1-D DCT Algorithms with 11 Multiplications",
  //   IEEE Intl. Conf. on Acoustics, Speech & Signal Processing, 1989,
  //   988-991.
  function quantizeAndInverse(zz, dataOut, dataIn) {
    let qt = component.quantizationTable;
    let v0, v1, v2, v3, v4, v5, v6, v7, t;
    let p = dataIn;
    let i;

    // dequant
    for (i = 0; i < 64; i++)
      p[i] = zz[i] * qt[i];

    // inverse DCT on rows
    for (i = 0; i < 8; ++i) {
      let row = 8 * i;

      // check for all-zero AC coefficients
      if (p[1 + row] == 0 && p[2 + row] == 0 && p[3 + row] == 0 &&
          p[4 + row] == 0 && p[5 + row] == 0 && p[6 + row] == 0 &&
          p[7 + row] == 0) {
        t = (dctSqrt2 * p[0 + row] + 512) >> 10;
        p[0 + row] = t;
        p[1 + row] = t;
        p[2 + row] = t;
        p[3 + row] = t;
        p[4 + row] = t;
        p[5 + row] = t;
        p[6 + row] = t;
        p[7 + row] = t;
        continue;
      }

      // stage 4
      v0 = (dctSqrt2 * p[0 + row] + 128) >> 8;
      v1 = (dctSqrt2 * p[4 + row] + 128) >> 8;
      v2 = p[2 + row];
      v3 = p[6 + row];
      v4 = (dctSqrt1d2 * (p[1 + row] - p[7 + row]) + 128) >> 8;
      v7 = (dctSqrt1d2 * (p[1 + row] + p[7 + row]) + 128) >> 8;
      v5 = p[3 + row] << 4;
      v6 = p[5 + row] << 4;

      // stage 3
      t = (v0 - v1+ 1) >> 1;
      v0 = (v0 + v1 + 1) >> 1;
      v1 = t;
      t = (v2 * dctSin6 + v3 * dctCos6 + 128) >> 8;
      v2 = (v2 * dctCos6 - v3 * dctSin6 + 128) >> 8;
      v3 = t;
      t = (v4 - v6 + 1) >> 1;
      v4 = (v4 + v6 + 1) >> 1;
      v6 = t;
      t = (v7 + v5 + 1) >> 1;
      v5 = (v7 - v5 + 1) >> 1;
      v7 = t;

      // stage 2
      t = (v0 - v3 + 1) >> 1;
      v0 = (v0 + v3 + 1) >> 1;
      v3 = t;
      t = (v1 - v2 + 1) >> 1;
      v1 = (v1 + v2 + 1) >> 1;
      v2 = t;
      t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
      v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
      v7 = t;
      t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
      v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
      v6 = t;

      // stage 1
      p[0 + row] = v0 + v7;
      p[7 + row] = v0 - v7;
      p[1 + row] = v1 + v6;
      p[6 + row] = v1 - v6;
      p[2 + row] = v2 + v5;
      p[5 + row] = v2 - v5;
      p[3 + row] = v3 + v4;
      p[4 + row] = v3 - v4;
    }

    // inverse DCT on columns
    for (i = 0; i < 8; ++i) {
      let col = i;

      // check for all-zero AC coefficients
      if (p[1*8 + col] == 0 && p[2*8 + col] == 0 && p[3*8 + col] == 0 &&
          p[4*8 + col] == 0 && p[5*8 + col] == 0 && p[6*8 + col] == 0 &&
          p[7*8 + col] == 0) {
        t = (dctSqrt2 * dataIn[i+0] + 8192) >> 14;
        p[0*8 + col] = t;
        p[1*8 + col] = t;
        p[2*8 + col] = t;
        p[3*8 + col] = t;
        p[4*8 + col] = t;
        p[5*8 + col] = t;
        p[6*8 + col] = t;
        p[7*8 + col] = t;
        continue;
      }

      // stage 4
      v0 = (dctSqrt2 * p[0*8 + col] + 2048) >> 12;
      v1 = (dctSqrt2 * p[4*8 + col] + 2048) >> 12;
      v2 = p[2*8 + col];
      v3 = p[6*8 + col];
      v4 = (dctSqrt1d2 * (p[1*8 + col] - p[7*8 + col]) + 2048) >> 12;
      v7 = (dctSqrt1d2 * (p[1*8 + col] + p[7*8 + col]) + 2048) >> 12;
      v5 = p[3*8 + col];
      v6 = p[5*8 + col];

      // stage 3
      t = (v0 - v1 + 1) >> 1;
      v0 = (v0 + v1 + 1) >> 1;
      v1 = t;
      t = (v2 * dctSin6 + v3 * dctCos6 + 2048) >> 12;
      v2 = (v2 * dctCos6 - v3 * dctSin6 + 2048) >> 12;
      v3 = t;
      t = (v4 - v6 + 1) >> 1;
      v4 = (v4 + v6 + 1) >> 1;
      v6 = t;
      t = (v7 + v5 + 1) >> 1;
      v5 = (v7 - v5 + 1) >> 1;
      v7 = t;

      // stage 2
      t = (v0 - v3 + 1) >> 1;
      v0 = (v0 + v3 + 1) >> 1;
      v3 = t;
      t = (v1 - v2 + 1) >> 1;
      v1 = (v1 + v2 + 1) >> 1;
      v2 = t;
      t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
      v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
      v7 = t;
      t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
      v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
      v6 = t;

      // stage 1
      p[0*8 + col] = v0 + v7;
      p[7*8 + col] = v0 - v7;
      p[1*8 + col] = v1 + v6;
      p[6*8 + col] = v1 - v6;
      p[2*8 + col] = v2 + v5;
      p[5*8 + col] = v2 - v5;
      p[3*8 + col] = v3 + v4;
      p[4*8 + col] = v3 - v4;
    }

    // convert to 8-bit integers
    for (i = 0; i < 64; ++i) {
      let sample = 128 + ((p[i] + 8) >> 4);
      dataOut[i] = sample < 0 ? 0 : sample > 0xFF ? 0xFF : sample;
    }
  }

  let i, j;
  for (let blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
    let scanLine = blockRow << 3;
    for (i = 0; i < 8; i++)
      lines.push(new Uint8Array(samplesPerLine));
    for (let blockCol = 0; blockCol < blocksPerLine; blockCol++) {
      quantizeAndInverse(component.blocks[blockRow][blockCol], r, R);

      let offset = 0, sample = blockCol << 3;
      for (j = 0; j < 8; j++) {
        let line = lines[scanLine + j];
        for (i = 0; i < 8; i++)
          line[sample + i] = r[offset++];
      }
    }
  }
  return lines;
}

function clampTo8bit(a) {
  return a < 0 ? 0 : a > 255 ? 255 : a;
}

/* decodeJpeg(bytes, { maxDim }) → { width, height, data: Uint8Array(w*h*3) }
   هر چیزی غیر از baseline/sequential ۸بیتی با ۱ یا ۳ مؤلفه → throw. */
export function decodeJpeg(bytes, opts) {
  const maxDim = (opts && opts.maxDim) || 4096;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  function readUint16() {
    const v = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    return v;
  }
  function readDataBlock() {
    const length = readUint16();
    const array = data.subarray(offset, offset + length - 2);
    offset += array.length;
    return array;
  }
  const quantizationTables = [], huffmanTablesAC = [], huffmanTablesDC = [];
  let frame = null, resetInterval = 0, scans = 0, adobeTransform = null;
  if (readUint16() !== 0xFFD8) throw new Error("SOI not found");
  let marker = readUint16();
  while (marker !== 0xFFD9) {
    if (offset > data.length) throw new Error("truncated");
    switch (marker) {
      case 0xFFE0: case 0xFFE1: case 0xFFE2: case 0xFFE3: case 0xFFE4: case 0xFFE5:
      case 0xFFE6: case 0xFFE7: case 0xFFE8: case 0xFFE9: case 0xFFEA: case 0xFFEB:
      case 0xFFEC: case 0xFFED: case 0xFFEE: case 0xFFEF: case 0xFFFE: {
        const app = readDataBlock();
        if (marker === 0xFFEE && app[0] === 0x41 && app[1] === 0x64 && app[2] === 0x6F &&
            app[3] === 0x62 && app[4] === 0x65 && app[5] === 0) adobeTransform = app[11];
        break;
      }
      case 0xFFDB: {
        const end = readUint16() + offset - 2;
        while (offset < end) {
          const spec = data[offset++];
          const t = new Int32Array(64);
          if ((spec >> 4) === 0) for (let j = 0; j < 64; j++) t[dctZigZag[j]] = data[offset++];
          else if ((spec >> 4) === 1) for (let j = 0; j < 64; j++) t[dctZigZag[j]] = readUint16();
          else throw new Error("DQT: invalid table spec");
          quantizationTables[spec & 15] = t;
        }
        break;
      }
      case 0xFFC0: case 0xFFC1: {  // baseline / extended-sequential huffman
        if (frame) throw new Error("only single frame JPEGs supported");
        readUint16();
        frame = {};
        frame.precision = data[offset++];
        if (frame.precision !== 8) throw new Error("only 8-bit precision supported");
        frame.scanLines = readUint16();
        frame.samplesPerLine = readUint16();
        if (!(frame.scanLines > 0 && frame.samplesPerLine > 0) ||
            frame.scanLines > maxDim || frame.samplesPerLine > maxDim) throw new Error("dimensions out of range");
        frame.components = {};
        frame.componentsOrder = [];
        const count = data[offset++];
        if (count !== 1 && count !== 3) throw new Error("unsupported component count");
        for (let i = 0; i < count; i++) {
          const id = data[offset];
          const h = data[offset + 1] >> 4, v = data[offset + 1] & 15;
          if (h <= 0 || v <= 0 || h > 4 || v > 4) throw new Error("invalid sampling factor");
          frame.componentsOrder.push(id);
          frame.components[id] = { h, v, quantizationIdx: data[offset + 2] };
          offset += 3;
        }
        prepareComponents(frame);
        break;
      }
      case 0xFFC2: case 0xFFC3: case 0xFFC5: case 0xFFC6: case 0xFFC7:
      case 0xFFC9: case 0xFFCA: case 0xFFCB: case 0xFFCD: case 0xFFCE: case 0xFFCF:
        throw new Error("unsupported JPEG type (progressive/lossless/arithmetic)");
      case 0xFFC4: {
        const len = readUint16();
        for (let i = 2; i < len;) {
          const spec = data[offset++];
          const codeLengths = new Uint8Array(16);
          let sum = 0;
          for (let j = 0; j < 16; j++, offset++) sum += (codeLengths[j] = data[offset]);
          const values = new Uint8Array(sum);
          for (let j = 0; j < sum; j++, offset++) values[j] = data[offset];
          i += 17 + sum;
          ((spec >> 4) === 0 ? huffmanTablesDC : huffmanTablesAC)[spec & 15] =
            buildHuffmanTable(codeLengths, values);
        }
        break;
      }
      case 0xFFDD:
        readUint16();
        resetInterval = readUint16();
        break;
      case 0xFFDA: {
        if (!frame) throw new Error("scan before frame");
        readUint16();
        const sel = data[offset++];
        const components = [];
        for (let i = 0; i < sel; i++) {
          const component = frame.components[data[offset++]];
          if (!component) throw new Error("bad scan component");
          const spec = data[offset++];
          component.huffmanTableDC = huffmanTablesDC[spec >> 4];
          component.huffmanTableAC = huffmanTablesAC[spec & 15];
          if (!component.huffmanTableDC || !component.huffmanTableAC) throw new Error("missing huffman table");
          components.push(component);
        }
        const ss = data[offset++], se = data[offset++], sa = data[offset++];
        if (ss !== 0 || se !== 63 || sa !== 0) throw new Error("not a baseline scan");
        offset += decodeScan(data, offset, frame, components, resetInterval);
        scans++;
        break;
      }
      case 0xFFFF:
        if (data[offset] !== 0xFF) offset--;
        break;
      default:
        throw new Error("unknown JPEG marker");
    }
    marker = readUint16();
  }
  if (!frame || scans < 1) throw new Error("no image data");
  const comps = [];
  for (const id of frame.componentsOrder) {
    const c = frame.components[id];
    c.quantizationTable = quantizationTables[c.quantizationIdx];
    if (!c.quantizationTable) throw new Error("missing quantization table");
    comps.push({ lines: buildComponentData(frame, c), scaleX: c.h / frame.maxH, scaleY: c.v / frame.maxV });
  }
  const width = frame.samplesPerLine, height = frame.scanLines;
  const out = new Uint8Array(width * height * 3);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const l1 = comps[0].lines[0 | (y * comps[0].scaleY)];
    if (comps.length === 1) {
      for (let x = 0; x < width; x++) {
        const Y = l1[0 | (x * comps[0].scaleX)];
        out[o++] = Y; out[o++] = Y; out[o++] = Y;
      }
      continue;
    }
    const l2 = comps[1].lines[0 | (y * comps[1].scaleY)];
    const l3 = comps[2].lines[0 | (y * comps[2].scaleY)];
    // سه مؤلفه: پیش‌فرض YCbCr؛ فقط اگر Adobe صریحاً transform=0 بگوید RGB
    const ycc = adobeTransform !== 0;
    for (let x = 0; x < width; x++) {
      const a = l1[0 | (x * comps[0].scaleX)];
      const b = l2[0 | (x * comps[1].scaleX)];
      const c = l3[0 | (x * comps[2].scaleX)];
      if (ycc) {
        out[o++] = clampTo8bit(a + 1.402 * (c - 128));
        out[o++] = clampTo8bit(a - 0.3441363 * (b - 128) - 0.71413636 * (c - 128));
        out[o++] = clampTo8bit(a + 1.772 * (b - 128));
      } else {
        out[o++] = a; out[o++] = b; out[o++] = c;
      }
    }
  }
  return { width, height, data: out };

  function prepareComponents(f) {
    let maxH = 1, maxV = 1;
    for (const id in f.components) {
      const c = f.components[id];
      if (maxH < c.h) maxH = c.h;
      if (maxV < c.v) maxV = c.v;
    }
    const mcusPerLine = Math.ceil(f.samplesPerLine / 8 / maxH);
    const mcusPerColumn = Math.ceil(f.scanLines / 8 / maxV);
    for (const id in f.components) {
      const c = f.components[id];
      c.blocksPerLine = Math.ceil(Math.ceil(f.samplesPerLine / 8) * c.h / maxH);
      c.blocksPerColumn = Math.ceil(Math.ceil(f.scanLines / 8) * c.v / maxV);
      const rows = mcusPerColumn * c.v, cols = mcusPerLine * c.h;
      const blocks = [];
      for (let i = 0; i < rows; i++) {
        const row = [];
        for (let j = 0; j < cols; j++) row.push(new Int32Array(64));
        blocks.push(row);
      }
      c.blocks = blocks;
    }
    f.maxH = maxH; f.maxV = maxV; f.mcusPerLine = mcusPerLine; f.mcusPerColumn = mcusPerColumn;
  }
}
